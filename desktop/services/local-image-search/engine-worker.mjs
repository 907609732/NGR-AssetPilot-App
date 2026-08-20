import { parentPort, workerData } from "node:worker_threads";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { opendir, readFile, stat } from "node:fs/promises";
import { availableParallelism } from "node:os";
import { performance } from "node:perf_hooks";
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

env.allowRemoteModels = false;
env.allowLocalModels = true;

const DEFAULT_MODEL_FINGERPRINT = "d169114d56ae3bbcc37cad224c9f39947b8712a4d5375c781d69f7fe632606e4";
const MAX_INPUT_PIXELS = 50_000_000;
const MAX_BUFFERED_SOURCE_BYTES = 32 * 1024 * 1024;
const FILE_CHUNK_SIZE = 8;
const INDEX_INFERENCE_BATCH_SIZE = 16;
const GPU_BATCH_SIZES = Object.freeze([16, 8, 4, 1]);
const CPU_INDEX_BATCH_SIZE = 16;
const INDEX_EXECUTION_PROFILE_VERSION = "batched-v1";
const MAX_EXECUTION_PROFILE_RESTARTS = 1;
const TRANSACTION_SIZE = 256;
const PROGRESS_EMIT_INTERVAL_MS = 250;
const logicalCpus = Math.max(1, availableParallelism());
const CPU_INTRA_OP_THREADS = Math.max(1, Math.min(6, logicalCpus - 2));
const PREPROCESS_CONCURRENCY = Math.max(2, Math.min(8, logicalCpus - 2));
const SHARP_CONCURRENCY = Math.max(2, Math.min(4, logicalCpus - 2));

sharp.concurrency(SHARP_CONCURRENCY);

const db = new DatabaseSync(workerData.dbPath);
db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
const modernSchema = Boolean(db.prepare(`
  SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'image_embeddings'
`).get());
const canceledJobs = new Set();
const activeOrQueuedJobs = new Set();
const sessionStates = new Map();
const progressEmissionTimes = new Map();
let activeCache = null;
let indexTail = Promise.resolve();
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
    modelPath: String(rawVision.modelPath || modelPath("vision", "onnx/vision_model_quantized.onnx")),
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
    state = {
      model,
      cpuVision: null,
      cpuText: null,
      tokenizer: null,
      gpuVision: null,
      gpuAttempted: false,
      gpuDisabled: preferredProvider !== "dml",
      visionProvider: preferredProvider === "dml" ? "dml" : "cpu",
      textProvider: "cpu",
      deviceId: Number.isInteger(probe.deviceId) ? probe.deviceId : 0,
      deviceName: probe.deviceName || null,
      batchSize: preferredProvider === "dml" && GPU_BATCH_SIZES.includes(Number(probe.batchSize))
        ? Number(probe.batchSize)
        : CPU_INDEX_BATCH_SIZE,
      fallbackReason: probe.fallbackReason || null,
      probeDiagnostics: Array.isArray(probe.probeDiagnostics) ? probe.probeDiagnostics : [],
    };
    sessionStates.set(key, state);
  } else if (requestProbe && !state.gpuAttempted) {
    state.gpuDisabled = requestProbe.preferredProvider !== "dml";
    state.visionProvider = requestProbe.preferredProvider === "dml" ? "dml" : "cpu";
    state.deviceId = Number.isInteger(requestProbe.deviceId) ? requestProbe.deviceId : 0;
    state.deviceName = requestProbe.deviceName || null;
    state.batchSize = requestProbe.preferredProvider === "dml"
      && GPU_BATCH_SIZES.includes(Number(requestProbe.batchSize))
      ? Number(requestProbe.batchSize)
      : CPU_INDEX_BATCH_SIZE;
    state.fallbackReason = requestProbe.fallbackReason || null;
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
    graphOptimizationLevel: "all",
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

async function* walkImages(rootPath, relativeDirectory = "") {
  const directoryPath = path.join(rootPath, relativeDirectory);
  let directory;
  try {
    directory = await opendir(directoryPath);
  } catch {
    return;
  }
  for await (const entry of directory) {
    if (entry.isSymbolicLink()) continue;
    const relativePath = path.join(relativeDirectory, entry.name);
    if (entry.isDirectory()) yield* walkImages(rootPath, relativePath);
    else if (entry.isFile() && SUPPORTED_IMAGE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
      yield relativePath;
    }
  }
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
      existing: db.prepare("SELECT *, embedding AS model_embedding FROM images WHERE library_id = ? AND relative_path = ?"),
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
        e.embedding AS model_embedding, e.error_code AS model_error_code
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
    markImage: db.prepare("UPDATE images SET scan_generation = ? WHERE id = ?"),
    markEmbedding: db.prepare(`
      UPDATE image_embeddings SET scan_generation = ?
      WHERE library_id = ? AND image_id = ? AND model_id = ? AND model_fingerprint = ?
    `),
    upsertImage: db.prepare(`
      INSERT INTO images(library_id, relative_path, mtime_ms, size_bytes, sha256, format, width, height, scan_generation)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(library_id, relative_path) DO UPDATE SET
        mtime_ms=excluded.mtime_ms, size_bytes=excluded.size_bytes, sha256=excluded.sha256,
        format=excluded.format, width=excluded.width, height=excluded.height,
        scan_generation=excluded.scan_generation
      RETURNING id
    `),
    deleteAllEmbeddings: db.prepare("DELETE FROM image_embeddings WHERE library_id = ? AND image_id = ?"),
    upsertEmbedding: db.prepare(`
      INSERT INTO image_embeddings(
        library_id, image_id, model_id, model_fingerprint, dimensions, embedding, scan_generation, error_code
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(library_id, image_id, model_id, model_fingerprint) DO UPDATE SET
        dimensions=excluded.dimensions, embedding=excluded.embedding,
        scan_generation=excluded.scan_generation, error_code=excluded.error_code
    `),
  };
}

