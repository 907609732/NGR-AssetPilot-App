import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { lstat, mkdir, open, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { Worker } from "node:worker_threads";
import { MODEL_FILES, MODEL_TOTAL_BYTES, LOCAL_IMAGE_SEARCH_VERSION } from "./constants.mjs";

const CUSTOM_MODEL_SCHEMA_VERSION = 1;
const CUSTOM_VALIDATION_TIMEOUT_MS = 60_000;
const CUSTOM_MODEL_MAX_FILE_BYTES = 4 * 1024 * 1024 * 1024;
const CUSTOM_MODEL_MAX_TOTAL_BYTES = 8 * 1024 * 1024 * 1024;
const CUSTOM_TOKENIZER_MAX_BYTES = 2 * 1024 * 1024 * 1024;
const PROBE_OUTPUT_LIMIT = 1024 * 1024;
const SAFE_TOKENIZER_EXTENSIONS = new Set([".json", ".txt", ".model", ".vocab", ".merges"]);
const BLOCKED_EXTENSIONS = new Set([
  ".appx", ".bat", ".chm", ".cmd", ".com", ".cpl", ".dll", ".dylib", ".exe", ".hta",
  ".jar", ".js", ".lnk", ".mjs", ".cjs", ".msi", ".msix", ".node", ".pif", ".ps1",
  ".py", ".reg", ".scr", ".sh", ".so", ".sys", ".url", ".vbs", ".wasm",
]);

function canonicalBuiltinFiles(files = MODEL_FILES) {
  return files.map(({ model, relativePath, size, sha256 }) => ({ model, relativePath, size, sha256 }));
}

export const BUILTIN_MODEL_ID = LOCAL_IMAGE_SEARCH_VERSION;
export const BUILTIN_INDEX_PROFILE = "batched-v1";
export const BUILTIN_MODEL_FINGERPRINT = createHash("sha256")
  .update(JSON.stringify({ indexProfile: BUILTIN_INDEX_PROFILE, files: canonicalBuiltinFiles() }))
  .digest("hex");

const BUILTIN_PREPROCESSING = Object.freeze({
  layout: "NCHW",
  width: 224,
  height: 224,
  colorSpace: "RGB",
  resizeMode: "crop",
  cropMode: "center",
  pixelType: "float32",
  scale: 1 / 255,
  mean: [0.48145466, 0.4578275, 0.40821073],
  std: [0.26862954, 0.26130258, 0.27577711],
  inputName: "pixel_values",
  outputName: "image_embeds",
  dimensions: 512,
  normalizeOutput: true,
  textInputName: "input_ids",
  textOutputName: "sentence_embedding",
});

function normalizeRelativePath(value) {
  if (typeof value !== "string" || !value.trim() || value.includes("\\")) {
    throw new Error("MODEL_RELATIVE_PATH_INVALID");
  }
  const normalized = path.posix.normalize(value.trim());
  if (normalized === "." || normalized.startsWith("../") || path.posix.isAbsolute(normalized)) {
    throw new Error("MODEL_RELATIVE_PATH_INVALID");
  }
  return normalized;
}

function isInside(root, candidate, { allowRoot = false } = {}) {
  const relative = path.relative(root, candidate);
  return (allowRoot && relative === "") || (relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative));
}

function normalizeTriplet(value, fallback) {
  if (value === undefined) return [...fallback];
  if (!Array.isArray(value) || value.length !== 3) throw new Error("MODEL_PREPROCESSING_TRIPLET_INVALID");
  const result = value.map(Number);
  if (!result.every(Number.isFinite)) throw new Error("MODEL_PREPROCESSING_TRIPLET_INVALID");
  return result;
}

export function normalizePreprocessing(value = {}) {
  if (value.layout !== undefined && !["NCHW", "NHWC"].includes(value.layout)) {
    throw new Error("MODEL_PREPROCESSING_LAYOUT_INVALID");
  }
  if (value.colorSpace !== undefined && !["RGB", "BGR"].includes(value.colorSpace)) {
    throw new Error("MODEL_PREPROCESSING_COLOR_INVALID");
  }
  if (value.pixelType !== undefined && !["float32", "uint8", "int8"].includes(value.pixelType)) {
    throw new Error("MODEL_PREPROCESSING_PIXEL_TYPE_INVALID");
  }
  const layout = value.layout || "NCHW";
  const colorSpace = value.colorSpace || "RGB";
  if (value.resizeMode !== undefined && !["crop", "fit", "stretch"].includes(value.resizeMode)) {
    throw new Error("MODEL_PREPROCESSING_RESIZE_INVALID");
  }
  const resizeMode = value.resizeMode || "crop";
  const pixelType = value.pixelType || "float32";
  const mean = normalizeTriplet(value.mean, [0, 0, 0]);
  const std = normalizeTriplet(value.std, [1, 1, 1]);
  if (std.some((item) => item === 0)) throw new Error("MODEL_PREPROCESSING_STD_INVALID");
  const width = value.width === undefined ? 224 : Number(value.width);
  const height = value.height === undefined ? 224 : Number(value.height);
  const dimensions = value.dimensions === undefined ? 0 : Number(value.dimensions);
  const scale = value.scale === undefined ? (pixelType === "float32" ? 1 / 255 : 1) : Number(value.scale);
  if (!Number.isInteger(width) || width < 16 || width > 4096 || !Number.isInteger(height) || height < 16 || height > 4096) {
    throw new Error("MODEL_PREPROCESSING_SIZE_INVALID");
  }
  if (!Number.isInteger(dimensions) || (dimensions !== 0 && (dimensions < 16 || dimensions > 4096))) {
    throw new Error("MODEL_PREPROCESSING_DIMENSIONS_INVALID");
  }
  if (!Number.isFinite(scale) || scale < -65536 || scale > 65536) {
    throw new Error("MODEL_PREPROCESSING_SCALE_INVALID");
  }
  return {
    layout,
    width,
    height,
    colorSpace,
    resizeMode,
    cropMode: value.cropMode === "none" ? "none" : "center",
    pixelType,
    scale,
    mean,
    std,
    inputName: typeof value.inputName === "string" ? value.inputName.trim().slice(0, 256) : "",
    outputName: typeof value.outputName === "string" ? value.outputName.trim().slice(0, 256) : "",
    dimensions,
    normalizeOutput: value.normalizeOutput !== false,
    textInputName: typeof value.textInputName === "string" ? value.textInputName.trim().slice(0, 256) : "",
    textOutputName: typeof value.textOutputName === "string" ? value.textOutputName.trim().slice(0, 256) : "",
  };
}

