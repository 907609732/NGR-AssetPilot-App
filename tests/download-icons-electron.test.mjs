import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { _electron as electron } from "playwright";
import AdmZip from "adm-zip";

test("下载主按钮直接导出、设置记忆与 EXE 图标显示", { timeout: 120_000 }, async () => {
  const root = path.resolve(import.meta.dirname, "..");
  fs.mkdirSync(path.join(root, ".tmp"), { recursive: true });
  const dir = fs.mkdtempSync(path.join(root, ".tmp", "download-icons-"));
  const userData = path.join(dir, "UserData");
  fs.mkdirSync(userData);
  const realArtHub = "D:\\Program Files\\ArtHub\\ArtHub.exe";
  const executable = path.join(root, "node_modules/electron/dist/electron.exe");
  fs.writeFileSync(path.join(userData, "external-apps.json"), JSON.stringify({ version: 1, apps: [
    { id: "arthub", name: "ArtHub", executablePath: fs.existsSync(realArtHub) ? realArtHub : executable, builtin: true },
    { id: "custom_icon", name: "自定义应用", executablePath: executable, builtin: false },
  ] }));
  const evidence = path.join(root, "artifacts/download-icons");
  fs.mkdirSync(evidence, { recursive: true });
  const launch = () => electron.launch({ args: [path.join(root, "desktop/main/index.mjs")], cwd: root,
    env: { ...process.env, NGR_E2E_USER_DATA: userData, ELECTRON_ENABLE_LOGGING: "0" } });
  let app = await launch();
  try {
    const page = await app.firstWindow();
    await page.waitForFunction(() => document.querySelector("#generalSettingsView .settings-tabs"));
    for (const id of ["arthub", "custom_icon"]) {
      const icon = page.locator(`#externalAppQuickList [data-app-id="${id}"] img`);
      await icon.waitFor();
      assert.ok(await icon.evaluate((img) => img.complete && img.naturalWidth > 0));
    }
    await page.screenshot({ path: path.join(evidence, "application-icons.png") });
    await page.locator("#workEntry").click();
    await page.locator("#namingModeSelect").selectOption("translate:cfc", { force: true });
    assert.equal(await page.locator(".naming-mode-field").count(), 0);
    assert.match(await page.locator("#runSelectedNaming").innerText(), /NGR 云翻译/);
    await page.locator(".naming-service-settings-action").click();
    assert.equal(await page.locator("#namingModeMenu").getAttribute("open"), "");
    await page.locator("#namingModeSelect").selectOption("translate:local");
    await page.waitForFunction(() => document.getElementById("runSelectedNaming").textContent.includes("内置离线 AI 翻译"));
    assert.equal(await page.locator("#namingModeMenu").getAttribute("open"), null);
    await page.locator(".naming-service-settings-action").click();
    await page.screenshot({ path: path.join(evidence, "naming-service-settings.png") });
    await page.keyboard.press("Escape");
    assert.equal(await page.locator("#namingModeMenu").getAttribute("open"), null);
    await page.locator("#exportFiles").click();
    assert.equal(await page.locator("#exportMenu").getAttribute("open"), null);
    assert.match(await page.locator("#toastMessage").innerText(), /没有可导出的图片/);
    await page.locator(".export-settings-action").click();
    await page.locator("#exportModeSelect").selectOption("zip");
    assert.equal(await page.locator("#exportMenu").getAttribute("open"), null);
    const buffer = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAACXBIWXMAAAPoAAAD6AG1e1JrAAAARUlEQVRYhe3XsREAMAhC0czAmEzh5maLpHmFvXcifE6m+3OOBeIEQ4T1hsuIwopHGFUcLyAJJBtQWli+iklUs1FO+1wHFywT7GqIQKHAAAAAAElFTkSuQmCC", "base64");
    await page.locator("#singleInput").setInputFiles({ name: "sample.png", mimeType: "image/png", buffer });
    await page.locator(".inline-final-name input").fill("Home_Button");
    const zipPath = path.join(dir, "result.zip");
    await app.evaluate(({ BrowserWindow }, output) => {
      globalThis.downloadFinished = new Promise((resolve) => {
        BrowserWindow.getAllWindows()[0].webContents.session.once("will-download", (_event, item) => {
          item.setSavePath(output);
          item.once("done", (_event, state) => resolve(state));
        });
      });
    }, zipPath);
    await page.locator("#exportFiles").click();
    await page.waitForFunction(() => document.getElementById("toastMessage").textContent.includes("ZIP 已生成"));
    assert.equal(await app.evaluate(() => globalThis.downloadFinished), "completed");
    const zip = new AdmZip(zipPath);
    assert.equal(zip.getEntries().length, 1);
    assert.match(zip.getEntries()[0].entryName, /Home_Button\.png$/);
    assert.deepEqual(zip.getEntries()[0].getData(), buffer);
    await page.locator(".export-settings-action").click();
    await page.screenshot({ path: path.join(evidence, "download-settings.png") });
    await app.close();
    app = await launch();
    const restored = await app.firstWindow();
    await restored.waitForFunction(() => document.querySelector("#generalSettingsView .settings-tabs"));
    await restored.locator("#workEntry").click();
    assert.equal(await restored.locator("#exportModeSelect").inputValue(), "zip");
    await restored.locator(".export-settings-action").click();
    await restored.locator("#exportModeSelect").selectOption("folder");
    assert.equal(await restored.evaluate(() => localStorage.getItem("ngr-export-mode")), "folder");
  } finally { await app.close(); }
});
