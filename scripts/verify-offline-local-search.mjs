import assert from "node:assert/strict";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { LocalImageSearchEngine } from "../desktop/services/local-image-search/engine.mjs";

const edition = process.argv[2];
assert.ok(["dev", "test"].includes(edition), "请指定 dev 或 test");
const productName = edition === "test" ? "NGR AssetPilot Test" : "NGR AssetPilot Dev";
const dataRoot = path.join(process.env.APPDATA, productName, "local-image-search");
const dbPath = path.join(dataRoot, "index.sqlite3");
const modelRoot = path.join(dataRoot, "models");
const db = new DatabaseSync(dbPath, { readOnly: true });
const library = db.prepare("SELECT id, name, item_count FROM libraries WHERE item_count > 0 ORDER BY last_indexed_at DESC LIMIT 1").get();
db.close();

assert.ok(library, "标准数据目录中没有已完成分析的图库");
const engine = new LocalImageSearchEngine({ dbPath, modelRoot });
const startedAt = Date.now();

try {
  const response = await engine.request("searchText", {
    libraryId: library.id,
    text: process.argv[3] || "按钮",
    limit: 5,
  });
  const results = response.results || [];
  assert.ok(results.length > 0, "离线文字搜索没有返回结果");
  process.stdout.write(`${JSON.stringify({
    offline: process.env.HF_HUB_OFFLINE === "1" && process.env.TRANSFORMERS_OFFLINE === "1",
    edition,
    library: library.name,
    indexedImages: Number(library.item_count),
    elapsedMs: Date.now() - startedAt,
    count: results.length,
    executionProvider: response.executionProvider,
    top: results.slice(0, 3).map((result) => ({
      id: result.id,
      score: result.score,
      relativePath: result.relativePath,
    })),
  }, null, 2)}\n`);
} finally {
  await engine.dispose();
}
