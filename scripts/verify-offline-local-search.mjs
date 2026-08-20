import assert from "node:assert/strict";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { LocalImageSearchEngine } from "../desktop/services/local-image-search/engine.mjs";

process.env.HF_HUB_OFFLINE = "1";
process.env.TRANSFORMERS_OFFLINE = "1";
process.env.HF_DATASETS_OFFLINE = "1";

function resolveManifestPath(root, relativePath, { allowRoot = false } = {}) {
  assert.equal(typeof relativePath, "string", "模型清单路径无效");
  assert.ok(relativePath && !relativePath.includes("\\"), "模型清单路径无效");
  const segments = relativePath === "." ? [] : relativePath.split("/");
  assert.ok(!segments.some((segment) => !segment || segment === "." || segment === ".."), "模型清单路径越界");
  const candidate = path.resolve(root, ...segments);
  const relative = path.relative(root, candidate);
  assert.ok((allowRoot && relative === "") || (relative && !relative.startsWith("..") && !path.isAbsolute(relative)), "模型清单路径越界");
  return candidate;
}

function toModelConfig(modelRoot, row) {
  const manifest = JSON.parse(row.manifest_json);
  assert.equal(manifest.id, row.id, "模型注册信息与清单不一致");
  assert.equal(manifest.fingerprint, row.fingerprint, "模型指纹与清单不一致");
  const root = manifest.relativeRoot === "."
    ? path.resolve(modelRoot)
    : resolveManifestPath(modelRoot, manifest.relativeRoot);
  const externalData = (tower) => (tower?.externalData || []).map((filePath) => ({
    path: path.posix.basename(filePath),
    data: resolveManifestPath(root, filePath),
  }));
  const vision = {
    ...manifest.vision,
    colorOrder: manifest.vision.colorOrder || manifest.vision.colorSpace || "RGB",
    modelPath: resolveManifestPath(root, manifest.vision.modelPath),
    modelRoot: resolveManifestPath(root, manifest.vision.modelRoot || path.posix.dirname(manifest.vision.modelPath)),
    externalData: externalData(manifest.vision),
  };
  const text = manifest.text ? {
    ...manifest.text,
    modelPath: resolveManifestPath(root, manifest.text.modelPath),
    modelRoot: resolveManifestPath(root, manifest.text.modelRoot || path.posix.dirname(manifest.text.modelPath)),
    tokenizerRoot: resolveManifestPath(root, manifest.text.tokenizerRoot || manifest.text.modelRoot),
    externalData: externalData(manifest.text),
  } : null;
  return {
    id: row.id,
    fingerprint: row.fingerprint,
    dimensions: Number(row.dimensions),
    kind: row.kind,
    supportsText: row.kind === "image-text",
    builtin: Boolean(row.builtin),
    vision,
    text,
  };
}

const edition = process.argv[2];
assert.ok(["prod", "dev", "test"].includes(edition), "请指定 prod、dev 或 test");
const productName = edition === "prod"
  ? "NGR AssetPilot"
  : edition === "test" ? "NGR AssetPilot Test" : "NGR AssetPilot Dev";
const dataRoot = path.join(process.env.APPDATA, productName, "local-image-search");
const dbPath = path.join(dataRoot, "index.sqlite3");
const modelRoot = path.join(dataRoot, "models");
const db = new DatabaseSync(dbPath, { readOnly: true });
assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='models'").get(), "请先启动当前桌面版完成索引迁移");
const activeModelId = db.prepare("SELECT value FROM local_search_settings WHERE key='active_model_id'").get()?.value;
const model = db.prepare(`
  SELECT * FROM models
  WHERE kind='image-text' AND status='ready'
  ORDER BY CASE WHEN id = ? THEN 0 ELSE 1 END, builtin DESC, created_at DESC
  LIMIT 1
`).get(activeModelId || "");
assert.ok(model, "没有已就绪的图文双塔模型");
const library = db.prepare(`
  SELECT l.id, l.name, lm.item_count
  FROM library_models lm JOIN libraries l ON l.id = lm.library_id
  WHERE lm.model_id = ? AND lm.model_fingerprint = ? AND lm.status='ready' AND lm.item_count > 0
  ORDER BY lm.last_indexed_at DESC LIMIT 1
`).get(model.id, model.fingerprint);
db.close();

assert.ok(library, "当前图文模型没有已完成分析的图库");
const modelConfig = toModelConfig(modelRoot, model);
const engine = new LocalImageSearchEngine({ dbPath, modelRoot });
const startedAt = Date.now();

try {
  const response = await engine.request("searchText", {
    libraryId: library.id,
    modelId: model.id,
    modelConfig,
    text: process.argv[3] || "按钮",
    limit: 5,
  });
  const results = response.results || [];
  assert.ok(results.length > 0, "离线文字搜索没有返回结果");
  process.stdout.write(`${JSON.stringify({
    offline: process.env.HF_HUB_OFFLINE === "1" && process.env.TRANSFORMERS_OFFLINE === "1",
    edition,
    library: library.name,
    model: model.name,
    modelFingerprint: model.fingerprint,
    indexedImages: Number(library.item_count),
    elapsedMs: Date.now() - startedAt,
    count: results.length,
    executionProvider: response.executionProvider,
    top: results.slice(0, 3).map((result) => ({
      imageId: result.imageId,
      score: result.score,
      relativePath: result.relativePath,
    })),
  }, null, 2)}\n`);
} finally {
  await engine.dispose();
}
