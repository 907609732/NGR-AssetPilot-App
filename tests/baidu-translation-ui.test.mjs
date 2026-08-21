import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workflow = fs.readFileSync(path.join(projectRoot, "app/js/ai-workflow.js"), "utf8");
const translator = fs.readFileSync(path.join(projectRoot, "app/js/uploads-editor-translator.js"), "utf8");
const knowledge = fs.readFileSync(path.join(projectRoot, "app/js/naming-knowledge.js"), "utf8");
const index = fs.readFileSync(path.join(projectRoot, "app/index.html"), "utf8");

test("翻译服务命名使用当前已选择的离线、百度或自定义模型且不强制切换服务", () => {
  assert.match(workflow, /ensureTranslationProviderReady\(\{ revealSettings: true \}\)/);
  assert.match(workflow, /shouldUseTranslationProvider = !shouldUseAi && useTranslationProvider/);
  assert.match(workflow, /runTranslationNamingQueue/);
  assert.doesNotMatch(workflow, /activateBaiduTranslation/);
  assert.doesNotMatch(translator, /translatorProvider\.value = "baidu"/);
  assert.match(workflow, /forceExternal: true/);
  assert.match(workflow, /requireExternal: true/);
  assert.match(workflow, /翻译服务有.*调用失败/);
  assert.match(translator, /provider === "local"/);
  assert.match(translator, /offlineTranslation\.getStatus\(\)/);
  assert.match(translator, /provider === "model"/);
  assert.match(knowledge, /if \(options\.requireExternal\) throw error/);
  assert.match(index, /<option value="translate" selected>翻译服务命名<\/option>/);
  assert.match(index, />运行翻译服务命名<\/button>/);
});

test("命名单词翻译支持回车并将 API 错误展示给用户", () => {
  assert.match(translator, /translatorInput\.addEventListener\("keydown"/);
  assert.match(translator, /event\.key !== "Enter" \|\| event\.isComposing/);
  assert.match(translator, /void runTranslatorNaming\(\)/);
  assert.match(translator, /翻译失败：\$\{error\?\.message/);
  assert.match(translator, /requireConfiguredProvider: true/);
});

test("百度翻译设置支持新版 API Key 和传统密钥两种鉴权", () => {
  assert.match(index, /id="baiduCredentialType"/);
  assert.match(index, /value="apiKey">新版 API Key/);
  assert.match(index, /value="legacy">App ID \+ 传统密钥/);
  assert.match(index, /value="cfc">百度翻译 CFC/);
  assert.match(translator, /if \(provider === "cfc"\) els\.baiduCredentialType\.value = "legacy"/);
  assert.match(translator, /aiTextTranslate/);
});
