import { parentPort as threadParentPort, workerData as threadWorkerData } from "node:worker_threads";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, opendir, readFile, realpath, stat } from "node:fs/promises";
import { availableParallelism } from "node:os";
import { performance } from "node:perf_hooks";
import process from "node:process";
import path from "node:path";
import sharp from "sharp";
import * as ort from "onnxruntime-node";
import { AutoTokenizer, env } from "@huggingface/transformers";
import {
  DEFAULT_RESULT_LIMIT,
  EMBEDDING_DIMENSIONS,
  LOCAL_IMAGE_SEARCH_VERSION,
  SUPPORTED_IMAGE_EXTENSIONS,
} from "./constants.mjs";
import { exactTopK } from "./vector-search.mjs";
import { BUILTIN_MODEL_FINGERPRINT } from "./model-manager.mjs";
import { createIndexExecutionProfile } from "./execution-profile.mjs";

env.allowRemoteModels = false;
env.allowLocalModels = true;

const UTILITY_WORKER_DATA_PREFIX = "--ngr-local-image-worker-data=";
const MAX_WORKER_DATA_ARGUMENT_CHARS = 24 * 1024;

function decodeUtilityWorkerData() {
  const argument = process.argv.find((value) => value.startsWith(UTILITY_WORKER_DATA_PREFIX));
  if (!argument) return null;
  const encoded = argument.slice(UTILITY_WORKER_DATA_PREFIX.length);
  if (!encoded || argument.length > MAX_WORKER_DATA_ARGUMENT_CHARS || !/^[A-Za-z0-9_-]+$/.test(encoded)) {
    throw new Error("WORKER_DATA_INVALID");
  }
  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    throw new Error("WORKER_DATA_INVALID");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("WORKER_DATA_INVALID");
  if (typeof parsed.dbPath !== "string" || !path.isAbsolute(parsed.dbPath)
      || typeof parsed.modelRoot !== "string" || !path.isAbsolute(parsed.modelRoot)) {
    throw new Error("WORKER_DATA_INVALID");
  }
  return Object.freeze({
    dbPath: parsed.dbPath,
    modelRoot: parsed.modelRoot,
    preferredProvider: parsed.preferredProvider === "dml" ? "dml" : "cpu",
    directmlProbe: parsed.directmlProbe && typeof parsed.directmlProbe === "object"
      ? parsed.directmlProbe
      : null,
    testScanFailurePrefix: typeof parsed.testScanFailurePrefix === "string"
      ? parsed.testScanFailurePrefix.slice(0, 1_024)
      : null,
    testPauseAfterStagedRows: Number.isInteger(parsed.testPauseAfterStagedRows)
      ? Math.max(1, Math.min(10_000, parsed.testPauseAfterStagedRows))
      : null,
    testPauseAfterIndexBegin: parsed.testPauseAfterIndexBegin === true,
  });
}

const utilityParentPort = threadParentPort ? null : process.parentPort;
const workerData = threadParentPort ? threadWorkerData : decodeUtilityWorkerData();
if (!workerData || (!threadParentPort && !utilityParentPort)) throw new Error("WORKER_PARENT_UNAVAILABLE");

function postParentMessage(message) {
  (threadParentPort || utilityParentPort).postMessage(message);
}

function onParentMessage(listener) {
  if (threadParentPort) {
    threadParentPort.on("message", listener);
    return;
  }
  utilityParentPort.on("message", (event) => listener(
    event && typeof event === "object" && Object.hasOwn(event, "data") ? event.data : event,
  ));
}

const DEFAULT_MODEL_FINGERPRINT = BUILTIN_MODEL_FINGERPRINT;
const MAX_INPUT_PIXELS = 50_000_000;
const MAX_BUFFERED_SOURCE_BYTES = 32 * 1024 * 1024;
const FILE_CHUNK_SIZE = 8;
const INDEX_INFERENCE_BATCH_SIZE = 16;
const GPU_BATCH_SIZES = Object.freeze([16, 8, 4, 1]);
const CPU_INDEX_BATCH_SIZE = 16;
const MAX_EXECUTION_PROFILE_RESTARTS = 1;
const TRANSACTION_SIZE = 256;
const ASSET_SORTS = Object.freeze({
  "path-asc": "normalized_path COLLATE NOCASE ASC, i.id ASC",
  "modified-desc": "i.mtime_ms DESC, i.id DESC",
  "modified-asc": "i.mtime_ms ASC, i.id ASC",
  "size-desc": "i.size_bytes DESC, i.id DESC",
});
const PROGRESS_EMIT_INTERVAL_MS = 250;
const MAX_VECTOR_CACHE_BYTES = 300 * 1024 * 1024;
const ORT_VERSION = "1.24.3";
const SCAN_COMPLETE_TOKEN = Symbol("local-image-scan-complete");
const logicalCpus = Math.max(1, availableParallelism());
const CPU_INTRA_OP_THREADS = Math.max(1, Math.min(6, logicalCpus - 2));
const PREPROCESS_CONCURRENCY = Math.max(2, Math.min(8, logicalCpus - 2));
const SCAN_STAT_CONCURRENCY = Math.max(8, Math.min(32, logicalCpus * 2));
const SHARP_CONCURRENCY = Math.max(2, Math.min(4, logicalCpus - 2));

sharp.concurrency(SHARP_CONCURRENCY);

const db = new DatabaseSync(workerData.dbPath);
db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
const modernSchema = Boolean(db.prepare(`
  SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'image_embeddings'
`).get());
const stagingSchema = Boolean(db.prepare(`
  SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'index_staging_jobs'
`).get());
const canceledJobs = new Set();
const activeOrQueuedJobs = new Set();
const sessionStates = new Map();
const progressEmissionTimes = new Map();
let activeCache = null;
let indexTail = Promise.resolve();
let requestTail = Promise.resolve();
let builtinPreprocessLutCache = null;

function modelPath(model, relativePath) {
  return path.join(workerData.modelRoot, model, ...relativePath.split("/"));
}

function triple(value, fallback) {
  return Array.isArray(value) && value.length === 3 && value.every(Number.isFinite)
    ? value.map(Number)
    : [...fallback];
}

function boundedInteger(value, fallback, minimum, maximum) {
  const number = Number(value);
  return Number.isInteger(number) && number >= minimum && number <= maximum ? number : fallback;
}

function externalDataFiles(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((item) => item && typeof item.path === "string"
    && path.basename(item.path) === item.path
    && path.posix.basename(item.path) === item.path
    && typeof item.data === "string" && path.isAbsolute(item.data))
    .map((item) => ({ path: item.path, data: item.data }));
}

function resolveModelConfig(payload = {}) {
  const raw = payload.modelConfig && typeof payload.modelConfig === "object" ? payload.modelConfig : {};
  const rawVision = raw.vision && typeof raw.vision === "object" ? raw.vision : {};
  const rawText = raw.text && typeof raw.text === "object" ? raw.text : null;
  const id = String(raw.id || payload.modelId || LOCAL_IMAGE_SEARCH_VERSION);
  const isBuiltinDefault = id === LOCAL_IMAGE_SEARCH_VERSION;
  const width = boundedInteger(rawVision.width, 224, 8, 4096);
  const height = boundedInteger(rawVision.height, 224, 8, 4096);
  if (width * height > 16_777_216) throw new Error("MODEL_INPUT_PIXELS_INVALID");
  const dimensions = boundedInteger(raw.dimensions, isBuiltinDefault ? EMBEDDING_DIMENSIONS : 0, 16, 4_096);
  if (!dimensions) throw new Error("MODEL_DIMENSIONS_INVALID");
  const kind = raw.kind === "image" ? "image" : "image-text";
  const vision = {
    modelPath: String(rawVision.modelPath || modelPath(
      "vision",
      isBuiltinDefault ? "onnx/vision_model_q4f16.onnx" : "onnx/vision_model_quantized.onnx",
    )),
    inputName: rawVision.inputName ? String(rawVision.inputName) : null,
    outputName: rawVision.outputName ? String(rawVision.outputName) : "image_embeds",
    pixelType: ["float32", "uint8", "int8"].includes(rawVision.pixelType) ? rawVision.pixelType : "float32",
    layout: rawVision.layout === "NHWC" ? "NHWC" : "NCHW",
    width,
    height,
    colorOrder: (rawVision.colorSpace || rawVision.colorOrder) === "BGR" ? "BGR" : "RGB",
    resizeMode: ["crop", "fit", "stretch", "cover", "contain"].includes(rawVision.resizeMode)
      ? rawVision.resizeMode
      : "crop",
    cropMode: rawVision.cropMode === "none" ? "none" : "center",
    scale: Number.isFinite(rawVision.scale) ? Number(rawVision.scale) : 1 / 255,
    mean: triple(rawVision.mean, isBuiltinDefault ? [0.48145466, 0.4578275, 0.40821073] : [0, 0, 0]),
    std: triple(rawVision.std, isBuiltinDefault ? [0.26862954, 0.26130258, 0.27577711] : [1, 1, 1])
      .map((number) => number || 1),
    normalizeOutput: rawVision.normalizeOutput !== false,
    externalData: externalDataFiles(rawVision.externalData),
  };
  const supportsText = Boolean(raw.supportsText ?? (kind === "image-text" && (rawText || isBuiltinDefault)));
  const text = supportsText ? {
    modelPath: String(rawText?.modelPath || modelPath("text", "onnx/model_quantized.onnx")),
    modelRoot: String(rawText?.modelRoot || path.join(workerData.modelRoot, "text")),
    tokenizerRoot: String(rawText?.tokenizerRoot || rawText?.modelRoot || path.join(workerData.modelRoot, "text")),
    outputName: rawText?.outputName ? String(rawText.outputName) : "sentence_embedding",
    inputName: rawText?.inputName ? String(rawText.inputName) : "input_ids",
    inputNames: Array.isArray(rawText?.inputNames) ? rawText.inputNames.map(String) : null,
    normalizeOutput: rawText?.normalizeOutput !== false,
    externalData: externalDataFiles(rawText?.externalData),
  } : null;
  return {
    id,
    fingerprint: String(raw.fingerprint || (isBuiltinDefault ? DEFAULT_MODEL_FINGERPRINT : "legacy-custom")),
    dimensions,
    kind,
    supportsText,
    builtin: Boolean(raw.builtin ?? isBuiltinDefault),
    legacyCompatibility: raw.legacyCompatibility === true,
    preprocessingVersion: String(raw.preprocessingVersion || raw.indexProfile || "1"),
    vision,
    text,
  };
}

