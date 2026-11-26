import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { _electron as electron } from "playwright-core";

test("设置保留完整历史，更新弹窗显示跨版本内容及固定下载进度", { timeout: 120_000 }, async () => {
  const root = path.resolve(import.meta.dirname, "..");
  fs.mkdirSync(path.join(root, ".tmp"), { recursive: true });
  const dir = fs.mkdtempSync(path.join(root, ".tmp", "release-history-"));
  const evidence = path.join(root, "artifacts/release-history");
  fs.mkdirSync(evidence, { recursive: true });
  const packaged = process.env.NGR_TEST_PACKAGED_EXE;
  const app = await electron.launch({ executablePath: packaged || path.join(root, "node_modules/electron/dist/electron.exe"),
    args: packaged ? [] : [root], cwd: root,
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
      const state = { enabled: true, currentVersion: "3.0.13", availableVersion: "3.0.17", phase: "available", releaseNotes: "测试长说明\n".repeat(120), releaseDate: "2026-09-26", downloadSize: 104857600 };
      ipcMain.removeHandler("ngr:updater:history");
      ipcMain.handle("ngr:updater:history", () => ({ fetchedAt: "fixture", releases: [
        ...[14, 16, 17, 18].map(i => ({ id: i, version: `v3.0.${i}`, notes: `版本 ${i} 内容\n未签名，可能显示未知发布者\n${i === 17 ? "新版功能\n".repeat(120) : ""}` })),
        { id: 13, version: "v3.0.13", notes: "已安装的版本" },
        { id: 15, version: "v3.0.15", prerelease: true, notes: "预发行版本" },
      ] }));
      ipcMain.removeHandler("ngr:updater:download");
      ipcMain.handle("ngr:updater:download", () => ({ ...state, phase: "downloading", progress: { percent: 37, transferred: 38797312, total: 104857600, bytesPerSecond: 1048576 } }));
      win.webContents.send("ngr:updater:state-changed", state);
      win.unmaximize(); win.setSize(1100, 650);
    });
    await page.locator("#updateAvailableButton").click();
    await page.waitForFunction(() => document.querySelector("#updateVersionsBehind").textContent === "已落后 3 个版本");
    const notes = await page.locator("#updateReleaseNotes").textContent();
    assert.match(notes, /v3\.0\.17[\s\S]*v3\.0\.16[\s\S]*v3\.0\.14/);
    assert.doesNotMatch(notes, /未签名|未知发布者|v3\.0\.(13|15|18)/);
    await page.locator("#updatePrimaryAction").click();
    await page.waitForFunction(() => document.getElementById("updateProgressPercent").textContent === "37%");
    const viewport = await page.evaluate(() => innerHeight);
    const rect = await page.locator(".update-dialog-footer").boundingBox();
    assert.ok(rect.y >= 0 && rect.y + rect.height <= viewport);
    await page.screenshot({ path: path.join(evidence, "fixed-download-progress.png") });
    await page.locator(".update-dialog-body").evaluate((node) => { node.scrollTop = node.scrollHeight; });
    const scrolledRect = await page.locator(".update-dialog-footer").boundingBox();
    assert.equal(scrolledRect.y, rect.y);
    await page.screenshot({ path: path.join(evidence, "history-scrolled-progress.png") });
  } finally { await app.close(); }
});
