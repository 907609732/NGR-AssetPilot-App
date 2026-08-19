import { parentPort, workerData } from "node:worker_threads";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { opendir, readFile, stat } from "node:fs/promises";
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

const db = new DatabaseSync(workerData.dbPath);
db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
const canceledJobs = new Set();
let sessions = null;
let activeCache = null;
let executionProvider = "cpu";

function modelPath(model, relativePath) {
  return path.join(workerData.modelRoot, model, ...relativePath.split("/"));
}

async function loadModels() {
  if (sessions) return sessions;
  const providers = workerData.preferredProvider === "dml" ? ["dml"] : ["cpu"];
  let lastError;
  for (const provider of providers) {
    try {
      const sessionOptions = { executionProviders: [provider], graphOptimizationLevel: "all" };
      const vision = await ort.InferenceSession.create(
        modelPath("vision", "onnx/vision_model_quantized.onnx"), sessionOptions,
      );
      const text = await ort.InferenceSession.create(
        modelPath("text", "onnx/model_quantized.onnx"), sessionOptions,
      );
      const tokenizer = await AutoTokenizer.from_pretrained(path.join(workerData.modelRoot, "text"), {
        local_files_only: true,
      });
      executionProvider = provider;
      sessions = { vision, text, tokenizer };
      return sessions;
    } catch (error) {
      lastError = error;
      sessions = null;
    }
  }
  throw lastError || new Error("MODEL_LOAD_FAILED");
}

function normalizeVector(input) {
  const source = input instanceof Float32Array ? input : Float32Array.from(input);
  if (source.length !== EMBEDDING_DIMENSIONS) throw new Error("EMBEDDING_DIMENSION_INVALID");
  let squared = 0;
  for (let i = 0; i < source.length; i += 1) squared += source[i] * source[i];
  const scale = Math.sqrt(squared) || 1;
  const output = new Float32Array(source.length);
  for (let i = 0; i < source.length; i += 1) output[i] = source[i] / scale;
  return output;
}

function firstOutput(outputs, preferredNames) {
  for (const name of preferredNames) if (outputs[name]?.data) return outputs[name].data;
  for (const output of Object.values(outputs)) {
    if (output?.data?.length === EMBEDDING_DIMENSIONS) return output.data;
  }
  throw new Error("MODEL_OUTPUT_INVALID");
}

async function embedImageBytes(bytes) {
  const { vision } = await loadModels();
  const { data, info } = await sharp(bytes, { pages: 1, limitInputPixels: 50_000_000 })
    .rotate()
    .resize(224, 224, { fit: "cover", position: "centre" })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  if (info.channels !== 3) throw new Error("IMAGE_CHANNELS_INVALID");
  const mean = [0.48145466, 0.4578275, 0.40821073];
  const std = [0.26862954, 0.26130258, 0.27577711];
  const input = new Float32Array(3 * 224 * 224);
  for (let pixel = 0; pixel < 224 * 224; pixel += 1) {
    input[pixel] = (data[pixel * 3] / 255 - mean[0]) / std[0];
    input[224 * 224 + pixel] = (data[pixel * 3 + 1] / 255 - mean[1]) / std[1];
    input[2 * 224 * 224 + pixel] = (data[pixel * 3 + 2] / 255 - mean[2]) / std[2];
  }
  const inputName = vision.inputNames.includes("pixel_values") ? "pixel_values" : vision.inputNames[0];
  const outputs = await vision.run({ [inputName]: new ort.Tensor("float32", input, [1, 3, 224, 224]) });
  return normalizeVector(firstOutput(outputs, ["image_embeds"]));
}

function toOrtTensor(tensor) {
  const type = tensor.type === "int64" ? "int64" : tensor.type;
  return new ort.Tensor(type, tensor.data, tensor.dims);
}

async function embedText(text) {
  const loaded = await loadModels();
  const encoded = await loaded.tokenizer(text, { truncation: true, max_length: 128 });
  const feeds = {};
  for (const name of loaded.text.inputNames) {
    if (encoded[name]) feeds[name] = toOrtTensor(encoded[name]);
  }
  const outputs = await loaded.text.run(feeds);
  return normalizeVector(firstOutput(outputs, ["sentence_embedding", "text_embeds", "output"]));
}

async function sha256File(filePath) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
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

function emitProgress(jobId, progress) {
  parentPort.postMessage({ type: "progress", jobId, progress });
}