export function createBuiltinModelManifest() {
  return {
    schemaVersion: CUSTOM_MODEL_SCHEMA_VERSION,
    id: BUILTIN_MODEL_ID,
    fingerprint: BUILTIN_MODEL_FINGERPRINT,
    name: "NGR CLIP B/32 多语言模型",
    kind: "image-text",
    version: LOCAL_IMAGE_SEARCH_VERSION,
    indexProfile: BUILTIN_INDEX_PROFILE,
    dimensions: 512,
    supportsText: true,
    builtin: true,
    certification: "built-in",
    license: "Apache-2.0",
    totalBytes: MODEL_TOTAL_BYTES,
    relativeRoot: ".",
    vision: {
      modelPath: "vision/onnx/vision_model_quantized.onnx",
      modelRoot: "vision",
      ...BUILTIN_PREPROCESSING,
    },
    text: {
      modelPath: "text/onnx/model_quantized.onnx",
      modelRoot: "text",
      tokenizerRoot: "text",
      inputName: BUILTIN_PREPROCESSING.textInputName,
      outputName: BUILTIN_PREPROCESSING.textOutputName,
      normalizeOutput: true,
    },
    files: canonicalBuiltinFiles().map((file) => ({
      role: file.model === "vision" ? "vision" : "text",
      path: `${file.model}/${file.relativePath}`,
      size: file.size,
      sha256: file.sha256,
    })),
  };
}

async function sha256File(filePath) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

async function fileMatches(filePath, expected) {
  try {
    const info = await stat(filePath);
    if (info.size !== expected.size) return false;
    return await sha256File(filePath) === expected.sha256;
  } catch {
    return false;
  }
}

async function assertRegularSource(filePath) {
  const [linkInfo, resolved] = await Promise.all([lstat(filePath), realpath(filePath)]);
  if (!linkInfo.isFile() || linkInfo.isSymbolicLink()) throw new Error("MODEL_SOURCE_FILE_INVALID");
  const info = await stat(resolved);
  if (!info.isFile() || info.size < 1 || info.size > CUSTOM_MODEL_MAX_FILE_BYTES) {
    throw new Error("MODEL_SOURCE_FILE_INVALID");
  }
  return { resolved, info };
}

async function copyAndDescribe(sourcePath, destinationRoot, relativePath, role, maxBytes = CUSTOM_MODEL_MAX_FILE_BYTES) {
  const safeRelativePath = normalizeRelativePath(relativePath);
  const { resolved } = await assertRegularSource(sourcePath);
  const targetPath = path.resolve(destinationRoot, ...safeRelativePath.split("/"));
  if (!isInside(destinationRoot, targetPath)) throw new Error("MODEL_DESTINATION_PATH_INVALID");
  await mkdir(path.dirname(targetPath), { recursive: true });
  let copiedBytes = 0;
  const byteLimit = Math.min(CUSTOM_MODEL_MAX_FILE_BYTES, maxBytes);
  const limiter = new Transform({
    transform(chunk, _encoding, callback) {
      copiedBytes += chunk.length;
      if (copiedBytes > byteLimit) callback(new Error("MODEL_TOTAL_SIZE_EXCEEDED"));
      else callback(null, chunk);
    },
  });
  try {
    await pipeline(createReadStream(resolved), limiter, createWriteStream(targetPath, { flags: "wx" }));
  } catch (error) {
    await rm(targetPath, { force: true });
    throw error;
  }
  const targetInfo = await stat(targetPath);
  return { role, path: safeRelativePath, size: targetInfo.size, sha256: await sha256File(targetPath) };
}

class OnnxWireReader {
  constructor(handle, size) {
    this.handle = handle;
    this.size = size;
    this.position = 0;
    this.buffer = Buffer.allocUnsafe(64 * 1024);
    this.bufferStart = -1;
    this.bufferLength = 0;
    this.fieldsVisited = 0;
  }

  async byte(end = this.size) {
    if (this.position >= end || this.position >= this.size) throw new Error("MODEL_ONNX_PROTOBUF_INVALID");
    if (this.position < this.bufferStart || this.position >= this.bufferStart + this.bufferLength) {
      this.bufferStart = this.position;
      const result = await this.handle.read(
        this.buffer,
        0,
        Math.min(this.buffer.length, this.size - this.position),
        this.position,
      );
      this.bufferLength = result.bytesRead;
      if (!this.bufferLength) throw new Error("MODEL_ONNX_PROTOBUF_INVALID");
    }
    const value = this.buffer[this.position - this.bufferStart];
    this.position += 1;
    return value;
  }

  async varint(end = this.size) {
    let value = 0;
    let multiplier = 1;
    for (let index = 0; index < 10; index += 1) {
      const byte = await this.byte(end);
      value += (byte & 0x7f) * multiplier;
      if (!Number.isSafeInteger(value)) throw new Error("MODEL_ONNX_PROTOBUF_INVALID");
      if ((byte & 0x80) === 0) return value;
      multiplier *= 128;
    }
    throw new Error("MODEL_ONNX_PROTOBUF_INVALID");
  }

  async skipVarint(end = this.size) {
    for (let index = 0; index < 10; index += 1) {
      if (((await this.byte(end)) & 0x80) === 0) return;
    }
    throw new Error("MODEL_ONNX_PROTOBUF_INVALID");
  }

  async lengthEnd(parentEnd) {
    const length = await this.varint(parentEnd);
    const end = this.position + length;
    if (!Number.isSafeInteger(end) || end < this.position || end > parentEnd || end > this.size) {
      throw new Error("MODEL_ONNX_PROTOBUF_INVALID");
    }
    return end;
  }