function modelKey(model) {
  return `${model.id}:${model.fingerprint}`;
}

function getSessionState(model, requestProbe) {
  const key = modelKey(model);
  let state = sessionStates.get(key);
  if (!state) {
    const probe = requestProbe || workerData.directmlProbe || {};
    const preferredProvider = probe.preferredProvider || workerData.preferredProvider || "cpu";
    const legacyCpuOnly = model.legacyCompatibility === true;
    state = {
      model,
      cpuVision: null,
      cpuText: null,
      tokenizer: null,
      gpuVision: null,
      gpuAttempted: false,
      gpuDisabled: legacyCpuOnly || preferredProvider !== "dml",
      visionProvider: !legacyCpuOnly && preferredProvider === "dml" ? "dml" : "cpu",
      textProvider: "cpu",
      deviceId: Number.isInteger(probe.deviceId) ? probe.deviceId : 0,
      deviceName: probe.deviceName || null,
      batchSize: legacyCpuOnly ? 1 : preferredProvider === "dml" && GPU_BATCH_SIZES.includes(Number(probe.batchSize))
        ? Number(probe.batchSize)
        : CPU_INDEX_BATCH_SIZE,
      fallbackReason: legacyCpuOnly ? "LEGACY_MODEL_CPU_ONLY" : probe.fallbackReason || null,
      driverFingerprint: String(probe.driverFingerprint || "unknown"),
      probeDiagnostics: Array.isArray(probe.probeDiagnostics) ? probe.probeDiagnostics : [],
    };
    sessionStates.set(key, state);
  } else if (requestProbe && !state.gpuAttempted) {
    const legacyCpuOnly = model.legacyCompatibility === true;
    state.gpuDisabled = legacyCpuOnly || requestProbe.preferredProvider !== "dml";
    state.visionProvider = !legacyCpuOnly && requestProbe.preferredProvider === "dml" ? "dml" : "cpu";
    state.deviceId = Number.isInteger(requestProbe.deviceId) ? requestProbe.deviceId : 0;
    state.deviceName = requestProbe.deviceName || null;
    state.batchSize = legacyCpuOnly ? 1 : requestProbe.preferredProvider === "dml"
      && GPU_BATCH_SIZES.includes(Number(requestProbe.batchSize))
      ? Number(requestProbe.batchSize)
      : CPU_INDEX_BATCH_SIZE;
    state.fallbackReason = legacyCpuOnly ? "LEGACY_MODEL_CPU_ONLY" : requestProbe.fallbackReason || null;
    state.driverFingerprint = String(requestProbe.driverFingerprint || "unknown");
    state.probeDiagnostics = requestProbe.probeDiagnostics || [];
  }
  return state;
}

async function releaseState(state) {
  for (const session of [state.cpuVision, state.cpuText, state.gpuVision]) {
    try {
      await session?.release();
    } catch {
      // Releasing an inactive provider is best-effort; the new model must still be usable.
    }
  }
  state.cpuVision = null;
  state.cpuText = null;
  state.gpuVision = null;
  state.tokenizer = null;
}

async function activateSessionState(model, requestProbe) {
  const key = modelKey(model);
  for (const [existingKey, state] of sessionStates) {
    if (existingKey === key) continue;
    await releaseState(state);
    sessionStates.delete(existingKey);
  }
  return getSessionState(model, requestProbe);
}

function cpuSessionOptions(externalData = []) {
  return {
    executionProviders: ["cpu"],
    graphOptimizationLevel: "basic",
    executionMode: "sequential",
    intraOpNumThreads: CPU_INTRA_OP_THREADS,
    interOpNumThreads: 1,
    ...(externalData.length ? { externalData } : {}),
  };
}

function directmlSessionOptions(deviceId, externalData = []) {
  return {
    executionProviders: [{ name: "dml", deviceId }],
    graphOptimizationLevel: "basic",
    executionMode: "sequential",
    enableMemPattern: false,
    ...(externalData.length ? { externalData } : {}),
  };
}

async function loadCpuVision(state) {
  if (!state.cpuVision) {
    state.cpuVision = await ort.InferenceSession.create(
      state.model.vision.modelPath,
      cpuSessionOptions(state.model.vision.externalData),
    );
  }
  return state.cpuVision;
}

async function loadGpuVision(state) {
  if (state.gpuDisabled) throw new Error(state.fallbackReason || "DIRECTML_DISABLED");
  state.gpuAttempted = true;
  if (!state.gpuVision) {
    try {
      state.gpuVision = await ort.InferenceSession.create(
        state.model.vision.modelPath,
        directmlSessionOptions(state.deviceId, state.model.vision.externalData),
      );
    } catch (error) {
      state.gpuDisabled = true;
      state.visionProvider = "cpu";
      state.batchSize = CPU_INDEX_BATCH_SIZE;
      state.fallbackReason = `DIRECTML_SESSION_FAILED:${shortError(error)}`;
      throw error;
    }
  }
  return state.gpuVision;
}

async function loadText(state) {
  if (!state.model.supportsText || !state.model.text) throw new Error("MODEL_TEXT_UNSUPPORTED");
  if (!state.cpuText) {
    state.cpuText = await ort.InferenceSession.create(
      state.model.text.modelPath,
      cpuSessionOptions(state.model.text.externalData),
    );
  }
  if (!state.tokenizer) {
    state.tokenizer = await AutoTokenizer.from_pretrained(state.model.text.tokenizerRoot, { local_files_only: true });
  }
  return { text: state.cpuText, tokenizer: state.tokenizer };
}

function normalizeVector(input, dimensions, shouldNormalize = true) {
  const source = input instanceof Float32Array ? input : Float32Array.from(input);
  if (source.length !== dimensions) throw new Error("EMBEDDING_DIMENSION_INVALID");
  const output = new Float32Array(source);
  if (!shouldNormalize) return output;
  let squared = 0;
  for (let index = 0; index < output.length; index += 1) squared += output[index] * output[index];
  const scale = Math.sqrt(squared) || 1;
  for (let index = 0; index < output.length; index += 1) output[index] /= scale;
  return output;
}

function outputData(outputs, preferredName, expectedLength) {
  if (preferredName && outputs[preferredName]?.data?.length === expectedLength) return outputs[preferredName].data;
  for (const output of Object.values(outputs)) {
    if (output?.data?.length === expectedLength) return output.data;
  }
  throw new Error("MODEL_OUTPUT_INVALID");
}

function resizeOptions(vision) {
  if (vision.resizeMode === "stretch") return { fit: "fill" };
  if (["fit", "contain"].includes(vision.resizeMode) || vision.cropMode === "none") {
    return { fit: "contain", position: "centre", background: { r: 0, g: 0, b: 0 } };
  }
  return { fit: "cover", position: "centre" };
}

function builtinFloatNchwLuts(model) {
  if (!model.builtin || model.vision.pixelType !== "float32" || model.vision.layout !== "NCHW") return null;
  const key = JSON.stringify({
    fingerprint: model.fingerprint,
    colorOrder: model.vision.colorOrder,
    scale: model.vision.scale,
    mean: model.vision.mean,
    std: model.vision.std,
  });
  if (builtinPreprocessLutCache?.key === key) return builtinPreprocessLutCache.value;
  const sourceChannels = model.vision.colorOrder === "BGR" ? [2, 1, 0] : [0, 1, 2];
  const luts = Array.from({ length: 3 }, (_, channel) => {
    const lut = new Float32Array(256);
    for (let raw = 0; raw < 256; raw += 1) {
      lut[raw] = (raw * model.vision.scale - model.vision.mean[channel]) / model.vision.std[channel];
    }
    return lut;
  });
  const value = { sourceChannels, luts };
  builtinPreprocessLutCache = { key, value };
  return value;
}

function pixelsToModelInput(data, pixelCount, model) {
  const fast = builtinFloatNchwLuts(model);
  if (fast) {
    const input = new Float32Array(pixelCount * 3);
    const [source0, source1, source2] = fast.sourceChannels;
    const [lut0, lut1, lut2] = fast.luts;
    const plane1 = pixelCount;
    const plane2 = pixelCount * 2;
    for (let pixel = 0, source = 0; pixel < pixelCount; pixel += 1, source += 3) {
      input[pixel] = lut0[data[source + source0]];
      input[plane1 + pixel] = lut1[data[source + source1]];
      input[plane2 + pixel] = lut2[data[source + source2]];
    }
    return input;
  }

  const input = model.vision.pixelType === "uint8"
    ? new Uint8Array(pixelCount * 3)
    : model.vision.pixelType === "int8"
      ? new Int8Array(pixelCount * 3)
      : new Float32Array(pixelCount * 3);
  const channelOrder = model.vision.colorOrder === "BGR" ? [2, 1, 0] : [0, 1, 2];
  const isNhwc = model.vision.layout === "NHWC";
  const isUint8 = model.vision.pixelType === "uint8";
  const isInt8 = model.vision.pixelType === "int8";
  for (let pixel = 0; pixel < pixelCount; pixel += 1) {
    for (let channel = 0; channel < 3; channel += 1) {
      const raw = data[pixel * 3 + channelOrder[channel]];
      const transformed = (raw * model.vision.scale - model.vision.mean[channel]) / model.vision.std[channel];
      const offset = isNhwc ? pixel * 3 + channel : channel * pixelCount + pixel;
      input[offset] = isUint8
        ? Math.max(0, Math.min(255, Math.round(transformed)))
        : isInt8
          ? Math.max(-128, Math.min(127, Math.round(transformed)))
          : transformed;
    }
  }
  return input;
}

