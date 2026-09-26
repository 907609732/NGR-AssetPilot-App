import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { _electron as electron } from "playwright";

test("工程标题文件夹入口、首次连接、结果保留和过期查询", { timeout: 120_000 }, async () => {
  const root = path.resolve(import.meta.dirname, "..");
  fs.mkdirSync(path.join(root, ".tmp"), { recursive: true });
  const dir = fs.mkdtempSync(path.join(root, ".tmp", "arthub-ui-"));
  const evidence = path.join(root, "artifacts/arthub-folders");
  fs.mkdirSync(evidence, { recursive: true });
  const app = await electron.launch({ args: [path.join(root, "desktop/main/index.mjs")], cwd: root,
    env: { ...process.env, NGR_E2E_USER_DATA: path.join(dir, "UserData"), ELECTRON_ENABLE_LOGGING: "0" } });
  try {
    const page = await app.firstWindow();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.stack || e.message));
    await page.waitForFunction(() => document.querySelector("#generalSettingsView .settings-tabs"));
    await page.locator("#workEntry").click();
    assert.ok(await page.locator("#openProjectFolder").isDisabled());
    await page.locator("#workProjectName").fill("ActivityMiniWinter");
    assert.ok(await page.locator("#openProjectFolder").isEnabled());
    await page.locator("#openProjectFolder").click();
    await page.locator('.arthub-folder-dialog form:not([hidden])').waitFor();
    await page.screenshot({ path: path.join(evidence, "first-connection.png") });
    await app.evaluate(({ BrowserWindow }) => { const win = BrowserWindow.getAllWindows()[0]; win.unmaximize(); win.setSize(1000, 700); });
    await page.waitForFunction(() => innerHeight < 750);
    const bounds = await page.locator('.arthub-folder-dialog').boundingBox();
    const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
    assert.ok(bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= viewport.width && bounds.y + bounds.height <= viewport.height);
    await page.screenshot({ path: path.join(evidence, "small-window.png") });
    await page.locator('.arthub-folder-dialog input[name="token"]').fill("fixture-token");
    await page.locator('.arthub-folder-dialog input[name="assetHub"]').fill("trial");
    // UI fixture only: no real authorization or cloud request is asserted by this test.
    await app.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler("ngr:arthub-folders:configure");
      ipcMain.handle("ngr:arthub-folders:configure", () => ({ configured: true }));
      ipcMain.removeHandler("ngr:arthub-folders:search");
      ipcMain.handle("ngr:arthub-folders:search", (_e, payload) => {
        globalThis.pendingFolderName = payload.projectName;
        return new Promise((resolve) => { globalThis.resolveFolderQuery = resolve; });
      });
    });
    await page.locator('.arthub-folder-dialog button[type="submit"]').click();
    await page.waitForFunction(() => document.querySelector('.arthub-folder-dialog form').hidden);
    assert.equal(await page.locator('.arthub-folder-dialog input[name="token"]').inputValue(), "");
    await page.locator('[data-search]').click();
    assert.ok(await page.locator("#openProjectFolder").isDisabled());
    await app.evaluate(() => globalThis.resolveFolderQuery({ matches: [{ resultId: "fixture", name: "ActivityMiniWinter", assetHub: "trial", path: "UI/ActivityMiniWinter" }], clientReady: false, clientReason: "精确定位协议尚未验证，不会跳转浏览器。" }));
    await page.locator(".arthub-folder-result").waitFor();
    assert.ok(await page.locator(".arthub-folder-result").isDisabled());
    assert.match(await page.locator(".arthub-folder-result").innerText(), /UI\/ActivityMiniWinter/);
    await page.screenshot({ path: path.join(evidence, "query-result-fixture.png") });
    await page.locator('[data-search]').click();
    await page.evaluate(() => { const input = document.getElementById("workProjectName"); input.value = "OtherProject"; input.dispatchEvent(new Event("input", { bubbles: true })); });
    await app.evaluate(() => globalThis.resolveFolderQuery({ matches: [{ name: "ActivityMiniWinter" }], clientReady: true }));
    await page.waitForFunction(() => !document.getElementById("openProjectFolder").disabled);
    assert.equal(await page.locator(".arthub-folder-result").count(), 0);
    await page.locator('[data-close]').press("Escape");
    assert.equal(await page.locator(".arthub-folder-dialog").isVisible(), false);
    assert.deepEqual(errors, []);
  } finally { await app.close(); }
});
