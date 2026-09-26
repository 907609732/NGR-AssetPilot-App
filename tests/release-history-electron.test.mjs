import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { _electron as electron } from "playwright";

test("设置与更新弹窗显示全部历史，长列表下载进度固定在底部", { timeout: 120_000 }, async () => {
  const root = path.resolve(import.meta.dirname, "..");
  fs.mkdirSync(path.join(root, ".tmp"), { recursive: true });
  const dir = fs.mkdtempSync(path.join(root, ".tmp", "release-history-"));
  const evidence = path.join(root, "artifacts/release-history");
  fs.mkdirSync(evidence, { recursive: true });
  const app = await electron.launch({ args: [path.join(root, "desktop/main/index.mjs")], cwd: root,
    env: { ...process.env, NGR_E2E_USER_DATA: path.join(dir, "UserData"), ELECTRON_ENABLE_LOGGING: "0" } });
  try {
    const page = await app.firstWindow();
    await page.waitForFunction(() => document.querySelector("#generalSettingsView .settings-tabs"));
    const actual = await page.evaluate(() => NgrDesktopBridge.getReleaseHistory());
    assert.ok(actual.releases.length >= 13);
    await page.locator("#rulesEntry").click();
    await page.waitForFunction(() => document.querySelectorAll("#generalSettingsView .release-history-list details").length >= 13);
    await page.locator("#generalSettingsView .release-history-list summary").first().click();
    await page.screenshot({ path: path.join(evidence, "settings-real-history.png") });
    await page.locator("#backButton").click();
    await app.evaluate(({ ipcMain, BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0];
      const state = { enabled: true, currentVersion: "3.0.13", availableVersion: "3.0.14", phase: "available", releaseNotes: "测试长说明\n".repeat(120), releaseDate: "2026-09-26", downloadSize: 104857600 };
      ipcMain.removeHandler("ngr:updater:history");
      ipcMain.handle("ngr:updater:history", () => ({ fetchedAt: "fixture", releases: Array.from({ length: 120 }, (_, i) => ({ id: i, version: `v2.0.${i}`, name: `历史版本 ${i}`, date: "2025-01-01", notes: "<img src=x onerror=alert(1)>\n更新说明" })) }));
      ipcMain.removeHandler("ngr:updater:download");
      ipcMain.handle("ngr:updater:download", () => ({ ...state, phase: "downloading", progress: { percent: 37, transferred: 38797312, total: 104857600, bytesPerSecond: 1048576 } }));
      win.webContents.send("ngr:updater:state-changed", state);
      win.unmaximize(); win.setSize(1100, 650);
    });
    await page.locator("#updateAvailableButton").click();
    await page.waitForFunction(() => document.querySelectorAll("#updateDialogOverlay .release-history-list details").length === 120);
    assert.equal(await page.locator("#generalSettingsView .release-history-list details").count(), 120);
    await page.locator("#updatePrimaryAction").click();
    await page.waitForFunction(() => document.getElementById("updateProgressPercent").textContent === "37%");
    const viewport = await page.evaluate(() => innerHeight);
    const rect = await page.locator(".update-dialog-footer").boundingBox();
    assert.ok(rect.y >= 0 && rect.y + rect.height <= viewport);
    await page.screenshot({ path: path.join(evidence, "fixed-download-progress.png") });
    await page.locator(".update-dialog-body").evaluate((node) => { node.scrollTop = node.scrollHeight; });
    const scrolledRect = await page.locator(".update-dialog-footer").boundingBox();
    assert.equal(scrolledRect.y, rect.y);
    await page.locator("#updateDialogOverlay .release-history-list summary").last().click();
    assert.equal(await page.locator("#updateDialogOverlay .release-history-list img").count(), 0);
    await page.screenshot({ path: path.join(evidence, "history-scrolled-progress.png") });
  } finally { await app.close(); }
});
