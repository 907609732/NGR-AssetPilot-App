import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rename, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";
import AdmZip from "adm-zip";
import sharp from "sharp";
import { LocalImageSearchStorage } from "../desktop/services/local-image-search/storage.mjs";
import { MODEL_FILES } from "../desktop/services/local-image-search/constants.mjs";
import {
  BUILTIN_MODEL_FINGERPRINT,
  BUILTIN_MODEL_ID,
  LEGACY_BUILTIN_MODEL_FINGERPRINT,
  LEGACY_BUILTIN_MODEL_ID,
  LocalModelManager,
  createBuiltinModelManifest,
  normalizePreprocessing,
} from "../desktop/services/local-image-search/model-manager.mjs";
import { exactTopK } from "../desktop/services/local-image-search/vector-search.mjs";
import { LocalImageSearchController } from "../desktop/services/local-image-search/controller.mjs";
import { LocalImageSearchEngine } from "../desktop/services/local-image-search/engine.mjs";
import { createIndexExecutionProfile } from "../desktop/services/local-image-search/execution-profile.mjs";

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

function cpuIndexFixture(root, model) {
  const manifest = createBuiltinModelManifest();
  const modelConfig = {
    id: model.id,
    fingerprint: model.fingerprint,
    dimensions: 512,
    kind: "image-text",
    supportsText: true,
    builtin: true,
    preprocessingVersion: manifest.indexProfile,
    vision: {
      ...manifest.vision,
      modelPath: path.join(root, "missing-q4.onnx"),
      colorOrder: "RGB",
    },
  };
  const executionProfile = createIndexExecutionProfile({
    modelFingerprint: model.fingerprint,
    preprocessingVersion: modelConfig.preprocessingVersion,
    preprocessing: {
      inputName: "pixel_values", outputName: "image_embeds", pixelType: "float32", layout: "NCHW",
      width: 224, height: 224, colorOrder: "RGB", resizeMode: "crop", cropMode: "center",
      scale: 1 / 255, mean: manifest.vision.mean, std: manifest.vision.std, normalizeOutput: true,
    },
    provider: "cpu", batchSize: 16, deviceId: null, driverFingerprint: null,
    onnxRuntimeVersion: "1.24.3", architecture: process.arch,
  });
  return { modelConfig, executionProfile };
}

test("q4f16 是新安装推荐模型，旧量化模型作为独立兼容项保留", async () => withTempDirectory(async (root) => {
  const vision = MODEL_FILES.find((file) => file.relativePath.endsWith("vision_model_q4f16.onnx"));
  assert.deepEqual(vision && {
    size: vision.size,
    sha256: vision.sha256,
    revisionPinned: vision.url.includes("d15189d7028b43f1d3e65039190477f6af591c2a"),
  }, {
    size: 53_267_374,
    sha256: "d238c4e0afe798c47c5991a046b923c5bcbeed19c2d75d7c0db845ba73bb7b87",
    revisionPinned: true,
  });
  assert.equal(createBuiltinModelManifest().vision.modelPath, "vision/onnx/vision_model_q4f16.onnx");
  const controller = new LocalImageSearchController({
    userDataPath: path.join(root, "appdata"), dialog: {}, shell: {}, netFetch: fetch, getWindow: () => null,
  });
  const models = await controller.listModels();
  assert.equal(models.activeModelId, BUILTIN_MODEL_ID);
  assert.deepEqual(models.models.filter((model) => model.builtin).map((model) => model.id).sort(), [
    BUILTIN_MODEL_ID,
    LEGACY_BUILTIN_MODEL_ID,
  ].sort());
  await controller.dispose();
}));

