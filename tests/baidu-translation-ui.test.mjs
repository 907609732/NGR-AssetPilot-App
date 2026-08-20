import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workflow = fs.readFileSync(path.join(projectRoot, "app/js/ai-workflow.js"), "utf8");
const translator = fs.readFileSync(path.join(projectRoot, "app/js/uploads-editor-translator.js"), "utf8");
const knowledge = fs.readFileSync(path.join(projectRoot, "app/js/naming-knowledge.js"), "utf8");

test("百度 API 命名模式强制启用百度并且不再静默冒充本地命名", () => {
  assert.match(workflow, /activateBaiduTranslation\(\{ revealSettings: true \}\)/);
  assert.match(workflow, /translationSettings\.provider === "baidu"/);
  assert.match(workflow, /forceExternal: true/);
  assert.match(workflow, /requireExternal: true/);
  assert.match(workflow, /百度翻译 API 有.*调用失败/);
  assert.match(knowledge, /if \(options\.requireExternal\) throw error/);
});

test("命名单词翻译支持回车并将 API 错误展示给用户", () => {
  assert.match(translator, /translatorInput\.addEventListener\("keydown"/);
  assert.match(translator, /event\.key !== "Enter" \|\| event\.isComposing/);
  assert.match(translator, /void runTranslatorNaming\(\)/);
  assert.match(translator, /翻译失败：\$\{error\?\.message/);
  assert.match(translator, /requireConfiguredProvider: true/);
});
