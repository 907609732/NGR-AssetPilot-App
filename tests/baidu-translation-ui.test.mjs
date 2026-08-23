import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workflow = fs.readFileSync(path.join(projectRoot, "app/js/ai-workflow.js"), "utf8");
const translator = fs.readFileSync(path.join(projectRoot, "app/js/uploads-editor-translator.js"), "utf8");
const knowledge = fs.readFileSync(path.join(projectRoot, "app/js/naming-knowledge.js"), "utf8");
const workspaceMigration = fs.readFileSync(path.join(projectRoot, "app/js/workspace-migration.js"), "utf8");
const index = fs.readFileSync(path.join(projectRoot, "app/index.html"), "utf8");

test("开始命名区直接选择各种翻译服务并与设置页双向同步", () => {
  assert.match(workflow, /ensureTranslationProviderReady\(\{ revealSettings: true \}\)/);
  assert.match(workflow, /shouldUseTranslationProvider = !shouldUseAi && useTranslationProvider/);
  assert.match(workflow, /runTranslationNamingQueue/);
  assert.doesNotMatch(workflow, /activateBaiduTranslation/);
  assert.match(workflow, /"translate:local": \{ provider: "local"/);
  assert.match(workflow, /"translate:cfc": \{ provider: "cfc"/);
  assert.match(workflow, /"translate:baidu": \{ provider: "baidu"/);
  assert.match(workflow, /"translate:model": \{ provider: "model"/);
  assert.match(workflow, /async function selectTranslationProvider/);
  assert.match(workflow, /await hydrateDesktopCredentials\(\)/);
  assert.match(workflow, /syncNamingModeWithTranslationSettings\(\{ force:/);
  assert.match(translator, /selectTranslationProvider\(provider, \{ forceNamingMode: true \}\)/);
  assert.match(translator, /syncNamingModeWithTranslationSettings\(\{ force: true \}\)/);
  assert.match(workflow, /forceExternal: true/);
  assert.match(workflow, /requireExternal: true/);
  assert.match(workflow, /翻译服务有.*调用失败/);
  assert.match(translator, /provider === "local"/);
  assert.match(translator, /offlineTranslation\.getStatus\(\)/);
  assert.match(translator, /provider === "model"/);
  assert.match(knowledge, /if \(options\.requireExternal\) throw error/);
  assert.match(index, /<optgroup label="翻译服务命名">/);
  assert.match(index, /<option value="translate:local">内置离线 AI 翻译<\/option>/);
  assert.match(index, /<option value="translate:cfc" selected>NGR 云翻译（开箱即用）<\/option>/);
  assert.match(index, /<option value="translate:baidu">自有百度翻译 API<\/option>/);
  assert.match(index, /<option value="translate:model">OpenAI 兼容文本模型<\/option>/);
  assert.match(index, />运行 NGR 云翻译命名<\/button>/);
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
  assert.match(index, /value="cfc">NGR 云翻译（百度 CFC，开箱即用）/);
  assert.match(index, /API 已随正式版启用，打开即可使用，无需填写 APP ID 或密钥/);
  assert.match(translator, /if \(provider === "cfc"\) els\.baiduCredentialType\.value = "legacy"/);
  assert.match(translator, /translationSettings\.managedCfcAvailable/);
  assert.match(translator, /aiTextTranslate/);
});

test("NGR 云翻译使用受管授权，不要求用户填写百度 API", () => {
  assert.match(translator, /function isManagedCfcTranslationReady\(\)/);
  assert.match(translator, /translationSettings\.managed \|\| translationSettings\.managedCfcAvailable/);
  assert.match(translator, /function hasDesktopTranslationAuthorization\(\)/);
  assert.match(translator, /translationSettings\.hasSecret \|\| isManagedCfcTranslationReady\(\)/);
  assert.match(knowledge, /const desktopCredential = hasDesktopTranslationAuthorization\(\)/);
  assert.match(translator, /当前构建未内置 NGR 云翻译配置/);
  assert.match(translator, /function syncManagedCfcAvailabilityUi\(\)/);
  assert.match(translator, /option\.disabled = !available/);
  assert.match(workspaceMigration, /missingManagedCfc \? "local" : translationSettings\.provider/);
  assert.match(workspaceMigration, /providerId: missingManagedCfc \? ""/);
});
