import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright";
import sharp from "sharp";
import { LocalStore, readBugImagesDOM, normalizeBugImageCandidates } from "../desktop/services/tapd-report-runtime.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// The two fixtures are original FFmpeg testsrc2 clips (320×180, 15 fps, 8 s),
// encoded as H.264/yuv420p and VP9. Runtime tests require no FFmpeg installation.

function currentWeek() {
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
  const monday = new Date(`${today}T00:00:00Z`);
  monday.setUTCDate(monday.getUTCDate() - (monday.getUTCDay() || 7) + 1);
  const sunday = new Date(monday);
  sunday.setUTCDate(sunday.getUTCDate() + 6);
  return { start: monday.toISOString().slice(0, 10), end: sunday.toISOString().slice(0, 10) };
}

async function seedLegacyMedia(runRoot, period) {
  const outputPath = path.join(runRoot, `TAPD-Bug图片--${period.start}至${period.end}`);
  const imageDirectory = path.join(outputPath, "101-旧版图片验收");
  const videoDirectory = path.join(outputPath, "202-视频播放验收");
  await fs.mkdir(imageDirectory, { recursive: true });
  await fs.mkdir(videoDirectory, { recursive: true });
  const imagePath = path.join(imageDirectory, "01-描述-红色原图.png");
  await sharp({ create: { width: 1800, height: 1200, channels: 3, background: "#ed263a" } }).png().toFile(imagePath);
  await sharp({ create: { width: 96, height: 96, channels: 3, background: "#2465ed" } }).png()
    .toFile(path.join(videoDirectory, "01-评论-蓝色图片.png"));
  await fs.copyFile(path.join(projectRoot, "tests/fixtures/tapd-media/playback.mp4"), path.join(videoDirectory, "02-附件-播放验收.mp4"));
  await fs.copyFile(path.join(projectRoot, "tests/fixtures/tapd-media/playback.webm"), path.join(videoDirectory, "03-评论-播放验收.webm"));
  const store = await LocalStore.open(path.join(runRoot, "UserData", "tapd-report"));
  try {
    // No capture or report entries: legacy exports must remain browsable independently.
    store.recordExport(outputPath, "bug-images", false);
  } finally {
    store.close();
  }
  return { outputPath, imagePath };
}

