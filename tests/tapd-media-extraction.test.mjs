import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import test from "node:test";
import sharp from "sharp";
import { chromium } from "playwright-core";
import {
  extractBugImagesToDirectory,
  normalizeBugImageCandidates,
  readBugImagesDOM,
  TapdCollector,
} from "../desktop/services/tapd-report-runtime.mjs";

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const ticket = (id) => ({
  id: String(id), shortId: String(id), workspaceId: "1", title: `测试${id}`,
  url: `https://tapd.tencent.com/tapd_fe/1/bug/detail/${id}`,
});
const candidate = (url, source = "附件") => ({ source, urls: [url], fileName: "测试媒体" });
const context = { cookies: async () => [{ name: "session", value: "test-session" }] };
const mp4 = Buffer.alloc(64);
mp4.writeUInt32BE(24, 0); mp4.write("ftyp", 4); mp4.write("isom", 8);
const png = await sharp({ create: { width: 50, height: 50, channels: 3, background: "red" } }).png().toBuffer();

async function temporaryRoot(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "ngr-media-extraction-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
function mockFetch(t, implementation) {
  const original = globalThis.fetch;
  globalThis.fetch = implementation;
  t.after(() => { globalThis.fetch = original; });
}
function streamedResponse(buffer, headers = {}) {
  let offset = 0;
  return new Response(new ReadableStream({
    async pull(controller) {
      await delay(1);
      if (offset >= buffer.length) { controller.close(); return; }
      controller.enqueue(buffer.subarray(offset, offset + 19));
      offset += 19;
    },
  }), { headers });
}

test("媒体下载全局最多 4 并发，详情最多 2 并发，清单按原始顺序提交", async (t) => {
  const root = await temporaryRoot(t);
  const tickets = [ticket(1), ticket(2), ticket(3)];
  let reading = 0, maxReading = 0, downloading = 0, maxDownloading = 0;
  let track = false;
  const readCandidates = async (_page, item) => {
    if (track) maxReading = Math.max(maxReading, ++reading);
    await delay(20);
    if (track) reading--;
    return Array.from({ length: 6 }, (_, index) => candidate(`https://8.8.8.8/${item.id}/${index}`));
  };
  const downloadCandidate = async (item) => {
    if (track) maxDownloading = Math.max(maxDownloading, ++downloading);
    await delay(20);
    if (track) downloading--;
    return { body: Buffer.from(item.urls[0]), url: item.urls[0], format: "png", contentType: "image/png", fileName: "" };
  };
  const serialStart = performance.now();
  for (const item of tickets)
    for (const media of await readCandidates({}, item)) await downloadCandidate(media);
  const serialMs = performance.now() - serialStart;
  track = true;
  const parallelStart = performance.now();
  const outputPath = path.join(root, "parallel");
  const result = await extractBugImagesToDirectory({ context: {}, page: {}, pages: [{}, {}], tickets,
    outputPath, readCandidates, downloadCandidate, stopped: () => false, progress() {} });
  const parallelMs = performance.now() - parallelStart;
  assert.equal(maxReading, 2);
  assert.equal(maxDownloading, 4);
  assert.equal(result.imageCount, 18);
  assert.equal(result.failedCount, 0);
  const manifest = await readFile(path.join(outputPath, "提取清单.csv"), "utf8");
  assert.ok(manifest.indexOf("1,测试1") < manifest.indexOf("2,测试2"));
  assert.ok(manifest.indexOf("2,测试2") < manifest.indexOf("3,测试3"));
  for (let id = 1; id <= 3; id++) {
    const files = await readdir(path.join(outputPath, `${id}-测试${id}`));
    assert.deepEqual(files.map((name) => name.slice(0, 2)).sort(), ["01", "02", "03", "04", "05", "06"]);
  }
  // Timings are diagnostic; only concurrency peaks are asserted.
  t.diagnostic(`相同 20ms 模拟延迟：串行 ${serialMs.toFixed(1)}ms，并发 ${parallelMs.toFixed(1)}ms`);
});

test("原生流式下载验证 MP4/PNG、携带 cookies/Referer，URL Promise 和内容 hash 去重", async (t) => {
  const root = await temporaryRoot(t);
  const requests = [], cookieRequests = [];
  mockFetch(t, async (url, options) => {
    requests.push({ url: String(url), options });
    const image = String(url).endsWith("image");
    return streamedResponse(image ? png : mp4, { "content-type": image ? "image/png" : "video/mp4" });
  });
  const outputPath = path.join(root, "native");
  const result = await extractBugImagesToDirectory({
    context: { cookies: async (url) => { cookieRequests.push(url); return context.cookies(); } },
    page: {}, tickets: [ticket(1)], outputPath, progress() {}, stopped: () => false,
    readCandidates: async () => [candidate("https://8.8.8.8/movie"), candidate("https://8.8.8.8/movie", "评论"),
      candidate("https://8.8.8.8/same-content"), candidate("https://8.8.8.8/image")],
  });
  assert.equal(requests.length, 3);
  assert.equal(cookieRequests.length, 3);
  assert.equal(result.videoCount, 1);
  assert.equal(result.imageCount, 1);
  assert.equal(result.duplicateCount, 2);
  for (const { options } of requests) {
    assert.equal(options.headers.Cookie, "session=test-session");
    assert.equal(options.headers.Referer, ticket(1).url);
    assert.equal(options.redirect, "manual");
    assert.ok(options.signal instanceof AbortSignal);
  }
  const files = await readdir(path.join(outputPath, "1-测试1"));
  assert.equal(files.length, 2);
  assert.deepEqual(await readFile(path.join(outputPath, "1-测试1", files.find((name) => name.endsWith(".mp4")))), mp4);
  assert.ok(!(await readdir(outputPath)).includes(".partial-downloads"));
});

test("blob/HLS、超限内容和伪装视频明确失败，并清理 partial", async (t) => {
  const root = await temporaryRoot(t);
  const requests = [];
  mockFetch(t, async (url) => {
    requests.push(String(url));
    if (String(url).endsWith("large-video")) return new Response("x", { headers: { "content-length": String(251 * 1024 * 1024) } });
    if (String(url).endsWith("large-image")) return streamedResponse(png, { "content-type": "image/png", "content-length": String(51 * 1024 * 1024) });
    return new Response("<html>not a video</html>", { headers: { "content-type": "video/mp4" } });
  });
  const outputPath = path.join(root, "invalid");
  const result = await extractBugImagesToDirectory({ context, page: {}, tickets: [ticket(1)], outputPath,
    progress() {}, stopped: () => false, readCandidates: async () => [
      candidate("blob:https://tapd.tencent.com/test"), candidate("https://8.8.8.8/live.m3u8"),
      candidate("https://8.8.8.8/large-video"), candidate("https://8.8.8.8/large-image"), candidate("https://8.8.8.8/fake.mp4"),
    ] });
  assert.equal(result.failedCount, 5);
  assert.equal(result.imageCount, 0);
  assert.equal(result.videoCount, 0);
  assert.equal(requests.length, 3);
  const manifest = await readFile(path.join(outputPath, "提取清单.csv"), "utf8");
  for (const message of [/blob/, /HLS\/DASH/, /250 MB/, /50 MB/, /不是有效图片或支持的视频/]) assert.match(manifest, message);
  assert.deepEqual(await readdir(path.join(outputPath, "1-测试1")), []);
  assert.ok(!(await readdir(outputPath)).includes(".partial-downloads"));
});

test("原生重定向每跳重新选 cookies，拒绝重定向到内网", async (t) => {
  const root = await temporaryRoot(t);
  const requests = [];
  mockFetch(t, async (url, options) => {
    requests.push({ url: String(url), cookie: options.headers.Cookie });
    if (String(url).endsWith("safe-redirect")) return new Response(null, { status: 302, headers: { location: "https://9.9.9.9/video" } });
    if (String(url).endsWith("private-redirect")) return new Response(null, { status: 302, headers: { location: "https://127.0.0.1/video" } });
    return streamedResponse(mp4, { "content-type": "video/mp4" });
  });
  const outputPath = path.join(root, "redirect");
  const result = await extractBugImagesToDirectory({
    context: { cookies: async (url) => [{ name: "host", value: new URL(url).hostname }] }, page: {},
    tickets: [ticket(1)], outputPath, progress() {}, stopped: () => false,
    readCandidates: async () => [candidate("https://8.8.8.8/safe-redirect"), candidate("https://8.8.8.8/private-redirect")],
  });
  assert.equal(result.videoCount, 1);
  assert.equal(result.failedCount, 1);
  assert.equal(requests.find((item) => item.url === "https://9.9.9.9/video")?.cookie, "host=9.9.9.9");
  assert.ok(!requests.some((item) => item.url.includes("127.0.0.1")));
  assert.match(await readFile(path.join(outputPath, "提取清单.csv"), "utf8"), /已拒绝本机或内网/);
});

test("取消中断原生下载流并保留先前成功文件", { timeout: 5000 }, async (t) => {
  const root = await temporaryRoot(t);
  let stop = false, aborted = 0;
  let notifySlow;
  const slowStarted = new Promise((resolve) => { notifySlow = resolve; });
  mockFetch(t, async (url, options) => {
    if (String(url).endsWith("image")) return streamedResponse(png, { "content-type": "image/png" });
    return new Response(new ReadableStream({ start(controller) {
      options.signal.addEventListener("abort", () => { aborted++; controller.error(new Error("Aborted")); }, { once: true });
      notifySlow();
    } }), { headers: { "content-type": "video/mp4" } });
  });
  const outputPath = path.join(root, "cancel");
  let imageCommitted;
  const committed = new Promise((resolve) => { imageCommitted = resolve; });
  const promise = extractBugImagesToDirectory({ context, page: {}, tickets: [ticket(1)], outputPath,
    stopped: () => stop, progress(value) { if (value.imageCount === 1) imageCommitted(); },
    readCandidates: async () => [candidate("https://8.8.8.8/image"), candidate("https://8.8.8.8/slow")],
  });
  await Promise.all([slowStarted, committed]);
  stop = true;
  const result = await promise;
  assert.equal(result.canceled, true);
  assert.equal(result.imageCount, 1);
  assert.equal(aborted, 1);
  assert.equal((await readdir(path.join(outputPath, "1-测试1"))).length, 1);
  assert.ok(!(await readdir(outputPath)).includes(".partial-downloads"));
  assert.match(await readFile(path.join(outputPath, "提取清单.csv"), "utf8"), /成功/);
});

test("取消仅关闭本次详情页，中断尚未完成的 goto 并保留清单", { timeout: 5000 }, async (t) => {
  const root = await temporaryRoot(t);
  let originalClosed = 0, detailClosed = 0, navigations = 0, ready;
  const started = new Promise((resolve) => { ready = resolve; });
  const original = { close: async () => { originalClosed++; } };
  const collector = new TapdCollector(path.join(root, "profile"), () => {});
  collector.authenticatedPage = async () => original;
  collector.context = { newPage: async () => {
    let rejectNavigation;
    return {
      goto: () => new Promise((_resolve, reject) => { rejectNavigation = reject; if (++navigations === 2) ready(); }),
      close: async () => { detailClosed++; rejectNavigation?.(new Error("Page closed")); },
    };
  } };
  const outputPath = path.join(root, "pages");
  const promise = collector.extractBugImages([ticket(1), ticket(2)], outputPath);
  await started;
  collector.cancel();
  const result = await promise;
  assert.equal(result.canceled, true);
  assert.equal(originalClosed, 0);
  assert.ok(detailClosed >= 2);
  assert.equal(collector.mediaPages.size, 0);
  assert.equal((await readFile(path.join(outputPath, "提取清单.csv"), "utf8")).charCodeAt(0), 0xfeff);
});

test("DOM 视频读取 src/source，不将 poster 当视频，并保留小视频和 blob 附件失败候选", () => {
  const attributes = { src: "https://8.8.8.8/direct.mp4", poster: "https://8.8.8.8/poster.jpg" };
  const video = {
    tagName: "VIDEO", id: "", className: "description", parentElement: null, currentSrc: "",
    getAttribute: (key) => attributes[key] ?? null,
    getBoundingClientRect: () => ({ width: 32, height: 32 }), closest: selector => selector.includes("bug-detail") ? {} : null,
    querySelectorAll: (selector) => selector === "source" ? [{ getAttribute: () => "https://8.8.8.8/fallback.webm" }] : [],
  };
  const originals = { document: globalThis.document, location: globalThis.location };
  try {
    globalThis.location = { href: ticket(1).url };
    globalThis.document = { querySelectorAll: (selector) => selector === "video" ? [video] : [] };
    const records = readBugImagesDOM();
    assert.equal(records.length, 1);
    assert.deepEqual(records[0].urls, [attributes.src, "https://8.8.8.8/fallback.webm"]);
    assert.ok(!records[0].urls.includes(attributes.poster));
    const candidates = normalizeBugImageCandidates([...records, { ...records[0], kind: "attachment", fileName: "record.mp4", urls: ["blob:https://tapd.tencent.com/a"] }], ticket(1).url);
    assert.equal(candidates.length, 2);
    assert.equal(candidates[0].mediaType, "video");
    assert.equal(candidates[1].mediaType, "video");
    assert.ok(candidates[1].urls[0].startsWith("blob:"));
  } finally {
    if (originals.document === undefined) delete globalThis.document; else globalThis.document = originals.document;
    if (originals.location === undefined) delete globalThis.location; else globalThis.location = originals.location;
  }
});

test("真实 TAPD 空文字附件链接读取同组文件名，压缩包图标和头像不进入媒体队列", () => {
  const originals = { document: globalThis.document, location: globalThis.location };
  const wrapper = (name) => ({ querySelector: (selector) => selector === ".attachment-list__filename"
    ? { getAttribute: () => null, textContent: name } : null });
  const makeLink = (name, id, hasIcon = false) => ({
    tagName: "A", id: "", className: "attachment-preview", parentElement: null, textContent: "",
    getAttribute: (key) => key === "href" ? `https://tapd.tencent.com/preview_attachments/${id}` : null,
    closest: (selector) => selector === ".attachment-list__item-wrapper" ? wrapper(name)
      : selector.includes("attachment-item") ? { querySelector: () => null } : selector.includes("bug-detail") ? {} : null,
    querySelector: (selector) => selector === "img" && hasIcon ? {} : null,
    getBoundingClientRect: () => ({ width: 100, height: 60 }),
  });
  const zipLink = makeLink("NGR.zip", "zip", true);
  const imageLink = makeLink("真实截图.png", "image");
  const videoLink = makeLink("实际录屏.mp4", "video");
  const icon = {
    tagName: "IMG", id: "", className: "attachment-icon", parentElement: null,
    currentSrc: "https://tapd.tencent.com/icons/zip.png", alt: "", naturalWidth: 60, naturalHeight: 60,
    getAttribute: () => null, getBoundingClientRect: () => ({ width: 60, height: 60 }),
    closest: (selector) => selector === "a[href]" ? zipLink : selector.includes("bug-detail") ? {} : null,
  };
  try {
    globalThis.location = { href: ticket(1).url };
    globalThis.document = { querySelectorAll: (selector) => selector === "img" ? [icon]
      : selector === "a[href]" ? [zipLink, imageLink, videoLink] : [] };
    const records = readBugImagesDOM();
    assert.equal(records[0].fileName, "NGR.zip");
    assert.ok(records.some((record) => record.fileName === "真实截图.png"));
    assert.ok(records.some((record) => record.fileName === "实际录屏.mp4"));
    const base = { kind: "image", urls: [], fileName: "图片", ownHints: "", ancestorHints: "description", inMain: true, visible: true, width: 100, height: 100 };
    const avatars = [
      { ...base, urls: ["https://viper.tapd.tencent.com/user_logo/user.jpg"] },
      { ...base, urls: ["https://tapd.tencent.com/avatar/user.jpg"] },
      { ...base, ownHints: "attachment", ancestorHints: "comment avatar", urls: ["https://8.8.8.8/user.jpg"] },
    ];
    const nonMedia = ["zip", "rar", "7z", "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "txt", "lua", "cpp", "h", "cs", "utxt", "uasset", "py", "js", "ts"]
      .map((extension) => ({ ...base, kind: "attachment", fileName: `附件.${extension}`, urls: [`https://tapd.tencent.com/preview_attachments/${extension}`] }));
    nonMedia.push(...["lua", "cpp", "h", "cs", "utxt", "uasset"].map((extension) => ({ ...base,
      kind: "attachment", fileName: "查看文件", urls: [`https://tapd.tencent.com/files/some-file.${extension}`] })));
    const candidates = normalizeBugImageCandidates([...records, ...avatars, ...nonMedia], ticket(1).url);
    assert.deepEqual(candidates.map((item) => item.fileName), ["真实截图.png", "实际录屏.mp4"]);
    assert.equal(candidates[1].mediaType, "video");
  } finally {
    if (originals.document === undefined) delete globalThis.document; else globalThis.document = originals.document;
    if (originals.location === undefined) delete globalThis.location; else globalThis.location = originals.location;
  }
});

test("TAPD 全局 AI 助手宣传图被排除，同地址在真实正文或附件中仍可提取", () => {
  const url = "https://fe.tapd.tencent.com/img/enable-use-claude-guide.20e83657.png";
  // Captured from the live TAPD DOM: the hidden popover has natural image dimensions.
  const promotion = {
    kind: "image", urls: [url], fileName: "图片", ownHints: "IMG  ",
    ancestorHints: "DIV ai-helper-guide-wrapper__main-content DIV ai-helper-guide-wrapper DIV agi-popover__content-text DIV agi-popover__body DIV agi-popover__content DIV el-popover el-popper ai-helper-btn__popover tooltip SPAN agi-popover__reference DIV ai-helper-button",
    inMain: false, visible: false, width: 1200, height: 706,
  };
  const description = { ...promotion, fileName: "业务说明图.png", ownHints: "IMG description",
    ancestorHints: "DIV description richtext DIV bug-detail", inMain: true };
  const attachment = { ...promotion, kind: "attachment", fileName: "手动上传的说明图.png",
    ownHints: "attachment", ancestorHints: "DIV attachment-list DIV bug-detail", inMain: true };
  assert.deepEqual(normalizeBugImageCandidates([promotion], ticket(1).url), []);
  for (const bug of [ticket(1), ticket(2)]) {
    const candidates = normalizeBugImageCandidates([promotion, description, attachment], bug.url);
    assert.deepEqual(candidates.map(item => [item.source, item.fileName]), [
      ["描述", "业务说明图.png"], ["附件", "手动上传的说明图.png"],
    ]);
    assert.ok(candidates.every(item => item.urls[0] === url));
  }
});

test("详情外框已出现但正文异步加载时，不会提前结束为无图片", { timeout: 20_000 }, async (t) => {
  const root = await temporaryRoot(t);
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  t.after(() => browser.close());
  const browserContext = await browser.newContext();
  await browserContext.route("https://tapd.tencent.com/**", route => route.fulfill({
    contentType: "text/html; charset=utf-8", body: `
      <div class="bug-detail"><div class="detail-container-left"><div class="detail-container-content" style="min-height:100px">
        <richtext-preview value=""></richtext-preview>
      </div></div></div>
      <script>setTimeout(() => document.querySelector('richtext-preview').setAttribute('value',
        '<p>业务截图</p><img src="https://8.8.8.8/delayed.png" width="100" height="80">'), 1800);</script>`,
  }));
  const page = await browserContext.newPage();
  const result = await extractBugImagesToDirectory({ context: browserContext, page, tickets: [ticket(1)],
    outputPath: path.join(root, "delayed-content"), stopped: () => false, progress() {},
    downloadCandidate: async () => ({ body: png, url: "https://8.8.8.8/delayed.png", format: "png", contentType: "image/png", fileName: "" }),
  });
  assert.equal(result.imageCount, 1);
  assert.equal(result.failedCount, 0);
});

test("opaque 下载端点保留，主机名不当后缀，响应声明 ZIP/代码附件在读流前跳过且不记失败", async (t) => {
  const root = await temporaryRoot(t);
  const base = { kind: "attachment", fileName: "查看附件", ownHints: "attachment", ancestorHints: "description", inMain: true, visible: true, width: 100, height: 100 };
  const candidates = normalizeBugImageCandidates([
    { ...base, urls: ["https://example.com"] },
    { ...base, urls: ["https://tapd.tencent.com/preview_attachments/123"] },
    { ...base, urls: ["https://tapd.tencent.com/download.php?id=1"] },
  ], ticket(1).url);
  assert.equal(candidates.length, 3);
  let canceled = 0;
  mockFetch(t, async (url) => {
    const headers = String(url).endsWith("zip")
      ? { "content-type": "application/zip" }
      : { "content-type": "application/octet-stream", "content-disposition": "attachment; filename*=UTF-8''source.lua" };
    return new Response(new ReadableStream({ cancel() { canceled++; } }), { headers });
  });
  const outputPath = path.join(root, "skip");
  const result = await extractBugImagesToDirectory({ context, page: {}, tickets: [ticket(1)], outputPath,
    progress() {}, stopped: () => false, readCandidates: async () => [candidate("https://8.8.8.8/zip"), candidate("https://8.8.8.8/code")] });
  assert.equal(result.failedCount, 0);
  assert.equal(result.imageCount, 0);
  assert.equal(result.videoCount, 0);
  assert.equal(canceled, 2);
  assert.deepEqual(await readdir(path.join(outputPath, "1-测试1")), []);
  const manifest = await readFile(path.join(outputPath, "提取清单.csv"), "utf8");
  assert.equal((manifest.match(/跳过非媒体附件/g) ?? []).length, 2);
  assert.ok(!manifest.split(/\r?\n/).slice(1).join("\n").includes("失败"));
});

test("详情读取先等真实内容与加载遮罩，再展开并等待内容稳定", async (t) => {
  const root = await temporaryRoot(t);
  const calls = [];
  const page = {
    goto: async () => { calls.push("goto"); }, url: () => ticket(1).url,
    locator: (selector) => ({ first: () => ({ waitFor: async (options) => { calls.push({ selector, state: options.state }); } }) }),
    waitForFunction: async () => { calls.push("description-ready"); },
    waitForTimeout: async () => { calls.push("stable-poll"); },
    evaluate: async (fn) => {
      if (fn.name === "readBugImagesDOM") { calls.push("read-media"); return []; }
      const source = String(fn);
      if (source.includes("elements.slice")) { calls.push("expand"); return { clicked: 0, atBottom: true }; }
      if (source.includes("innerText.length")) return "stable-content";
      return undefined;
    },
  };
  const result = await extractBugImagesToDirectory({ context: {}, page, tickets: [ticket(1)],
    outputPath: path.join(root, "ready"), stopped: () => false, progress() {} });
  assert.equal(result.failedCount, 0);
  const waits = calls.filter((item) => typeof item === "object");
  assert.match(waits[0].selector, /detail-container-content/);
  assert.ok(!waits[0].selector.includes("main,"));
  assert.equal(waits[0].state, "visible");
  assert.match(waits[1].selector, /loading/);
  assert.equal(waits[1].state, "hidden");
  assert.ok(calls.indexOf(waits[1]) < calls.indexOf("expand"));
  assert.ok(calls.indexOf(waits[1]) < calls.indexOf("description-ready"));
  assert.ok(calls.indexOf("description-ready") < calls.indexOf("expand"));
  assert.ok(calls.filter((item) => item === "read-media").length > 1);
  assert.equal(calls.filter((item) => item === "stable-poll").length, 3);
  page.waitForFunction = async () => { const error = new Error("empty description"); error.name = "TimeoutError"; throw error; };
  const empty = await extractBugImagesToDirectory({ context: {}, page, tickets: [ticket(1)],
    outputPath: path.join(root, "empty-description"), stopped: () => false, progress() {} });
  assert.equal(empty.failedCount, 0, "a legitimately empty description must still allow attachment scanning");
});

test("详情左栏渐进滚动触发底部视频懒加载，合并保留已卸载的顶部图片并恢复滚动位置", async (t) => {
  const root = await temporaryRoot(t);
  const original = Object.fromEntries(["document", "location", "window", "getComputedStyle"].map((name) => [name, globalThis[name]]));
  const positions = [];
  let scrollTop = 0;
  const container = { scrollHeight: 1000, clientHeight: 200,
    get scrollTop() { return scrollTop; }, set scrollTop(value) { scrollTop = value; positions.push(value); } };
  const makeMedia = (video = false) => ({
    tagName: video ? "VIDEO" : "IMG", id: "", className: "description", parentElement: null,
    currentSrc: video ? "https://8.8.8.8/lazy.mp4" : "https://8.8.8.8/top.png", alt: "顶部图片",
    naturalWidth: 100, naturalHeight: 100,
    getAttribute: () => null, getBoundingClientRect: () => ({ width: 100, height: 100 }),
    closest: (selector) => selector.includes("bug-detail") ? {} : null,
    querySelectorAll: () => [],
  });
  const image = makeMedia(), video = makeMedia(true);
  let waited = 0;
  try {
    globalThis.location = { href: ticket(1).url };
    globalThis.window = { scrollTo() {} };
    globalThis.getComputedStyle = () => ({ overflowY: "auto" });
    globalThis.document = {
      body: { innerText: "详情内容" }, documentElement: { scrollHeight: 500, clientHeight: 500 }, scrollingElement: null,
      querySelectorAll(selector) {
        if (selector === "img") return scrollTop < 320 ? [image] : [];
        if (selector === "video") return scrollTop >= 640 ? [video] : [];
        if (selector === "img,video,source") return scrollTop < 320 ? [image] : scrollTop >= 640 ? [video] : [];
        if (selector.includes(".detail-container-left__scroll-wrapper")) return [container];
        return [];
      },
    };
    const page = { goto: async () => {}, url: () => ticket(1).url,
      locator: () => ({ first: () => ({ waitFor: async () => {} }) }),
      waitForFunction: async () => {},
      waitForTimeout: async () => { waited++; }, evaluate: async (fn) => fn(),
    };
    const result = await extractBugImagesToDirectory({ context: {}, page, tickets: [ticket(1)],
      outputPath: path.join(root, "inner-scroll"), stopped: () => false, progress() {},
      downloadCandidate: async (item) => ({ body: item.mediaType === "video" ? mp4 : png,
        url: item.urls[0], format: item.mediaType === "video" ? "mp4" : "png",
        contentType: item.mediaType === "video" ? "video/mp4" : "image/png", fileName: "", mediaType: item.mediaType }),
    });
    assert.equal(result.imageCount, 1);
    assert.equal(result.videoCount, 1);
    assert.equal(result.failedCount, 0);
    assert.deepEqual(positions.slice(0, 5), [160, 320, 480, 640, 800]);
    assert.equal(positions.at(-1), 0);
    assert.ok(waited >= 7);
  } finally {
    for (const [name, value] of Object.entries(original)) {
      if (value === undefined) delete globalThis[name]; else globalThis[name] = value;
    }
  }
});