async function runIndex({ jobId, libraryId }) {
  const library = db.prepare("SELECT * FROM libraries WHERE id = ?").get(libraryId);
  if (!library) throw new Error("LIBRARY_NOT_FOUND");
  if (library.model_version !== LOCAL_IMAGE_SEARCH_VERSION) throw new Error("MODEL_VERSION_CHANGED");
  const generation = Number(library.scan_generation || 0) + 1;
  db.prepare("UPDATE libraries SET scan_generation = ?, status = 'indexing' WHERE id = ?").run(generation, libraryId);
  const progress = { state: "indexing", scanned: 0, analyzed: 0, reused: 0, skipped: 0, errors: 0 };
  const existingQuery = db.prepare("SELECT * FROM images WHERE library_id = ? AND relative_path = ?");
  const duplicateQuery = db.prepare(`
    SELECT embedding, width, height, format FROM images
    WHERE library_id = ? AND sha256 = ? AND embedding IS NOT NULL LIMIT 1
  `);
  const upsert = db.prepare(`
    INSERT INTO images(library_id, relative_path, mtime_ms, size_bytes, sha256, format, width, height, embedding, scan_generation, error_code)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(library_id, relative_path) DO UPDATE SET
      mtime_ms=excluded.mtime_ms, size_bytes=excluded.size_bytes, sha256=excluded.sha256,
      format=excluded.format, width=excluded.width, height=excluded.height,
      embedding=excluded.embedding, scan_generation=excluded.scan_generation, error_code=excluded.error_code
  `);
  for await (const relativePath of walkImages(library.root_path)) {
    if (canceledJobs.has(jobId)) {
      db.prepare("UPDATE libraries SET status = 'paused' WHERE id = ?").run(libraryId);
      return { ...progress, state: "canceled", executionProvider };
    }
    progress.scanned += 1;
    const absolutePath = path.join(library.root_path, relativePath);
    try {
      const info = await stat(absolutePath);
      const existing = existingQuery.get(libraryId, relativePath);
      if (existing?.embedding && Number(existing.mtime_ms) === info.mtimeMs && Number(existing.size_bytes) === info.size) {
        db.prepare("UPDATE images SET scan_generation = ? WHERE id = ?").run(generation, existing.id);
        progress.reused += 1;
      } else {
        const digest = await sha256File(absolutePath);
        const duplicate = duplicateQuery.get(libraryId, digest);
        let embedding;
        let metadata;
        if (duplicate) {
          embedding = duplicate.embedding;
          metadata = duplicate;
          progress.reused += 1;
        } else {
          metadata = await sharp(absolutePath, { pages: 1, limitInputPixels: 50_000_000 }).metadata();
          const vector = await embedImageBytes(await readFile(absolutePath));
          embedding = Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);
          progress.analyzed += 1;
        }
        upsert.run(
          libraryId, relativePath, info.mtimeMs, info.size, digest,
          metadata.format || path.extname(relativePath).slice(1), metadata.width || null, metadata.height || null,
          embedding, generation, null,
        );
      }
    } catch (error) {
      progress.errors += 1;
      const info = await stat(absolutePath).catch(() => ({ mtimeMs: 0, size: 0 }));
      upsert.run(libraryId, relativePath, info.mtimeMs, info.size, null, null, null, null, null, generation,
        String(error?.code || error?.name || "IMAGE_ANALYSIS_FAILED").slice(0, 64));
    }
    if (progress.scanned % 5 === 0) {
      emitProgress(jobId, progress);
      await new Promise((resolve) => setImmediate(resolve));
    }
  }
  db.prepare("DELETE FROM images WHERE library_id = ? AND scan_generation <> ?").run(libraryId, generation);
  const counts = db.prepare(`
    SELECT COUNT(embedding) AS item_count,
      SUM(CASE WHEN error_code IS NOT NULL THEN 1 ELSE 0 END) AS error_count
    FROM images WHERE library_id = ?
  `).get(libraryId);
  db.prepare(`
    UPDATE libraries SET status='ready', item_count=?, error_count=?, last_indexed_at=? WHERE id=?
  `).run(Number(counts.item_count || 0), Number(counts.error_count || 0), new Date().toISOString(), libraryId);
  if (activeCache?.libraryId === libraryId) activeCache = null;
  return { ...progress, state: "completed", executionProvider };
}

function loadCache(libraryId) {
  if (activeCache?.libraryId === libraryId) return activeCache;
  const rows = db.prepare(`
    SELECT id, relative_path, width, height, format, embedding FROM images
    WHERE library_id = ? AND embedding IS NOT NULL ORDER BY id
  `).all(libraryId);
  const vectors = new Float32Array(rows.length * EMBEDDING_DIMENSIONS);
  rows.forEach((row, index) => {
    const bytes = Buffer.from(row.embedding);
    const vector = new Float32Array(bytes.buffer, bytes.byteOffset, EMBEDDING_DIMENSIONS);
    vectors.set(vector, index * EMBEDDING_DIMENSIONS);
  });
  activeCache = { libraryId, rows, vectors };
  return activeCache;
}

function exactSearch(libraryId, query, limit = DEFAULT_RESULT_LIMIT) {
  const cache = loadCache(libraryId);
  return exactTopK(cache.vectors, cache.rows.length, query, limit).map(({ rowIndex, score }) => {
    const row = cache.rows[rowIndex];
    return {
      imageId: Number(row.id), relativePath: row.relative_path, fileName: path.basename(row.relative_path),
      width: row.width, height: row.height, format: row.format, score,
    };
  });
}

async function handleRequest(action, payload) {
  if (action === "index") return runIndex(payload);
  if (action === "cancel") {
    canceledJobs.add(payload.jobId);
    return { canceled: true };
  }
  if (action === "invalidate") {
    if (!payload.libraryId || activeCache?.libraryId === payload.libraryId) activeCache = null;
    return { invalidated: true };
  }
  if (action === "searchImage") {
    const vector = await embedImageBytes(Buffer.from(payload.bytes));
    return { results: exactSearch(payload.libraryId, vector, payload.limit), executionProvider };
  }
  if (action === "searchText") {
    const vector = await embedText(payload.text);
    return { results: exactSearch(payload.libraryId, vector, payload.limit), executionProvider };
  }
  if (action === "dispose") {
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
      type: "error", requestId,
      error: { code: String(error?.code || error?.message || "WORKER_FAILED").slice(0, 80) },
    });
  }
});
