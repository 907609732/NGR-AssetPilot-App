import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { _electron as electron } from "playwright";

test("keep awake settings work in Electron and survive restart", { timeout: 90_000 }, async () => {
  const root = path.resolve(import.meta.dirname, "..");
  fs.mkdirSync(path.join(root, ".tmp"), { recursive: true });
  const dir = fs.mkdtempSync(path.join(root, ".tmp", "keep-awake-ui-"));
  const launch = () => electron.launch({ args: [path.join(root, "desktop/main/index.mjs")], cwd: root,
    env: { ...process.env, NGR_E2E_USER_DATA: path.join(dir, "UserData"), APPDATA: path.join(dir, "Roaming"), LOCALAPPDATA: path.join(dir, "Local"), ELECTRON_ENABLE_LOGGING: "0" } });
  let app = await launch();
  try {
    let page = await app.firstWindow();
    await page.waitForFunction(() => document.querySelector("#generalSettingsView .settings-tabs"));
    await page.locator("#rulesEntry").click();
    await page.waitForFunction(() => !document.getElementById("keepAwakeEnabled").disabled);
    assert.equal(await page.locator("#keepAwakeEnabled").isChecked(), false);
    await page.locator("#keepAwakeEnabled").check();
    await page.waitForFunction(async () => (await window.ngrDesktop.keepAwake.getState()).systemActive);
    await page.locator("#keepAwakeMode").selectOption("combined");
    await page.waitForFunction(async () => (await window.ngrDesktop.keepAwake.getState()).mouseState === "running", undefined, { timeout: 20000 });
    assert.equal((await page.evaluate(() => window.ngrDesktop.keepAwake.getState())).systemActive, true);
    await page.waitForFunction(() => document.getElementById("keepAwakeStatus").textContent.includes("待命"));
    fs.mkdirSync(path.join(root, "artifacts/keep-awake"), { recursive: true });
    await page.screenshot({ path: path.join(root, "artifacts/keep-awake/settings.png") });
    await app.close();
    app = await launch(); page = await app.firstWindow();
    await page.waitForFunction(async () => window.ngrDesktop?.keepAwake && (await window.ngrDesktop.keepAwake.getState()).mouseState === "running");
    const restored = await page.evaluate(() => window.ngrDesktop.keepAwake.getState());
    assert.equal(restored.enabled, true); assert.equal(restored.mode, "combined"); assert.equal(restored.systemActive, true);
    await page.waitForFunction(() => document.querySelector("#generalSettingsView .settings-tabs"));
    await page.locator("#rulesEntry").click();
    await page.locator("#keepAwakeMode").selectOption("mouse");
    await page.waitForFunction(async () => !(await window.ngrDesktop.keepAwake.getState()).systemActive);
    await page.locator("#keepAwakeEnabled").uncheck();
    await page.waitForFunction(async () => !(await window.ngrDesktop.keepAwake.getState()).enabled);
    const off = await page.evaluate(() => window.ngrDesktop.keepAwake.getState());
    assert.equal(off.mouseState, "stopped"); assert.equal(off.systemActive, false);
  } finally { await app.close(); }
});