function queryExisting(queries, model, libraryId, relativePath) {
  return modernSchema
    ? queries.existing.get(model.id, model.fingerprint, libraryId, relativePath)
    : queries.existing.get(libraryId, relativePath);
}

function queryDuplicate(queries, model, libraryId, digest) {
  return modernSchema
    ? queries.duplicate.get(libraryId, digest, model.id, model.fingerprint)
    : queries.duplicate.get(libraryId, digest);
}

async function inspectCandidate({ relativePath, library, model, queries, jobId }) {
  const absolutePath = path.join(library.root_path, relativePath);
  let fileInfo;
  let existing;
  try {
    fileInfo = await stat(absolutePath);
    existing = queryExisting(queries, model, library.id, relativePath);
    const fileUnchanged = Boolean(existing
      && Number(existing.mtime_ms) === fileInfo.mtimeMs
      && Number(existing.size_bytes) === fileInfo.size);
    const currentEmbedding = existing?.model_embedding;
    if (fileUnchanged && embeddingValid(currentEmbedding, model.dimensions)) {
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

    const duplicate = queryDuplicate(queries, model, library.id, digest);
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
  parentPort.postMessage({ type: "progress", jobId, progress });
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
  return `${INDEX_EXECUTION_PROFILE_VERSION}:${provider}:${state.batchSize}`;
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

function beginIndexState(library, model, executionProfile) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const fileGeneration = Number(library.scan_generation || 0) + 1;
    db.prepare("UPDATE libraries SET scan_generation = ?, status = 'indexing' WHERE id = ?")
      .run(fileGeneration, library.id);
    let modelGeneration = fileGeneration;
    if (modernSchema) {
      db.prepare(`
        INSERT OR IGNORE INTO library_models(
          library_id, model_id, model_fingerprint, status, item_count, error_count,
          scan_generation, execution_profile
        ) VALUES (?, ?, ?, 'new', 0, 0, 0, ?)
      `).run(library.id, model.id, model.fingerprint, executionProfile);
      const row = db.prepare(`
        SELECT status, scan_generation, execution_profile FROM library_models
        WHERE library_id = ? AND model_id = ? AND model_fingerprint = ?
      `).get(library.id, model.id, model.fingerprint);
      const profileRebuilt = row?.execution_profile !== executionProfile;
      if (profileRebuilt) {
        db.prepare(`
          DELETE FROM image_embeddings
          WHERE library_id = ? AND model_id = ? AND model_fingerprint = ?
        `).run(library.id, model.id, model.fingerprint);
      }
      modelGeneration = Number(row?.scan_generation || 0) + 1;
      db.prepare(`
        UPDATE library_models
        SET scan_generation = ?, status = 'indexing', execution_profile = ?,
          item_count = CASE WHEN ? THEN 0 ELSE item_count END,
          error_count = CASE WHEN ? THEN 0 ELSE error_count END,
          last_indexed_at = CASE WHEN ? THEN NULL ELSE last_indexed_at END
        WHERE library_id = ? AND model_id = ? AND model_fingerprint = ?
      `).run(
        modelGeneration,
        executionProfile,
        profileRebuilt ? 1 : 0,
        profileRebuilt ? 1 : 0,
        profileRebuilt ? 1 : 0,
        library.id,
        model.id,
        model.fingerprint,
      );
      db.exec("COMMIT");
      if (profileRebuilt && activeCache?.libraryId === library.id && activeCache?.modelId === model.id) {
        activeCache = null;
      }
      return { fileGeneration, modelGeneration, executionProfile, profileRebuilt };
    } else if (library.model_version !== LOCAL_IMAGE_SEARCH_VERSION) {
      throw new Error("MODEL_VERSION_CHANGED");
    }
    db.exec("COMMIT");
    return { fileGeneration, modelGeneration, executionProfile: null, profileRebuilt: false };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function createWriter({ library, model, queries, fileGeneration, modelGeneration }) {
  let open = false;
  let writes = 0;
  const ensureOpen = () => {
    if (!open) {
      db.exec("BEGIN IMMEDIATE");
      open = true;
    }
  };
  const rotate = () => {
    writes += 1;
    if (writes >= TRANSACTION_SIZE) {
      db.exec("COMMIT");
      open = false;
      writes = 0;
    }
  };
  const write = (candidate, embedding, metadata, error) => {
    ensureOpen();
    const errorCode = error ? shortError(error) : null;
    const embeddingBytes = embedding ? vectorBuffer(embedding) : null;
    if (!modernSchema) {
      queries.upsertLegacy.run(
        library.id,
        candidate.relativePath,
        candidate.fileInfo?.mtimeMs || 0,
        candidate.fileInfo?.size || 0,
        candidate.digest || null,
        metadata?.format || path.extname(candidate.relativePath).slice(1) || null,
        metadata?.width || null,
        metadata?.height || null,
        embeddingBytes,
        fileGeneration,
        errorCode,
      );
      rotate();
      return;
    }

    let imageId = Number(candidate.existing?.id || 0);
    if (!candidate.fileUnchanged || !imageId) {
      const row = queries.upsertImage.get(
        library.id,
        candidate.relativePath,
        candidate.fileInfo?.mtimeMs || 0,
        candidate.fileInfo?.size || 0,
        candidate.digest || null,
        metadata?.format || path.extname(candidate.relativePath).slice(1) || null,
        metadata?.width || null,
        metadata?.height || null,
        fileGeneration,
      );
      imageId = Number(row.id);
      if (!candidate.fileUnchanged) {
        queries.deleteAllEmbeddings.run(library.id, imageId);
      }
    } else {
      queries.markImage.run(fileGeneration, imageId);
    }
    queries.upsertEmbedding.run(
      library.id,
      imageId,
      model.id,
      model.fingerprint,
      model.dimensions,
      embeddingBytes,
      modelGeneration,
      errorCode,
    );
    rotate();
  };
  const markReused = (candidate) => {
    ensureOpen();
    if (modernSchema) {
      queries.markImage.run(fileGeneration, candidate.existing.id);
      queries.markEmbedding.run(
        modelGeneration,
        library.id,
        candidate.existing.id,
        model.id,
        model.fingerprint,
      );
    } else {
      queries.markReused.run(fileGeneration, candidate.existing.id);
    }
    rotate();
  };
  const flush = () => {
    if (open) db.exec("COMMIT");
    open = false;
    writes = 0;
  };
  const rollback = () => {
    if (open) db.exec("ROLLBACK");
    open = false;
    writes = 0;
  };
  return { write, markReused, flush, rollback };
}

function pauseIndex(libraryId, model) {
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("UPDATE libraries SET status = 'paused' WHERE id = ?").run(libraryId);
    if (modernSchema) {
      db.prepare(`
        UPDATE library_models SET status = 'paused'
        WHERE library_id = ? AND model_id = ? AND model_fingerprint = ?
      `).run(libraryId, model.id, model.fingerprint);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function resetIndexForExecutionProfile(libraryId, model, executionProfile) {
  if (!modernSchema) return;
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(`
      DELETE FROM image_embeddings
      WHERE library_id = ? AND model_id = ? AND model_fingerprint = ?
    `).run(libraryId, model.id, model.fingerprint);
    db.prepare(`
      UPDATE library_models
      SET status = 'new', item_count = 0, error_count = 0,
        execution_profile = ?, last_indexed_at = NULL
      WHERE library_id = ? AND model_id = ? AND model_fingerprint = ?
    `).run(executionProfile, libraryId, model.id, model.fingerprint);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  if (activeCache?.libraryId === libraryId && activeCache?.modelId === model.id) activeCache = null;
}

function finishIndex({ libraryId, model, fileGeneration, modelGeneration, executionProfile }) {
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("DELETE FROM images WHERE library_id = ? AND scan_generation <> ?").run(libraryId, fileGeneration);
    let counts;
    if (modernSchema) {
      counts = db.prepare(`
        SELECT COUNT(e.embedding) AS item_count,
          SUM(CASE WHEN e.error_code IS NOT NULL THEN 1 ELSE 0 END) AS error_count
        FROM image_embeddings e
        JOIN images i ON i.library_id = e.library_id AND i.id = e.image_id
        WHERE e.library_id = ? AND e.model_id = ? AND e.model_fingerprint = ?
          AND e.scan_generation = ?
      `).get(libraryId, model.id, model.fingerprint, modelGeneration);
      db.prepare(`
        UPDATE library_models
        SET status='ready', item_count=?, error_count=?, execution_profile=?, last_indexed_at=?
        WHERE library_id=? AND model_id=? AND model_fingerprint=?
      `).run(
        Number(counts.item_count || 0),
        Number(counts.error_count || 0),
        executionProfile,
        new Date().toISOString(),
        libraryId,
        model.id,
        model.fingerprint,
      );
    } else {
      counts = db.prepare(`
        SELECT COUNT(embedding) AS item_count,
          SUM(CASE WHEN error_code IS NOT NULL THEN 1 ELSE 0 END) AS error_count
        FROM images WHERE library_id = ?
      `).get(libraryId);
    }
    db.prepare(`
      UPDATE libraries SET status='ready', item_count=?, error_count=?, last_indexed_at=? WHERE id=?
    `).run(
      Number(counts.item_count || 0),
      Number(counts.error_count || 0),
      new Date().toISOString(),
      libraryId,
    );
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
  const generations = beginIndexState(library, model, expectedExecutionProfile);
  const writer = createWriter({ library, model, queries, ...generations });
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
    profileRebuilt: generations.profileRebuilt,
    ...runtimeFields(state),
  };
  const paths = [];
  let inferenceInFlight = null;
  const awaitInferenceBarrier = async () => {
    if (!inferenceInFlight) return;
    const active = inferenceInFlight;
    const settled = await active;
    if (inferenceInFlight === active) inferenceInFlight = null;
    if (settled.error) throw settled.error;
  };
  try {
    for await (const relativePath of walkImages(library.root_path)) {
      if (canceledJobs.has(jobId)) {
        writer.flush();
        pauseIndex(libraryId, model);
        return { ...progress, state: "canceled", ...runtimeFields(state) };
      }
      paths.push(relativePath);
      progress.scanned = paths.length;
      progress.total = paths.length;
      if (paths.length % 250 === 0) {
        emitProgress(jobId, progress);
        await new Promise((resolve) => setImmediate(resolve));
      }
    }

    progress.total = paths.length;
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
      const inspected = await mapLimit(pathChunk, PREPROCESS_CONCURRENCY, (relativePath) => inspectCandidate({
        relativePath,
        library,
        model,
        queries,
        jobId,
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
      pauseIndex(libraryId, model);
      return { ...progress, state: "canceled", ...runtimeFields(state) };
    }
    progress.stage = "finalizing";
    emitProgress(jobId, progress, { force: true });
    const finalProfileError = modernSchema
      ? executionProfileChanged(expectedExecutionProfile, state, progress)
      : null;
    if (finalProfileError) {
      finalProfileError.model = model;
      throw finalProfileError;
    }
    finishIndex({ libraryId, model, ...generations, executionProfile: expectedExecutionProfile });
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
    writer.rollback();
    if (failure?.code !== "INDEX_EXECUTION_PROFILE_CHANGED") pauseIndex(libraryId, model);
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
        resetIndexForExecutionProfile(libraryId, model, actualProfile);
        const clearedProgress = {
          ...(error.progress || {}),
          analyzed: 0,
          reused: 0,
          skipped: 0,
          errors: 0,
          executionProfile: actualProfile,
        };
        if (canceledJobs.has(jobId)) {
          pauseIndex(libraryId, model);
          return {
            ...clearedProgress,
            state: "canceled",
            stage: "canceled",
            profileRestartCount,
          };
        }
        if (profileRestartCount >= MAX_EXECUTION_PROFILE_RESTARTS) {
          pauseIndex(libraryId, model);
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
  let rows;
  if (modernSchema) {
    rows = db.prepare(`
      SELECT i.id, i.relative_path, i.width, i.height, i.format, e.embedding
      FROM image_embeddings e
      JOIN images i ON i.library_id = e.library_id AND i.id = e.image_id
      WHERE e.library_id = ? AND e.model_id = ? AND e.model_fingerprint = ?
        AND e.dimensions = ? AND e.embedding IS NOT NULL
      ORDER BY i.id
    `).all(libraryId, model.id, model.fingerprint, model.dimensions);
  } else {
    rows = db.prepare(`
      SELECT id, relative_path, width, height, format, embedding FROM images
      WHERE library_id = ? AND embedding IS NOT NULL ORDER BY id
    `).all(libraryId);
  }
  const validRows = rows.filter((row) => embeddingValid(row.embedding, model.dimensions));
  const vectors = new Float32Array(validRows.length * model.dimensions);
  validRows.forEach((row, index) => vectors.set(bufferToVector(row.embedding, model.dimensions), index * model.dimensions));
  activeCache = { key, libraryId, modelId: model.id, fingerprint: model.fingerprint, rows: validRows, vectors };
  return activeCache;
}

function exactSearch(libraryId, model, query, limit = DEFAULT_RESULT_LIMIT) {
  const cache = loadCache(libraryId, model);
  return exactTopK(cache.vectors, cache.rows.length, query, limit).map(({ rowIndex, score }) => {
    const row = cache.rows[rowIndex];
    return {
      imageId: Number(row.id),
      relativePath: row.relative_path,
      fileName: path.basename(row.relative_path),
      width: row.width,
      height: row.height,
      format: row.format,
      score,
    };
  });
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

parentPort.on("message", async ({ requestId, action, payload }) => {
  try {
    const result = await handleRequest(action, payload || {});
    parentPort.postMessage({ type: "result", requestId, result });
  } catch (error) {
    parentPort.postMessage({
      type: "error",
      requestId,
      error: { code: String(error?.code || error?.message || "WORKER_FAILED").slice(0, 160) },
    });
  }
});