async function preprocessCandidate(candidate, model) {
  const source = candidate.bytes || candidate.absolutePath;
  const pipeline = sharp(source, { pages: 1, limitInputPixels: MAX_INPUT_PIXELS, animated: false });
  const metadata = candidate.knownMetadata || await pipeline.metadata();
  const { data, info } = await pipeline
    .rotate()
    .removeAlpha()
    .toColourspace("srgb")
    .resize(model.vision.width, model.vision.height, resizeOptions(model.vision))
    .raw()
    .toBuffer({ resolveWithObject: true });
  candidate.bytes = null;
  if (info.channels !== 3) throw new Error("IMAGE_CHANNELS_INVALID");
  const pixelCount = model.vision.width * model.vision.height;
  const input = pixelsToModelInput(data, pixelCount, model);
  return {
    candidate,
    input,
    metadata: {
      format: metadata.format || path.extname(candidate.relativePath).slice(1),
      width: metadata.width || null,
      height: metadata.height || null,
    },
  };
}

function inputDimensions(model, batchSize) {
  return model.vision.layout === "NHWC"
    ? [batchSize, model.vision.height, model.vision.width, 3]
    : [batchSize, 3, model.vision.height, model.vision.width];
}

function ortArrayType(pixelType, length) {
  if (pixelType === "uint8") return new Uint8Array(length);
  if (pixelType === "int8") return new Int8Array(length);
  return new Float32Array(length);
}

async function runVisionBatch(session, prepared, model, { padTo = prepared.length } = {}) {
  if (!prepared.length) return [];
  const batchSize = Math.max(prepared.length, padTo);
  const valuesPerImage = prepared[0].input.length;
  const combined = ortArrayType(model.vision.pixelType, batchSize * valuesPerImage);
  for (let index = 0; index < batchSize; index += 1) {
    const source = prepared[Math.min(index, prepared.length - 1)].input;
    combined.set(source, index * valuesPerImage);
  }
  const inputName = model.vision.inputName
    || (session.inputNames.includes("pixel_values") ? "pixel_values" : session.inputNames[0]);
  const outputs = await session.run({
    [inputName]: new ort.Tensor(model.vision.pixelType, combined, inputDimensions(model, batchSize)),
  });
  const data = outputData(outputs, model.vision.outputName, batchSize * model.dimensions);
  const vectors = [];
  for (let index = 0; index < prepared.length; index += 1) {
    const start = index * model.dimensions;
    vectors.push(normalizeVector(
      data.subarray ? data.subarray(start, start + model.dimensions) : Array.from(data).slice(start, start + model.dimensions),
      model.dimensions,
      model.vision.normalizeOutput,
    ));
  }
  return vectors;
}

async function inferChunks(session, prepared, model, batchSize, padTail) {
  const vectors = [];
  for (let offset = 0; offset < prepared.length; offset += batchSize) {
    const chunk = prepared.slice(offset, offset + batchSize);
    vectors.push(...await runVisionBatch(session, chunk, model, { padTo: padTail ? batchSize : chunk.length }));
  }
  return vectors;
}

async function inferCpuWithIsolation(state, prepared) {
  const session = await loadCpuVision(state);
  const requestedBatchSize = state.batchSize === 1 ? 1 : CPU_INDEX_BATCH_SIZE;
  state.visionProvider = "cpu";
  try {
    const vectors = await inferChunks(session, prepared, state.model, requestedBatchSize, true);
    state.batchSize = requestedBatchSize;
    return vectors.map((vector) => ({ vector, error: null }));
  } catch (batchError) {
    if (requestedBatchSize !== 1) {
      state.batchSize = 1;
      state.fallbackReason = `CPU_BATCH_${requestedBatchSize}_FAILED:${shortError(batchError)}`;
      try {
        const vectors = await inferChunks(session, prepared, state.model, 1, true);
        return vectors.map((vector) => ({ vector, error: null }));
      } catch {
        // Isolate the failing image below while retaining the cpu:1 execution profile.
      }
    }
    const results = [];
    state.batchSize = 1;
    for (const item of prepared) {
      try {
        const [vector] = await runVisionBatch(session, [item], state.model, { padTo: 1 });
        results.push({ vector, error: null });
      } catch (error) {
        results.push({ vector: null, error });
      }
    }
    return results;
  }
}

async function inferIndexBatch(state, prepared) {
  if (!prepared.length) return [];
  if (!state.gpuDisabled) {
    try {
      const session = await loadGpuVision(state);
      const startIndex = Math.max(0, GPU_BATCH_SIZES.indexOf(state.batchSize));
      for (let index = startIndex; index < GPU_BATCH_SIZES.length; index += 1) {
        const batchSize = GPU_BATCH_SIZES[index];
        try {
          const vectors = await inferChunks(session, prepared, state.model, batchSize, true);
          state.batchSize = batchSize;
          state.visionProvider = "dml";
          return vectors.map((vector) => ({ vector, error: null }));
        } catch (error) {
          state.fallbackReason = `DIRECTML_BATCH_${batchSize}_FAILED:${shortError(error)}`;
        }
      }
    } catch {
      // loadGpuVision records the diagnostic and the CPU path below replays the batch.
    }
    state.gpuDisabled = true;
    state.visionProvider = "cpu";
    state.batchSize = CPU_INDEX_BATCH_SIZE;
    try {
      await state.gpuVision?.release();
    } catch {
      // The CPU replay remains available even if the failed DML session cannot release cleanly.
    }
    state.gpuVision = null;
  }
  return inferCpuWithIsolation(state, prepared);
}

function toOrtTensor(tensor) {
  const type = tensor.type === "int64" ? "int64" : tensor.type;
  return new ort.Tensor(type, tensor.data, tensor.dims);
}

function inputMetadata(session, name) {
  if (Array.isArray(session.inputMetadata)) {
    return session.inputMetadata.find((metadata) => metadata?.name === name) || null;
  }
  return session.inputMetadata?.[name] || null;
}

function zeroTokenizerTensor(reference, session, name) {
  const type = inputMetadata(session, name)?.type || reference.type || "int64";
  const length = Number(reference.data?.length || 0);
  let data;
  if (type === "int64") data = new BigInt64Array(length);
  else if (type === "int32") data = new Int32Array(length);
  else if (type === "bool") data = new Uint8Array(length);
  else throw new Error(`MODEL_TEXT_INPUT_TYPE_UNSUPPORTED:${name}`);
  return { type, data, dims: reference.dims };
}

function convertTokenizerTensor(tensor, session, name) {
  const type = inputMetadata(session, name)?.type || tensor.type;
  if (type === tensor.type) return tensor;
  const numbers = Array.from(tensor.data, (value) => Number(value));
  let data;
  if (type === "int64") data = BigInt64Array.from(numbers, (value) => BigInt(Math.trunc(value)));
  else if (type === "int32") data = Int32Array.from(numbers);
  else if (type === "uint32") data = Uint32Array.from(numbers);
  else if (type === "float32") data = Float32Array.from(numbers);
  else if (type === "bool") data = Uint8Array.from(numbers, (value) => value ? 1 : 0);
  else throw new Error(`MODEL_TEXT_INPUT_TYPE_UNSUPPORTED:${name}`);
  return { type, data, dims: tensor.dims };
}

async function embedText(text, state) {
  const loaded = await loadText(state);
  const encoded = await loaded.tokenizer(text, { truncation: true, max_length: 128 });
  const feeds = {};
  const inputIds = encoded.input_ids;
  for (const name of loaded.text.inputNames) {
    let tensor = encoded[name];
    if (!tensor && name === state.model.text.inputName) tensor = inputIds;
    if (!tensor && /token_type/i.test(name) && inputIds) {
      tensor = zeroTokenizerTensor(inputIds, loaded.text, name);
    }
    if (!tensor) throw new Error(`MODEL_TEXT_INPUT_MISSING:${name}`);
    feeds[name] = toOrtTensor(convertTokenizerTensor(tensor, loaded.text, name));
  }
  const outputs = await loaded.text.run(feeds);
  return normalizeVector(
    outputData(outputs, state.model.text.outputName, state.model.dimensions),
    state.model.dimensions,
    state.model.text.normalizeOutput,
  );
}

async function embedImageBytes(bytes, state) {
  const prepared = await preprocessCandidate({
    bytes,
    absolutePath: null,
    relativePath: "query-image",
    knownMetadata: null,
  }, state.model);
  const session = await loadCpuVision(state);
  const [vector] = await runVisionBatch(session, [prepared], state.model);
  return vector;
}

function shortError(error) {
  return String(error?.code || error?.message || error?.name || "FAILED")
    .replace(/[\r\n]+/g, " ")
    .slice(0, 96);
}

async function sha256File(filePath, jobId) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) {
    if (canceledJobs.has(jobId)) throw new Error("INDEX_CANCELED");
    hash.update(chunk);
  }
  return hash.digest("hex");
}

function scanIncomplete(error) {
  const wrapped = new Error("INDEX_SCAN_INCOMPLETE", { cause: error });
  wrapped.code = "INDEX_SCAN_INCOMPLETE";
  return wrapped;
}

