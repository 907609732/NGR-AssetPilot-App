import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";
import { LocalImageSearchStorage } from "../desktop/services/local-image-search/storage.mjs";
import {
  BUILTIN_MODEL_FINGERPRINT,
  BUILTIN_MODEL_ID,
  LocalModelManager,
  normalizePreprocessing,
} from "../desktop/services/local-image-search/model-manager.mjs";
import { exactTopK } from "../desktop/services/local-image-search/vector-search.mjs";
import { LocalImageSearchController } from "../desktop/services/local-image-search/controller.mjs";

async function withTempDirectory(callback) {
  const root = await mkdtemp(path.join(os.tmpdir(), "ngr-local-search-"));
  try {
    return await callback(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function waitForModel(manager) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const status = await manager.inspect();
    if (["ready", "error", "canceled"].includes(status.state)) return status;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("model manager did not settle");
}

test("本地搜图库使用 WAL，删除索引不会删除中文原图目录", async () => withTempDirectory(async (root) => {
  const source = path.join(root, "中文图库");
  await mkdir(source);
  const original = path.join(source, "原图.png");
  await writeFile(original, Buffer.from("source-image"));
  const storage = new LocalImageSearchStorage({ dataRoot: path.join(root, "data") });
  const library = storage.createLibrary({ id: randomUUID(), rootPath: source, name: "中文图库" });
  assert.equal(storage.listLibraries()[0].name, "中文图库");
  assert.equal(storage.db.prepare("PRAGMA journal_mode").get().journal_mode, "wal");
  assert.ok(storage.db.prepare("PRAGMA table_info(library_models)").all().some((column) => column.name === "execution_profile"));
  assert.equal(storage.removeLibrary(library.id), true);
  storage.close();
  assert.equal((await readFile(original)).toString(), "source-image");
}));

test("旧版单张 CPU 向量升级时失效，图片元数据保留且重复启动保持幂等", async () => withTempDirectory(async (root) => {
  const dataRoot = path.join(root, "data");
  await mkdir(dataRoot);
  const dbPath = path.join(dataRoot, "index.sqlite3");
  const legacy = new DatabaseSync(dbPath);
  legacy.exec(`
    CREATE TABLE libraries (
      id TEXT PRIMARY KEY, root_path TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
      model_version TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'new',
      item_count INTEGER NOT NULL DEFAULT 0, error_count INTEGER NOT NULL DEFAULT 0,
      scan_generation INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, last_indexed_at TEXT
    );
    CREATE TABLE images (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      library_id TEXT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
      relative_path TEXT NOT NULL, mtime_ms REAL NOT NULL, size_bytes INTEGER NOT NULL,
      sha256 TEXT, format TEXT, width INTEGER, height INTEGER, embedding BLOB,
      scan_generation INTEGER NOT NULL DEFAULT 0, error_code TEXT,
      UNIQUE(library_id, relative_path)
    );
  `);
  const libraryId = randomUUID();
  const vector = Buffer.alloc(512 * 4, 7);
  legacy.prepare(`
    INSERT INTO libraries(id, root_path, name, model_version, status, item_count, scan_generation, created_at)
    VALUES (?, ?, '旧图库', 'clip-b32-multilingual-v1', 'ready', 1, 3, ?)
  `).run(libraryId, path.join(root, "source"), new Date().toISOString());
  legacy.prepare(`
    INSERT INTO images(library_id, relative_path, mtime_ms, size_bytes, sha256, embedding, scan_generation)
    VALUES (?, 'image.png', 1, 10, 'digest', ?, 3)
  `).run(libraryId, vector);
  legacy.close();

  for (let pass = 0; pass < 2; pass += 1) {
    const storage = new LocalImageSearchStorage({ dataRoot });
    assert.equal(storage.db.prepare("SELECT COUNT(*) AS count FROM image_embeddings WHERE library_id = ?").get(libraryId).count, 0);
    const metadata = storage.db.prepare(`
      SELECT relative_path, sha256, size_bytes, embedding, error_code FROM images WHERE library_id = ?
    `).get(libraryId);
    assert.equal(metadata.relative_path, "image.png");
    assert.equal(metadata.sha256, "digest");
    assert.equal(Number(metadata.size_bytes), 10);
    assert.equal(metadata.embedding, null);
    assert.equal(metadata.error_code, null);
    const libraryModel = storage.getLibraryModel(libraryId, BUILTIN_MODEL_ID);
    assert.equal(libraryModel.modelFingerprint, BUILTIN_MODEL_FINGERPRINT);
    assert.equal(libraryModel.status, "new");
    assert.equal(libraryModel.itemCount, 0);
    assert.equal(storage.getLibrary(libraryId, { modelId: BUILTIN_MODEL_ID }).itemCount, 0);
    storage.close();
  }
}));

test("索引配置升级只清理内置模型向量，并保留自定义模型向量", async () => withTempDirectory(async (root) => {
  const dataRoot = path.join(root, "data");
  const source = path.join(root, "source");
  await mkdir(source);
  const libraryId = randomUUID();
  const customModelId = "e".repeat(64);
  const customFingerprint = "f".repeat(64);
  let storage = new LocalImageSearchStorage({ dataRoot });
  storage.createLibrary({ id: libraryId, rootPath: source, name: "modern-old-profile" });
  const image = storage.db.prepare(`
    INSERT INTO images(library_id, relative_path, mtime_ms, size_bytes, sha256, width, height, embedding, error_code)
    VALUES (?, 'keep.png', 123, 456, 'keep-digest', 640, 480, ?, 'legacy-error') RETURNING id
  `).get(libraryId, Buffer.alloc(512 * 4, 1));
  storage.db.prepare(`
    INSERT INTO image_embeddings(library_id, image_id, model_id, model_fingerprint, dimensions, embedding)
    VALUES (?, ?, ?, ?, 512, ?)
  `).run(libraryId, image.id, BUILTIN_MODEL_ID, "old-builtin-fingerprint", Buffer.alloc(512 * 4, 2));
  storage.db.prepare(`
    INSERT INTO image_embeddings(library_id, image_id, model_id, model_fingerprint, dimensions, embedding)
    VALUES (?, ?, ?, ?, 32, ?)
  `).run(libraryId, image.id, customModelId, customFingerprint, Buffer.alloc(32 * 4, 3));
  storage.db.prepare(`
    INSERT INTO library_models(library_id, model_id, model_fingerprint, status, item_count)
    VALUES (?, ?, ?, 'ready', 1)
  `).run(libraryId, customModelId, customFingerprint);
  storage.db.prepare("UPDATE local_search_settings SET value='legacy-single-cpu' WHERE key='builtin_index_profile'").run();
  storage.close();

  for (let pass = 0; pass < 2; pass += 1) {
    storage = new LocalImageSearchStorage({ dataRoot });
    assert.equal(storage.db.prepare("SELECT COUNT(*) AS count FROM image_embeddings WHERE model_id = ?").get(BUILTIN_MODEL_ID).count, 0);
    assert.equal(storage.db.prepare("SELECT COUNT(*) AS count FROM image_embeddings WHERE model_id = ?").get(customModelId).count, 1);
    assert.equal(storage.db.prepare("SELECT COUNT(*) AS count FROM library_models WHERE model_id = ?").get(customModelId).count, 1);
    const metadata = storage.db.prepare("SELECT sha256, width, height, embedding, error_code FROM images WHERE id = ?").get(image.id);
    assert.equal(metadata.sha256, "keep-digest");
    assert.equal(Number(metadata.width), 640);
    assert.equal(Number(metadata.height), 480);
    assert.equal(metadata.embedding, null);
    assert.equal(metadata.error_code, null);
    const builtinState = storage.getLibraryModel(libraryId, BUILTIN_MODEL_ID);
    assert.equal(builtinState.modelFingerprint, BUILTIN_MODEL_FINGERPRINT);
    assert.equal(builtinState.status, "new");
    assert.equal(builtinState.itemCount, 0);
    storage.close();
  }
}));

test("不同模型向量相互隔离，删除当前自定义模型会恢复内置模型且不删除原图", async () => withTempDirectory(async (root) => {
  const source = path.join(root, "source");
  await mkdir(source);
  const original = path.join(source, "original.png");
  await writeFile(original, Buffer.from("source-stays"));
  const storage = new LocalImageSearchStorage({ dataRoot: path.join(root, "data") });
  const customId = "a".repeat(64);
  const customFingerprint = "b".repeat(64);
  storage.upsertModel({
    id: customId,
    fingerprint: customFingerprint,
    name: "自定义模型",
    kind: "image",
    version: "1",
    dimensions: 3,
    builtin: false,
    certification: "unverified",
    license: "MIT",
    relativeRoot: `custom/${customId}`,
    totalBytes: 10,
    files: [],
  });
  const library = storage.createLibrary({ id: randomUUID(), rootPath: source, name: "source" });
  const image = storage.db.prepare(`
    INSERT INTO images(library_id, relative_path, mtime_ms, size_bytes, sha256)
    VALUES (?, 'original.png', 1, 12, 'digest') RETURNING id
  `).get(library.id);
  storage.ensureLibraryModel(library.id, BUILTIN_MODEL_ID);
  storage.ensureLibraryModel(library.id, customId);
  storage.db.prepare(`
    INSERT INTO image_embeddings(library_id, image_id, model_id, model_fingerprint, dimensions, embedding)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(library.id, image.id, BUILTIN_MODEL_ID, BUILTIN_MODEL_FINGERPRINT, 512, Buffer.alloc(2048));
  storage.db.prepare(`
    INSERT INTO image_embeddings(library_id, image_id, model_id, model_fingerprint, dimensions, embedding)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(library.id, image.id, customId, customFingerprint, 3, Buffer.alloc(12));
  storage.setActiveModelId(customId);

  const removed = storage.removeModelData(customId);
  assert.equal(removed.removedEmbeddings, 1);
  assert.equal(storage.getModel(customId), null);
  assert.equal(storage.getActiveModelId(), BUILTIN_MODEL_ID);
  assert.equal(
    storage.db.prepare("SELECT value FROM local_search_settings WHERE key='active_model_id'").get().value,
    BUILTIN_MODEL_ID,
  );
  assert.equal(storage.db.prepare("SELECT COUNT(*) AS count FROM image_embeddings").get().count, 1);
  storage.close();
  assert.equal((await readFile(original)).toString(), "source-stays");
}));

test("模型先下载到 .part，SHA-256 正确后才启用", async () => withTempDirectory(async (root) => {
  const bytes = Buffer.from("fixed-local-model");
  const file = {
    model: "vision",
    relativePath: "onnx/tiny.onnx",
    size: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    url: "https://models.invalid/tiny.onnx",
  };
  const manager = new LocalModelManager({
    modelRoot: root,
    files: [file],
    fetchImpl: async () => new Response(bytes, { status: 200 }),
  });
  manager.startDownload();
  const status = await waitForModel(manager);
  assert.equal(status.ready, true);
  assert.deepEqual(await readFile(path.join(root, "vision", "onnx", "tiny.onnx")), bytes);
  await assert.rejects(readFile(path.join(root, "vision", "onnx", "tiny.onnx.part")));
  await unlink(path.join(root, "vision", "onnx", "tiny.onnx"));
  assert.equal((await manager.inspect()).ready, true, "普通状态读取可复用最近一次完整校验");
  const forced = await manager.inspect({ force: true });
  assert.equal(forced.ready, false, "启用模型前的强制校验必须发现运行中被移除的文件");
  assert.equal(forced.state, "missing");
}));

test("模型哈希不匹配时拒绝启用并允许重试", async () => withTempDirectory(async (root) => {
  const expected = Buffer.from("expected");
  const file = {
    model: "text",
    relativePath: "onnx/tiny.onnx",
    size: expected.length,
    sha256: createHash("sha256").update(expected).digest("hex"),
    url: "https://models.invalid/tiny.onnx",
  };
  const manager = new LocalModelManager({
    modelRoot: root,
    files: [file],
    fetchImpl: async () => new Response(Buffer.from("tampered"), { status: 200 }),
  });
  manager.startDownload();
  const status = await waitForModel(manager);
  assert.equal(status.ready, false);
  assert.equal(status.state, "error");
  await assert.rejects(readFile(path.join(root, "text", "onnx", "tiny.onnx")));
}));

test("离线模型包可导出后在无网络环境导入，并拒绝损坏包", async () => withTempDirectory(async (root) => {
  const bytes = Buffer.from("air-gapped-fixed-model");
  const file = {
    model: "vision",
    relativePath: "onnx/tiny.onnx",
    size: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    url: "https://models.invalid/tiny.onnx",
  };
  const onlineRoot = path.join(root, "online-models");
  await mkdir(path.join(onlineRoot, "vision", "onnx"), { recursive: true });
  await writeFile(path.join(onlineRoot, "vision", "onnx", "tiny.onnx"), bytes);
  const online = new LocalModelManager({ modelRoot: onlineRoot, files: [file], fetchImpl: fetch });
  const packagePath = path.join(root, "model.ngrmodel");
  await online.exportPackage(packagePath);

  const offlineRoot = path.join(root, "offline-models");
  const customMarker = path.join(offlineRoot, "custom", "existing-model", "keep.bin");
  await mkdir(path.dirname(customMarker), { recursive: true });
  await writeFile(customMarker, Buffer.from("keep-custom-model"));
  const offline = new LocalModelManager({
    modelRoot: offlineRoot,
    files: [file],
    fetchImpl: async () => { throw new Error("NETWORK_MUST_NOT_BE_USED"); },
  });
  assert.equal(offline.startImport(packagePath), true);
  await offline.packagePromise;
  assert.equal((await offline.inspect()).ready, true);
  assert.deepEqual(await readFile(path.join(offlineRoot, "vision", "onnx", "tiny.onnx")), bytes);
  assert.equal((await readFile(customMarker)).toString(), "keep-custom-model", "built-in package import must preserve custom models");

  const corruptedPackage = path.join(root, "corrupted.ngrmodel");
  await writeFile(corruptedPackage, Buffer.from("not-a-model-package"));
  assert.equal(offline.startImport(corruptedPackage), true);
  await assert.rejects(offline.packagePromise);
  assert.deepEqual(await readFile(path.join(offlineRoot, "vision", "onnx", "tiny.onnx")), bytes);
  assert.equal((await offline.inspect()).ready, true, "failed import must preserve the last valid model");
}));

test("自定义预处理清单严格限制布局、尺寸、维度和张量类型", () => {
  assert.deepEqual(normalizePreprocessing({ pixelType: "uint8" }), {
    layout: "NCHW",
    width: 224,
    height: 224,
    colorSpace: "RGB",
    resizeMode: "crop",
    cropMode: "center",
    pixelType: "uint8",
    scale: 1,
    mean: [0, 0, 0],
    std: [1, 1, 1],
    inputName: "",
    outputName: "",
    dimensions: 0,
    normalizeOutput: true,
    textInputName: "",
    textOutputName: "",
  });
  assert.throws(() => normalizePreprocessing({ resizeMode: "cover" }), /MODEL_PREPROCESSING_RESIZE_INVALID/);
  assert.throws(() => normalizePreprocessing({ pixelType: "float16" }), /MODEL_PREPROCESSING_PIXEL_TYPE_INVALID/);
  assert.throws(() => normalizePreprocessing({ width: 4097 }), /MODEL_PREPROCESSING_SIZE_INVALID/);
  assert.throws(() => normalizePreprocessing({ dimensions: 4097 }), /MODEL_PREPROCESSING_DIMENSIONS_INVALID/);
  assert.throws(() => normalizePreprocessing({ std: [1, 0, 1] }), /MODEL_PREPROCESSING_STD_INVALID/);
});

test("同指纹模型目录损坏时可原子替换，并在数据库失败前恢复旧目录", async () => withTempDirectory(async (root) => {
  const modelRoot = path.join(root, "models");
  const manager = new LocalModelManager({ modelRoot, files: [], fetchImpl: fetch });
  const modelId = "c".repeat(64);
  const relativeModelPath = "vision/model.onnx";
  const validBytes = Buffer.from("validated-new-model");
  const invalidBytes = Buffer.from("damaged-old-model");
  const manifest = {
    schemaVersion: 1,
    id: modelId,
    fingerprint: modelId,
    name: "repairable",
    kind: "image",
    version: "1",
    dimensions: 32,
    supportsText: false,
    builtin: false,
    certification: "unverified",
    relativeRoot: `custom/${modelId}`,
    totalBytes: validBytes.length,
    vision: { modelPath: relativeModelPath, modelRoot: "vision" },
    files: [{
      role: "vision",
      path: relativeModelPath,
      size: validBytes.length,
      sha256: createHash("sha256").update(validBytes).digest("hex"),
    }],
  };
  const targetFile = path.join(modelRoot, "custom", modelId, "vision", "model.onnx");
  await mkdir(path.dirname(targetFile), { recursive: true });
  await writeFile(targetFile, invalidBytes);

  const makeValidation = async (name) => {
    const stagingRoot = path.join(modelRoot, name);
    await mkdir(path.join(stagingRoot, "vision"), { recursive: true });
    await writeFile(path.join(stagingRoot, "vision", "model.onnx"), validBytes);
    return { stagingRoot, manifest };
  };
  const first = await manager.installValidated(await makeValidation(".validation-first"), { name: "repairable" });
  assert.ok(first.backupRoot, "damaged target must be backed up before replacement");
  assert.deepEqual(await readFile(targetFile), validBytes);
  await manager.rollbackInstall(first);
  assert.deepEqual(await readFile(targetFile), invalidBytes, "rollback must restore the pre-existing model");

  const second = await manager.installValidated(await makeValidation(".validation-second"), { name: "repairable" });
  await manager.commitInstall(second);
  assert.deepEqual(await readFile(targetFile), validBytes);
  assert.equal((await manager.inspectManifest(second.manifest)).ready, true);
}));

test("活动自定义模型文件在运行中缺失后，模型列表会立即标记为不可用", async () => withTempDirectory(async (root) => {
  const controller = new LocalImageSearchController({
    userDataPath: path.join(root, "appdata"),
    dialog: {},
    shell: {},
    netFetch: fetch,
    getWindow: () => null,
  });
  const modelId = "d".repeat(64);
  const bytes = Buffer.from("custom-model-file");
  const relativePath = "vision/model.onnx";
  const absolutePath = path.join(controller.modelRoot, "custom", modelId, "vision", "model.onnx");
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, bytes);
  controller.storage.upsertModel({
    schemaVersion: 1,
    id: modelId,
    fingerprint: modelId,
    name: "live-integrity-model",
    kind: "image",
    version: "1",
    dimensions: 32,
    supportsText: false,
    builtin: false,
    certification: "unverified",
    license: "MIT",
    relativeRoot: `custom/${modelId}`,
    totalBytes: bytes.length,
    vision: { modelPath: relativePath, modelRoot: "vision" },
    files: [{ role: "vision", path: relativePath, size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") }],
  });
  controller.storage.setActiveModelId(modelId);
  assert.equal((await controller.listModels()).models.find((model) => model.id === modelId).ready, true);
  await rm(absolutePath, { force: true });
  const missing = (await controller.listModels()).models.find((model) => model.id === modelId);
  assert.equal(missing.ready, false);
  assert.equal(missing.status, "missing");
  await controller.dispose();
}));

test("图库分析期间拒绝删除图库，避免索引事务与级联删除竞态", async () => withTempDirectory(async (root) => {
  const controller = new LocalImageSearchController({
    userDataPath: path.join(root, "appdata"),
    dialog: {},
    shell: {},
    netFetch: fetch,
    getWindow: () => null,
  });
  const source = path.join(root, "source");
  await mkdir(source);
  const library = controller.storage.createLibrary({ id: randomUUID(), rootPath: source, name: "busy-library" });
  controller.jobs.set(randomUUID(), { state: "indexing", libraryId: library.id });
  await assert.rejects(
    controller.removeLibrary({ libraryId: library.id }),
    { code: "LOCAL_SEARCH_JOB_BUSY" },
  );
  assert.ok(controller.storage.getLibrary(library.id));
  await controller.dispose();
}));

test("精确 Top-K 使用归一化点积并按相似度降序返回", () => {
  const dimensions = 512;
  const vectors = new Float32Array(3 * dimensions);
  const query = new Float32Array(dimensions);
  query[0] = 1;
  vectors[0] = 0.2;
  vectors[dimensions] = 0.9;
  vectors[dimensions * 2] = -0.5;
  assert.deepEqual(exactTopK(vectors, 3, query, 2), [
    { rowIndex: 1, score: 0.8999999761581421 },
    { rowIndex: 0, score: 0.20000000298023224 },
  ]);
});

test("精确 Top-K 支持自定义模型维度并稳定处理同分结果", () => {
  const query = Float32Array.from([1, 0, 0]);
  const vectors = Float32Array.from([
    0.5, 0, 0,
    0.8, 0, 0,
    0.8, 0, 0,
    -0.1, 0, 0,
  ]);
  assert.deepEqual(exactTopK(vectors, 4, query, 2), [
    { rowIndex: 1, score: 0.800000011920929 },
    { rowIndex: 2, score: 0.800000011920929 },
  ]);
  assert.throws(() => exactTopK(vectors, 4, Float32Array.from([1, 0]), 2), RangeError);
});

test("渲染层只能用 libraryId + imageId，越界结果路径会被拒绝", async () => withTempDirectory(async (root) => {
  const source = path.join(root, "library");
  await mkdir(source);
  await writeFile(path.join(root, "outside.png"), Buffer.from("outside"));
  const controller = new LocalImageSearchController({
    userDataPath: path.join(root, "appdata"),
    dialog: {},
    shell: {},
    netFetch: fetch,
    getWindow: () => null,
  });
  const libraryId = randomUUID();
  controller.storage.createLibrary({ id: libraryId, rootPath: source, name: "library" });
  const image = controller.storage.db.prepare(`
    INSERT INTO images(library_id, relative_path, mtime_ms, size_bytes, embedding)
    VALUES (?, '../outside.png', 1, 1, ?) RETURNING id
  `).get(libraryId, Buffer.alloc(512 * 4));
  await assert.rejects(
    controller.resolveImage({ libraryId, imageId: Number(image.id) }),
    { code: "LOCAL_SEARCH_PATH_REJECTED" },
  );
  await controller.dispose();
}));

test("删除本地模型会保留 SQLite 图库索引并重建空模型状态", async () => withTempDirectory(async (root) => {
  const userDataPath = path.join(root, "appdata");
  const controller = new LocalImageSearchController({
    userDataPath,
    dialog: {},
    shell: {},
    netFetch: fetch,
    getWindow: () => null,
  });
  const source = path.join(root, "source");
  await mkdir(source);
  const library = controller.storage.createLibrary({ id: randomUUID(), rootPath: source, name: "保留图库" });
  await mkdir(controller.modelRoot, { recursive: true });
  await writeFile(path.join(controller.modelRoot, "marker.bin"), Buffer.from("model"));
  const result = await controller.removeModel();
  assert.equal(result.removed, true);
  assert.equal(result.state, "missing");
  assert.equal(controller.storage.getLibrary(library.id).name, "保留图库");
  await assert.rejects(readFile(path.join(controller.modelRoot, "marker.bin")));
  await controller.dispose();
}));