  async string(parentEnd, maxBytes = 4096) {
    const end = await this.lengthEnd(parentEnd);
    const length = end - this.position;
    if (length > maxBytes) throw new Error("MODEL_ONNX_EXTERNAL_DATA_INVALID");
    const bytes = Buffer.allocUnsafe(length);
    let offset = 0;
    while (this.position < end) {
      const available = this.position >= this.bufferStart && this.position < this.bufferStart + this.bufferLength
        ? Math.min(end - this.position, this.bufferStart + this.bufferLength - this.position)
        : 0;
      if (!available) {
        await this.byte(end);
        this.position -= 1;
        continue;
      }
      this.buffer.copy(bytes, offset, this.position - this.bufferStart, this.position - this.bufferStart + available);
      this.position += available;
      offset += available;
    }
    return bytes.toString("utf8");
  }

  async field(end) {
    this.fieldsVisited += 1;
    if (this.fieldsVisited > 2_000_000) throw new Error("MODEL_ONNX_TOO_COMPLEX");
    const tag = await this.varint(end);
    const number = Math.floor(tag / 8);
    const wire = tag & 7;
    if (!number || ![0, 1, 2, 5].includes(wire)) throw new Error("MODEL_ONNX_PROTOBUF_INVALID");
    return { number, wire };
  }

  async skip(wire, end) {
    if (wire === 0) {
      await this.skipVarint(end);
      return;
    }
    if (wire === 1 || wire === 5) {
      const width = wire === 1 ? 8 : 4;
      if (this.position + width > end) throw new Error("MODEL_ONNX_PROTOBUF_INVALID");
      this.position += width;
      return;
    }
    if (wire === 2) {
      this.position = await this.lengthEnd(end);
      return;
    }
    throw new Error("MODEL_ONNX_PROTOBUF_INVALID");
  }
}

function assertLengthDelimited(field) {
  if (field.wire !== 2) throw new Error("MODEL_ONNX_PROTOBUF_INVALID");
}

async function scanOnnxStringEntry(reader, end) {
  let key = null;
  let value = null;
  while (reader.position < end) {
    const field = await reader.field(end);
    if (field.number === 1 || field.number === 2) {
      assertLengthDelimited(field);
      const text = await reader.string(end);
      if (field.number === 1) key = text;
      else value = text;
    } else {
      await reader.skip(field.wire, end);
    }
  }
  return { key, value };
}

async function scanOnnxTensor(reader, end, locations, depth) {
  if (depth > 64) throw new Error("MODEL_ONNX_TOO_COMPLEX");
  while (reader.position < end) {
    const field = await reader.field(end);
    if (field.number === 13) {
      assertLengthDelimited(field);
      const entry = await scanOnnxStringEntry(reader, await reader.lengthEnd(end));
      if (entry.key === "location") {
        if (typeof entry.value !== "string" || !entry.value) throw new Error("MODEL_EXTERNAL_DATA_LOCATION_INVALID");
        locations.add(entry.value);
      }
    } else {
      await reader.skip(field.wire, end);
    }
  }
}

async function scanOnnxSparseTensor(reader, end, locations, depth) {
  if (depth > 64) throw new Error("MODEL_ONNX_TOO_COMPLEX");
  while (reader.position < end) {
    const field = await reader.field(end);
    if (field.number === 1 || field.number === 2) {
      assertLengthDelimited(field);
      await scanOnnxTensor(reader, await reader.lengthEnd(end), locations, depth + 1);
    } else {
      await reader.skip(field.wire, end);
    }
  }
}

async function scanOnnxAttribute(reader, end, locations, depth) {
  if (depth > 64) throw new Error("MODEL_ONNX_TOO_COMPLEX");
  while (reader.position < end) {
    const field = await reader.field(end);
    if (field.number === 5 || field.number === 10) {
      assertLengthDelimited(field);
      await scanOnnxTensor(reader, await reader.lengthEnd(end), locations, depth + 1);
    } else if (field.number === 6 || field.number === 11) {
      assertLengthDelimited(field);
      await scanOnnxGraph(reader, await reader.lengthEnd(end), locations, depth + 1);
    } else if (field.number === 22 || field.number === 23) {
      assertLengthDelimited(field);
      await scanOnnxSparseTensor(reader, await reader.lengthEnd(end), locations, depth + 1);
    } else {
      await reader.skip(field.wire, end);
    }
  }
}

async function scanOnnxNode(reader, end, locations, depth) {
  if (depth > 64) throw new Error("MODEL_ONNX_TOO_COMPLEX");
  while (reader.position < end) {
    const field = await reader.field(end);
    if (field.number === 5) {
      assertLengthDelimited(field);
      await scanOnnxAttribute(reader, await reader.lengthEnd(end), locations, depth + 1);
    } else {
      await reader.skip(field.wire, end);
    }
  }
}

async function scanOnnxGraph(reader, end, locations, depth) {
  if (depth > 64) throw new Error("MODEL_ONNX_TOO_COMPLEX");
  while (reader.position < end) {
    const field = await reader.field(end);
    if (field.number === 1) {
      assertLengthDelimited(field);
      await scanOnnxNode(reader, await reader.lengthEnd(end), locations, depth + 1);
    } else if (field.number === 5) {
      assertLengthDelimited(field);
      await scanOnnxTensor(reader, await reader.lengthEnd(end), locations, depth + 1);
    } else if (field.number === 15) {
      assertLengthDelimited(field);
      await scanOnnxSparseTensor(reader, await reader.lengthEnd(end), locations, depth + 1);
    } else {
      await reader.skip(field.wire, end);
    }
  }
}

async function scanOnnxTrainingInfo(reader, end, locations, depth) {
  if (depth > 64) throw new Error("MODEL_ONNX_TOO_COMPLEX");
  while (reader.position < end) {
    const field = await reader.field(end);
    if (field.number === 1 || field.number === 2) {
      assertLengthDelimited(field);
      await scanOnnxGraph(reader, await reader.lengthEnd(end), locations, depth + 1);
    } else {
      await reader.skip(field.wire, end);
    }
  }
}