function canonicalDirectoryKey(directoryPath) {
  const resolved = path.resolve(directoryPath).replace(/^\\\\\?\\/, "");
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

async function* walkImages(rootPath) {
  let canonicalRoot;
  try {
    canonicalRoot = await realpath(rootPath);
  } catch (error) {
    throw scanIncomplete(error);
  }
  const visited = new Set();
  const visit = async function* (segments) {
    const directoryPath = path.join(canonicalRoot, ...segments);
    let canonicalDirectory;
    let directory;
    try {
      if (segments.join("/") === workerData.testScanFailurePrefix) {
        const injected = new Error("EACCES");
        injected.code = "EACCES";
        throw injected;
      }
      canonicalDirectory = await realpath(directoryPath);
      const relativeCanonical = path.relative(canonicalRoot, canonicalDirectory);
      if (relativeCanonical.startsWith("..") || path.isAbsolute(relativeCanonical)) {
        yield { kind: "skipped", reason: "REPARSE_POINT" };
        return;
      }
      // A normal directory resolves to itself. A different target means a Windows junction,
      // mount/reparse point, or another alias; all are skipped even when they happen to point
      // back inside the library so traversal cannot loop or escape its lexical root.
      if (segments.length && canonicalDirectoryKey(canonicalDirectory) !== canonicalDirectoryKey(directoryPath)) {
        yield { kind: "skipped", reason: "REPARSE_POINT" };
        return;
      }
      const canonicalKey = canonicalDirectoryKey(canonicalDirectory);
      if (visited.has(canonicalKey)) {
        yield { kind: "skipped", reason: "REPARSE_POINT" };
        return;
      }
      visited.add(canonicalKey);
      directory = await opendir(canonicalDirectory);
    } catch (error) {
      throw scanIncomplete(error);
    }
    const entries = [];
    try {
      for await (const entry of directory) entries.push(entry);
    } catch (error) {
      throw scanIncomplete(error);
    }
    const inspectedEntries = await mapLimit(entries, SCAN_STAT_CONCURRENCY, async (entry) => {
      const childSegments = [...segments, entry.name];
      const childPath = path.join(canonicalDirectory, entry.name);
      try {
        return { entry, childSegments, linkInfo: await lstat(childPath) };
      } catch (error) {
        throw scanIncomplete(error);
      }
    });
    for (const { entry, childSegments, linkInfo } of inspectedEntries) {
      if (linkInfo.isSymbolicLink() || entry.isSymbolicLink()) {
        yield { kind: "skipped", reason: "REPARSE_POINT" };
        continue;
      }
      if (entry.isDirectory()) yield* visit(childSegments);
      else if (entry.isFile() && SUPPORTED_IMAGE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        yield { kind: "image", relativePath: childSegments.join("/"), fileInfo: linkInfo };
      } else if (entry.isFile()) {
        yield { kind: "skipped", reason: "UNSUPPORTED_FORMAT" };
      }
    }
  };
  yield* visit([]);
}

async function mapLimit(items, limit, mapper) {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await mapper(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

function embeddingValid(value, dimensions) {
  return value != null && Buffer.from(value).byteLength === dimensions * Float32Array.BYTES_PER_ELEMENT;
}

function vectorBuffer(vector) {
  return Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);
}

function createIndexQueries(model) {
  if (!modernSchema) {
    if (model.id !== LOCAL_IMAGE_SEARCH_VERSION || model.dimensions !== EMBEDDING_DIMENSIONS) {
      throw new Error("MULTI_MODEL_SCHEMA_REQUIRED");
    }
    return {
      existing: db.prepare(`
        SELECT *, length(embedding) AS model_embedding_bytes
        FROM images WHERE library_id = ? AND relative_path = ?
      `),
      duplicate: db.prepare(`
        SELECT embedding, width, height, format FROM images
        WHERE library_id = ? AND sha256 = ? AND embedding IS NOT NULL LIMIT 1
      `),
      markReused: db.prepare("UPDATE images SET scan_generation = ? WHERE id = ?"),
      upsertLegacy: db.prepare(`
        INSERT INTO images(library_id, relative_path, mtime_ms, size_bytes, sha256, format, width, height, embedding, scan_generation, error_code)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(library_id, relative_path) DO UPDATE SET
          mtime_ms=excluded.mtime_ms, size_bytes=excluded.size_bytes, sha256=excluded.sha256,
          format=excluded.format, width=excluded.width, height=excluded.height,
          embedding=excluded.embedding, scan_generation=excluded.scan_generation, error_code=excluded.error_code
      `),
    };
  }
  return {
    existing: db.prepare(`
      SELECT i.id, i.library_id, i.relative_path, i.mtime_ms, i.size_bytes,
        i.sha256, i.format, i.width, i.height, i.scan_generation,
        length(e.embedding) AS model_embedding_bytes, e.error_code AS model_error_code
      FROM images i
      LEFT JOIN image_embeddings e
        ON e.library_id = i.library_id AND e.image_id = i.id
       AND e.model_id = ? AND e.model_fingerprint = ?
      WHERE i.library_id = ? AND i.relative_path = ?
    `),
    duplicate: db.prepare(`
      SELECT e.embedding, i.width, i.height, i.format
      FROM images i INDEXED BY images_content_idx
      CROSS JOIN image_embeddings e
      WHERE i.library_id = ? AND i.sha256 = ?
        AND e.library_id = i.library_id AND e.image_id = i.id
        AND e.model_id = ? AND e.model_fingerprint = ? AND e.embedding IS NOT NULL
      LIMIT 1
    `),
    stagedDuplicate: db.prepare(`
      SELECT embedding, width, height, format
      FROM index_staging_images INDEXED BY index_staging_images_sha_idx
      WHERE job_id=? AND sha256=? AND embedding IS NOT NULL
      LIMIT 1
    `),
    upsertStage: db.prepare(`
      INSERT INTO index_staging_images(
        job_id, relative_path, mtime_ms, size_bytes, sha256, format, width, height,
        error_code, file_changed, embedding_changed, embedding
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(job_id, relative_path) DO UPDATE SET
        mtime_ms=excluded.mtime_ms,
        size_bytes=excluded.size_bytes,
        sha256=excluded.sha256,
        format=excluded.format,
        width=excluded.width,
        height=excluded.height,
        error_code=excluded.error_code,
        file_changed=excluded.file_changed,
        embedding_changed=excluded.embedding_changed,
        embedding=excluded.embedding
    `),
  };
}

function queryExisting(queries, model, libraryId, relativePath) {
  return modernSchema
    ? queries.existing.get(model.id, model.fingerprint, libraryId, relativePath)
    : queries.existing.get(libraryId, relativePath);
}

function queryDuplicate(queries, model, libraryId, digest, { jobId, profileRebuilt }) {
  if (!modernSchema) return queries.duplicate.get(libraryId, digest);
  const staged = queries.stagedDuplicate.get(jobId, digest);
  if (staged && embeddingValid(staged.embedding, model.dimensions)) return staged;
  if (profileRebuilt) return null;
  return queries.duplicate.get(libraryId, digest, model.id, model.fingerprint);
}

async function inspectCandidate({ relativePath, scannedFileInfo, library, model, queries, jobId, profileRebuilt }) {
  const absolutePath = path.join(library.root_path, relativePath);
  let fileInfo = scannedFileInfo || null;
  let existing;
  try {
    if (!fileInfo) fileInfo = await stat(absolutePath);
    existing = queryExisting(queries, model, library.id, relativePath);
    const fileUnchanged = Boolean(existing
      && Number(existing.mtime_ms) === fileInfo.mtimeMs
      && Number(existing.size_bytes) === fileInfo.size);
    const embeddingBytes = Number(existing?.model_embedding_bytes || 0);
    if (!profileRebuilt && fileUnchanged && embeddingBytes === model.dimensions * Float32Array.BYTES_PER_ELEMENT) {
      return { kind: "unchanged", existing, relativePath, absolutePath, fileInfo, fileUnchanged };
    }

    let bytes = null;
    let digest = fileUnchanged ? existing?.sha256 : null;
    if (!digest && fileInfo.size <= MAX_BUFFERED_SOURCE_BYTES) {
      bytes = await readFile(absolutePath);
      digest = createHash("sha256").update(bytes).digest("hex");
    } else if (!digest) {
      digest = await sha256File(absolutePath, jobId);
    }
    if (canceledJobs.has(jobId)) throw new Error("INDEX_CANCELED");

    const duplicate = queryDuplicate(queries, model, library.id, digest, { jobId, profileRebuilt });
    if (duplicate && embeddingValid(duplicate.embedding, model.dimensions)) {
      return {
        kind: "duplicate", existing, relativePath, absolutePath, fileInfo, fileUnchanged, digest, bytes: null,
        embedding: duplicate.embedding,
        metadata: {
          format: duplicate.format || existing?.format || path.extname(relativePath).slice(1),
          width: duplicate.width || existing?.width || null,
          height: duplicate.height || existing?.height || null,
        },
      };
    }
    return {
      kind: "inference",
      existing,
      relativePath,
      absolutePath,
      fileInfo,
      fileUnchanged,
      digest,
      bytes,
      knownMetadata: fileUnchanged && existing?.width && existing?.height ? {
        format: existing.format,
        width: existing.width,
        height: existing.height,
      } : null,
    };
  } catch (error) {
    return {
      kind: "error",
      existing,
      relativePath,
      absolutePath,
      fileInfo: fileInfo || { mtimeMs: 0, size: 0 },
      fileUnchanged: false,
      digest: null,
      error,
    };
  }
}

function emitProgress(jobId, progress, { force = false } = {}) {
  const now = performance.now();
  const lastEmission = progressEmissionTimes.get(jobId) || 0;
  if (!force && now - lastEmission < PROGRESS_EMIT_INTERVAL_MS) return false;
  progressEmissionTimes.set(jobId, now);
  postParentMessage({ type: "progress", jobId, progress });
  return true;
}

function runtimeFields(state) {
  return {
    executionProvider: state.visionProvider,
    visionProvider: state.visionProvider,
    textProvider: "cpu",
    deviceId: state.visionProvider === "dml" ? state.deviceId : null,
    deviceName: state.visionProvider === "dml" ? state.deviceName : null,
    batchSize: state.batchSize,
    executionProfile: indexExecutionProfile(state),
    fallbackReason: state.fallbackReason || null,
  };
}

function indexExecutionProfile(state) {
  const provider = state.visionProvider === "dml" ? "dml" : "cpu";
  const vision = state.model.vision;
  return createIndexExecutionProfile({
    modelFingerprint: state.model.fingerprint,
    preprocessingVersion: state.model.preprocessingVersion,
    preprocessing: {
      inputName: vision.inputName,
      outputName: vision.outputName,
      pixelType: vision.pixelType,
      layout: vision.layout,
      width: vision.width,
      height: vision.height,
      colorOrder: vision.colorOrder,
      resizeMode: vision.resizeMode,
      cropMode: vision.cropMode,
      scale: vision.scale,
      mean: vision.mean,
      std: vision.std,
      normalizeOutput: vision.normalizeOutput,
    },
    provider,
    batchSize: state.batchSize,
    deviceId: provider === "dml" ? state.deviceId : null,
    driverFingerprint: provider === "dml" ? state.driverFingerprint : null,
    onnxRuntimeVersion: ORT_VERSION,
    architecture: process.arch,
  });
}

function executionProfileChanged(expectedProfile, state, progress) {
  const actualProfile = indexExecutionProfile(state);
  if (actualProfile === expectedProfile) return null;
  const error = new Error("INDEX_EXECUTION_PROFILE_CHANGED");
  error.code = "INDEX_EXECUTION_PROFILE_CHANGED";
  error.expectedProfile = expectedProfile;
  error.actualProfile = actualProfile;
  error.progress = { ...progress, ...runtimeFields(state), executionProfile: actualProfile };
  return error;
}

function refreshRate(progress, analysisStartedAt) {
  const processed = progress.analyzed + progress.reused + progress.skipped + progress.errors;
  const elapsedSeconds = Math.max(0.001, (performance.now() - analysisStartedAt) / 1000);
  progress.imagesPerSecond = Number((processed / elapsedSeconds).toFixed(2));
  const remaining = Math.max(0, progress.total - processed);
  progress.etaSeconds = progress.imagesPerSecond > 0
    ? Math.ceil(remaining / progress.imagesPerSecond)
    : null;
}

function beginIndexState(jobId, library, model, executionProfile) {
  if (!modernSchema || !stagingSchema) throw new Error("INDEX_STAGING_SCHEMA_REQUIRED");
  db.exec("BEGIN IMMEDIATE");
  try {
    const committedLibrary = db.prepare(`
      SELECT scan_generation, catalog_revision FROM libraries WHERE id=?
    `).get(library.id);
    if (!committedLibrary) throw new Error("LIBRARY_NOT_FOUND");
    db.prepare(`
      INSERT OR IGNORE INTO library_models(
        library_id, model_id, model_fingerprint, status, item_count, error_count,
        scan_generation, execution_profile
      ) VALUES (?, ?, ?, 'new', 0, 0, 0, NULL)
    `).run(library.id, model.id, model.fingerprint);
    const committedModel = db.prepare(`
      SELECT scan_generation, execution_profile FROM library_models
      WHERE library_id=? AND model_id=? AND model_fingerprint=?
    `).get(library.id, model.id, model.fingerprint);
    const baseFileGeneration = Number(committedLibrary.scan_generation || 0);
    const baseModelGeneration = Number(committedModel?.scan_generation || 0);
    const baseCatalogRevision = Number(committedLibrary.catalog_revision || 0);
    const fileGeneration = baseFileGeneration + 1;
    const modelGeneration = baseModelGeneration + 1;
    const profileRebuilt = committedModel?.execution_profile !== executionProfile;
    db.prepare(`
      DELETE FROM index_staging_jobs
      WHERE library_id=? AND model_id=? AND model_fingerprint=?
    `).run(library.id, model.id, model.fingerprint);
    db.prepare(`
      INSERT INTO index_staging_jobs(
        job_id, library_id, model_id, model_fingerprint, dimensions,
        base_catalog_revision, base_file_generation, target_file_generation,
        base_model_generation, target_model_generation, execution_profile,
        profile_rebuilt, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      jobId,
      library.id,
      model.id,
      model.fingerprint,
      model.dimensions,
      baseCatalogRevision,
      baseFileGeneration,
      fileGeneration,
      baseModelGeneration,
      modelGeneration,
      executionProfile,
      profileRebuilt ? 1 : 0,
      new Date().toISOString(),
    );
    db.prepare("UPDATE libraries SET status='indexing' WHERE id=?").run(library.id);
    db.prepare(`
      UPDATE library_models SET status='indexing'
      WHERE library_id=? AND model_id=? AND model_fingerprint=?
    `).run(library.id, model.id, model.fingerprint);
    db.exec("COMMIT");
    return {
      jobId,
      fileGeneration,
      modelGeneration,
      executionProfile,
      profileRebuilt,
      baseCatalogRevision,
      baseFileGeneration,
      baseModelGeneration,
    };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function createWriter({ jobId, model, queries, profileRebuilt }) {
  const pending = [];
  let stagedRows = 0;
  const applyWrite = ({ candidate, embedding, metadata, error, embeddingChanged }) => {
    if (profileRebuilt && !embeddingChanged) throw new Error("INDEX_PROFILE_REUSE_INVALID");
    const existing = candidate.existing || null;
    const errorCode = error ? shortError(error) : null;
    queries.upsertStage.run(
      jobId,
      candidate.relativePath,
      Number(candidate.fileInfo?.mtimeMs || existing?.mtime_ms || 0),
      Number(candidate.fileInfo?.size || existing?.size_bytes || 0),
      candidate.digest || existing?.sha256 || null,
      metadata?.format || existing?.format || path.extname(candidate.relativePath).slice(1) || null,
      metadata?.width ?? existing?.width ?? null,
      metadata?.height ?? existing?.height ?? null,
      errorCode,
      (!existing || !candidate.fileUnchanged) ? 1 : 0,
      embeddingChanged ? 1 : 0,
      embedding ? vectorBuffer(embedding) : null,
    );
  };
  const flush = () => {
    if (!pending.length) return;
    const operations = pending.splice(0, pending.length);
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const operation of operations) applyWrite(operation);
      db.exec("COMMIT");
      stagedRows += operations.length;
      if (workerData.testPauseAfterStagedRows && stagedRows >= workerData.testPauseAfterStagedRows) {
        canceledJobs.add(jobId);
      }
    } catch (error) {
      db.exec("ROLLBACK");
      pending.unshift(...operations);
      throw error;
    }
  };
  const enqueue = (operation) => {
    pending.push(operation);
    if (pending.length >= TRANSACTION_SIZE) flush();
  };
  const write = (candidate, embedding, metadata, error) => enqueue({
    candidate, embedding, metadata, error, embeddingChanged: true,
  });
  const markReused = (candidate) => enqueue({
    candidate, embedding: null, metadata: null, error: null, embeddingChanged: false,
  });
  const rollback = () => { pending.length = 0; };
  return { write, markReused, flush, flushReused: () => {}, rollback };
}

function pauseIndex(jobId, libraryId, model) {
  db.exec("BEGIN IMMEDIATE");
  try {
    if (jobId) {
      db.prepare(`
        DELETE FROM index_staging_jobs
        WHERE job_id=? AND library_id=? AND model_id=? AND model_fingerprint=?
      `).run(jobId, libraryId, model.id, model.fingerprint);
    }
    db.prepare("UPDATE libraries SET status='paused', catalog_status='paused' WHERE id=?").run(libraryId);
    if (modernSchema) {
      db.prepare(`
        UPDATE library_models SET status='paused'
        WHERE library_id=? AND model_id=? AND model_fingerprint=?
      `).run(libraryId, model.id, model.fingerprint);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function stagingStaleError() {
  const error = new Error("INDEX_STAGING_STALE");
  error.code = "INDEX_STAGING_STALE";
  return error;
}

function finishIndex({ jobId, libraryId, model, fileGeneration, modelGeneration, executionProfile, scanCompleteToken }) {
  if (scanCompleteToken !== SCAN_COMPLETE_TOKEN) {
    const error = new Error("INDEX_SCAN_INCOMPLETE");
    error.code = "INDEX_SCAN_INCOMPLETE";
    throw error;
  }
  db.exec("BEGIN IMMEDIATE");
  try {
    const job = db.prepare("SELECT * FROM index_staging_jobs WHERE job_id=?").get(jobId);
    const committedLibrary = db.prepare(`
      SELECT scan_generation, catalog_revision FROM libraries WHERE id=?
    `).get(libraryId);
    const committedModel = db.prepare(`
      SELECT scan_generation FROM library_models
      WHERE library_id=? AND model_id=? AND model_fingerprint=?
    `).get(libraryId, model.id, model.fingerprint);
    if (!job || !committedLibrary || !committedModel
      || job.library_id !== libraryId || job.model_id !== model.id
      || job.model_fingerprint !== model.fingerprint || Number(job.dimensions) !== model.dimensions
      || Number(job.target_file_generation) !== fileGeneration
      || Number(job.target_model_generation) !== modelGeneration
      || job.execution_profile !== executionProfile
      || Number(committedLibrary.catalog_revision) !== Number(job.base_catalog_revision)
      || Number(committedLibrary.scan_generation) !== Number(job.base_file_generation)
      || Number(committedModel.scan_generation) !== Number(job.base_model_generation)) {
      throw stagingStaleError();
    }
    if (Number(job.profile_rebuilt) === 1) {
      const invalidReuse = Number(db.prepare(`
        SELECT COUNT(*) AS count FROM index_staging_images
        WHERE job_id=? AND embedding_changed=0
      `).get(jobId).count || 0);
      if (invalidReuse) throw new Error("INDEX_PROFILE_REUSE_INVALID");
    }
    const contentChanged = Boolean(db.prepare(`
      SELECT
        EXISTS(SELECT 1 FROM index_staging_images WHERE job_id=? AND file_changed=1)
        OR EXISTS(
          SELECT 1 FROM images i WHERE i.library_id=? AND NOT EXISTS(
            SELECT 1 FROM index_staging_images s
            WHERE s.job_id=? AND s.relative_path=i.relative_path
          )
        ) AS changed
    `).get(jobId, libraryId, jobId).changed);
    if (contentChanged) {
      db.prepare(`
        UPDATE library_models SET status='stale'
        WHERE library_id=? AND NOT (model_id=? AND model_fingerprint=?)
          AND status IN ('ready','paused','error')
      `).run(libraryId, model.id, model.fingerprint);
      db.prepare(`
        DELETE FROM image_embeddings
        WHERE library_id=? AND image_id IN (
          SELECT i.id FROM images i JOIN index_staging_images s
            ON s.job_id=? AND s.relative_path=i.relative_path
          WHERE i.library_id=? AND s.file_changed=1
        )
      `).run(libraryId, jobId, libraryId);
    }
    db.prepare(`
      DELETE FROM images
      WHERE library_id=? AND NOT EXISTS(
        SELECT 1 FROM index_staging_images s
        WHERE s.job_id=? AND s.relative_path=images.relative_path
      )
    `).run(libraryId, jobId);
    db.prepare(`
      INSERT INTO images(
        library_id, relative_path, mtime_ms, size_bytes, sha256, format, width, height,
        scan_generation, error_code
      )
      SELECT ?, relative_path, mtime_ms, size_bytes, sha256, format, width, height, ?, error_code
      FROM index_staging_images WHERE job_id=? AND file_changed=1
      ON CONFLICT(library_id, relative_path) DO UPDATE SET
        mtime_ms=excluded.mtime_ms,
        size_bytes=excluded.size_bytes,
        sha256=excluded.sha256,
        format=excluded.format,
        width=excluded.width,
        height=excluded.height,
        scan_generation=excluded.scan_generation,
        error_code=excluded.error_code
    `).run(libraryId, fileGeneration, jobId);
    if (Number(job.profile_rebuilt) === 1) {
      db.prepare(`
        DELETE FROM image_embeddings
        WHERE library_id=? AND model_id=? AND model_fingerprint=?
      `).run(libraryId, model.id, model.fingerprint);
    } else {
      db.prepare(`
        DELETE FROM image_embeddings
        WHERE library_id=? AND model_id=? AND model_fingerprint=? AND image_id IN (
          SELECT i.id FROM images i JOIN index_staging_images s
            ON s.job_id=? AND s.relative_path=i.relative_path
          WHERE i.library_id=? AND s.embedding_changed=1
        )
      `).run(libraryId, model.id, model.fingerprint, jobId, libraryId);
    }
    db.prepare(`
      INSERT INTO image_embeddings(
        library_id, image_id, model_id, model_fingerprint, dimensions,
        embedding, scan_generation, error_code
      )
      SELECT ?, i.id, ?, ?, ?, s.embedding, ?, s.error_code
      FROM index_staging_images s JOIN images i
        ON i.library_id=? AND i.relative_path=s.relative_path
      WHERE s.job_id=? AND s.embedding_changed=1
      ON CONFLICT(library_id, image_id, model_id, model_fingerprint) DO UPDATE SET
        dimensions=excluded.dimensions,
        embedding=excluded.embedding,
        scan_generation=excluded.scan_generation,
        error_code=excluded.error_code
    `).run(
      libraryId,
      model.id,
      model.fingerprint,
      model.dimensions,
      modelGeneration,
      libraryId,
      jobId,
    );
    const counts = db.prepare(`
      SELECT COUNT(embedding) AS item_count,
        SUM(CASE WHEN error_code IS NOT NULL THEN 1 ELSE 0 END) AS error_count
      FROM image_embeddings
      WHERE library_id=? AND model_id=? AND model_fingerprint=?
    `).get(libraryId, model.id, model.fingerprint);
    const indexedAt = new Date().toISOString();
    db.prepare(`
      UPDATE library_models
      SET status='ready', item_count=?, error_count=?, scan_generation=?,
        execution_profile=?, last_indexed_at=?
      WHERE library_id=? AND model_id=? AND model_fingerprint=?
    `).run(
      Number(counts.item_count || 0),
      Number(counts.error_count || 0),
      modelGeneration,
      executionProfile,
      indexedAt,
      libraryId,
      model.id,
      model.fingerprint,
    );
    db.prepare(`
      UPDATE libraries
      SET status='ready', item_count=?, error_count=?, scan_generation=?, last_indexed_at=?,
        catalog_status='ready',
        catalog_item_count=(SELECT COUNT(*) FROM images WHERE library_id=?),
        catalog_revision=catalog_revision+1,
        catalog_last_scanned_at=?
      WHERE id=?
    `).run(
      Number(counts.item_count || 0),
      Number(counts.error_count || 0),
      fileGeneration,
      indexedAt,
      libraryId,
      indexedAt,
      libraryId,
    );
    db.prepare("DELETE FROM index_staging_jobs WHERE job_id=?").run(jobId);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

async function runIndexAttempt({ jobId, libraryId, modelId, modelConfig, engineProbe }, profileRestartCount) {
  const library = db.prepare("SELECT * FROM libraries WHERE id = ?").get(libraryId);
  if (!library) throw new Error("LIBRARY_NOT_FOUND");
  const model = resolveModelConfig({ modelId, modelConfig });
  const state = await activateSessionState(model, engineProbe);
  const queries = createIndexQueries(model);
  const expectedExecutionProfile = indexExecutionProfile(state);
  let generations = null;
  let writer = null;
  const progress = {
    state: "indexing",
    stage: "scanning",
    scanned: 0,
    total: 0,
    analyzed: 0,
    reused: 0,
    skipped: 0,
    errors: 0,
    imagesPerSecond: 0,
    etaSeconds: null,
    profileRestartCount,
    profileRebuilt: false,
    ...runtimeFields(state),
  };
  const paths = [];
  let scanCompleteToken = null;
  let inferenceInFlight = null;
  const awaitInferenceBarrier = async () => {
    if (!inferenceInFlight) return;
    const active = inferenceInFlight;
    const settled = await active;
    if (inferenceInFlight === active) inferenceInFlight = null;
    if (settled.error) throw settled.error;
  };
  try {
    for await (const scannedFile of walkImages(library.root_path)) {
      if (canceledJobs.has(jobId)) {
        pauseIndex(jobId, libraryId, model);
        return { ...progress, state: "canceled", ...runtimeFields(state) };
      }
      progress.scanned += 1;
      if (scannedFile.kind === "skipped") {
        progress.skipped += 1;
        progress.total = paths.length + progress.skipped;
        if (progress.scanned % 250 === 0) {
          emitProgress(jobId, progress);
          await new Promise((resolve) => setImmediate(resolve));
        }
        continue;
      }
      paths.push(scannedFile);
      progress.total = paths.length + progress.skipped;
      if (progress.scanned % 250 === 0) {
        emitProgress(jobId, progress);
        await new Promise((resolve) => setImmediate(resolve));
      }
    }
    scanCompleteToken = SCAN_COMPLETE_TOKEN;
    if (canceledJobs.has(jobId)) {
      pauseIndex(jobId, libraryId, model);
      return { ...progress, state: "canceled", ...runtimeFields(state) };
    }

    // Do not advance generations, change the execution profile, or prune/rebuild vectors
    // until the whole directory tree has been enumerated successfully. A missing/offline or
    // unreadable root/subdirectory must leave the last committed index intact.
    generations = beginIndexState(jobId, library, model, expectedExecutionProfile);
    writer = createWriter({ jobId, model, queries, ...generations });
    progress.profileRebuilt = generations.profileRebuilt;
    if (workerData.testPauseAfterIndexBegin) canceledJobs.add(jobId);

    progress.total = paths.length + progress.skipped;
    progress.stage = "preprocessing";
    emitProgress(jobId, progress, { force: true });
    const analysisStartedAt = performance.now();
    const pendingGroups = [];
    const pendingByDigest = new Map();

    const processInferenceGroups = async (groups) => {
      progress.stage = "inference";
      Object.assign(progress, runtimeFields(state));
      refreshRate(progress, analysisStartedAt);
      emitProgress(jobId, progress);
      const results = await inferIndexBatch(state, groups.map((group) => group.prepared));
      Object.assign(progress, runtimeFields(state));
      const profileError = modernSchema
        ? executionProfileChanged(expectedExecutionProfile, state, progress)
        : null;
      if (profileError) {
        profileError.model = model;
        throw profileError;
      }
      for (let index = 0; index < groups.length; index += 1) {
        const group = groups[index];
        const result = results[index];
        pendingByDigest.delete(group.candidate.digest);
        if (result?.vector) {
          writer.write(group.candidate, result.vector, group.prepared.metadata, null);
          progress.analyzed += 1;
          for (const follower of group.followers) {
            writer.write(follower, result.vector, group.prepared.metadata, null);
            progress.reused += 1;
          }
        } else {
          writer.write(group.candidate, null, group.prepared.metadata, result?.error || new Error("MODEL_INFERENCE_FAILED"));
          progress.errors += 1;
          for (const follower of group.followers) {
            writer.write(follower, null, group.prepared.metadata, result?.error || new Error("MODEL_INFERENCE_FAILED"));
            progress.errors += 1;
          }
        }
      }
      progress.stage = "preprocessing";
      refreshRate(progress, analysisStartedAt);
      emitProgress(jobId, progress);
    };

    const startInference = (groups) => {
      const task = processInferenceGroups(groups);
      // Convert rejection into data immediately so producer-side preprocessing can safely overlap it.
      inferenceInFlight = task.then(
        () => ({ error: null }),
        (error) => ({ error }),
      );
    };

    const flushInference = async (force = false) => {
      while (pendingGroups.length >= INDEX_INFERENCE_BATCH_SIZE || (force && pendingGroups.length)) {
        await awaitInferenceBarrier();
        if (canceledJobs.has(jobId)) return;
        const groups = pendingGroups.splice(0, INDEX_INFERENCE_BATCH_SIZE);
        startInference(groups);
      }
      if (force) await awaitInferenceBarrier();
    };

    for (let offset = 0; offset < paths.length; offset += FILE_CHUNK_SIZE) {
      if (canceledJobs.has(jobId)) break;
      const pathChunk = paths.slice(offset, offset + FILE_CHUNK_SIZE);
      const inspected = await mapLimit(pathChunk, PREPROCESS_CONCURRENCY, (scannedFile) => inspectCandidate({
        relativePath: scannedFile.relativePath,
        scannedFileInfo: scannedFile.fileInfo,
        library,
        model,
        queries,
        jobId,
        profileRebuilt: generations.profileRebuilt,
      }));
      const representatives = [];
      const representativesByDigest = new Map();
      for (const candidate of inspected) {
        if (candidate.kind === "unchanged") {
          writer.markReused(candidate);
          progress.reused += 1;
        } else if (candidate.kind === "duplicate") {
          writer.write(candidate, bufferToVector(candidate.embedding, model.dimensions), candidate.metadata, null);
          progress.reused += 1;
        } else if (candidate.kind === "error") {
          if (shortError(candidate.error) !== "INDEX_CANCELED") {
            writer.write(candidate, null, null, candidate.error);
            progress.errors += 1;
          }
        } else {
          const pending = pendingByDigest.get(candidate.digest);
          const local = representativesByDigest.get(candidate.digest);
          if (pending) {
            candidate.bytes = null;
            pending.followers.push(candidate);
          } else if (local) {
            candidate.bytes = null;
            local.followers.push(candidate);
          } else {
            const group = { candidate, followers: [] };
            representatives.push(group);
            representativesByDigest.set(candidate.digest, group);
          }
        }
      }

      const prepared = await mapLimit(representatives, PREPROCESS_CONCURRENCY, async (group) => {
        const { candidate } = group;
        try {
          return { ...group, prepared: await preprocessCandidate(candidate, model), error: null };
        } catch (error) {
          candidate.bytes = null;
          return { ...group, prepared: null, error };
        }
      });
      for (const item of prepared) {
        if (item.error) {
          writer.write(item.candidate, null, item.candidate.knownMetadata, item.error);
          progress.errors += 1;
          for (const follower of item.followers) {
            writer.write(follower, null, item.candidate.knownMetadata, item.error);
            progress.errors += 1;
          }
          continue;
        }
        const group = { candidate: item.candidate, prepared: item.prepared, followers: item.followers };
        pendingGroups.push(group);
        pendingByDigest.set(item.candidate.digest, group);
      }
      await flushInference(false);
      refreshRate(progress, analysisStartedAt);
      if (offset % 32 === 0) emitProgress(jobId, progress);
      await new Promise((resolve) => setImmediate(resolve));
    }

    if (!canceledJobs.has(jobId)) await flushInference(true);
    else await awaitInferenceBarrier();
    writer.flush();
    if (canceledJobs.has(jobId)) {
      pauseIndex(jobId, libraryId, model);
      return { ...progress, state: "canceled", ...runtimeFields(state) };
    }
    writer.flushReused();
    progress.stage = "finalizing";
    emitProgress(jobId, progress, { force: true });
    const finalProfileError = modernSchema
      ? executionProfileChanged(expectedExecutionProfile, state, progress)
      : null;
    if (finalProfileError) {
      finalProfileError.model = model;
      throw finalProfileError;
    }
    finishIndex({
      jobId,
      libraryId,
      model,
      ...generations,
      executionProfile: expectedExecutionProfile,
      scanCompleteToken,
    });
    if (activeCache?.libraryId === libraryId) activeCache = null;
    refreshRate(progress, analysisStartedAt);
    return { ...progress, state: "completed", ...runtimeFields(state) };
  } catch (error) {
    let failure = error;
    try {
      await awaitInferenceBarrier();
    } catch (inferenceError) {
      if (inferenceError?.code === "INDEX_EXECUTION_PROFILE_CHANGED") failure = inferenceError;
    }
    writer?.rollback();
    if (failure?.code !== "INDEX_EXECUTION_PROFILE_CHANGED") pauseIndex(jobId, libraryId, model);
    throw failure;
  }
}

async function runIndex(payload) {
  const { jobId, libraryId } = payload;
  let profileRestartCount = 0;
  try {
    while (true) {
      try {
        return await runIndexAttempt(payload, profileRestartCount);
      } catch (error) {
        if (error?.code !== "INDEX_EXECUTION_PROFILE_CHANGED" || !modernSchema) throw error;
        const model = error.model || resolveModelConfig(payload);
        const actualProfile = error.actualProfile || indexExecutionProfile(await activateSessionState(
          model,
          payload.engineProbe,
        ));
        const clearedProgress = {
          ...(error.progress || {}),
          analyzed: 0,
          reused: 0,
          skipped: 0,
          errors: 0,
          executionProfile: actualProfile,
        };
        if (canceledJobs.has(jobId)) {
          pauseIndex(jobId, libraryId, model);
          return {
            ...clearedProgress,
            state: "canceled",
            stage: "canceled",
            profileRestartCount,
          };
        }
        if (profileRestartCount >= MAX_EXECUTION_PROFILE_RESTARTS) {
          pauseIndex(jobId, libraryId, model);
          const unstableError = new Error("INDEX_EXECUTION_PROFILE_UNSTABLE");
          unstableError.code = "INDEX_EXECUTION_PROFILE_UNSTABLE";
          unstableError.expectedProfile = error.expectedProfile;
          unstableError.actualProfile = actualProfile;
          throw unstableError;
        }
        profileRestartCount += 1;
        emitProgress(jobId, {
          ...clearedProgress,
          state: "indexing",
          stage: "restarting",
          profileRestartCount,
          profileRebuilt: true,
        }, { force: true });
        await new Promise((resolve) => setImmediate(resolve));
      }
    }
  } finally {
    canceledJobs.delete(jobId);
    progressEmissionTimes.delete(jobId);
  }
}

function bufferToVector(bytes, dimensions) {
  const buffer = Buffer.from(bytes);
  if (buffer.byteLength !== dimensions * 4) throw new Error("EMBEDDING_DIMENSION_INVALID");
  if (buffer.byteOffset % 4 === 0) return new Float32Array(buffer.buffer, buffer.byteOffset, dimensions);
  return new Float32Array(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength));
}

function loadCache(libraryId, model) {
  const key = `${libraryId}:${modelKey(model)}`;
  if (activeCache?.key === key) return activeCache;
  const expectedBytes = model.dimensions * Float32Array.BYTES_PER_ELEMENT;
  const count = modernSchema
    ? Number(db.prepare(`
      SELECT COUNT(*) AS count FROM image_embeddings
      WHERE library_id=? AND model_id=? AND model_fingerprint=? AND dimensions=?
        AND embedding IS NOT NULL AND length(embedding)=?
    `).get(libraryId, model.id, model.fingerprint, model.dimensions, expectedBytes).count || 0)
    : Number(db.prepare(`
      SELECT COUNT(*) AS count FROM images
      WHERE library_id=? AND embedding IS NOT NULL AND length(embedding)=?
    `).get(libraryId, expectedBytes).count || 0);
  const requiredBytes = count * expectedBytes + count * Float64Array.BYTES_PER_ELEMENT;
  if (requiredBytes > MAX_VECTOR_CACHE_BYTES) {
    activeCache = {
      key, libraryId, modelId: model.id, fingerprint: model.fingerprint,
      mode: "chunked", count, requiredBytes,
    };
    return activeCache;
  }
  const vectors = new Float32Array(count * model.dimensions);
  const imageIds = new Float64Array(count);
  const statement = modernSchema ? db.prepare(`
    SELECT image_id AS id, embedding FROM image_embeddings
    WHERE library_id=? AND model_id=? AND model_fingerprint=? AND dimensions=?
      AND embedding IS NOT NULL AND length(embedding)=?
    ORDER BY image_id
  `) : db.prepare(`
    SELECT id, embedding FROM images
    WHERE library_id=? AND embedding IS NOT NULL AND length(embedding)=?
    ORDER BY id
  `);
  const argumentsList = modernSchema
    ? [libraryId, model.id, model.fingerprint, model.dimensions, expectedBytes]
    : [libraryId, expectedBytes];
  let rowIndex = 0;
  for (const row of statement.iterate(...argumentsList)) {
    imageIds[rowIndex] = Number(row.id);
    vectors.set(bufferToVector(row.embedding, model.dimensions), rowIndex * model.dimensions);
    rowIndex += 1;
  }
  activeCache = {
    key, libraryId, modelId: model.id, fingerprint: model.fingerprint,
    mode: "memory", count: rowIndex, imageIds, vectors,
  };
  return activeCache;
}

function chunkedTopK(libraryId, model, query, limit) {
  const expectedBytes = model.dimensions * Float32Array.BYTES_PER_ELEMENT;
  const statement = modernSchema ? db.prepare(`
    SELECT image_id AS id, embedding FROM image_embeddings
    WHERE library_id=? AND model_id=? AND model_fingerprint=? AND dimensions=?
      AND embedding IS NOT NULL AND length(embedding)=?
    ORDER BY image_id
  `) : db.prepare(`
    SELECT id, embedding FROM images
    WHERE library_id=? AND embedding IS NOT NULL AND length(embedding)=?
    ORDER BY id
  `);
  const argumentsList = modernSchema
    ? [libraryId, model.id, model.fingerprint, model.dimensions, expectedBytes]
    : [libraryId, expectedBytes];
  const winners = [];
  let ordinal = 0;
  for (const row of statement.iterate(...argumentsList)) {
    const vector = bufferToVector(row.embedding, model.dimensions);
    let score = 0;
    for (let index = 0; index < model.dimensions; index += 1) score += vector[index] * query[index];
    const winner = { imageId: Number(row.id), score, ordinal };
    ordinal += 1;
    let insertion = winners.findIndex((item) => score > item.score || (score === item.score && winner.ordinal < item.ordinal));
    if (insertion < 0) insertion = winners.length;
    if (insertion < limit) winners.splice(insertion, 0, winner);
    if (winners.length > limit) winners.pop();
  }
  return winners;
}

function resultMetadata(libraryId, winners) {
  if (!winners.length) return [];
  const placeholders = winners.map(() => "?").join(",");
  const rows = db.prepare(`
    SELECT id, replace(relative_path, char(92), '/') AS relative_path,
      width, height, format, size_bytes, mtime_ms
    FROM images WHERE library_id=? AND id IN (${placeholders})
  `).all(libraryId, ...winners.map((winner) => winner.imageId));
  const byId = new Map(rows.map((row) => [Number(row.id), row]));
  return winners.flatMap((winner) => {
    const row = byId.get(winner.imageId);
    if (!row) return [];
    return [{
      imageId: Number(row.id),
      relativePath: row.relative_path,
      fileName: path.posix.basename(row.relative_path),
      width: row.width,
      height: row.height,
      format: row.format,
      sizeBytes: Number(row.size_bytes || 0),
      modifiedAt: Number(row.mtime_ms || 0),
      score: winner.score,
    }];
  });
}

function normalizeAssetPrefix(value, { maximumLength = 1024 } = {}) {
  if (value === undefined || value === null || value === "") return "";
  if (
    typeof value !== "string" || value.length > maximumLength || value.includes("\0")
    || value.includes("\\") || value.startsWith("/") || /^[a-z]:/i.test(value) || value.startsWith("//")
  ) throw new Error("LOCAL_SEARCH_ASSET_PREFIX_INVALID");
  const normalized = value.replace(/\/+$/g, "");
  if (!normalized || path.posix.isAbsolute(normalized)) throw new Error("LOCAL_SEARCH_ASSET_PREFIX_INVALID");
  const segments = normalized.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error("LOCAL_SEARCH_ASSET_PREFIX_INVALID");
  }
  return segments.join("/");
}

function escapeLike(value) {
  return value.replaceAll("!", "!!").replaceAll("%", "!%").replaceAll("_", "!_");
}

function requireCatalogLibrary(libraryId) {
  const library = db.prepare("SELECT id, catalog_revision FROM libraries WHERE id=?").get(libraryId);
  if (!library) throw new Error("LOCAL_SEARCH_LIBRARY_NOT_FOUND");
  return library;
}

function listAssetFolders(payload) {
  const libraryId = String(payload.libraryId || "");
  const library = requireCatalogLibrary(libraryId);
  const canonicalParent = normalizeAssetPrefix(payload.parentPrefix);
  const prefix = canonicalParent ? `${canonicalParent}/` : "";
  const rows = db.prepare(`
    WITH normalized AS (
      SELECT replace(relative_path, char(92), '/') AS normalized_path
      FROM images
      WHERE library_id=?
    ), descendants AS (
      SELECT substr(normalized_path, length(?) + 1) AS rest
      FROM normalized
      WHERE normalized_path LIKE ? ESCAPE '!'
    )
    SELECT substr(rest, 1, instr(rest, '/') - 1) AS name, COUNT(*) AS item_count
    FROM descendants
    WHERE instr(rest, '/') > 0
    GROUP BY name COLLATE NOCASE
    ORDER BY name COLLATE NOCASE ASC
  `).all(libraryId, prefix, `${escapeLike(prefix)}%`);
  return {
    libraryId,
    catalogRevision: Number(library.catalog_revision || 0),
    parentPrefix: canonicalParent,
    folders: rows.map((row) => ({
      name: row.name,
      prefix: canonicalParent ? `${canonicalParent}/${row.name}` : row.name,
      itemCount: Number(row.item_count || 0),
    })),
  };
}

function listAssets(payload) {
  const libraryId = String(payload.libraryId || "");
  const library = requireCatalogLibrary(libraryId);
  const canonicalFolder = normalizeAssetPrefix(payload.folderPrefix);
  const pageSize = Number(payload.pageSize ?? 100);
  const requestedPage = Number(payload.page ?? 1);
  const filter = payload.filter ?? "";
  const sort = payload.sort ?? "path-asc";
  if (!Number.isInteger(pageSize) || pageSize !== 100) throw new Error("LOCAL_SEARCH_ASSET_PAGE_SIZE_INVALID");
  if (!Number.isSafeInteger(requestedPage) || requestedPage < 1) throw new Error("LOCAL_SEARCH_ASSET_PAGE_INVALID");
  if (typeof filter !== "string" || filter.length > 100 || filter.includes("\0")) {
    throw new Error("LOCAL_SEARCH_ASSET_FILTER_INVALID");
  }
  const orderBy = ASSET_SORTS[sort];
  if (!orderBy) throw new Error("LOCAL_SEARCH_ASSET_SORT_INVALID");
  const folderPattern = canonicalFolder ? `${escapeLike(canonicalFolder)}/%` : "%";
  const filterPattern = `%${escapeLike(filter.trim())}%`;
  const where = `
    i.library_id=?
    AND replace(i.relative_path, char(92), '/') LIKE ? ESCAPE '!'
    AND replace(i.relative_path, char(92), '/') LIKE ? ESCAPE '!'
  `;
  const totalItems = Number(db.prepare(`SELECT COUNT(*) AS count FROM images i WHERE ${where}`)
    .get(libraryId, folderPattern, filterPattern).count || 0);
  const pageCount = Math.max(1, Math.ceil(totalItems / pageSize));
  const currentPage = Math.min(requestedPage, pageCount);
  const rows = db.prepare(`
    SELECT i.id, replace(i.relative_path, char(92), '/') AS normalized_path,
      i.width, i.height, i.format, i.size_bytes, i.mtime_ms,
      COALESCE(i.error_code, (
        SELECT e.error_code FROM image_embeddings e
        WHERE e.library_id=i.library_id AND e.image_id=i.id AND e.error_code IS NOT NULL
        LIMIT 1
      )) AS browse_error_code
    FROM images i
    WHERE ${where}
    ORDER BY ${orderBy}
    LIMIT ? OFFSET ?
  `).all(libraryId, folderPattern, filterPattern, pageSize, (currentPage - 1) * pageSize);
  return {
    libraryId,
    catalogRevision: Number(library.catalog_revision || 0),
    page: currentPage,
    pageSize,
    pageCount,
    totalItems,
    items: rows.map((row) => {
      const relativePath = row.normalized_path;
      const directory = path.posix.dirname(relativePath);
      return {
        imageId: Number(row.id),
        fileName: path.posix.basename(relativePath),
        relativePath,
        directory: directory === "." ? "" : directory,
        width: row.width == null ? null : Number(row.width),
        height: row.height == null ? null : Number(row.height),
        format: row.format || null,
        sizeBytes: Number(row.size_bytes || 0),
        modifiedAt: Number(row.mtime_ms || 0),
        errorCode: row.browse_error_code || null,
      };
    }),
  };
}

function exactSearch(libraryId, model, query, limit = DEFAULT_RESULT_LIMIT) {
  const cache = loadCache(libraryId, model);
  const winners = cache.mode === "chunked"
    ? chunkedTopK(libraryId, model, query, limit)
    : exactTopK(cache.vectors, cache.count, query, limit).map(({ rowIndex, score }) => ({
      imageId: Number(cache.imageIds[rowIndex]), score,
    }));
  return resultMetadata(libraryId, winners);
}

async function engineStatus(payload = {}) {
  const model = resolveModelConfig(payload);
  const state = await activateSessionState(model, payload.engineProbe);
  return {
    ...runtimeFields(state),
    probeDiagnostics: state.probeDiagnostics,
    cpuThreads: CPU_INTRA_OP_THREADS,
    preprocessConcurrency: PREPROCESS_CONCURRENCY,
    modelId: model.id,
    modelFingerprint: model.fingerprint,
  };
}

async function releaseSessions() {
  for (const state of sessionStates.values()) {
    await releaseState(state);
  }
  sessionStates.clear();
}

async function handleRequest(action, payload) {
  if (action === "index") {
    activeOrQueuedJobs.add(payload.jobId);
    const task = indexTail.then(() => runIndex(payload)).finally(() => activeOrQueuedJobs.delete(payload.jobId));
    indexTail = task.catch(() => {});
    return task;
  }
  if (action === "cancel") {
    canceledJobs.add(payload.jobId);
    return { canceled: true };
  }
  if (action === "invalidate") {
    if (!payload.libraryId || activeCache?.libraryId === payload.libraryId) activeCache = null;
    return { invalidated: true };
  }
  if (action === "listAssetFolders") return listAssetFolders(payload);
  if (action === "listAssets") return listAssets(payload);
  if (action === "status" || action === "getEngineStatus") return engineStatus(payload);
  if (action === "searchImage") {
    const model = resolveModelConfig(payload);
    const state = await activateSessionState(model, payload.engineProbe);
    const vector = await embedImageBytes(Buffer.from(payload.bytes), state);
    return {
      results: exactSearch(payload.libraryId, model, vector, payload.limit),
      executionProvider: "cpu",
      visionProvider: "cpu",
      textProvider: "cpu",
      modelId: model.id,
    };
  }
  if (action === "searchText") {
    const model = resolveModelConfig(payload);
    const state = await activateSessionState(model, payload.engineProbe);
    const vector = await embedText(payload.text, state);
    return {
      results: exactSearch(payload.libraryId, model, vector, payload.limit),
      executionProvider: "cpu",
      visionProvider: state.visionProvider,
      textProvider: "cpu",
      modelId: model.id,
    };
  }
  if (action === "dispose") {
    for (const jobId of activeOrQueuedJobs) canceledJobs.add(jobId);
    await indexTail.catch(() => {});
    await releaseSessions();
    db.close();
    return { disposed: true };
  }
  throw new Error("WORKER_ACTION_INVALID");
}

onParentMessage(({ requestId, action, payload }) => {
  const run = async () => {
  try {
    const result = await handleRequest(action, payload || {});
    postParentMessage({ type: "result", requestId, result });
  } catch (error) {
    postParentMessage({
      type: "error",
      requestId,
      error: { code: String(error?.code || error?.message || "WORKER_FAILED").slice(0, 160) },
    });
  }
  };
  if (action === "cancel") {
    void run();
    return;
  }
  if (action === "dispose") {
    for (const jobId of activeOrQueuedJobs) canceledJobs.add(jobId);
  }
  const task = requestTail.then(run, run);
  requestTail = task.catch(() => {});
});
