import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { _electron as electron } from "playwright";

const projectRoot = path.resolve(import.meta.dirname, "..");
const appUrl = pathToFileURL(path.join(projectRoot, "app", "index.html")).href;

test("安装完成提示按安装类型显示，并在对应界面显示后才确认", { timeout: 45_000 }, async (context) => {
  const tempRoot = path.resolve(os.tmpdir());
  const fixtureRoot = mkdtempSync(path.join(tempRoot, "ngr-installation-notice-"));
  context.after(() => {
    if (path.dirname(fixtureRoot) === tempRoot) rmSync(fixtureRoot, { recursive: true, force: true });
  });
  const mainPath = path.join(fixtureRoot, "main.cjs");
  writeFileSync(mainPath, `
    const { app, BrowserWindow, ipcMain } = require("electron");
    const path = require("node:path");
    app.setPath("userData", path.join(__dirname, "UserData"));
    globalThis.fixture = { notice: null, reads: 0, acknowledgements: [] };
    ipcMain.handle("fixture:get", () => {
      fixture.reads += 1;
      return fixture.notice;
    });
    ipcMain.handle("fixture:acknowledge", (_event, id, displayed) => {
      fixture.acknowledgements.push({ id, displayed });
      if (fixture.notice?.id === id) fixture.notice = null;
    });
    app.whenReady().then(() => {
      const window = new BrowserWindow({
        width: 1060,
        height: 720,
        webPreferences: { preload: path.join(__dirname, "preload.cjs") },
      });
      window.loadURL("about:blank");
    });
  `);
  writeFileSync(path.join(fixtureRoot, "preload.cjs"), `
    const { contextBridge, ipcRenderer } = require("electron");
    contextBridge.exposeInMainWorld("ngrDesktop", {
      installationNotice: {
        get: async () => {
          const notice = await ipcRenderer.invoke("fixture:get");
          document.documentElement.dataset.installationNoticeRead = "true";
          return notice;
        },
        acknowledge: async (id) => {
          const visible = (selector) => document.querySelector(selector)?.getClientRects().length > 0;
          const displayed = visible("#tutorialCenterOverlay") ? "tutorial"
            : visible("#installationNoticeDialog") ? "notice" : null;
          await ipcRenderer.invoke("fixture:acknowledge", id, displayed);
          document.documentElement.dataset.installationNoticeAcknowledged = id;
        },
      },
    });
  `);
  const app = await electron.launch({ args: [mainPath], cwd: projectRoot });
  try {
    const page = await app.firstWindow();
    const tutorial = page.locator("#tutorialCenterOverlay");
    const dialog = page.locator("#installationNoticeDialog");
    const beforeInstall = page.locator("#updateDialogOverlay");

    async function loadNotice(notice) {
      await app.evaluate((_electron, next) => { globalThis.fixture.notice = next; }, notice);
      await page.goto(appUrl);
    }
    const waitForAcknowledgement = (id) => page.waitForFunction((expected) =>
      document.documentElement.dataset.installationNoticeAcknowledged === expected, id, { timeout: 5000 });
    const getFixture = () => app.evaluate(() => globalThis.fixture);

    await loadNotice({ id: "first", kind: "first", version: "3.0.27" });
    await tutorial.waitFor({ state: "visible", timeout: 5000 });
    assert.equal(await dialog.isVisible(), false);
    await page.locator("#tutorialCenterSearch").waitFor({ state: "visible" });
    await page.waitForFunction(() => document.activeElement?.id === "tutorialCenterSearch");
    await waitForAcknowledgement("first");
    assert.deepEqual((await getFixture()).acknowledgements, [{ id: "first", displayed: "tutorial" }]);
    await page.locator("#tutorialCenterClose").click();

    await page.reload();
    await page.locator('html[data-installation-notice-read="true"]').waitFor({ timeout: 5000 });
    assert.equal(await tutorial.isVisible(), false);
    assert.equal(await dialog.isVisible(), false);

    const notes = "新增快速找界面\n<img src=x> & <strong>原文</strong>";
    await loadNotice({ id: "update", kind: "update", version: "3.0.27", previousVersion: "3.0.26", notes });
    await page.getByRole("dialog", { name: "更新完成" }).waitFor({ timeout: 5000 });
    assert.match(await page.locator("#installationNoticeVersion").innerText(), /V3\.0\.27.*V3\.0\.26/);
    assert.equal(await page.locator("#installationNoticeNotes").textContent(), notes);
    assert.equal(await page.locator("#installationNoticeNotes > *").count(), 0);
    assert.equal(await beforeInstall.isVisible(), false);
    await page.waitForFunction(() => document.activeElement?.id === "installationNoticeClose");
    await waitForAcknowledgement("update");
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "hidden" });

    await loadNotice({ id: "reinstall", kind: "reinstall", version: "3.0.27", previousVersion: "3.0.27", notes: " " });
    await page.getByRole("dialog", { name: "重新安装完成" }).waitFor({ timeout: 5000 });
    assert.equal(await page.locator("#installationNoticeVersion").innerText(), "当前版本 V3.0.27");
    assert.equal(await page.locator("#installationNoticeNotes").innerText(), "暂无版本变动说明");
    await waitForAcknowledgement("reinstall");
    await page.locator("#installationNoticeClose").click();
    await dialog.waitFor({ state: "hidden" });

    const fixture = await getFixture();
    assert.equal(fixture.reads, 4);
    assert.deepEqual(fixture.acknowledgements, [
      { id: "first", displayed: "tutorial" },
      { id: "update", displayed: "notice" },
      { id: "reinstall", displayed: "notice" },
    ]);
  } finally {
    await app.close();
  }
});