async function scanOnnxFunction(reader, end, locations, depth) {
  if (depth > 64) throw new Error("MODEL_ONNX_TOO_COMPLEX");
  while (reader.position < end) {
    const field = await reader.field(end);
    if (field.number === 7) {
      assertLengthDelimited(field);
      await scanOnnxNode(reader, await reader.lengthEnd(end), locations, depth + 1);
    } else if (field.number === 11) {
      assertLengthDelimited(field);
      await scanOnnxAttribute(reader, await reader.lengthEnd(end), locations, depth + 1);
    } else {
      await reader.skip(field.wire, end);
    }
  }
}

async function externalDataLocations(modelPath) {
  const handle = await open(modelPath, "r");
  try {
    const info = await handle.stat();
    const reader = new OnnxWireReader(handle, info.size);
    const locations = new Set();
    while (reader.position < reader.size) {
      const field = await reader.field(reader.size);
      if (field.number === 7) {
        assertLengthDelimited(field);
        await scanOnnxGraph(reader, await reader.lengthEnd(reader.size), locations, 1);
      } else if (field.number === 20) {
        assertLengthDelimited(field);
        await scanOnnxTrainingInfo(reader, await reader.lengthEnd(reader.size), locations, 1);
      } else if (field.number === 25) {
        assertLengthDelimited(field);
        await scanOnnxFunction(reader, await reader.lengthEnd(reader.size), locations, 1);
      } else {
        await reader.skip(field.wire, reader.size);
      }
    }
    return [...locations].sort((left, right) => left.localeCompare(right, "en"));
  } finally {
    await handle.close();
  }
}

function validateExternalDataSelection(locations, selectedEntries) {
  const selectedNames = selectedEntries.map(({ resolved }) => path.basename(resolved));
  for (const location of locations) {
    const normalized = path.posix.normalize(location);
    if (
      location.includes("\0")
      || /[\u0000-\u001f\u007f]/.test(location)
      || location.includes("\\")
      || path.posix.isAbsolute(location)
      || path.win32.isAbsolute(location)
      || normalized === "."
      || normalized === ".."
      || normalized.startsWith("../")
      || location !== path.posix.basename(location)
      || location !== path.win32.basename(location)
    ) throw new Error("MODEL_EXTERNAL_DATA_PATH_REJECTED");
  }
  const expected = new Set(locations);
  const actual = new Set(selectedNames);
  if (expected.size !== actual.size || [...expected].some((name) => !actual.has(name))) {
    throw new Error("MODEL_EXTERNAL_DATA_SELECTION_MISMATCH");
  }
}

function assertSafeSelectedExtension(filePath, { main = false } = {}) {
  const extension = path.extname(filePath).toLowerCase();
  if (BLOCKED_EXTENSIONS.has(extension)) throw new Error("MODEL_EXECUTABLE_FILE_REJECTED");
  if (main ? extension !== ".onnx" : extension === ".onnx") {
    throw new Error("MODEL_FILE_TYPE_UNSUPPORTED");
  }
}

async function copyOnnxSelection(sourcePaths, destinationRoot, tower, maxBytes = CUSTOM_MODEL_MAX_TOTAL_BYTES) {
  if (!Array.isArray(sourcePaths) || sourcePaths.length < 1 || sourcePaths.length > 64) {
    throw new Error("MODEL_ONNX_SELECTION_INVALID");
  }
  const resolvedEntries = [];
  for (const sourcePath of sourcePaths) {
    const entry = await assertRegularSource(sourcePath);
    resolvedEntries.push({ sourcePath, ...entry });
  }
  const mainEntries = resolvedEntries.filter(({ resolved }) => path.extname(resolved).toLowerCase() === ".onnx");
  if (mainEntries.length !== 1) throw new Error("MODEL_ONNX_MAIN_FILE_REQUIRED");
  const externalEntries = resolvedEntries.filter((entry) => entry !== mainEntries[0]);
  validateExternalDataSelection(await externalDataLocations(mainEntries[0].resolved), externalEntries);
  const sourceRoot = path.dirname(mainEntries[0].resolved);
  const names = new Set();
  const descriptions = [];
  let totalBytes = 0;
  for (const entry of resolvedEntries) {
    if (path.dirname(entry.resolved) !== sourceRoot) throw new Error("MODEL_EXTERNAL_DATA_DIRECTORY_MISMATCH");
    const main = entry === mainEntries[0];
    assertSafeSelectedExtension(entry.resolved, { main });
    const name = path.basename(entry.resolved);
    const key = name.toLowerCase();
    if (names.has(key)) throw new Error("MODEL_FILE_NAME_COLLISION");
    names.add(key);
    if (totalBytes + entry.info.size > maxBytes) throw new Error("MODEL_TOTAL_SIZE_EXCEEDED");
    const description = await copyAndDescribe(
      entry.resolved,
      destinationRoot,
      `${tower}/${name}`,
      main ? tower : `${tower}-external`,
      maxBytes - totalBytes,
    );
    totalBytes += description.size;
    descriptions.push(description);
  }
  return { mainPath: `${tower}/${path.basename(mainEntries[0].resolved)}`, files: descriptions, totalBytes };
}

