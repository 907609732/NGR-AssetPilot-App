import { createHash } from "node:crypto";
import { open, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import pLimit from "p-limit";
import sharp from "sharp";
import type { BugMediaGroup, BugMediaItem, BugMediaRequest, LocalState, Period } from "../shared/types";
import { dateRange } from "../shared/report";
import { detectVideoFormat } from "./media-format";

const IMAGE_EXTENSIONS = new Set([".avif", ".bmp", ".gif", ".jpeg", ".jpg", ".png", ".tif", ".tiff", ".webp"]);
const VIDEO_EXTENSIONS = new Set([".mp4", ".webm", ".mov", ".m4v"]);
const MAX_FILES = 2000;
const MAX_IMAGE_BYTES = 50 * 1024 * 1024;
const MAX_VIDEO_BYTES = 250 * 1024 * 1024;

export interface RegisteredBugMedia extends BugMediaItem {
  absolutePath: string;
  root: string;
  outputPath: string;
  title: string;
  mtimeMs: number;
}
function inside(root: string, file: string) {
  const relative = path.relative(root, file);
  return !!relative && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
function matchingExports(state: LocalState, period: Period) {
  dateRange(period?.start, period?.end);
  const pattern = new RegExp(`^TAPD-Bug(?:图片|媒体)--${period.start}至${period.end}(?: \\(\\d+\\))?$`);
  return state.exports.filter((entry) => ["bug-images", "bug-media"].includes(entry.kind) && pattern.test(path.basename(entry.path)));
}
async function inspectFile(root: string, outputPath: string, folder: string, name: string): Promise<RegisteredBugMedia | null> {
  const ext = path.extname(name).toLowerCase();
  if (!IMAGE_EXTENSIONS.has(ext) && !VIDEO_EXTENSIONS.has(ext)) return null;
  const absolutePath = await realpath(path.join(root, folder, name)).catch(() => "");
  if (!absolutePath || !inside(root, absolutePath)) return null;
  const details = await stat(absolutePath).catch(() => null);
  const kind = VIDEO_EXTENSIONS.has(ext) ? "video" : "image";
  if (!details?.isFile() || details.size <= 0 || details.size > (kind === "video" ? MAX_VIDEO_BYTES : MAX_IMAGE_BYTES)) return null;
  let width = 0, height = 0, mimeType = "";
  if (kind === "image") {
    const metadata = await sharp(absolutePath, { animated: false, limitInputPixels: 250_000_000 }).metadata().catch(() => null);
    if (!metadata?.format) return null;
    width = metadata.width ?? 0;
    height = metadata.height ?? 0;
    if (width > 0 && height > 0 && width < 48 && height < 48) return null;
    mimeType = `image/${metadata.format === "jpg" ? "jpeg" : metadata.format}`;
  } else {
    const handle = await open(absolutePath, "r");
    let format;
    try {
      const prefix = Buffer.alloc(Math.min(details.size, 64 * 1024));
      await handle.read(prefix, 0, prefix.length, 0);
      format = detectVideoFormat(prefix);
    } finally { await handle.close(); }
    if (!format) return null;
    mimeType = format.mimeType;
  }
  const bugId = folder.match(/^(\d+)-/)![1];
  return {
    id: createHash("sha256").update(`${absolutePath}\0${details.size}\0${details.mtimeMs}`).digest("hex").slice(0, 32),
    bugId, kind, source: name.match(/^\d+-(描述|评论|附件)-/)?.[1] ?? (kind === "video" ? "视频" : "图片"),
    fileName: name, width, height, size: details.size, mimeType, absolutePath, root, outputPath,
    title: folder.slice(bugId.length + 1), mtimeMs: details.mtimeMs,
  };
}

/** Cache metadata once per export selection. Individual reads revalidate the exact file. */
export class BugMediaLibrary {
  private key = "";
  private files = new Map<string, RegisteredBugMedia>();
  private groups: BugMediaGroup[] = [];
  private pending: Promise<{ files: Map<string, RegisteredBugMedia>; groups: BugMediaGroup[] }> | null = null;
  private generation = 0;
  private imageLimit = pLimit(4);
  private thumbnails = new Map<string, Buffer>();
  private thumbnailBytes = 0;
  clear() {
    this.key = "";
    this.files.clear();
    this.groups = [];
    this.pending = null;
    this.thumbnails.clear();
    this.thumbnailBytes = 0;
    this.generation++;
  }
  private async ensure(state: LocalState, period: Period, refresh = false) {
    const exports = matchingExports(state, period);
    const key = JSON.stringify([state.capture?.account ?? "", period, exports]);
    if (key === this.key) {
      if (this.pending) return this.pending;
      if (!refresh) return { files: this.files, groups: this.groups };
    }
    const generation = ++this.generation;
    this.key = key;
    const pending = (async () => {
      const files = new Map<string, RegisteredBugMedia>();
      const groups = new Map<string, BugMediaGroup>();
      const limit = pLimit(4);
      for (const entry of exports) {
        const root = await realpath(entry.path).catch(() => "");
        if (!root) continue;
        const folders = await readdir(root, { withFileTypes: true }).catch(() => []);
        for (const folder of folders.sort((a, b) => a.name.localeCompare(b.name, "en", { numeric: true }))) {
          if (!folder.isDirectory() || !/^\d+-/.test(folder.name) || files.size >= MAX_FILES) continue;
          const bugId = folder.name.match(/^(\d+)-/)![1];
          // Prefer the newest export of a ticket; incomplete batches fall back to older tickets.
          if (groups.has(bugId)) continue;
          const children = await readdir(path.join(root, folder.name), { withFileTypes: true }).catch(() => []);
          const previews = (await Promise.all(children.filter((child) => child.isFile())
            .sort((a, b) => a.name.localeCompare(b.name, "en", { numeric: true }))
            .slice(0, Math.max(0, MAX_FILES - files.size))
            .map((child) => limit(() => inspectFile(root, entry.path, folder.name, child.name).catch(() => null)))))
            .filter((file): file is RegisteredBugMedia => !!file);
          if (!previews.length) continue;
          const items = previews.map(({ absolutePath: _path, root: _root, outputPath: _output, title: _title, mtimeMs: _time, ...item }) => item);
          groups.set(bugId, { bugId, title: previews[0].title, items, outputPath: entry.path });
          previews.forEach((file) => files.set(file.id, file));
        }
      }
      const result = { files, groups: [...groups.values()].sort((a, b) => a.bugId.localeCompare(b.bugId, "en", { numeric: true })) };
      if (generation === this.generation) {
        this.files = files;
        this.groups = result.groups;
      }
      return result;
    })();
    this.pending = pending;
    try { return await pending; }
    catch (error) { if (generation === this.generation) this.clear(); throw error; }
    finally { if (this.pending === pending) this.pending = null; }
  }
  async list(state: LocalState, period: Period, refresh = false) {
    return (await this.ensure(state, period, refresh)).groups;
  }
  async resolve(state: LocalState, input: BugMediaRequest): Promise<RegisteredBugMedia> {
    if (!/^\d{1,30}$/.test(input?.bugId ?? "") || !/^[a-f0-9]{32}$/.test(input?.mediaId ?? "")) throw new Error("媒体标识无效");
    const index = await this.ensure(state, input.period);
    const file = index.files.get(input.mediaId);
    if (!file || file.bugId !== input.bugId) throw new Error("媒体不存在或已被移动，请刷新媒体列表");
    const actualRoot = await realpath(file.outputPath).catch(() => "");
    const actual = await realpath(file.absolutePath).catch(() => "");
    if (!actualRoot || actualRoot !== file.root || actual !== file.absolutePath || !inside(actualRoot, actual)) throw new Error("媒体不存在或已被移动，请刷新媒体列表");
    const details = await stat(actual).catch(() => null);
    if (!details?.isFile() || details.size !== file.size || details.mtimeMs !== file.mtimeMs) throw new Error("媒体已改变，请刷新媒体列表");
    return file;
  }
  async imageBuffer(state: LocalState, input: BugMediaRequest, thumbnail = false) {
    return this.imageLimit(async () => {
      const file = await this.resolve(state, input);
      if (file.kind !== "image") throw new Error("请选择图片");
      if (thumbnail && this.thumbnails.has(file.id)) return this.thumbnails.get(file.id)!;
      const image = sharp(file.absolutePath, { animated: false, limitInputPixels: thumbnail ? 250_000_000 : 40_000_000 }).rotate();
      if (!thumbnail) return image.png().toBuffer();
      const output = await image.resize({ width: 640, height: 480, fit: "inside", withoutEnlargement: true }).webp({ quality: 80 }).toBuffer();
      if (!this.thumbnails.has(file.id)) {
        this.thumbnails.set(file.id, output);
        this.thumbnailBytes += output.length;
        while (this.thumbnailBytes > 32 * 1024 * 1024 || this.thumbnails.size > 200) {
          const oldest = this.thumbnails.keys().next().value!;
          this.thumbnailBytes -= this.thumbnails.get(oldest)!.length;
          this.thumbnails.delete(oldest);
        }
      }
      return output;
    });
  }
}
