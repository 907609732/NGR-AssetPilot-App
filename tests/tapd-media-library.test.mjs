import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rename, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import sharp from "sharp";
import { BugMediaLibrary } from "../desktop/services/tapd-report-runtime.mjs";
import { bugMediaFileResponse } from "../desktop/services/tapd-media-response.mjs";

const period = { start: "2026-10-12", end: "2026-10-18" };
function state(exports) { return { capture: null, exports, overrides: {}, budgets: {}, settings: {}, history: [] }; }

test("Bug media index reuses old exports, verifies containers and IDs, and rejects moved/replaced files", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "tapd-library-"));
  try {
    const root = path.join(temp, `TAPD-Bug图片--${period.start}至${period.end}`);
    const folder = path.join(root, "123-原有单据");
    await mkdir(folder, { recursive: true });
    const imagePath = path.join(folder, "01-描述-原图.png");
    await sharp({ create: { width: 1800, height: 1200, channels: 3, background: "red" } }).png().toFile(imagePath);
    await writeFile(path.join(folder, "02-附件-伪装视频.mp4"), "<!doctype html>not video");
    await writeFile(path.join(folder, "03-附件-不允许.html"), "<script>bad</script>");
    const local = state([{ path: root, kind: "bug-images", at: "2026-10-12", draft: false }]);
    const library = new BugMediaLibrary();
    const simultaneous = await Promise.all(Array.from({ length: 8 }, () => library.list(local, period, true)));
    assert.ok(simultaneous.every((groups) => groups.length === 1), "overlapping refreshes must never expose an unfinished empty index");
    const groups = simultaneous[0];
    assert.equal(groups.length, 1);
    assert.equal(groups[0].title, "原有单据");
    assert.equal(groups[0].items.length, 1);
    const image = groups[0].items[0];
    assert.equal("absolutePath" in image, false);
    const request = { period, bugId: "123", mediaId: image.id };
    const thumbnail = await library.imageBuffer(local, request, true);
    const original = await library.imageBuffer(local, request);
    assert.ok((await sharp(thumbnail).metadata()).width <= 640);
    assert.equal((await sharp(original).metadata()).width, 1800);
    await assert.rejects(() => library.resolve(local, { ...request, mediaId: "../outside" }), /标识无效/);
    await assert.rejects(() => library.resolve(local, { ...request, bugId: "999" }), /不存在/);
    await rename(imagePath, `${imagePath}.moved`);
    await assert.rejects(() => library.resolve(local, request), /不存在|移动/);
    assert.equal((await library.list(local, period, true)).length, 0);
    assert.equal((await library.list(state([]), period)).length, 0);
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test("Incomplete recent media batch preserves access to older tickets and keeps registered range boundaries", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "tapd-library-history-"));
  try {
    const roots = ["TAPD-Bug媒体--2026-10-12至2026-10-18", "TAPD-Bug图片--2026-10-12至2026-10-18"]
      .map((name) => path.join(temp, name));
    for (const [index, root] of roots.entries()) {
      await mkdir(path.join(root, `${index + 1}-任务`), { recursive: true });
      await sharp({ create: { width: 64, height: 64, channels: 3, background: "blue" } }).png()
        .toFile(path.join(root, `${index + 1}-任务`, "01-评论-截图.png"));
    }
    const local = state(roots.map((root) => ({ path: root, kind: "bug-images", draft: true, at: "2026-10-12" })));
    const library = new BugMediaLibrary();
    const groups = await library.list(local, period);
    assert.deepEqual(groups.map((group) => group.bugId), ["1", "2"]);
    const item = groups[0].items[0];
    await assert.rejects(() => library.resolve(local, { period: { start: "2026-10-19", end: "2026-10-25" }, bugId: item.bugId, mediaId: item.id }), /不存在/);
    assert.equal((await library.list(local, period)).length, 2);
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test("Media streaming supports seeking ranges, suffixes and HEAD without reading whole videos", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "tapd-range-"));
  try {
    const filename = path.join(temp, "video.mp4");
    await writeFile(filename, Buffer.from("0123456789"));
    const file = { absolutePath: filename, mimeType: "video/mp4", size: (await stat(filename)).size };
    const request = (range, method = "GET") => new Request("https://app.test/media/token", { method, headers: range ? { Range: range } : {} });
    const partial = bugMediaFileResponse(file, request("bytes=2-5"));
    assert.equal(partial.status, 206);
    assert.equal(partial.headers.get("Content-Range"), "bytes 2-5/10");
    assert.equal(await partial.text(), "2345");
    assert.equal(await bugMediaFileResponse(file, request("bytes=-3")).text(), "789");
    assert.equal(await bugMediaFileResponse(file, request("bytes=8-")).text(), "89");
    assert.equal(await bugMediaFileResponse(file, request(null)).text(), "0123456789");
    const head = bugMediaFileResponse(file, request("bytes=0-2", "HEAD"));
    assert.equal(head.status, 206);
    assert.equal(head.headers.get("Content-Length"), "3");
    assert.equal(await head.text(), "");
    for (const value of ["bytes=20-30", "bytes=8-3", "bytes=-0", "bytes=0-1,3-4", "items=0-2"])
      assert.equal(bugMediaFileResponse(file, request(value)).status, 416);
    assert.equal(bugMediaFileResponse(file, request(null, "POST")).status, 405);
  } finally { await rm(temp, { recursive: true, force: true }); }
});