test("本地搜图库使用 WAL，删除索引不会删除中文原图目录", async () => withTempDirectory(async (root) => {
  const source = path.join(root, "中文图库");
  await mkdir(source);
  const original = path.join(source, "原图.png");
  await writeFile(original, Buffer.from("source-image"));
  const storage = new LocalImageSearchStorage({ dataRoot: path.join(root, "data") });
  const library = storage.createLibrary({ id: randomUUID(), rootPath: source, name: "中文图库" });
  assert.equal(storage.listLibraries()[0].name, "中文图库");
  assert.equal(storage.db.prepare("PRAGMA journal_mode").get().journal_mode, "wal");
  assert.equal(Number(storage.db.prepare("PRAGMA user_version").get().user_version), 3);
  assert.ok(storage.db.prepare("PRAGMA table_info(library_models)").all().some((column) => column.name === "execution_profile"));
  const indexes = new Set(storage.db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all().map((row) => row.name));
  assert.ok(indexes.has("image_embeddings_image_fk_idx"));
  assert.ok(indexes.has("images_browse_mtime_idx"));
  assert.ok(indexes.has("images_browse_size_idx"));
  assert.ok(storage.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='index_staging_jobs'").get());
  assert.ok(storage.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='index_staging_images'").get());
  assert.equal(storage.removeLibrary(library.id), true);
  storage.close();
  assert.equal((await readFile(original)).toString(), "source-image");
}));

test("旧版单张 CPU 向量升级到兼容模型，图片元数据和向量保留且重复启动保持幂等", async () => withTempDirectory(async (root) => {
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
    assert.equal(storage.db.prepare(`
      SELECT COUNT(*) AS count FROM image_embeddings
      WHERE library_id=? AND model_id=? AND model_fingerprint=?
    `).get(libraryId, LEGACY_BUILTIN_MODEL_ID, LEGACY_BUILTIN_MODEL_FINGERPRINT).count, 1);
    const metadata = storage.db.prepare(`
      SELECT relative_path, sha256, size_bytes, embedding, error_code FROM images WHERE library_id = ?
    `).get(libraryId);
    assert.equal(metadata.relative_path, "image.png");
    assert.equal(metadata.sha256, "digest");
    assert.equal(Number(metadata.size_bytes), 10);
    assert.equal(metadata.embedding, null);
    assert.equal(metadata.error_code, null);
    const libraryModel = storage.getLibraryModel(libraryId, LEGACY_BUILTIN_MODEL_ID);
    assert.equal(libraryModel.modelFingerprint, LEGACY_BUILTIN_MODEL_FINGERPRINT);
    assert.equal(libraryModel.status, "ready");
    assert.equal(libraryModel.itemCount, 1);
    assert.equal(storage.getActiveModelId(), LEGACY_BUILTIN_MODEL_ID);
    assert.equal(storage.getLibrary(libraryId, { modelId: LEGACY_BUILTIN_MODEL_ID }).itemCount, 1);
    assert.equal(storage.getLibraryModel(libraryId, BUILTIN_MODEL_ID).status, "new");
    storage.close();
  }
}));

test("素材目录按图库隔离，支持中文文件夹、固定分页以及 %/_ 字面筛选", async () => withTempDirectory(async (root) => {
  const storage = new LocalImageSearchStorage({ dataRoot: path.join(root, "data") });
  const first = storage.createLibrary({ id: randomUUID(), rootPath: path.join(root, "一号"), name: "一号" });
  const second = storage.createLibrary({ id: randomUUID(), rootPath: path.join(root, "二号"), name: "二号" });
  const insert = storage.db.prepare(`
    INSERT INTO images(library_id,relative_path,mtime_ms,size_bytes,format,width,height,error_code)
    VALUES (?,?,?,?,?,?,?,?)
  `);
  insert.run(first.id, "分类_%/子图/甲.png", 30, 300, "png", 30, 20, null);
  insert.run(first.id, "分类_%/乙.png", 20, 200, "png", 20, 10, null);
  insert.run(first.id, "另一个/丙.jpg", 10, 100, "jpg", 10, 10, "IMAGE_DAMAGED");
  insert.run(second.id, "分类_%/不能泄露.png", 40, 400, "png", 40, 40, null);
  storage.db.prepare(`
    UPDATE libraries SET catalog_item_count=3,catalog_status='ready',catalog_revision=7 WHERE id=?
  `).run(first.id);

  assert.deepEqual(storage.listAssetFolders({ libraryId: first.id, parentPrefix: "" }), {
    libraryId: first.id,
    catalogRevision: 7,
    parentPrefix: "",
    folders: [
      { name: "分类_%", prefix: "分类_%", itemCount: 2 },
      { name: "另一个", prefix: "另一个", itemCount: 1 },
    ],
  });
  assert.deepEqual(storage.listAssetFolders({ libraryId: first.id, parentPrefix: "分类_%" }).folders, [
    { name: "子图", prefix: "分类_%/子图", itemCount: 1 },
  ]);
  const literalPercent = storage.listAssets({
    libraryId: first.id, page: 1, pageSize: 100, folderPrefix: "", filter: "%", sort: "path-asc",
  });
  assert.equal(literalPercent.totalItems, 2);
  assert.ok(literalPercent.items.every((item) => item.relativePath.startsWith("分类_%/")));
  assert.ok(literalPercent.items.every((item) => !item.relativePath.includes("不能泄露")));
  const literalUnderscore = storage.listAssets({
    libraryId: first.id, page: 99, pageSize: 100, folderPrefix: "分类_%", filter: "_", sort: "size-desc",
  });
  assert.equal(literalUnderscore.page, 1);
  assert.deepEqual(literalUnderscore.items.map((item) => item.fileName), ["甲.png", "乙.png"]);
  assert.throws(
    () => storage.listAssets({ libraryId: first.id, page: 1, pageSize: 100, folderPrefix: "/分类_%" }),
    /LOCAL_SEARCH_ASSET_PREFIX_INVALID/,
  );
  assert.throws(
    () => storage.listAssets({ libraryId: first.id, page: 1, pageSize: 100, folderPrefix: "分类_\\%" }),
    /LOCAL_SEARCH_ASSET_PREFIX_INVALID/,
  );
  storage.close();
}));

test("图库根目录不可读时索引返回 INDEX_SCAN_INCOMPLETE 并保留旧记录为暂停状态", async () => withTempDirectory(async (root) => {
  const dataRoot = path.join(root, "data");
  const storage = new LocalImageSearchStorage({ dataRoot });
  const library = storage.createLibrary({
    id: randomUUID(), rootPath: path.join(root, "missing-library"), name: "离线图库",
  });
  storage.db.prepare(`
    INSERT INTO images(library_id,relative_path,mtime_ms,size_bytes,sha256,scan_generation)
    VALUES (?, '保留.png', 1, 1, 'keep', 1)
  `).run(library.id);
  const model = storage.getModel(BUILTIN_MODEL_ID);
  const image = storage.db.prepare("SELECT id FROM images WHERE library_id=?").get(library.id);
  const oldEmbedding = Buffer.alloc(512 * 4, 9);
  storage.ensureLibraryModel(library.id, model.id);
  storage.db.prepare(`
    UPDATE library_models
    SET status='ready',item_count=1,error_count=0,scan_generation=7,execution_profile='execution-v2:old-profile'
    WHERE library_id=? AND model_id=? AND model_fingerprint=?
  `).run(library.id, model.id, model.fingerprint);
  storage.db.prepare(`
    INSERT INTO image_embeddings(
      library_id,image_id,model_id,model_fingerprint,dimensions,embedding,scan_generation,error_code
    ) VALUES (?,?,?,?,512,?,7,NULL)
  `).run(library.id, image.id, model.id, model.fingerprint, oldEmbedding);
  storage.db.prepare(`
    UPDATE libraries SET status='ready',item_count=1,error_count=0,scan_generation=7,
      catalog_status='ready',catalog_item_count=1,catalog_revision=3
    WHERE id=?
  `).run(library.id);
  const engine = new LocalImageSearchEngine({ dbPath: storage.dbPath, modelRoot: path.join(dataRoot, "models") });
  await assert.rejects(engine.request("index", {
    jobId: randomUUID(),
    libraryId: library.id,
    modelId: model.id,
    modelConfig: {
      id: model.id,
      fingerprint: model.fingerprint,
      dimensions: 512,
      kind: "image-text",
      supportsText: true,
      builtin: true,
      preprocessingVersion: "test",
      vision: { modelPath: path.join(dataRoot, "missing.onnx") },
    },
  }), { code: "INDEX_SCAN_INCOMPLETE" });
  assert.equal(storage.db.prepare("SELECT COUNT(*) AS count FROM images WHERE library_id=?").get(library.id).count, 1);
  const preservedModel = storage.getLibraryModel(library.id, model.id);
  assert.equal(preservedModel.status, "paused");
  assert.equal(preservedModel.executionProfile, "execution-v2:old-profile");
  assert.equal(preservedModel.itemCount, 1);
  assert.equal(preservedModel.scanGeneration, 7);
  const preservedEmbedding = storage.db.prepare(`
    SELECT embedding,scan_generation FROM image_embeddings
    WHERE library_id=? AND image_id=? AND model_id=? AND model_fingerprint=?
  `).get(library.id, image.id, model.id, model.fingerprint);
  assert.deepEqual(Buffer.from(preservedEmbedding.embedding), oldEmbedding);
  assert.equal(preservedEmbedding.scan_generation, 7);
  const preservedLibrary = storage.getLibrary(library.id, { modelId: model.id });
  assert.equal(preservedLibrary.status, "paused");
  assert.equal(preservedLibrary.itemCount, 1);
  assert.equal(preservedLibrary.catalogStatus, "paused");
  assert.equal(preservedLibrary.catalogRevision, 3);
  await engine.dispose();
  storage.close();
}));

test("普通子目录枚举 EACCES 时保留旧 profile、向量、计数和素材修订号", async () => withTempDirectory(async (root) => {
  const source = path.join(root, "library");
  await mkdir(path.join(source, "ordinary-child"), { recursive: true });
  const originalPath = path.join(source, "keep.png");
  await writeFile(originalPath, Buffer.from("old-source"));
  const originalInfo = await stat(originalPath);
  const dataRoot = path.join(root, "data");
  const storage = new LocalImageSearchStorage({ dataRoot });
  const library = storage.createLibrary({ id: randomUUID(), rootPath: source, name: "子目录失败" });
  const model = storage.getModel(BUILTIN_MODEL_ID);
  const image = storage.db.prepare(`
    INSERT INTO images(library_id,relative_path,mtime_ms,size_bytes,sha256,scan_generation)
    VALUES (?,?,?,?,?,11) RETURNING id
  `).get(library.id, "keep.png", originalInfo.mtimeMs, originalInfo.size, "old-digest");
  const oldEmbedding = Buffer.alloc(512 * 4, 4);
  storage.ensureLibraryModel(library.id, model.id);
  storage.db.prepare(`
    UPDATE library_models
    SET status='ready',item_count=1,error_count=0,scan_generation=11,execution_profile='execution-v2:subdir-old'
    WHERE library_id=? AND model_id=? AND model_fingerprint=?
  `).run(library.id, model.id, model.fingerprint);
  storage.db.prepare(`
    INSERT INTO image_embeddings(
      library_id,image_id,model_id,model_fingerprint,dimensions,embedding,scan_generation,error_code
    ) VALUES (?,?,?,?,512,?,11,NULL)
  `).run(library.id, image.id, model.id, model.fingerprint, oldEmbedding);
  storage.db.prepare(`
    UPDATE libraries SET status='ready',item_count=1,error_count=0,scan_generation=11,
      catalog_status='ready',catalog_item_count=1,catalog_revision=19
    WHERE id=?
  `).run(library.id);

  const engine = new LocalImageSearchEngine({
    dbPath: storage.dbPath,
    modelRoot: path.join(dataRoot, "models"),
    testScanFailurePrefix: "ordinary-child",
  });
  await assert.rejects(engine.request("index", {
    jobId: randomUUID(),
    libraryId: library.id,
    modelId: model.id,
    modelConfig: {
      id: model.id,
      fingerprint: model.fingerprint,
      dimensions: 512,
      kind: "image-text",
      supportsText: true,
      builtin: true,
      preprocessingVersion: "new-profile-that-must-not-commit",
      vision: { modelPath: path.join(dataRoot, "missing.onnx") },
    },
  }), { code: "INDEX_SCAN_INCOMPLETE" });

  const state = storage.getLibraryModel(library.id, model.id);
  assert.equal(state.status, "paused");
  assert.equal(state.executionProfile, "execution-v2:subdir-old");
  assert.equal(state.itemCount, 1);
  assert.equal(state.scanGeneration, 11);
  const embedding = storage.db.prepare(`
    SELECT embedding,scan_generation FROM image_embeddings
    WHERE library_id=? AND image_id=? AND model_id=? AND model_fingerprint=?
  `).get(library.id, image.id, model.id, model.fingerprint);
  assert.deepEqual(Buffer.from(embedding.embedding), oldEmbedding);
  assert.equal(embedding.scan_generation, 11);
  const catalog = storage.getLibrary(library.id, { modelId: model.id });
  assert.equal(catalog.catalogStatus, "paused");
  assert.equal(catalog.catalogItemCount, 1);
  assert.equal(catalog.catalogRevision, 19);
  await engine.dispose();
  storage.close();
}));

test("Windows 目录联接作为 reparse point 跳过，不把外部图片带入索引", {
  skip: process.platform !== "win32",
}, async (context) => withTempDirectory(async (root) => {
  const source = path.join(root, "library");
  const outside = path.join(root, "outside");
  await mkdir(source);
  await mkdir(outside);
  await writeFile(path.join(outside, "must-not-scan.png"), Buffer.from("outside"));
  try {
    await symlink(outside, path.join(source, "junction"), "junction");
  } catch (error) {
    context.skip(`当前 Windows 环境无法创建 junction: ${error?.code || "UNKNOWN"}`);
    return;
  }
  const dataRoot = path.join(root, "data");
  const storage = new LocalImageSearchStorage({ dataRoot });
  const library = storage.createLibrary({ id: randomUUID(), rootPath: source, name: "junction" });
  const model = storage.getModel(BUILTIN_MODEL_ID);
  const engine = new LocalImageSearchEngine({ dbPath: storage.dbPath, modelRoot: path.join(dataRoot, "models") });
  const result = await engine.request("index", {
    jobId: randomUUID(),
    libraryId: library.id,
    modelId: model.id,
    modelConfig: {
      id: model.id,
      fingerprint: model.fingerprint,
      dimensions: 512,
      kind: "image-text",
      supportsText: true,
      builtin: true,
      preprocessingVersion: "junction-test",
      vision: { modelPath: path.join(dataRoot, "missing.onnx") },
    },
  });
  assert.equal(result.state, "completed");
  assert.ok(result.skipped >= 1);
  assert.equal(storage.db.prepare("SELECT COUNT(*) AS count FROM images WHERE library_id=?").get(library.id).count, 0);
  assert.equal(storage.getLibrary(library.id).catalogItemCount, 0);
  await engine.dispose();
  storage.close();
}));

test("新增图片会在同一短事务中使其他模型索引变为 stale", async () => withTempDirectory(async (root) => {
  const source = path.join(root, "source");
  await mkdir(source);
  const bytes = Buffer.from("same-content-without-decoding");
  const seedPath = path.join(source, "seed.png");
  await writeFile(seedPath, bytes);
  await writeFile(path.join(source, "new.png"), bytes);
  const seedInfo = await stat(seedPath);
  const storage = new LocalImageSearchStorage({ dataRoot: path.join(root, "data") });
  const library = storage.createLibrary({ id: randomUUID(), rootPath: source, name: "多模型" });
  storage.ensureLibraryModel(library.id, LEGACY_BUILTIN_MODEL_ID);
  storage.db.prepare(`
    UPDATE library_models SET status='ready',item_count=1
    WHERE library_id=? AND model_id=? AND model_fingerprint=?
  `).run(library.id, LEGACY_BUILTIN_MODEL_ID, LEGACY_BUILTIN_MODEL_FINGERPRINT);
  const model = storage.getModel(BUILTIN_MODEL_ID);
  const manifest = createBuiltinModelManifest();
  const modelConfig = {
    id: model.id,
    fingerprint: model.fingerprint,
    dimensions: 512,
    kind: "image-text",
    supportsText: true,
    builtin: true,
    preprocessingVersion: manifest.indexProfile,
    vision: {
      ...manifest.vision,
      modelPath: path.join(root, "missing-q4.onnx"),
      colorOrder: "RGB",
    },
  };
  const executionProfile = createIndexExecutionProfile({
    modelFingerprint: model.fingerprint,
    preprocessingVersion: modelConfig.preprocessingVersion,
    preprocessing: {
      inputName: "pixel_values", outputName: "image_embeds", pixelType: "float32", layout: "NCHW",
      width: 224, height: 224, colorOrder: "RGB", resizeMode: "crop", cropMode: "center",
      scale: 1 / 255, mean: manifest.vision.mean, std: manifest.vision.std, normalizeOutput: true,
    },
    provider: "cpu", batchSize: 16, deviceId: null, driverFingerprint: null,
    onnxRuntimeVersion: "1.24.3", architecture: process.arch,
  });
  storage.db.prepare(`
    UPDATE library_models SET execution_profile=?
    WHERE library_id=? AND model_id=? AND model_fingerprint=?
  `).run(executionProfile, library.id, model.id, model.fingerprint);
  const seed = storage.db.prepare(`
    INSERT INTO images(library_id,relative_path,mtime_ms,size_bytes,sha256,format,width,height,scan_generation)
    VALUES (?,?,?,?,?,'png',1,1,0) RETURNING id
  `).get(library.id, "seed.png", seedInfo.mtimeMs, seedInfo.size, createHash("sha256").update(bytes).digest("hex"));
  storage.db.prepare(`
    INSERT INTO image_embeddings(library_id,image_id,model_id,model_fingerprint,dimensions,embedding,scan_generation)
    VALUES (?,?,?,?,512,?,0)
  `).run(library.id, seed.id, model.id, model.fingerprint, Buffer.from(Float32Array.from({ length: 512 }, (_, i) => i === 0 ? 1 : 0).buffer));
  const engine = new LocalImageSearchEngine({ dbPath: storage.dbPath, modelRoot: path.join(root, "models") });
  const result = await engine.request("index", {
    jobId: randomUUID(), libraryId: library.id, modelId: model.id, modelConfig,
  });
  assert.equal(result.state, "completed");
  assert.equal(storage.getLibraryModel(library.id, LEGACY_BUILTIN_MODEL_ID).status, "stale");
  assert.equal(storage.getLibraryModel(library.id, BUILTIN_MODEL_ID).status, "ready");
  assert.equal(storage.db.prepare("SELECT COUNT(*) AS count FROM images WHERE library_id=?").get(library.id).count, 2);
  assert.equal(storage.getLibrary(library.id).catalogRevision, 1);
  assert.equal(storage.db.prepare("SELECT COUNT(*) AS count FROM index_staging_jobs").get().count, 0);
  const rescan = await engine.request("index", {
    jobId: randomUUID(), libraryId: library.id, modelId: model.id, modelConfig,
  });
  assert.equal(rescan.state, "completed");
  assert.equal(storage.getLibrary(library.id).catalogRevision, 2);
  assert.equal(storage.db.prepare("SELECT COUNT(*) AS count FROM index_staging_images").get().count, 0);
  await engine.dispose();
  storage.close();
}));

test("索引已分批写入 staging 后取消，ready 素材快照和向量仍逐字段不变", async () => withTempDirectory(async (root) => {
  const source = path.join(root, "source");
  await mkdir(source);
  const bytes = Buffer.from("atomic-staging-duplicate");
  await Promise.all(Array.from({ length: 300 }, (_, index) => (
    writeFile(path.join(source, `${String(index).padStart(3, "0")}.png`), bytes)
  )));
  const seedPath = path.join(source, "000.png");
  const seedInfo = await stat(seedPath);
  const storage = new LocalImageSearchStorage({ dataRoot: path.join(root, "data") });
  const library = storage.createLibrary({ id: randomUUID(), rootPath: source, name: "原子取消" });
  const model = storage.getModel(BUILTIN_MODEL_ID);
  const { modelConfig, executionProfile } = cpuIndexFixture(root, model);
  const digest = createHash("sha256").update(bytes).digest("hex");
  const oldVector = Buffer.from(Float32Array.from({ length: 512 }, (_, index) => index === 0 ? 1 : 0).buffer);
  const image = storage.db.prepare(`
    INSERT INTO images(library_id,relative_path,mtime_ms,size_bytes,sha256,format,width,height,scan_generation)
    VALUES (?,?,?,?,?,'png',10,10,5) RETURNING id
  `).get(library.id, "000.png", seedInfo.mtimeMs, seedInfo.size, digest);
  storage.db.prepare(`
    INSERT INTO image_embeddings(
      library_id,image_id,model_id,model_fingerprint,dimensions,embedding,scan_generation
    ) VALUES (?,?,?,?,512,?,5)
  `).run(library.id, image.id, model.id, model.fingerprint, oldVector);
  storage.db.prepare(`
    UPDATE library_models SET status='ready',item_count=1,error_count=0,
      scan_generation=5,execution_profile=?,last_indexed_at='old-model-time'
    WHERE library_id=? AND model_id=? AND model_fingerprint=?
  `).run(executionProfile, library.id, model.id, model.fingerprint);
  storage.db.prepare(`
    UPDATE libraries SET status='ready',item_count=1,error_count=0,scan_generation=5,
      catalog_status='ready',catalog_item_count=1,catalog_revision=9,
      catalog_last_scanned_at='old-catalog-time',last_indexed_at='old-library-time'
    WHERE id=?
  `).run(library.id);
  const engine = new LocalImageSearchEngine({
    dbPath: storage.dbPath,
    modelRoot: path.join(root, "models"),
    testPauseAfterStagedRows: 256,
  });
  const result = await engine.request("index", {
    jobId: randomUUID(), libraryId: library.id, modelId: model.id, modelConfig,
  });
  assert.equal(result.state, "canceled");
  assert.equal(storage.db.prepare("SELECT COUNT(*) AS count FROM images WHERE library_id=?").get(library.id).count, 1);
  const preservedVector = storage.db.prepare(`
    SELECT embedding,scan_generation FROM image_embeddings
    WHERE library_id=? AND image_id=? AND model_id=? AND model_fingerprint=?
  `).get(library.id, image.id, model.id, model.fingerprint);
  assert.deepEqual(Buffer.from(preservedVector.embedding), oldVector);
  assert.equal(Number(preservedVector.scan_generation), 5);
  const modelState = storage.getLibraryModel(library.id, model.id);
  assert.equal(modelState.status, "paused");
  assert.equal(modelState.itemCount, 1);
  assert.equal(modelState.scanGeneration, 5);
  assert.equal(modelState.executionProfile, executionProfile);
  const catalog = storage.getLibrary(library.id, { modelId: model.id });
  assert.equal(catalog.catalogStatus, "paused");
  assert.equal(catalog.catalogItemCount, 1);
  assert.equal(catalog.catalogRevision, 9);
  assert.equal(storage.db.prepare("SELECT COUNT(*) AS count FROM index_staging_jobs").get().count, 0);
  assert.equal(storage.db.prepare("SELECT COUNT(*) AS count FROM index_staging_images").get().count, 0);
  await engine.dispose();
  storage.close();
}));

test("profile 重建在 begin 后取消不会预删旧向量或提交新 profile", async () => withTempDirectory(async (root) => {
  const source = path.join(root, "source");
  await mkdir(source);
  const filePath = path.join(source, "keep.png");
  await writeFile(filePath, Buffer.from("profile-rebuild-source"));
  const info = await stat(filePath);
  const storage = new LocalImageSearchStorage({ dataRoot: path.join(root, "data") });
  const library = storage.createLibrary({ id: randomUUID(), rootPath: source, name: "profile cancel" });
  const model = storage.getModel(BUILTIN_MODEL_ID);
  const { modelConfig } = cpuIndexFixture(root, model);
  modelConfig.preprocessingVersion = "new-profile";
  const oldVector = Buffer.alloc(512 * 4, 6);
  const image = storage.db.prepare(`
    INSERT INTO images(library_id,relative_path,mtime_ms,size_bytes,sha256,scan_generation)
    VALUES (?,?,?,?,?,7) RETURNING id
  `).get(library.id, "keep.png", info.mtimeMs, info.size, createHash("sha256").update("profile-rebuild-source").digest("hex"));
  storage.db.prepare(`
    INSERT INTO image_embeddings(library_id,image_id,model_id,model_fingerprint,dimensions,embedding,scan_generation)
    VALUES (?,?,?,?,512,?,7)
  `).run(library.id, image.id, model.id, model.fingerprint, oldVector);
  storage.db.prepare(`
    UPDATE library_models SET status='ready',item_count=1,scan_generation=7,execution_profile='execution-v2:old'
    WHERE library_id=? AND model_id=? AND model_fingerprint=?
  `).run(library.id, model.id, model.fingerprint);
  storage.db.prepare(`
    UPDATE libraries SET status='ready',item_count=1,scan_generation=7,
      catalog_status='ready',catalog_item_count=1,catalog_revision=4 WHERE id=?
  `).run(library.id);
  const engine = new LocalImageSearchEngine({
    dbPath: storage.dbPath,
    modelRoot: path.join(root, "models"),
    testPauseAfterIndexBegin: true,
  });
  const result = await engine.request("index", {
    jobId: randomUUID(), libraryId: library.id, modelId: model.id, modelConfig,
  });
  assert.equal(result.state, "canceled");
  const preserved = storage.db.prepare(`
    SELECT embedding,scan_generation FROM image_embeddings
    WHERE library_id=? AND image_id=? AND model_id=? AND model_fingerprint=?
  `).get(library.id, image.id, model.id, model.fingerprint);
  assert.deepEqual(Buffer.from(preserved.embedding), oldVector);
  assert.equal(Number(preserved.scan_generation), 7);
  assert.equal(storage.getLibraryModel(library.id, model.id).executionProfile, "execution-v2:old");
  assert.equal(storage.getLibrary(library.id).catalogRevision, 4);
  assert.equal(storage.db.prepare("SELECT COUNT(*) AS count FROM index_staging_jobs").get().count, 0);
  await engine.dispose();
  storage.close();
}));

test("进程无完成消息退出后重启仅清理已知 staging，并保留 committed 快照", async () => withTempDirectory(async (root) => {
  const dataRoot = path.join(root, "data");
  const source = path.join(root, "source");
  await mkdir(source);
  let storage = new LocalImageSearchStorage({ dataRoot });
  const library = storage.createLibrary({ id: randomUUID(), rootPath: source, name: "crash recovery" });
  const model = storage.getModel(BUILTIN_MODEL_ID);
  const vector = Buffer.alloc(512 * 4, 8);
  const image = storage.db.prepare(`
    INSERT INTO images(library_id,relative_path,mtime_ms,size_bytes,sha256,scan_generation)
    VALUES (?,'keep.png',1,1,'keep',12) RETURNING id
  `).get(library.id);
  storage.db.prepare(`
    INSERT INTO image_embeddings(library_id,image_id,model_id,model_fingerprint,dimensions,embedding,scan_generation)
    VALUES (?,?,?,?,512,?,12)
  `).run(library.id, image.id, model.id, model.fingerprint, vector);
  storage.db.prepare(`
    UPDATE library_models SET status='indexing',item_count=1,scan_generation=12,execution_profile='old-profile'
    WHERE library_id=? AND model_id=? AND model_fingerprint=?
  `).run(library.id, model.id, model.fingerprint);
  storage.db.prepare(`
    UPDATE libraries SET status='indexing',item_count=1,scan_generation=12,
      catalog_status='ready',catalog_item_count=1,catalog_revision=6 WHERE id=?
  `).run(library.id);
  const jobId = randomUUID();
  storage.db.prepare(`
    INSERT INTO index_staging_jobs(
      job_id,library_id,model_id,model_fingerprint,dimensions,
      base_catalog_revision,base_file_generation,target_file_generation,
      base_model_generation,target_model_generation,execution_profile,profile_rebuilt,created_at
    ) VALUES (?,?,?,?,512,6,12,13,12,13,'new-profile',1,?)
  `).run(jobId, library.id, model.id, model.fingerprint, new Date().toISOString());
  storage.db.prepare(`
    INSERT INTO index_staging_images(
      job_id,relative_path,mtime_ms,size_bytes,sha256,file_changed,embedding_changed,embedding
    ) VALUES (?,'half.png',2,2,'half',1,1,?)
  `).run(jobId, Buffer.alloc(512 * 4, 2));
  storage.close();

  storage = new LocalImageSearchStorage({ dataRoot });
  assert.equal(storage.db.prepare("SELECT COUNT(*) AS count FROM index_staging_jobs").get().count, 0);
  assert.equal(storage.db.prepare("SELECT COUNT(*) AS count FROM index_staging_images").get().count, 0);
  assert.equal(storage.db.prepare("SELECT COUNT(*) AS count FROM images WHERE library_id=?").get(library.id).count, 1);
  const preserved = storage.db.prepare(`
    SELECT embedding,scan_generation FROM image_embeddings
    WHERE library_id=? AND image_id=? AND model_id=? AND model_fingerprint=?
  `).get(library.id, image.id, model.id, model.fingerprint);
  assert.deepEqual(Buffer.from(preserved.embedding), vector);
  assert.equal(Number(preserved.scan_generation), 12);
  assert.equal(storage.getLibraryModel(library.id, model.id).status, "paused");
  assert.equal(storage.getLibraryModel(library.id, model.id).executionProfile, "old-profile");
  assert.equal(storage.getLibrary(library.id).catalogRevision, 6);
  storage.close();
}));

test("索引配置升级标记内置模型 stale，并保留新索引发布前的全部向量", async () => withTempDirectory(async (root) => {
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
  `).run(libraryId, image.id, BUILTIN_MODEL_ID, BUILTIN_MODEL_FINGERPRINT, Buffer.alloc(512 * 4, 2));
  storage.db.prepare(`
    INSERT INTO image_embeddings(library_id, image_id, model_id, model_fingerprint, dimensions, embedding)
    VALUES (?, ?, ?, ?, 32, ?)
  `).run(libraryId, image.id, customModelId, customFingerprint, Buffer.alloc(32 * 4, 3));
  storage.db.prepare(`
    INSERT INTO library_models(library_id, model_id, model_fingerprint, status, item_count)
    VALUES (?, ?, ?, 'ready', 1)
  `).run(libraryId, customModelId, customFingerprint);
  storage.db.prepare(`
    UPDATE library_models SET status='ready', item_count=1, execution_profile='execution-v2:old'
    WHERE library_id=? AND model_id=? AND model_fingerprint=?
  `).run(libraryId, BUILTIN_MODEL_ID, BUILTIN_MODEL_FINGERPRINT);
  storage.db.prepare("UPDATE local_search_settings SET value='legacy-single-cpu' WHERE key='builtin_index_profile'").run();
  storage.close();

  for (let pass = 0; pass < 2; pass += 1) {
    storage = new LocalImageSearchStorage({ dataRoot });
    assert.equal(storage.db.prepare("SELECT COUNT(*) AS count FROM image_embeddings WHERE model_id = ?").get(BUILTIN_MODEL_ID).count, 1);
    assert.equal(storage.db.prepare("SELECT COUNT(*) AS count FROM image_embeddings WHERE model_id = ?").get(customModelId).count, 1);
    assert.equal(storage.db.prepare("SELECT COUNT(*) AS count FROM library_models WHERE model_id = ?").get(customModelId).count, 1);
    const metadata = storage.db.prepare("SELECT sha256, width, height, embedding, error_code FROM images WHERE id = ?").get(image.id);
    assert.equal(metadata.sha256, "keep-digest");
    assert.equal(Number(metadata.width), 640);
    assert.equal(Number(metadata.height), 480);
    assert.equal(metadata.embedding, null);
    assert.equal(metadata.error_code, "legacy-error");
    const builtinState = storage.getLibraryModel(libraryId, BUILTIN_MODEL_ID);
    assert.equal(builtinState.modelFingerprint, BUILTIN_MODEL_FINGERPRINT);
    assert.equal(builtinState.status, "stale");
    assert.equal(builtinState.itemCount, 1);
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

test("模型下载保留合法断点并用严格 Content-Range 续传", async () => withTempDirectory(async (root) => {
  const bytes = Buffer.from("resume-model-bytes");
  const file = {
    model: "vision",
    relativePath: "onnx/resume.onnx",
    size: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    url: "https://models.invalid/resume.onnx",
  };
  const partial = path.join(root, "vision", "onnx", "resume.onnx.part");
  await mkdir(path.dirname(partial), { recursive: true });
  await writeFile(partial, bytes.subarray(0, 6));
  let requestedRange = null;
  const manager = new LocalModelManager({
    modelRoot: root,
    files: [file],
    fetchImpl: async (_url, options) => {
      requestedRange = options.headers?.Range || null;
      return new Response(bytes.subarray(6), {
        status: 206,
        headers: {
          "content-range": `bytes 6-${bytes.length - 1}/${bytes.length}`,
          "content-length": String(bytes.length - 6),
        },
      });
    },
  });
  manager.startDownload();
  assert.equal((await waitForModel(manager)).ready, true);
  assert.equal(requestedRange, "bytes=6-");
  assert.deepEqual(await readFile(path.join(root, "vision", "onnx", "resume.onnx")), bytes);
}));

test("模型下载中断保留合法 .part，重试时续传而不是从零开始", async () => withTempDirectory(async (root) => {
  const bytes = Buffer.from("retry-resume-model");
  const file = {
    model: "vision",
    relativePath: "onnx/retry.onnx",
    size: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    url: "https://models.invalid/retry.onnx",
  };
  let requestCount = 0;
  let retryRange = null;
  const manager = new LocalModelManager({
    modelRoot: root,
    files: [file],
    fetchImpl: async (_url, options) => {
      requestCount += 1;
      if (requestCount === 1) return new Response(bytes.subarray(0, 5), { status: 200 });
      retryRange = options.headers?.Range || null;
      return new Response(bytes.subarray(5), {
        status: 206,
        headers: { "content-range": `bytes 5-${bytes.length - 1}/${bytes.length}` },
      });
    },
  });
  manager.startDownload();
  assert.equal((await waitForModel(manager)).state, "error");
  assert.equal((await stat(path.join(root, "vision", "onnx", "retry.onnx.part"))).size, 5);
  manager.startDownload();
  assert.equal((await waitForModel(manager)).ready, true);
  assert.equal(retryRange, "bytes=5-");
}));

test("断点服务器返回 200 时从零重启，错误 Content-Range 或超量响应不会启用模型", async () => withTempDirectory(async (root) => {
  const bytes = Buffer.from("range-server-reset");
  const file = {
    model: "vision",
    relativePath: "onnx/range.onnx",
    size: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    url: "https://models.invalid/range.onnx",
  };
  const resetRoot = path.join(root, "reset");
  const resetPartial = path.join(resetRoot, "vision", "onnx", "range.onnx.part");
  await mkdir(path.dirname(resetPartial), { recursive: true });
  await writeFile(resetPartial, bytes.subarray(0, 4));
  let resetRange = null;
  const resetManager = new LocalModelManager({
    modelRoot: resetRoot,
    files: [file],
    fetchImpl: async (_url, options) => {
      resetRange = options.headers?.Range || null;
      return new Response(bytes, { status: 200 });
    },
  });
  resetManager.startDownload();
  assert.equal((await waitForModel(resetManager)).ready, true);
  assert.equal(resetRange, "bytes=4-");
  assert.deepEqual(await readFile(path.join(resetRoot, "vision", "onnx", "range.onnx")), bytes);

  const invalidRoot = path.join(root, "invalid-range");
  const invalidPartial = path.join(invalidRoot, "vision", "onnx", "range.onnx.part");
  await mkdir(path.dirname(invalidPartial), { recursive: true });
  await writeFile(invalidPartial, bytes.subarray(0, 4));
  const invalidManager = new LocalModelManager({
    modelRoot: invalidRoot,
    files: [file],
    fetchImpl: async () => new Response(bytes.subarray(4), {
      status: 206,
      headers: { "content-range": `bytes 5-${bytes.length - 1}/${bytes.length}` },
    }),
  });
  invalidManager.startDownload();
  assert.equal((await waitForModel(invalidManager)).state, "error");
  await assert.rejects(readFile(path.join(invalidRoot, "vision", "onnx", "range.onnx")));
  await assert.rejects(readFile(invalidPartial));

  const oversizedRoot = path.join(root, "oversized");
  const oversizedManager = new LocalModelManager({
    modelRoot: oversizedRoot,
    files: [file],
    fetchImpl: async () => new Response(Buffer.concat([bytes, Buffer.from("extra")])),
  });
  oversizedManager.startDownload();
  assert.equal((await waitForModel(oversizedManager)).state, "error");
  await assert.rejects(readFile(path.join(oversizedRoot, "vision", "onnx", "range.onnx")));
  await assert.rejects(readFile(path.join(oversizedRoot, "vision", "onnx", "range.onnx.part")));
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
  const packageArchive = new AdmZip(packagePath);
  const manifest = JSON.parse(packageArchive.readAsText(packageArchive.getEntry("manifest.json"), "utf8"));
  assert.equal(manifest.formatVersion, 2);
  assert.equal(manifest.modelId, BUILTIN_MODEL_ID);
  assert.equal(typeof manifest.modelFingerprint === "string" || manifest.modelFingerprint === null, true);

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

  const legacyV1Path = path.join(root, "model-v1.ngrmodel");
  const v1Source = new AdmZip(packagePath);
  const v1Manifest = JSON.parse(v1Source.readAsText(v1Source.getEntry("manifest.json"), "utf8"));
  v1Manifest.formatVersion = 1;
  delete v1Manifest.modelId;
  delete v1Manifest.modelFingerprint;
  delete v1Manifest.sharedComponents;
  const v1Archive = new AdmZip();
  v1Archive.addFile("manifest.json", Buffer.from(`${JSON.stringify(v1Manifest, null, 2)}\n`, "utf8"));
  for (const entry of v1Source.getEntries().filter((item) => !item.isDirectory && item.entryName !== "manifest.json")) {
    v1Archive.addFile(entry.entryName, v1Source.readFile(entry));
  }
  await v1Archive.writeZipPromise(legacyV1Path, { overwrite: true });
  const v1Root = path.join(root, "v1-models");
  const v1Offline = new LocalModelManager({ modelRoot: v1Root, files: [file], fetchImpl: async () => { throw new Error("OFFLINE"); } });
  assert.equal(v1Offline.startImport(legacyV1Path), true);
  await v1Offline.packagePromise;
  assert.equal((await v1Offline.inspect()).ready, true, "v1 package remains importable after the v2 manifest upgrade");
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

test("后端只允许 ready 的模型索引搜索，暂停/分析中/错误和 stale 均受门禁保护", async () => withTempDirectory(async (root) => {
  const controller = new LocalImageSearchController({
    userDataPath: path.join(root, "appdata"), dialog: {}, shell: {}, netFetch: fetch, getWindow: () => null,
  });
  try {
    const source = path.join(root, "source");
    await mkdir(source);
    const library = controller.storage.createLibrary({ id: randomUUID(), rootPath: source, name: "gated" });
    const model = controller.storage.getModel(BUILTIN_MODEL_ID);
    for (const status of ["paused", "indexing", "error", "new"]) {
      controller.storage.db.prepare(`
        UPDATE library_models SET status=?,item_count=1
        WHERE library_id=? AND model_id=? AND model_fingerprint=?
      `).run(status, library.id, model.id, model.fingerprint);
      await assert.rejects(
        controller.assertSearchable(library.id, model.id),
        { code: "LOCAL_SEARCH_INDEX_NOT_READY" },
      );
    }
    controller.storage.db.prepare(`
      UPDATE library_models SET status='stale',item_count=1
      WHERE library_id=? AND model_id=? AND model_fingerprint=?
    `).run(library.id, model.id, model.fingerprint);
    await assert.rejects(
      controller.assertSearchable(library.id, model.id),
      { code: "LOCAL_SEARCH_INDEX_STALE" },
    );
  } finally {
    await controller.dispose();
  }
}));

test("缩略图使用内容指纹键、并发请求去重且原子替换旧缓存", async () => withTempDirectory(async (root) => {
  const source = path.join(root, "library");
  await mkdir(source);
  const imageBytes = await sharp({
    create: { width: 8, height: 8, channels: 3, background: { r: 12, g: 34, b: 56 } },
  }).png().toBuffer();
  const imagePath = path.join(source, "pixel.png");
  await writeFile(imagePath, imageBytes);
  const sourceInfo = await stat(imagePath);
  const firstDigest = createHash("sha256").update(imageBytes).digest("hex");
  const controller = new LocalImageSearchController({
    userDataPath: path.join(root, "appdata"), dialog: {}, shell: {}, netFetch: fetch, getWindow: () => null,
  });
  try {
    const library = controller.storage.createLibrary({ id: randomUUID(), rootPath: source, name: "library" });
    const image = controller.storage.db.prepare(`
      INSERT INTO images(library_id,relative_path,mtime_ms,size_bytes,sha256,format,width,height)
      VALUES (?,?,?,?,?,'png',1,1) RETURNING id
    `).get(library.id, "pixel.png", sourceInfo.mtimeMs, sourceInfo.size, firstDigest);

    const responses = await Promise.all(Array.from({ length: 8 }, () => controller.getThumbnail({
      libraryId: library.id,
      imageId: Number(image.id),
    })));
    assert.ok(responses.every((response) => response.mimeType === "image/webp" && response.data.length > 0));
    const thumbnailDirectory = path.join(controller.thumbnailRoot, library.id);
    assert.deepEqual(await readdir(thumbnailDirectory), [`${image.id}-${firstDigest}.webp`]);

    const secondDigest = "b".repeat(64);
    controller.storage.db.prepare("UPDATE images SET sha256=? WHERE id=?").run(secondDigest, image.id);
    await controller.getThumbnail({ libraryId: library.id, imageId: Number(image.id) });
    assert.deepEqual(await readdir(thumbnailDirectory), [`${image.id}-${secondDigest}.webp`]);
    assert.equal((await readdir(thumbnailDirectory)).some((name) => name.includes(".part-")), false);
  } finally {
    await controller.dispose();
  }
}));

test("模型删除日志在进程中断后只恢复已登记文件并保留共享文件", async () => withTempDirectory(async (root) => {
  const modelRoot = path.join(root, "models");
  const removedPath = path.join(modelRoot, "vision", "remove.onnx");
  const sharedPath = path.join(modelRoot, "text", "shared.onnx");
  await mkdir(path.dirname(removedPath), { recursive: true });
  await mkdir(path.dirname(sharedPath), { recursive: true });
  await writeFile(removedPath, Buffer.from("restore-after-crash"));
  await writeFile(sharedPath, Buffer.from("keep-shared"));

  const interrupted = new LocalModelManager({ modelRoot, files: [], fetchImpl: fetch });
  await interrupted.stageRemoval({ builtin: true }, { preservePaths: ["text/shared.onnx"] });
  await assert.rejects(readFile(removedPath));
  assert.equal((await readFile(sharedPath)).toString(), "keep-shared");
  const journalPath = path.join(modelRoot, ".model-operation-journal.json");
  await rename(journalPath, `${journalPath}.replace-backup`);

  const recovered = new LocalModelManager({ modelRoot, files: [], fetchImpl: fetch });
  await recovered.inspect({ force: true });
  assert.equal((await readFile(removedPath)).toString(), "restore-after-crash");
  assert.equal((await readFile(sharedPath)).toString(), "keep-shared");
  await assert.rejects(readFile(journalPath));
  await assert.rejects(readFile(`${journalPath}.replace-backup`));
  assert.equal((await readdir(modelRoot)).some((name) => name.startsWith(".removal-")), false);
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