test("Electron Bug 媒体：旧目录、搜索、原图复制、视频播放拖动及受限流式读取", { timeout: 120_000 }, async () => {
  await fs.mkdir(path.join(projectRoot, ".tmp"), { recursive: true });
  const runRoot = await fs.mkdtemp(path.join(projectRoot, ".tmp", "tapd-media-e2e-"));
  const period = currentWeek();
  const fixture = await seedLegacyMedia(runRoot, period);
  const app = await electron.launch({
    args: [path.join(projectRoot, "desktop/main/index.mjs")], cwd: projectRoot,
    env: {
      ...process.env,
      APPDATA: path.join(runRoot, "Roaming"), LOCALAPPDATA: path.join(runRoot, "Local"),
      NGR_E2E_USER_DATA: path.join(runRoot, "UserData"), ELECTRON_ENABLE_LOGGING: "0",
    },
  });
  let clipboardSaved = false;
  let reportPage;
  try {
    const main = await app.firstWindow();
    main.on("dialog", async (dialog) => { console.error(`Unexpected app dialog: ${dialog.message()}`); await dialog.dismiss(); });
    await main.waitForFunction(() => Boolean(window.ngrDesktop?.tapdReport));
    await main.locator(".settings-tabs").first().waitFor({ state: "attached" });
    const nextWindow = app.waitForEvent("window");
    await main.locator("#moreFeaturesEntry").click();
    await main.locator("#tapdReportEntry").click();
    const report = await nextWindow;
    reportPage = report;
    await report.waitForFunction(() => Boolean(window.tapd?.listBugMedia));
    await report.evaluate(() => {
      const host = document.createElement("richtext-preview");
      host.setAttribute("value", '<video controls src="https://tapd.tencent.com/20416981/attachments/preview_attachments/11/bug_description" poster="https://tapd.tencent.com/poster/11"><source src="https://tapd.tencent.com/20416981/attachments/preview_attachments/11/bug_description"></video><video src="https://tapd.tencent.com/20416981/attachments/preview_attachments/22/bug_description"></video>');
      host.attachShadow({ mode: "open" });
      document.body.append(host);
    });
    const embedded = await report.evaluate(readBugImagesDOM);
    await report.locator("richtext-preview").evaluate((host) => host.remove());
    const embeddedVideos = normalizeBugImageCandidates(embedded, "https://tapd.tencent.com/tapd_fe/20416981/bug/detail/1")
      .filter((item) => item.mediaType === "video");
    assert.equal(embeddedVideos.length, 2, "unloaded richtext shadow content must yield both original videos");
    assert.ok(embeddedVideos.every((item) => item.urls.every((url) => !url.includes("/poster/"))));
    const stored = await report.evaluate(() => window.tapd.load());
    assert.equal(stored.capture, null);
    const groups = await report.evaluate((period) => window.tapd.listBugMedia({ period }), period);
    assert.equal(groups.length, 2);
    const images = groups.find((group) => group.bugId === "101");
    const videos = groups.find((group) => group.bugId === "202");
    assert.ok(images && videos);
    assert.equal(images.items.filter((item) => item.kind === "image").length, 1);
    assert.equal(videos.items.filter((item) => item.kind === "video").length, 2);
    await report.getByRole("tab", { name: "Bug 媒体" }).click();

    // UI selectors are shared with the accessible labels in BugMediaBrowser.
    const search = report.getByRole("searchbox", { name: "搜索 Bug 单号或标题" });
    await search.fill("101");
    await report.getByRole("button", { name: /查看 Bug #101 媒体/ }).waitFor();
    assert.equal(await report.getByRole("button", { name: /查看 Bug #202 媒体/ }).count(), 0);
    await search.fill("视频播放验收");
    await report.getByRole("button", { name: /查看 Bug #202 媒体/ }).waitFor();
    assert.equal(await report.getByRole("button", { name: /查看 Bug #101 媒体/ }).count(), 0);
    await search.fill("");
    await report.getByRole("button", { name: /查看 Bug #101 媒体/ }).click();
    await report.locator(`[data-media-id="${images.items[0].id}"]`).getByRole("button", { name: /放大图片/ }).click();
    const lightbox = report.getByRole("dialog", { name: /图片大图/ });
    await lightbox.locator("img").waitFor();
    await report.waitForFunction(() => {
      const image = document.querySelector('.bug-media-lightbox-stage img');
      return image?.complete && image.naturalWidth === 1800 && image.naturalHeight === 1200;
    });
    await report.keyboard.press("Escape");

    await app.evaluate(({ clipboard }) => {
      globalThis.__tapdMediaClipboard = {
        text: clipboard.readText(), html: clipboard.readHTML(), rtf: clipboard.readRTF(),
        image: clipboard.readImage(), bookmark: clipboard.readBookmark(),
      };
    });
    clipboardSaved = true;
    await report.getByRole("button", { name: `复制图片 ${images.items[0].fileName}`, exact: true }).click();
    await report.getByText("图片已复制", { exact: true }).waitFor();
    const copied = await app.evaluate(({ clipboard }) => clipboard.readImage().toPNG().toString("base64"));
    const decoded = await sharp(Buffer.from(copied, "base64")).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const original = await sharp(fixture.imagePath).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    assert.equal(decoded.info.width, 1800);
    assert.equal(decoded.info.height, 1200);
    assert.deepEqual(decoded.data, original.data, "clipboard must contain original image pixels, not thumbnail pixels");

    await report.getByRole("button", { name: /查看 Bug #202 媒体/ }).click();
    for (const item of videos.items.filter((item) => item.kind === "video")) {
      await report.locator(`[data-media-id="${item.id}"]`).getByRole("button", { name: "▶ 加载并播放视频" }).click();
      const player = report.locator(`[data-media-id="${item.id}"] video`);
      await player.scrollIntoViewIfNeeded();
      await player.evaluate(async (video) => { video.muted = true; await video.play(); });
      await report.waitForFunction((id) => {
        const video = document.querySelector(`[data-media-id="${id}"] video`);
        return video?.currentTime > 0.25 && !video.paused;
      }, item.id);
      await player.evaluate((video) => { video.pause(); video.focus(); });
      const before = await player.evaluate((video) => video.currentTime);
      const bounds = await player.boundingBox();
      assert.ok(bounds);
      const trackY = bounds.y + bounds.height - 22;
      await report.mouse.move(bounds.x + 20, trackY);
      await report.mouse.down();
      await report.mouse.move(bounds.x + bounds.width * 0.7, trackY, { steps: 8 });
      await report.mouse.up();
      await report.waitForFunction(({ id, before }) => {
        const video = document.querySelector(`[data-media-id="${id}"] video`);
        return video && video.currentTime > before + 1;
      }, { id: item.id, before });
    }

    const videoItem = videos.items.find((item) => item.kind === "video");
    const videoUrl = await report.evaluate(({ period, id }) => window.tapd.getBugMediaUrl({
      period, bugId: "202", mediaId: id, variant: "original",
    }), { period, id: videoItem.id });
    const range = await app.evaluate(async ({ net }, url) => {
      const response = await net.fetch(url, { headers: { Range: "bytes=0-31" } });
      return { status: response.status, contentRange: response.headers.get("content-range"), bytes: (await response.arrayBuffer()).byteLength };
    }, videoUrl);
    assert.equal(range.status, 206);
    assert.equal(range.bytes, 32);
    assert.match(range.contentRange, /^bytes 0-31\/\d+$/);
    const rejected = await report.evaluate(async (period) => {
      try {
        await window.tapd.getBugMediaUrl({ period, bugId: "202", mediaId: "f".repeat(32), variant: "original" });
        return false;
      } catch { return true; }
    }, period);
    assert.equal(rejected, true, "unregistered media IDs must not grant file access");
    const unknownTokenStatus = await app.evaluate(async ({ net }, url) => {
      return (await net.fetch(new URL(`/tapd-media/${"0".repeat(48)}`, url).href)).status;
    }, videoUrl);
    assert.equal(unknownTokenStatus, 404, "unregistered URL capabilities must not serve files");

    await report.locator(`[data-media-id="${videoItem.id}"] video`).evaluate(async (video) => {
      globalThis.__tapdPreviousVideo = video;
      await video.play();
    });
    await report.getByRole("button", { name: /查看 Bug #101 媒体/ }).click();
    await report.waitForFunction(() => {
      const old = globalThis.__tapdPreviousVideo;
      return old && !old.isConnected && old.paused && !old.getAttribute("src");
    });
    await report.reload();
    await report.waitForFunction(() => Boolean(window.tapd?.listBugMedia));
    await report.getByRole("tab", { name: "Bug 媒体" }).click();
    await report.getByRole("button", { name: /查看 Bug #101 媒体/ }).waitFor();
    assert.equal((await report.evaluate((period) => window.tapd.listBugMedia({ period }), period)).length, 2);
    await report.screenshot({ path: path.join(runRoot, "bug-media-accepted.png"), fullPage: true });
  } catch (error) {
    await reportPage?.screenshot({ path: path.join(runRoot, "bug-media-failure.png"), fullPage: true }).catch(() => {});
    throw error;
  } finally {
    if (clipboardSaved) {
      await app.evaluate(({ clipboard }) => {
        const saved = globalThis.__tapdMediaClipboard;
        if (!saved) return;
        clipboard.write({ text: saved.text, html: saved.html, rtf: saved.rtf, image: saved.image,
          ...(saved.bookmark?.title ? { bookmark: saved.bookmark.title } : {}) });
        delete globalThis.__tapdMediaClipboard;
      }).catch(() => {});
    }
    await app.close();
  }
});
