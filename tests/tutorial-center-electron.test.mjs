import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { _electron as electron } from "playwright";

const root = path.resolve(import.meta.dirname, "..");
const appVersion = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;

test("顶部教程合并为按版本和模块分类的软件内教程中心", { timeout: 90_000 }, async () => {
  fs.mkdirSync(path.join(root, ".tmp"), { recursive: true });
  const dir = fs.mkdtempSync(path.join(root, ".tmp", "tutorial-center-"));
  const evidence = path.join(root, "artifacts", "tutorial-center");
  fs.mkdirSync(evidence, { recursive: true });
  const playerRequests = [];
  const app = await electron.launch({
    args: [root],
    cwd: root,
    env: { ...process.env, NGR_E2E_USER_DATA: path.join(dir, "UserData"), ELECTRON_ENABLE_LOGGING: "0" },
  });
  try {
    const page = await app.firstWindow();
    await page.route("https://player.bilibili.com/player.html**", async (route) => {
      playerRequests.push(route.request().url());
      await route.fulfill({
        status: 200,
        contentType: "text/html; charset=utf-8",
        body: '<!doctype html><html><body><p id="player-marker">播放器已加载</p></body></html>',
      });
    });
    await page.waitForFunction(() => window.NgrTutorialCenter?.modules?.length === 11);
    assert.equal(await page.locator("#tutorialCenterEntry").count(), 1);
    assert.equal(await page.locator("#tutorialEntry, #guideEntry").count(), 0);
    assert.match(await page.locator("#tutorialCenterEntry").innerText(), /使用教程/);

    await page.locator("#tutorialCenterEntry").click();
    await page.locator("#tutorialCenterOverlay").waitFor({ state: "visible" });
    assert.equal(await page.locator(".tutorial-center-nav-item").count(), 11);
    const expectedVersion = `适用于 V${appVersion}`;
    await page.waitForFunction((label) => document.querySelector("#tutorialCenterVersion")?.textContent === label, expectedVersion);
    assert.equal(await page.locator("#tutorialCenterVersion").innerText(), expectedVersion);
    assert.equal(await page.locator("#tutorialCenterContent iframe").count(), 0);
    assert.match(await page.locator("#tutorialCenterContent").innerText(), /这个功能是干什么的？/);
    assert.match(await page.locator("#tutorialCenterContent").innerText(), /照着下面做/);
    await page.screenshot({ path: path.join(evidence, "tutorial-center.png") });

    await page.locator(".tutorial-center-nav-item", { hasText: "图片命名" }).click();
    await page.locator("#tutorialCenterContent .tutorial-video").waitFor();
    assert.equal(await page.locator("#tutorialCenterContent iframe").count(), 0);
    assert.equal(playerRequests.length, 0);
    assert.equal(await page.locator(".tutorial-video-poster").count(), 1);
    assert.equal(await page.locator(".tutorial-video-cover").count(), 1);
    assert.equal(
      await page.locator("[data-tutorial-external]").getAttribute("href"),
      "https://www.bilibili.com/video/BV1mAxg63En7/",
    );
    await page.locator(".tutorial-video-poster").click();
    const namingFrame = page.locator("#tutorialCenterContent iframe");
    await namingFrame.waitFor();
    assert.equal(
      await namingFrame.getAttribute("src"),
      "https://player.bilibili.com/player.html?bvid=BV1mAxg63En7&page=1&autoplay=1",
    );
    assert.equal(await namingFrame.getAttribute("sandbox"), "allow-scripts allow-same-origin allow-presentation");
    assert.equal(await namingFrame.getAttribute("referrerpolicy"), "no-referrer");
    assert.notEqual(await namingFrame.getAttribute("allowfullscreen"), null);
    assert.match(await namingFrame.getAttribute("allow"), /fullscreen/);
    const namingPlayer = page.frameLocator("#tutorialCenterContent iframe");
    await namingPlayer.locator("#player-marker").waitFor();
    assert.equal(await namingPlayer.locator("#player-marker").innerText(), "播放器已加载");
    assert.equal(playerRequests.length, 1);

    await page.locator(".tutorial-center-nav-item", { hasText: "UI 切图检测" }).click();
    await page.locator("#tutorialCenterContent iframe").waitFor({ state: "detached" });
    assert.equal(await page.locator("#tutorialCenterContent iframe").count(), 0);
    assert.equal(
      await page.locator("[data-tutorial-external]").getAttribute("href"),
      "https://www.bilibili.com/video/BV1vyn96eELU/",
    );
    const poster = page.locator(".tutorial-video-poster > img");
    assert.match(await poster.getAttribute("src"), /assets\/tutorials\/detection\/slide-03\.png$/);
    await page.waitForFunction(() => {
      const image = document.querySelector(".tutorial-video-poster > img");
      return Boolean(image?.complete && image.naturalWidth > 0);
    });
    await page.locator(".tutorial-video-poster").click();
    const detectionFrame = page.locator("#tutorialCenterContent iframe");
    await detectionFrame.waitFor();
    assert.equal(
      await detectionFrame.getAttribute("src"),
      "https://player.bilibili.com/player.html?bvid=BV1vyn96eELU&page=1&autoplay=1",
    );
    const detectionPlayer = page.frameLocator("#tutorialCenterContent iframe");
    await detectionPlayer.locator("#player-marker").waitFor();
    assert.equal(playerRequests.length, 2);

    await page.locator("#tutorialCenterClose").click();
    await page.locator("#tutorialCenterOverlay").waitFor({ state: "hidden" });
    assert.equal(await page.locator("#tutorialCenterContent iframe").count(), 0);

    await page.locator("#tutorialCenterEntry").click();
    await page.locator("#tutorialCenterOverlay").waitFor({ state: "visible" });
    await page.locator(".tutorial-center-nav-item", { hasText: "图片命名" }).click();
    await page.locator(".tutorial-video-poster").click();
    await page.locator("#tutorialCenterContent iframe").waitFor();
    await page.locator("#tutorialCenterSearch").fill("zzzz没有这个教程");
    await page.locator("#tutorialCenterContent iframe").waitFor({ state: "detached" });
    assert.equal(await page.locator("#tutorialCenterContent iframe").count(), 0);
    assert.equal(await page.locator(".tutorial-center-nav-item").count(), 0);
    assert.match(await page.locator("#tutorialCenterContent").innerText(), /没有搜索结果/);
    await page.locator("#tutorialCenterSearch").fill("");
    assert.equal(await page.locator(".tutorial-center-nav-item").count(), 11);

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

    for (const [view, bvid] of [["work", "BV1mAxg63En7"], ["detect", "BV1vyn96eELU"]]) {
      await page.evaluate((name) => window.NgrTutorialActions.showView(name), view);
      await page.locator("#tutorialCenterEntry").click();
      assert.equal(await page.locator("[data-tutorial-external]").getAttribute("href"), `https://www.bilibili.com/video/${bvid}/`);
      assert.equal(await page.locator("#tutorialCenterNav").isVisible(), false);
      assert.equal(await page.locator(".tutorial-center-nav-item").count(), 0);
      assert.equal(await page.locator(".tutorial-center-toolbar").isVisible(), false);
      assert.equal(await page.locator("#tutorialCenterContent h3").innerText(), view === "work" ? "图片命名" : "UI 切图检测");
      await page.screenshot({ path: path.join(evidence, `${view}-scoped.png`) });
      await page.locator("#tutorialCenterClose").click();
      await page.locator("#tutorialCenterEntry").click();
      assert.equal(await page.locator("#tutorialCenterSearch").inputValue(), "");
      assert.equal(await page.locator("[data-tutorial-external]").getAttribute("href"), `https://www.bilibili.com/video/${bvid}/`);
      await page.locator("#tutorialCenterClose").click();
    }
    await page.evaluate(() => window.NgrTutorialActions.showView("home"));
    await page.locator("#tutorialCenterEntry").click();
    assert.equal(await page.locator("#tutorialCenterNav").isVisible(), true);
    assert.equal(await page.locator(".tutorial-center-nav-item").count(), 11);
  } finally {
    await app.close();
  }
});
