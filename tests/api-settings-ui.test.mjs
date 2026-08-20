import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const index = fs.readFileSync(path.join(projectRoot, "app/index.html"), "utf8");
const lifecycle = fs.readFileSync(path.join(projectRoot, "app/js/lifecycle-rules.js"), "utf8");
const translator = fs.readFileSync(path.join(projectRoot, "app/js/uploads-editor-translator.js"), "utf8");

test("设置包含统一 API 页签并接管视觉命名与翻译配置", () => {
  assert.match(index, /id="apiSettingsView"/);
  assert.match(index, /id="apiSettingsAiSlot"/);
  assert.match(index, /id="apiSettingsTranslationSlot"/);
  assert.match(lifecycle, /apiSettingsAiSlot\.appendChild\(els\.aiSettingsPanel\)/);
  assert.match(lifecycle, /apiSettingsTranslationSlot\.appendChild\(els\.translatorSettings\)/);
  assert.match(lifecycle, /\["apiSettings", "API"\]/);
});

test("浮动翻译框不再提供 API 配置入口，缺少百度配置时跳转统一 API 页", () => {
  assert.doesNotMatch(index, /id="translatorSettingsToggle"/);
  assert.match(translator, /openSettingsView\("apiSettings", currentViewName\)/);
});