async function listTokenizerSources(rootPath) {
  const selectedInfo = await lstat(rootPath);
  if (!selectedInfo.isDirectory() || selectedInfo.isSymbolicLink()) throw new Error("MODEL_TOKENIZER_DIRECTORY_INVALID");
  const resolvedRoot = await realpath(rootPath);
  const rootInfo = await lstat(resolvedRoot);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error("MODEL_TOKENIZER_DIRECTORY_INVALID");
  const result = [];
  let totalBytes = 0;
  let visitedEntries = 0;
  async function visit(currentPath, relativeBase = "") {
    const entries = (await readdir(currentPath, { withFileTypes: true }))
      .sort((left, right) => left.name.localeCompare(right.name, "en"));
    for (const entry of entries) {
      visitedEntries += 1;
      if (visitedEntries > 1024) throw new Error("MODEL_TOKENIZER_TOO_MANY_ENTRIES");
      if (result.length >= 256) throw new Error("MODEL_TOKENIZER_TOO_MANY_FILES");
      const sourcePath = path.join(currentPath, entry.name);
      const linkInfo = await lstat(sourcePath);
      if (linkInfo.isSymbolicLink()) throw new Error("MODEL_TOKENIZER_LINK_REJECTED");
      const relativePath = path.posix.join(relativeBase, entry.name);
      if (entry.isDirectory()) {
        await visit(sourcePath, relativePath);
      } else {
        if (!entry.isFile()) throw new Error("MODEL_TOKENIZER_ENTRY_INVALID");
        const extension = path.extname(entry.name).toLowerCase();
        if (BLOCKED_EXTENSIONS.has(extension)) throw new Error("MODEL_EXECUTABLE_FILE_REJECTED");
        if (!SAFE_TOKENIZER_EXTENSIONS.has(extension)) continue;
        const info = await stat(sourcePath);
        totalBytes += info.size;
        if (totalBytes > CUSTOM_TOKENIZER_MAX_BYTES) throw new Error("MODEL_TOKENIZER_SIZE_EXCEEDED");
        result.push({ sourcePath, relativePath, size: info.size });
      }
    }
  }
  await visit(resolvedRoot);
  if (!result.some(({ relativePath }) => relativePath.toLowerCase().endsWith("tokenizer.json"))) {
    throw new Error("MODEL_TOKENIZER_JSON_REQUIRED");
  }
  return { sources: result, totalBytes };
}

async function copyTokenizer(sourceRoot, destinationRoot, maxBytes) {
  const files = [];
  const tokenizer = await listTokenizerSources(sourceRoot);
  if (tokenizer.totalBytes > maxBytes) throw new Error("MODEL_TOTAL_SIZE_EXCEEDED");
  for (const source of tokenizer.sources) {
    const copiedBytes = files.reduce((sum, file) => sum + file.size, 0);
    files.push(await copyAndDescribe(
      source.sourcePath,
      destinationRoot,
      path.posix.join("text", "tokenizer", source.relativePath),
      "tokenizer",
      maxBytes - copiedBytes,
    ));
  }
  return files;
}

function runProbe(probePayload) {
  const probePath = fileURLToPath(new URL("./custom-model-probe.mjs", import.meta.url));
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--max-old-space-size=512", probePath], {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback(value);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(reject, new Error("MODEL_VALIDATION_TIMEOUT"));
    }, CUSTOM_VALIDATION_TIMEOUT_MS);
    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify(probePayload));
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
      if (stdout.length > PROBE_OUTPUT_LIMIT) {
        child.kill();
        finish(reject, new Error("MODEL_VALIDATION_OUTPUT_TOO_LARGE"));
      }
    });
    child.stderr.on("data", (chunk) => {
      if (stderr.length <= 64 * 1024) stderr += chunk.toString("utf8");
    });
    child.once("error", (error) => finish(reject, error));
    child.once("exit", (code) => {
      if (settled) return;
      if (code !== 0) {
        const probeCode = stderr.trim().split(/\r?\n/).at(-1) || "";
        const safeCode = /^MODEL_[A-Z0-9_]{2,100}$/.test(probeCode)
          ? probeCode
          : "MODEL_VALIDATION_PROCESS_FAILED";
        return finish(reject, new Error(safeCode));
      }
      try {
        finish(resolve, JSON.parse(stdout));
      } catch {
        finish(reject, new Error("MODEL_VALIDATION_RESULT_INVALID"));
      }
    });
  });
}

