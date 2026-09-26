import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { _electron as electron } from "playwright";

test("顶部教程合并为按版本和模块分类的软件内教程中心", { timeout: 90_000 }, async () => {
  const root = path.resolve(import.meta.dirname, "..");
  fs.mkdirSync(path.join(root, ".tmp"), { recursive: true });
  const dir = fs.mkdtempSync(path.join(root, ".tmp", "tutorial-center-"));
  const evidence = path.join(root, "artifacts", "tutorial-center");
  fs.mkdirSync(evidence, { recursive: true });
  const app = await electron.launch({
    args: [path.join(root, "desktop/main/index.mjs")],
    cwd: root,
    env: { ...process.env, NGR_E2E_USER_DATA: path.join(dir, "UserData"), ELECTRON_ENABLE_LOGGING: "0" },
  });
  try {
    const page = await app.firstWindow();
    await page.waitForFunction(() => window.NgrTutorialCenter?.modules?.length === 11);
    assert.equal(await page.locator("#tutorialCenterEntry").count(), 1);
    assert.equal(await page.locator("#tutorialEntry, #guideEntry").count(), 0);
    assert.match(await page.locator("#tutorialCenterEntry").innerText(), /使用教程/);

    await page.locator("#tutorialCenterEntry").click();
    await page.locator("#tutorialCenterOverlay").waitFor({ state: "visible" });
    assert.equal(await page.locator(".tutorial-center-nav-item").count(), 11);
    assert.equal(await page.locator("#tutorialCenterVersion").innerText(), "适用于 V3.0.14");
    assert.match(await page.locator("#tutorialCenterContent").innerText(), /这个功能是干什么的？/);
    assert.match(await page.locator("#tutorialCenterContent").innerText(), /照着下面做/);
    await page.screenshot({ path: path.join(evidence, "tutorial-center.png") });

    await page.locator("#tutorialCenterSearch").fill("鼠标微动");
    assert.equal(await page.locator(".tutorial-center-nav-item").count(), 1);
    assert.match(await page.locator("#tutorialCenterContent").innerText(), /开机启动、防止息屏与备份/);
    assert.match(await page.locator("#tutorialCenterContent").innerText(), /双重保活/);

    await page.locator("#tutorialCenterSearch").fill("切图检测");
    await page.locator(".tutorial-center-nav-item", { hasText: "UI 切图检测" }).click();
    await page.locator(".tutorial-module-actions button", { hasText: "10 页图文教程" }).click();
    await page.locator("#tutorialOverlay").waitFor({ state: "visible" });
    assert.match(await page.locator("#tutorialTitle").innerText(), /UI切图检测功能教程/);
    await page.keyboard.press("Escape");

    await page.locator("#tutorialCenterEntry").click();
    await page.locator("#tutorialCenterQuickTour").click();
    await page.locator("#guideOverlay").waitFor({ state: "visible" });
    await page.waitForFunction(() => document.querySelector("#guideTitle")?.textContent === "从主界面开始");
    assert.match(await page.locator("#guideTitle").innerText(), /从主界面开始/);
    await page.locator("#guideClose").click();

    await app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0];
      win.unmaximize();
      win.setSize(1100, 700);
    });
    await page.locator("#tutorialCenterEntry").click();
    await page.waitForFunction(() => innerWidth <= 1100 && innerHeight <= 700);
    const dialog = await page.locator(".tutorial-center-dialog").boundingBox();
    const viewport = page.viewportSize() || await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
    assert.ok(dialog.x >= 0 && dialog.y >= 0);
    assert.ok(dialog.x + dialog.width <= viewport.width + 1);
    assert.ok(dialog.y + dialog.height <= viewport.height + 1);
    await page.screenshot({ path: path.join(evidence, "tutorial-center-small.png") });
    await page.keyboard.press("Escape");
    assert.equal(await page.locator("#tutorialCenterOverlay").isHidden(), true);
  } finally {
    await app.close();
  }
});
