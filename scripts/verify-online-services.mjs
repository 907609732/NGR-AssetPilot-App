import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { _electron as electron } from "playwright";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const executablePath = path.join(
  projectRoot,
  "artifacts",
  "test",
  "win-unpacked",
  "NGR AssetPilot TEST.exe",
);

const electronApp = await electron.launch({
  executablePath,
  env: { ...process.env, ELECTRON_ENABLE_LOGGING: "0" },
  timeout: 30_000,
});

try {
  const window = await electronApp.firstWindow({ timeout: 30_000 });
  await window.waitForLoadState("domcontentloaded");
  await window.waitForFunction(() => {
    const aiKey = document.querySelector("#openaiApiKey");
    const translationAppId = document.querySelector("#baiduTranslateAppId");
    const translationSecret = document.querySelector("#baiduTranslateSecret");
    return aiKey?.value && translationAppId?.value && translationSecret?.value;
  });

  const providerState = await window.evaluate(() => ({
    ai: document.querySelector("#aiProvider")?.value,
    translation: document.querySelector("#translatorProvider")?.value,
  }));
  assert.equal(providerState.ai, "kimi");
  assert.equal(providerState.translation, "baidu");

  // Each service is deliberately invoked exactly once. Do not add retries.
  await window.evaluate(() => document.querySelector("#testAiSettings").click());
  await window.waitForFunction(() => /API 测试(通过|失败)/.test(document.querySelector("#toast")?.textContent || ""), null, {
    timeout: 125_000,
  });
  const aiResult = await window.evaluate(() => document.querySelector("#toast")?.textContent?.trim() || "");

  await window.evaluate(() => document.querySelector("#testTranslatorSettings").click());
  await window.waitForFunction(() => /^测试(成功|失败)：/.test(document.querySelector("#translatorOutput")?.textContent || ""), null, {
    timeout: 35_000,
  });
  const translationResult = await window.evaluate(() => document.querySelector("#translatorOutput")?.textContent?.trim() || "");

  process.stdout.write(`${JSON.stringify({ aiResult, translationResult })}\n`);
  assert.match(aiResult, /API 测试通过/);
  assert.match(translationResult, /^测试成功：/);
  process.stdout.write("ONLINE_SERVICE_SMOKE_OK\n");
} finally {
  await electronApp.close();
}
