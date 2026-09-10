import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { _electron as electron } from "playwright";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const appEntry = path.join(projectRoot, "desktop", "main", "index.mjs");

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address()));
  });
}

test("Electron API 页可创建自定义目标、运行本机诊断并管理历史", { timeout: 45_000 }, async () => {
  const server = http.createServer((_request, response) => {
    response.writeHead(401, { "content-type": "application/json", "x-test-secret": "must-not-be-exposed" });
    response.end('{"token":"must-not-be-read"}');
  });
  const address = await listen(server);
  fs.mkdirSync(path.join(projectRoot, ".tmp"), { recursive: true });
  const runRoot = fs.mkdtempSync(path.join(projectRoot, ".tmp", "diagnostics-electron-"));
  const electronApp = await electron.launch({
    args: [appEntry],
    cwd: projectRoot,
    env: {
      ...process.env,
      APPDATA: path.join(runRoot, "Roaming"),
      LOCALAPPDATA: path.join(runRoot, "Local"),
      NGR_E2E_USER_DATA: path.join(runRoot, "UserData"),
      ELECTRON_ENABLE_LOGGING: "0",
    },
  });

  try {
    const window = await electronApp.firstWindow();
    await window.waitForLoadState("domcontentloaded");
    await window.waitForFunction(() => Boolean(window.NgrNetworkDiagnostics && window.ngrDesktop?.diagnostics));
    await window.locator("#rulesEntry").click();
    await window.waitForFunction(() => document.querySelector("#generalSettingsView")?.classList.contains("active"));
    await window.locator('#generalSettingsView [data-settings-view="apiSettings"]').click();
    await window.waitForFunction(() => document.querySelector("#apiSettingsView")?.classList.contains("active"));
    await window.waitForFunction(() => document.querySelectorAll("[data-diagnostics-target]").length >= 15);

    assert.match(await window.locator("#diagnosticsOnlineBadge").innerText(), /系统网络(在线|离线)/);
    assert.match(await window.locator("#diagnosticsTargetList").innerText(), /Figma REST API/);
    assert.match(await window.locator("#diagnosticsTargetList").innerText(), /阿里云 OSS/);
    assert.match(await window.locator("#diagnosticsTargetList").innerText(), /腾讯云 COS/);

    await window.locator("#diagnosticsCustomDetails summary").click();
    await window.locator("#diagnosticsCustomName").fill("本机健康检查");
    await window.locator("#diagnosticsCustomUrl").fill(`http://127.0.0.1:${address.port}/health`);
    await window.locator("#diagnosticsCustomMethod").selectOption("HEAD");
    await window.locator("#diagnosticsSaveCustom").click();
    await window.waitForFunction(() => document.querySelector("#diagnosticsCustomList")?.textContent?.includes("本机健康检查"));

    await window.locator("[data-diagnostics-target]").evaluateAll((checkboxes) => {
      for (const checkbox of checkboxes) {
        checkbox.checked = false;
        checkbox.dispatchEvent(new Event("change", { bubbles: true }));
      }
    });
    const localCheckbox = window.locator(".network-diagnostics-target", { hasText: "本机健康检查" }).locator("input");
    await localCheckbox.check();
    await window.locator("#diagnosticsRouteMode").selectOption("system");
    await window.locator("#diagnosticsRunSelected").click();
    await window.waitForFunction(() => document.querySelector("#diagnosticsProgressBadge")?.textContent?.includes("测试完成"));

    const resultText = await window.locator("#diagnosticsResultsBody").innerText();
    assert.match(resultText, /本机健康检查/);
    assert.match(resultText, /可达，需要鉴权/);
    assert.match(resultText, /401/);
    assert.doesNotMatch(resultText, /must-not-be-exposed|must-not-be-read/);

    await window.locator("#diagnosticsHistoryDetails summary").click();
    assert.match(await window.locator("#diagnosticsHistoryList").innerText(), /1\/1 项收到 HTTP 响应/);
    window.once("dialog", (dialog) => dialog.accept());
    await window.locator("#diagnosticsClearHistory").click();
    await window.waitForFunction(() => document.querySelector("#diagnosticsHistoryList")?.textContent?.includes("尚无诊断历史"));

    window.once("dialog", (dialog) => dialog.accept());
    await window.locator("[data-diagnostics-remove]").click();
    await window.waitForFunction(() => document.querySelector("#diagnosticsCustomList")?.textContent?.includes("尚未添加自定义"));
  } finally {
    await electronApp.close();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(runRoot, { recursive: true, force: true });
  }
});