function modelFingerprint(manifest) {
  const canonical = {
    schemaVersion: manifest.schemaVersion,
    kind: manifest.kind,
    dimensions: manifest.dimensions,
    preprocessing: manifest.preprocessing,
    inspection: manifest.inspection,
    files: manifest.files
      .map(({ role, path: filePath, size, sha256 }) => ({ role, path: filePath, size, sha256 }))
      .sort((left, right) => `${left.role}\0${left.path}`.localeCompare(`${right.role}\0${right.path}`, "en")),
  };
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

export class LocalModelManager {
  constructor({ modelRoot, fetchImpl, files = MODEL_FILES }) {
    this.modelRoot = modelRoot;
    this.fetchImpl = fetchImpl;
    this.files = files;
    this.totalBytes = files.reduce((sum, file) => sum + file.size, 0);
    this.job = null;
    this.cachedInspection = null;
  }

  resolveFile(file) {
    return path.join(this.modelRoot, file.model, ...file.relativePath.split("/"));
  }

  async inspect({ force = false } = {}) {
    if (["downloading", "importing"].includes(this.job?.state)) {
      return { version: LOCAL_IMAGE_SEARCH_VERSION, ready: false, state: this.job.state, downloadedBytes: this.job.downloadedBytes, totalBytes: this.totalBytes || MODEL_TOTAL_BYTES, error: null };
    }
    if (!force && this.job?.state === "ready") {
      return { version: LOCAL_IMAGE_SEARCH_VERSION, ready: true, state: "ready", downloadedBytes: this.totalBytes, totalBytes: this.totalBytes || MODEL_TOTAL_BYTES, error: null };
    }
    if (!force && this.cachedInspection && !this.job) return this.cachedInspection;
    let downloadedBytes = 0;
    let ready = true;
    for (const file of this.files) {
      const matches = await fileMatches(this.resolveFile(file), file);
      if (matches) downloadedBytes += file.size;
      else ready = false;
    }
    const visibleJob = force ? null : this.job;
    const result = {
      version: LOCAL_IMAGE_SEARCH_VERSION,
      ready,
      state: visibleJob?.state || (ready ? "ready" : "missing"),
      downloadedBytes: visibleJob?.downloadedBytes ?? downloadedBytes,
      totalBytes: this.totalBytes || MODEL_TOTAL_BYTES,
      error: visibleJob?.error || null,
    };
    if (!visibleJob) this.cachedInspection = result;
    return result;
  }

  async inspectManifest(manifest, modelRoot = this.modelRoot) {
    try {
      if (!Array.isArray(manifest?.files) || manifest.files.length < 1) throw new Error("MODEL_FILES_REQUIRED");
      const relativeRoot = manifest.relativeRoot === "." ? "." : normalizeRelativePath(manifest.relativeRoot);
      const root = relativeRoot === "." ? path.resolve(modelRoot) : path.resolve(modelRoot, ...relativeRoot.split("/"));
      if (!isInside(modelRoot, root, { allowRoot: true })) throw new Error("MODEL_ROOT_INVALID");
      let totalBytes = 0;
      for (const file of manifest.files || []) {
        const relativePath = normalizeRelativePath(file.path);
        const filePath = path.resolve(root, ...relativePath.split("/"));
        if (!isInside(root, filePath)) throw new Error("MODEL_FILE_PATH_INVALID");
        const linkInfo = await lstat(filePath);
        if (!linkInfo.isFile() || linkInfo.isSymbolicLink()) throw new Error("MODEL_FILE_LINK_REJECTED");
        const canonicalPath = await realpath(filePath);
        if (!isInside(root, canonicalPath) || !(await fileMatches(canonicalPath, file))) {
          throw new Error("MODEL_FILE_MISMATCH");
        }
        totalBytes += Number(file.size || 0);
      }
      return { ready: true, state: "ready", totalBytes, error: null };
    } catch {
      return { ready: false, state: "missing", totalBytes: Number(manifest?.totalBytes || 0), error: "模型文件缺失或校验失败" };
    }
  }

  resolveManifestRoot(manifest) {
    const relativeRoot = manifest.relativeRoot === "." ? "." : normalizeRelativePath(manifest.relativeRoot);
    const root = relativeRoot === "."
      ? path.resolve(this.modelRoot)
      : path.resolve(this.modelRoot, ...relativeRoot.split("/"));
    if (!isInside(this.modelRoot, root, { allowRoot: true })) throw new Error("MODEL_ROOT_INVALID");
    return root;
  }

  resolveManifestFile(root, relativePath) {
    const safePath = normalizeRelativePath(relativePath);
    const resolved = path.resolve(root, ...safePath.split("/"));
    if (!isInside(root, resolved)) throw new Error("MODEL_FILE_PATH_INVALID");
    return resolved;
  }

  async validateInstalledManifest(manifest) {
    const integrity = await this.inspectManifest(manifest);
    if (!integrity.ready) return integrity;
    try {
      const root = this.resolveManifestRoot(manifest);
      const externalData = (tower) => (tower?.externalData || []).map((filePath) => ({
        path: path.posix.basename(filePath),
        data: this.resolveManifestFile(root, filePath),
      }));
      const inspection = await runProbe({
        type: manifest.kind,
        preprocessing: manifest.preprocessing || manifest.vision,
        visionPath: this.resolveManifestFile(root, manifest.vision.modelPath),
        visionExternalData: externalData(manifest.vision),
        textPath: manifest.text ? this.resolveManifestFile(root, manifest.text.modelPath) : null,
        tokenizerRoot: manifest.text
          ? this.resolveManifestFile(root, manifest.text.tokenizerRoot || manifest.text.modelRoot)
          : null,
        textExternalData: externalData(manifest.text),
      });
      if (
        inspection.dimensions !== manifest.dimensions
        || Boolean(inspection.supportsText) !== Boolean(manifest.supportsText)
      ) throw new Error("MODEL_RUNTIME_METADATA_CHANGED");
      return { ...integrity, inspection };
    } catch (error) {
      return {
        ready: false,
        state: "error",
        totalBytes: integrity.totalBytes,
        error: String(error?.message || "MODEL_VALIDATION_FAILED").slice(0, 160),
      };
    }
  }

  async prepareCustomValidation({ type, preprocessing, visionFiles, textFiles = [], tokenizerRoot = null }) {
    if (!["image", "image-text"].includes(type)) throw new Error("MODEL_TYPE_INVALID");
    const stagingRoot = path.join(this.modelRoot, `.validation-${randomUUID()}`);
    await rm(stagingRoot, { recursive: true, force: true });
    await mkdir(stagingRoot, { recursive: true });
    try {
      const normalizedPreprocessing = normalizePreprocessing(preprocessing);
      const vision = await copyOnnxSelection(visionFiles, stagingRoot, "vision");
      let text = null;
      let tokenizerFiles = [];
      if (type === "image-text") {
        text = await copyOnnxSelection(
          textFiles,
          stagingRoot,
          "text",
          CUSTOM_MODEL_MAX_TOTAL_BYTES - vision.totalBytes,
        );
        if (!tokenizerRoot) throw new Error("MODEL_TOKENIZER_DIRECTORY_REQUIRED");
        tokenizerFiles = await copyTokenizer(
          tokenizerRoot,
          stagingRoot,
          CUSTOM_MODEL_MAX_TOTAL_BYTES - vision.totalBytes - text.totalBytes,
        );
      }
      const files = [...vision.files, ...(text?.files || []), ...tokenizerFiles];
      const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
      if (totalBytes > CUSTOM_MODEL_MAX_TOTAL_BYTES) throw new Error("MODEL_TOTAL_SIZE_EXCEEDED");
      const inspection = await runProbe({
        type,
        preprocessing: normalizedPreprocessing,
        visionPath: path.join(stagingRoot, ...vision.mainPath.split("/")),
        visionExternalData: vision.files
          .filter((file) => file.role === "vision-external")
          .map((file) => ({ path: path.posix.basename(file.path), data: path.join(stagingRoot, ...file.path.split("/")) })),
        textPath: text ? path.join(stagingRoot, ...text.mainPath.split("/")) : null,
        tokenizerRoot: text ? path.join(stagingRoot, "text", "tokenizer") : null,
        textExternalData: text ? text.files
          .filter((file) => file.role === "text-external")
          .map((file) => ({ path: path.posix.basename(file.path), data: path.join(stagingRoot, ...file.path.split("/")) })) : [],
      });
      if (
        !inspection
        || !Number.isInteger(inspection.dimensions)
        || inspection.dimensions < 16
        || inspection.dimensions > 4096
      ) throw new Error("MODEL_OUTPUT_DIMENSIONS_UNSUPPORTED");
      if (normalizedPreprocessing.dimensions && normalizedPreprocessing.dimensions !== inspection.dimensions) {
        throw new Error("MODEL_DIMENSIONS_MISMATCH");
      }
      const manifest = {
        schemaVersion: CUSTOM_MODEL_SCHEMA_VERSION,
        kind: type,
        dimensions: inspection.dimensions,
        supportsText: type === "image-text",
        builtin: false,
        certification: "unverified",
        preprocessing: { ...normalizedPreprocessing, dimensions: inspection.dimensions },
        inspection,
        totalBytes,
        relativeRoot: null,
        vision: {
          modelPath: vision.mainPath,
          modelRoot: "vision",
          externalData: vision.files.filter((file) => file.role === "vision-external").map((file) => file.path),
          ...normalizedPreprocessing,
          inputName: inspection.vision.inputName,
          outputName: inspection.vision.outputName,
          dimensions: inspection.dimensions,
        },
        text: text ? {
          modelPath: text.mainPath,
          modelRoot: "text/tokenizer",
          tokenizerRoot: "text/tokenizer",
          externalData: text.files.filter((file) => file.role === "text-external").map((file) => file.path),
          inputName: inspection.text.inputName,
          inputNames: inspection.text.inputNames,
          outputName: inspection.text.outputName,
          normalizeOutput: normalizedPreprocessing.normalizeOutput,
        } : null,
        files: files.sort((left, right) => `${left.role}\0${left.path}`.localeCompare(`${right.role}\0${right.path}`, "en")),
      };
      manifest.fingerprint = modelFingerprint(manifest);
      manifest.id = manifest.fingerprint;
      manifest.relativeRoot = `custom/${manifest.id}`;
      return { stagingRoot, manifest, inspection, files };
    } catch (error) {
      await rm(stagingRoot, { recursive: true, force: true });
      throw error;
    }
  }

  async installValidated(validation, { name, license }) {
    const manifest = structuredClone(validation.manifest);
    manifest.name = String(name || "自定义 ONNX 模型").trim().slice(0, 120) || "自定义 ONNX 模型";
    manifest.license = String(license || "未声明").trim().slice(0, 200) || "未声明";
    manifest.createdAt = new Date().toISOString();
    const targetRoot = path.join(this.modelRoot, "custom", manifest.id);
    if (!isInside(this.modelRoot, targetRoot)) throw new Error("MODEL_INSTALL_PATH_INVALID");
    await mkdir(path.dirname(targetRoot), { recursive: true });
    let installedNew = true;
    let backupRoot = null;
    try {
      await rename(validation.stagingRoot, targetRoot);
    } catch (error) {
      const targetInfo = await stat(targetRoot).catch(() => null);
      if (!targetInfo?.isDirectory()) throw error;
      const existing = await this.inspectManifest(manifest);
      const existingManifest = await readFile(path.join(targetRoot, "manifest.json"), "utf8")
        .then((value) => JSON.parse(value))
        .catch(() => null);
      const complete = existing.ready
        && existingManifest?.id === manifest.id
        && existingManifest?.fingerprint === manifest.fingerprint
        && existingManifest?.schemaVersion === manifest.schemaVersion;
      if (complete) {
        installedNew = false;
        await rm(validation.stagingRoot, { recursive: true, force: true });
      } else {
        backupRoot = `${targetRoot}.backup-${randomUUID()}`;
        await rename(targetRoot, backupRoot);
        try {
          await rename(validation.stagingRoot, targetRoot);
        } catch (replaceError) {
          await rename(backupRoot, targetRoot).catch(() => {});
          throw replaceError;
        }
      }
    }
    if (installedNew) {
      try {
        await writeFile(path.join(targetRoot, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
      } catch (error) {
        await rm(targetRoot, { recursive: true, force: true });
        if (backupRoot) await rename(backupRoot, targetRoot).catch(() => {});
        throw error;
      }
    }
    return { manifest, targetRoot, installedNew, backupRoot };
  }

  async rollbackInstall(installResult) {
    if (installResult?.installedNew && installResult.targetRoot) {
      let cleanupError = null;
      try {
        await rm(installResult.targetRoot, { recursive: true, force: true });
      } catch (error) {
        cleanupError = error;
      }
      if (installResult.backupRoot) {
        await rename(installResult.backupRoot, installResult.targetRoot);
      }
      if (cleanupError) throw cleanupError;
    }
  }

  async commitInstall(installResult) {
    if (installResult?.backupRoot) {
      await rm(installResult.backupRoot, { recursive: true, force: true });
    }
  }

  async stageRemoval(manifest) {
    const trashRoot = path.join(this.modelRoot, `.removal-${randomUUID()}`);
    const entries = [];
    await mkdir(trashRoot, { recursive: true });
    if (manifest?.builtin) {
      const candidates = (await readdir(this.modelRoot, { withFileTypes: true }).catch(() => []))
        .filter((entry) => entry.name !== "custom" && !entry.name.startsWith(".validation-") && !entry.name.startsWith(".removal-"));
      try {
        for (const entry of candidates) {
          await rename(path.join(this.modelRoot, entry.name), path.join(trashRoot, entry.name));
          entries.push(entry.name);
        }
      } catch (error) {
        await this.rollbackRemoval({ trashRoot, entries, builtin: true });
        throw error;
      }
      return { trashRoot, entries, builtin: true };
    }
    const relativeRoot = normalizeRelativePath(manifest?.relativeRoot || "");
    const targetRoot = path.resolve(this.modelRoot, ...relativeRoot.split("/"));
    if (!isInside(path.join(this.modelRoot, "custom"), targetRoot)) throw new Error("MODEL_REMOVE_PATH_REJECTED");
    try {
      await rename(targetRoot, path.join(trashRoot, "model"));
      entries.push({ source: targetRoot, trashName: "model" });
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    return { trashRoot, entries, builtin: false };
  }

  async rollbackRemoval(removal) {
    if (!removal?.trashRoot) return;
    const failures = [];
    if (removal.builtin) {
      for (const name of removal.entries || []) {
        await rename(path.join(removal.trashRoot, name), path.join(this.modelRoot, name))
          .catch((error) => failures.push(error));
      }
    } else {
      for (const entry of removal.entries || []) {
        await mkdir(path.dirname(entry.source), { recursive: true });
        await rename(path.join(removal.trashRoot, entry.trashName), entry.source)
          .catch((error) => failures.push(error));
      }
    }
    if (failures.length) throw failures[0];
    await rm(removal.trashRoot, { recursive: true, force: true });
  }

  async commitRemoval(removal) {
    this.cachedInspection = null;
    this.job = null;
    await rm(removal?.trashRoot, { recursive: true, force: true });
  }

  async removeInstalled(manifest) {
    const removal = await this.stageRemoval(manifest);
    await this.commitRemoval(removal);
    return true;
  }

  startDownload() {
    if (["downloading", "importing", "exporting"].includes(this.job?.state)) return false;
    const abortController = new AbortController();
    this.cachedInspection = null;
    this.job = { state: "downloading", downloadedBytes: 0, error: null, abortController };
    this.runDownload(abortController.signal).catch((error) => {
      if (error?.name === "AbortError") this.job.state = "canceled";
      else {
        this.job.state = "error";
        this.job.error = "模型下载或校验失败，请重试";
      }
    });
    return true;
  }

  cancelDownload() {
    if (this.job?.state !== "downloading") return false;
    this.job.abortController.abort();
    return true;
  }

  runPackageWorker(workerData, onProgress = () => {}) {
    return new Promise((resolve, reject) => {
      const worker = new Worker(new URL("./model-package-worker.mjs", import.meta.url), { workerData });
      worker.on("message", (message) => {
        if (message?.type === "progress") onProgress(message.completedBytes);
        else if (message?.type === "complete") resolve(message.result);
        else if (message?.type === "error") reject(new Error(message.code));
      });
      worker.once("error", reject);
      worker.once("exit", (code) => { if (code !== 0) reject(new Error("MODEL_PACKAGE_WORKER_FAILED")); });
    });
  }

  startImport(packagePath) {
    if (["downloading", "importing", "exporting"].includes(this.job?.state)) return false;
    this.cachedInspection = null;
    this.job = { state: "importing", downloadedBytes: 0, error: null };
    this.packagePromise = this.runImport(packagePath).catch((error) => {
      this.job.state = "error";
      this.job.error = "离线模型包无效、版本不匹配或文件已损坏";
      throw error;
    });
    return true;
  }

  async runImport(packagePath) {
    const parentRoot = path.dirname(this.modelRoot);
    const stagingRoot = path.join(parentRoot, `.models-import-${randomUUID()}`);
    const backupRoot = path.join(parentRoot, `.models-backup-${randomUUID()}`);
    const installedTowers = [];
    const backedUpTowers = [];
    try {
      await this.runPackageWorker({ action: "import", packagePath, stagingRoot, files: this.files },
        (completedBytes) => { this.job.downloadedBytes = completedBytes; });
      await mkdir(this.modelRoot, { recursive: true });
      await mkdir(backupRoot, { recursive: true });
      const packageTowers = [...new Set(this.files.map((file) => file.model))].sort();
      for (const tower of packageTowers) {
        const currentTower = path.join(this.modelRoot, tower);
        const stagedTower = path.join(stagingRoot, tower);
        const backupTower = path.join(backupRoot, tower);
        try {
          await rename(currentTower, backupTower);
          backedUpTowers.push(tower);
        } catch (error) {
          if (error?.code !== "ENOENT") throw error;
        }
        await rename(stagedTower, currentTower);
        installedTowers.push(tower);
      }
      await rm(stagingRoot, { recursive: true, force: true }).catch(() => {});
      this.cachedInspection = null;
      this.job.state = "ready";
      this.job.downloadedBytes = this.totalBytes;
      this.job.error = null;
      await rm(backupRoot, { recursive: true, force: true }).catch(() => {});
    } catch (error) {
      await rm(stagingRoot, { recursive: true, force: true }).catch(() => {});
      for (const tower of installedTowers) {
        await rm(path.join(this.modelRoot, tower), { recursive: true, force: true }).catch(() => {});
      }
      const restoreErrors = [];
      for (const tower of backedUpTowers) {
        try {
          await rename(path.join(backupRoot, tower), path.join(this.modelRoot, tower));
        } catch (restoreError) {
          restoreErrors.push(restoreError);
        }
      }
      if (restoreErrors.length) {
        throw new AggregateError(
          [error, ...restoreErrors],
          `MODEL_IMPORT_ROLLBACK_FAILED:${backupRoot}`,
        );
      }
      await rm(backupRoot, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
  }

  async exportPackage(packagePath) {
    const inspection = await this.inspect();
    if (!inspection.ready) throw new Error("MODEL_NOT_READY");
    const previousJob = this.job;
    this.job = { state: "exporting", downloadedBytes: this.totalBytes, error: null };
    try {
      const result = await this.runPackageWorker({ action: "export", packagePath, modelRoot: this.modelRoot, files: this.files });
      this.job = { state: "ready", downloadedBytes: this.totalBytes, error: null };
      return result;
    } catch (error) {
      this.job = previousJob;
      throw error;
    }
  }

  async runDownload(signal) {
    await mkdir(this.modelRoot, { recursive: true });
    let completed = 0;
    for (const file of this.files) {
      const target = this.resolveFile(file);
      if (await fileMatches(target, file)) {
        completed += file.size;
        this.job.downloadedBytes = completed;
        continue;
      }
      await mkdir(path.dirname(target), { recursive: true });
      const partial = `${target}.part`;
      await rm(partial, { force: true });
      const response = await this.fetchImpl(file.url, { signal });
      if (!response.ok || !response.body) throw new Error(`MODEL_HTTP_${response.status}`);
      let received = 0;
      const manager = this;
      const progress = new TransformStream({
        transform(chunk, controller) {
          received += chunk.byteLength;
          manager.job.downloadedBytes = completed + received;
          controller.enqueue(chunk);
        },
      });
      await pipeline(response.body.pipeThrough(progress), createWriteStream(partial), { signal });
      this.job.downloadedBytes = completed + received;
      if (!(await fileMatches(partial, file))) {
        await rm(partial, { force: true });
        throw new Error("MODEL_HASH_MISMATCH");
      }
      await rm(target, { force: true });
      await rename(partial, target);
      completed += file.size;
      this.job.downloadedBytes = completed;
    }
    this.job.state = "ready";
    this.job.error = null;
  }
}
