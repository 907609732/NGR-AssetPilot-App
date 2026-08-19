import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { LocalImageSearchStorage } from "../desktop/services/local-image-search/storage.mjs";
import { LocalModelManager } from "../desktop/services/local-image-search/model-manager.mjs";
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
  assert.equal(storage.removeLibrary(library.id), true);
  storage.close();
  assert.equal((await readFile(original)).toString(), "source-image");
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
  const offline = new LocalModelManager({
    modelRoot: offlineRoot,
    files: [file],
    fetchImpl: async () => { throw new Error("NETWORK_MUST_NOT_BE_USED"); },
  });
  assert.equal(offline.startImport(packagePath), true);
  await offline.packagePromise;
  assert.equal((await offline.inspect()).ready, true);
  assert.deepEqual(await readFile(path.join(offlineRoot, "vision", "onnx", "tiny.onnx")), bytes);

  const corruptedPackage = path.join(root, "corrupted.ngrmodel");
  await writeFile(corruptedPackage, Buffer.from("not-a-model-package"));
  assert.equal(offline.startImport(corruptedPackage), true);
  await assert.rejects(offline.packagePromise);
  assert.deepEqual(await readFile(path.join(offlineRoot, "vision", "onnx", "tiny.onnx")), bytes);
  assert.equal((await offline.inspect()).ready, true, "failed import must preserve the last valid model");
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
