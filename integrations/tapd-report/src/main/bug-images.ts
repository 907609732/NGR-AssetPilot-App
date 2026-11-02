import { createHash, randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import { constants, existsSync } from "node:fs";
import { copyFile, mkdir, open, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import path from "node:path";
import sharp from "sharp";
import pLimit from "p-limit";
import { detectVideoFormat } from "./media-format";
import type { BrowserContext, Page } from "playwright-core";
import type {
  BugImageExportResult,
  BugImagePreviewData,
  BugImagePreviewGroup,
  BugImagePreviewItem,
  LocalState,
  Period,
  Progress,
} from "../shared/types";
import {
  buildReport,
  captureCovers,
  dateRange,
} from "../shared/report";

const MAX_BUGS = 200;
const MAX_IMAGES_PER_BUG = 200;
const MAX_IMAGE_BYTES = 50 * 1024 * 1024;
const MAX_VIDEO_BYTES = 250 * 1024 * 1024;
const TAPD_ORIGIN = "https://tapd.tencent.com";
const PREVIEW_EXTENSIONS = new Set([
  ".avif",
  ".bmp",
  ".gif",
  ".jpeg",
  ".jpg",
  ".png",
  ".tif",
  ".tiff",
  ".webp",
]);
const MAX_PREVIEW_FILES = 1000;

export type BugImageSource = "描述" | "评论" | "附件";

export interface BugImageTicket {
  id: string;
  shortId: string;
  workspaceId: string;
  title: string;
  url: string;
}

export interface BugImageDOMRecord {
  kind: "image" | "video" | "attachment";
  urls: string[];
  fileName: string;
  ownHints: string;
  ancestorHints: string;
  inMain: boolean;
  visible: boolean;
  width: number;
  height: number;
}

export interface BugImageCandidate {
  source: BugImageSource;
  urls: string[];
  fileName: string;
  mediaType?: "image" | "video";
}

interface ManifestRow {
  bugId: string;
  title: string;
  source: string;
  originalUrl: string;
  savedFile: string;
  sha256: string;
  status: string;
  error: string;
}

export interface DownloadedBugImage {
  body: Buffer;
  url: string;
  format: string;
  contentType: string;
  fileName: string;
  mediaType?: "image" | "video";
  temporaryPath?: string;
  sha256?: string;
  skipped?: boolean;
}

interface BugImagePreviewFile extends BugImagePreviewItem {
  absolutePath: string;
}

function asMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export function sanitizePathPart(value: string, fallback = "未命名", maxLength = 80) {
  let result = String(value ?? "")
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .replace(/\s+/g, " ")
    .replace(/[. ]+$/g, "")
    .trim();
  if (!result) result = fallback;
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(result))
    result = `_${result}`;
  return result.slice(0, maxLength).replace(/[. ]+$/g, "") || fallback;
}

export function unusedBugImageDirectory(parent: string, period: Period) {
  const base = `TAPD-Bug图片--${period.start}至${period.end}`;
  let candidate = path.join(parent, base);
  for (let index = 2; existsSync(candidate); index++)
    candidate = path.join(parent, `${base} (${index})`);
  return candidate;
}

function registeredBugImageExport(state: LocalState, period: Period) {
  dateRange(period?.start, period?.end);
  const base = `TAPD-Bug图片--${period.start}至${period.end}`;
  return state.exports.find((entry) => {
    if (entry.kind !== "bug-images") return false;
    const name = path.basename(entry.path);
    return name === base || new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\(\\d+\\)$`).test(name);
  });
}

function inside(root: string, target: string) {
  const relative = path.relative(root, target);
  return !!relative && !relative.startsWith("..") && !path.isAbsolute(relative);
}

async function scanBugImagePreviews(state: LocalState, period: Period) {
  const entry = registeredBugImageExport(state, period);
  if (!entry) return [] as BugImagePreviewFile[];
  const root = await realpath(entry.path).catch(() => "");
  if (!root) return [];
  const folders = await readdir(root, { withFileTypes: true }).catch(() => []);
  const previews: BugImagePreviewFile[] = [];
  for (const folder of folders) {
    if (!folder.isDirectory()) continue;
    const bugId = folder.name.match(/^(\d+)-/)?.[1];
    if (!bugId) continue;
    const folderPath = path.join(root, folder.name);
    const files = await readdir(folderPath, { withFileTypes: true }).catch(() => []);
    for (const file of files) {
      if (!file.isFile() || !PREVIEW_EXTENSIONS.has(path.extname(file.name).toLowerCase()))
        continue;
      const candidate = path.join(folderPath, file.name);
      const absolutePath = await realpath(candidate).catch(() => "");
      if (!absolutePath || !inside(root, absolutePath)) continue;
      const details = await stat(absolutePath).catch(() => null);
      if (!details?.isFile() || details.size <= 0 || details.size > MAX_IMAGE_BYTES)
        continue;
      const metadata = await sharp(absolutePath, {
        animated: false,
        limitInputPixels: 250_000_000,
      })
        .metadata()
        .catch(() => null);
      const width = metadata?.width ?? 0;
      const height = metadata?.height ?? 0;
      if (!metadata?.format || (width > 0 && height > 0 && width < 48 && height < 48))
        continue;
      const relative = path.relative(root, absolutePath).replace(/\\/g, "/");
      const source = file.name.match(/^\d+-(描述|评论|附件)-/)?.[1] ?? "图片";
      previews.push({
        id: createHash("sha256")
          .update(`${relative}\u0000${details.size}\u0000${Math.trunc(details.mtimeMs)}`)
          .digest("hex")
          .slice(0, 32),
        bugId,
        source,
        fileName: file.name,
        width,
        height,
        absolutePath,
      });
      if (previews.length >= MAX_PREVIEW_FILES) return previews;
    }
  }
  return previews;
}

export async function listBugImagePreviews(
  state: LocalState,
  period: Period,
): Promise<BugImagePreviewGroup[]> {
  const groups = new Map<string, BugImagePreviewItem[]>();
  for (const { absolutePath: _absolutePath, ...preview } of await scanBugImagePreviews(
    state,
    period,
  )) {
    const images = groups.get(preview.bugId) ?? [];
    images.push(preview);
    groups.set(preview.bugId, images);
  }
  return [...groups.entries()].map(([bugId, images]) => ({ bugId, images }));
}

export async function getBugImagePreview(
  state: LocalState,
  input: { period: Period; bugId: string; imageId: string },
): Promise<BugImagePreviewData> {
  if (!/^\d{1,30}$/.test(input?.bugId ?? "") || !/^[a-f0-9]{32}$/.test(input?.imageId ?? ""))
    throw new Error("图片标识无效");
  const preview = (await scanBugImagePreviews(state, input.period)).find(
    (item) => item.bugId === input.bugId && item.id === input.imageId,
  );
  if (!preview) throw new Error("图片不存在或已被移动");
  const output = await sharp(preview.absolutePath, {
    animated: false,
    limitInputPixels: 250_000_000,
  })
    .rotate()
    .resize({
      width: 1600,
      height: 1200,
      fit: "inside",
      withoutEnlargement: true,
    })
    .webp({ quality: 84 })
    .toBuffer();
  const data = output.buffer.slice(
    output.byteOffset,
    output.byteOffset + output.byteLength,
  ) as ArrayBuffer;
  return { mimeType: "image/webp", data };
}

export function selectBugImageTickets(state: LocalState, period: Period) {
  dateRange(period?.start, period?.end);
  if (!state.capture) throw new Error("请先抓取所选日期，再提取 Bug 单图片");
  if (!state.capture.complete)
    throw new Error("当前采集尚未完成，请重新抓取所选日期后再提取图片");
  if (!captureCovers(state.capture, period))
    throw new Error("所选日期超出当前采集范围，请先抓取所选日期");
  const report = buildReport(state, period);
  const tickets = new Map<string, BugImageTicket>();
  for (const item of report.items) {
    if (String(item.type).toLowerCase() !== "bug") continue;
    const parsed = new URL(item.url, TAPD_ORIGIN);
    const match = parsed.pathname.match(
      /^\/tapd_fe\/(\d+)\/bug\/(?:detail\/)?(\d+)\/?$/i,
    );
    if (
      parsed.protocol !== "https:" ||
      parsed.hostname !== "tapd.tencent.com" ||
      !match ||
      match[1] !== item.workspaceId ||
      match[2] !== item.id
    )
      throw new Error(`Bug #${item.shortId} 的 TAPD 链接无效，请重新抓取`);
    const key = `${item.workspaceId}:${item.id}`;
    if (!tickets.has(key))
      tickets.set(key, {
        id: item.id,
        shortId: item.shortId,
        workspaceId: item.workspaceId,
        title: item.cleanTitle || item.title,
        url: parsed.href,
      });
  }
  if (!tickets.size) throw new Error("当前日期范围没有 Bug 单");
  if (tickets.size > MAX_BUGS)
    throw new Error(`当前范围有 ${tickets.size} 个 Bug，单次最多提取 ${MAX_BUGS} 个`);
  return [...tickets.values()];
}

// Runs inside a TAPD bug detail page. Only DOM attributes and layout metadata
// are returned; ticket text is never copied into the parser output.
export function readBugImagesDOM(): BugImageDOMRecord[] {
  const records: BugImageDOMRecord[] = [];
  const absolute = (raw: string | null | undefined) => {
    if (!raw) return "";
    try {
      return new URL(raw, location.href).href;
    } catch {
      return "";
    }
  };
  const hints = (element: Element | null) => {
    if (!element) return "";
    return [
      element.tagName,
      element.id,
      element.className,
      element.getAttribute("role"),
      element.getAttribute("aria-label"),
      element.getAttribute("data-field"),
      element.getAttribute("data-testid"),
    ]
      .filter((value) => typeof value === "string")
      .join(" ");
  };
  const ancestors = (element: Element) => {
    const values: string[] = [];
    let parent = element.parentElement;
    for (let depth = 0; parent && depth < 8; depth++, parent = parent.parentElement)
      values.push(hints(parent));
    return values.join(" ");
  };
  const srcset = (value: string | null) =>
    (value ?? "")
      .split(",")
      .map((part) => part.trim().split(/\s+/)[0])
      .filter(Boolean)
      .reverse();
  const unique = (values: string[]) => [...new Set(values.map(absolute).filter(Boolean))];
  const imageLink = (value: string) =>
    /(?:attach|download|file|capture)|\.(?:png|jpe?g|gif|webp|bmp|tiff?|avif|svg)(?:$|[?#])/i.test(value) ? value : "";
  const attachmentName = (element: Element | null) => {
    for (const selector of [".attachment-list__item-wrapper", ".attachment-item"]) {
      const label = element?.closest(selector)?.querySelector(".attachment-list__filename");
      const value = label?.getAttribute("title")?.trim() || label?.textContent?.trim();
      if (value) return value;
    }
    return "";
  };

  document.querySelectorAll("img").forEach((image) => {
    const img = image as HTMLImageElement;
    const link = img.closest("a[href]") as HTMLAnchorElement | null;
    const linkHref = link?.getAttribute("href") ?? "";
    const urls = unique([
      imageLink(img.getAttribute("href") ?? ""),
      img.getAttribute("original_src") ?? "",
      imageLink(linkHref),
      img.getAttribute("data-original") ?? "",
      img.getAttribute("data-origin") ?? "",
      img.getAttribute("data-src") ?? "",
      img.getAttribute("data-lazy-src") ?? "",
      ...srcset(img.getAttribute("srcset")),
      img.currentSrc,
      img.getAttribute("src") ?? "",
    ]);
    if (!urls.length) return;
    const rect = img.getBoundingClientRect();
    records.push({
      kind: "image",
      urls,
      fileName:
        link?.getAttribute("download") ||
        attachmentName(link || img) ||
        img.getAttribute("data-filename") ||
        img.alt ||
        "图片",
      ownHints: hints(img),
      ancestorHints: ancestors(img),
      inMain: !!img.closest(
        "main,[role='main'],.main-content,.bug-detail,.bug-content,.workitem-detail",
      ),
      visible: rect.width > 0 && rect.height > 0,
      width: Math.max(img.naturalWidth || 0, Math.round(rect.width)),
      height: Math.max(img.naturalHeight || 0, Math.round(rect.height)),
    });
  });

  document.querySelectorAll("video").forEach((element) => {
    const video = element as HTMLVideoElement;
    const rect = video.getBoundingClientRect();
    const urls = unique([
      video.currentSrc,
      video.getAttribute("src") ?? "",
      video.getAttribute("data-src") ?? "",
      ...Array.from(video.querySelectorAll("source")).map((source) => source.getAttribute("src") ?? ""),
    ]);
    if (!urls.length) return;
    records.push({ kind: "video", urls, fileName: video.getAttribute("title") || "视频",
      ownHints: hints(video), ancestorHints: ancestors(video),
      inMain: !!video.closest("main,[role='main'],.main-content,.bug-detail,.bug-content,.workitem-detail"),
      visible: rect.width > 0 && rect.height > 0, width: Math.round(rect.width), height: Math.round(rect.height) });
  });

  document.querySelectorAll("a[href]").forEach((element) => {
    const link = element as HTMLAnchorElement;
    if (link.querySelector("img")) return;
    const href = link.getAttribute("href") ?? "";
    const name =
      link.getAttribute("download") ||
      attachmentName(link) ||
      link.getAttribute("title") ||
      link.textContent?.trim() ||
      "图片附件";
    const imageName = /\.(?:png|jpe?g|gif|webp|bmp|tiff?|avif|svg|mp4|webm|mov|m4v|m3u8|mpd)(?:$|[?#\s])/i.test(
      `${name} ${href}`,
    );
    const attachment = /(?:attach|download|file)/i.test(
      `${href} ${hints(link)} ${ancestors(link)}`,
    );
    if (!imageName && !attachment) return;
    const rect = link.getBoundingClientRect();
    records.push({
      kind: "attachment",
      urls: unique([href]),
      fileName: name,
      ownHints: hints(link),
      ancestorHints: ancestors(link),
      inMain: !!link.closest(
        "main,[role='main'],.main-content,.bug-detail,.bug-content,.workitem-detail",
      ),
      visible: rect.width > 0 && rect.height > 0,
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    });
  });

  // TAPD renders the Bug description inside <richtext-preview>'s shadow root.
  // Its value contains the original media URLs even when videos are not loaded
  // and the component has not mounted all of its shadow children yet.
  document.querySelectorAll("richtext-preview[value]").forEach((host) => {
    const markup = host.getAttribute("value");
    if (!markup || typeof DOMParser === "undefined") return;
    const content = new DOMParser().parseFromString(markup, "text/html");
    const context = `${hints(host)} ${ancestors(host)} richtext description`;
    const inMain = !!host.closest("main,[role='main'],.main-content,.bug-detail,.bug-content,.workitem-detail");
    const visible = host.getBoundingClientRect().width > 0;
    content.querySelectorAll("video").forEach((element) => {
      const video = element as HTMLVideoElement;
      const urls = unique([
        video.getAttribute("src") ?? "",
        ...Array.from(video.querySelectorAll("source")).map((source) => source.getAttribute("src") ?? ""),
      ]);
      if (!urls.length) return;
      records.push({ kind: "video", urls, fileName: video.getAttribute("title") || "视频",
        ownHints: hints(video), ancestorHints: context, inMain, visible,
        width: Number(video.getAttribute("video_original_width") || video.getAttribute("width") || 0),
        height: Number(video.getAttribute("video_original_height") || video.getAttribute("height") || 0) });
    });
    content.querySelectorAll("img").forEach((element) => {
      const img = element as HTMLImageElement;
      const link = img.closest("a[href]");
      const href = link?.getAttribute("href") ?? "";
      const urls = unique([
        imageLink(img.getAttribute("href") ?? ""),
        img.getAttribute("original_src") ?? "",
        imageLink(href),
        img.getAttribute("data-original") ?? "", img.getAttribute("data-origin") ?? "",
        img.getAttribute("data-src") ?? "", img.getAttribute("src") ?? "",
      ]);
      if (!urls.length) return;
      records.push({ kind: "image", urls,
        fileName: link?.getAttribute("download") || img.getAttribute("data-filename") || img.alt || "图片",
        ownHints: hints(img), ancestorHints: context, inMain, visible,
        width: Number(img.getAttribute("width") || 0), height: Number(img.getAttribute("height") || 0) });
    });
  });
  return records;
}

function nonMediaFilename(value: string, url = false) {
  let filename = value;
  try { filename = url ? new URL(value).pathname : value; } catch { return false; }
  try { filename = decodeURIComponent(filename); } catch {}
  // Inspect the final path segment rather than the hostname (example.com is not a file).
  const extension = filename.split("/").at(-1)?.match(/\.([a-z0-9]{1,12})(?:$|[?#\s)])/i)?.[1]?.toLowerCase();
  if (!extension || /^\d+$/.test(extension)) return false;
  if (url && /^(php|aspx?|jsp|cgi)$/.test(extension)) return false;
  return !/^(avif|bmp|gif|jpe?g|png|svg|tiff?|webp|mp4|m4v|mov|webm|m3u8|mpd)$/.test(extension);
}

export function normalizeBugImageCandidates(
  records: BugImageDOMRecord[],
  pageUrl: string,
) {
  const candidates: BugImageCandidate[] = [];
  const seen = new Set<string>();
  for (const record of records) {
    const own = record.ownHints.toLowerCase();
    const context = `${record.ownHints} ${record.ancestorHints}`.toLowerCase();
    // TAPD attachment preview URLs have no suffix; use the visible filename before considering icon URLs.
    if (nonMediaFilename(record.fileName) || record.urls.some((url) => nonMediaFilename(url, true))) continue;
    if (/avatar|user[-_ ]?logo|user[-_ ]?photo|head[-_ ]?photo|头像/.test(context)) continue;
    const attachment =
      record.kind === "attachment" ||
      /attach|attachment|download|file-list|file-item|附件|下载/.test(context);
    const excluded =
      /avatar|head[-_ ]?photo|user[-_ ]?photo|logo|emoji|emoticon|loading|spinner|captcha/.test(
        own,
      ) ||
      /navbar|navigation|breadcrumb|side[-_ ]?bar|global[-_ ]?header|top[-_ ]?bar/.test(
        context,
      );
    if (excluded && !attachment) continue;
    if (
      !attachment && record.kind !== "video" &&
      record.width > 0 &&
      record.height > 0 &&
      record.width < 48 &&
      record.height < 48
    )
      continue;
    const comment = /comment|reply|activity|timeline|record|log-list|评论|回复|处理记录/.test(
      context,
    );
    const description = /description|detail|content|rich|editor|markdown|正文|描述/.test(
      context,
    );
    if (!attachment && !comment && !description && !record.inMain) continue;
    const video = record.kind === "video" || /\.(?:mp4|webm|mov|m4v|m3u8|mpd)(?:$|[?#\s])/i.test(`${record.fileName} ${record.urls.join(" ")}`);
    const urls = record.urls
      .map((raw) => {
        try {
          return new URL(raw, pageUrl).href;
        } catch {
          return "";
        }
      })
      .filter((url) => !/\/(?:user_logo|avatar)\//i.test(url))
      .filter((url) => url.startsWith("https://") || (video && url.startsWith("blob:")));
    if (!urls.length) continue;
    if (
      attachment &&
      record.width > 0 &&
      record.height > 0 &&
      record.width <= 32 &&
      record.height <= 32 &&
      urls.every((url) => /\.svg(?:$|[?#])/i.test(url))
    )
      continue;
    const source: BugImageSource = attachment
      ? "附件"
      : comment
        ? "评论"
        : "描述";
    const key = `${source}\u0000${urls.join("\u0000")}`;
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push({ source, urls, fileName: record.fileName, ...(video ? { mediaType: "video" as const } : {}) });
    if (candidates.length >= MAX_IMAGES_PER_BUG) break;
  }
  return candidates;
}

function privateAddress(address: string) {
  const value = address.toLowerCase();
  if (value === "::1" || value === "::" || value.startsWith("fc") || value.startsWith("fd") || value.startsWith("fe8") || value.startsWith("fe9") || value.startsWith("fea") || value.startsWith("feb"))
    return true;
  const mapped = value.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  const ipv4 = mapped ?? (isIP(value) === 4 ? value : "");
  if (!ipv4) return false;
  const [a, b] = ipv4.split(".").map(Number);
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a >= 224
  );
}

export async function assertSafeImageUrl(raw: string) {
  const url = new URL(raw);
  if (url.protocol !== "https:") throw new Error("仅允许下载 HTTPS 图片");
  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  if (!hostname || hostname === "localhost" || hostname.endsWith(".local"))
    throw new Error("已拒绝本机或内网图片地址");
  if (isIP(hostname)) {
    if (privateAddress(hostname)) throw new Error("已拒绝本机或内网图片地址");
  } else {
    const addresses = await lookup(hostname, { all: true, verbatim: true });
    if (!addresses.length || addresses.some((entry) => privateAddress(entry.address)))
      throw new Error("已拒绝本机或内网图片地址");
  }
  return url;
}

function extensionFor(format: string | undefined, contentType: string) {
  const value = (format || contentType.split(";")[0].split("/")[1] || "image")
    .toLowerCase()
    .replace(/^x-/, "");
  const normalized =
    ({ jpeg: "jpg", svgxml: "svg", "svg+xml": "svg", tiff: "tif" } as Record<string, string>)[value] ??
    value.replace(/[^a-z0-9]/g, "");
  return normalized || "image";
}

function dispositionName(value: string) {
  const encoded = value.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  if (encoded) {
    try {
      return decodeURIComponent(encoded);
    } catch {}
  }
  return value.match(/filename="?([^";]+)"?/i)?.[1] ?? "";
}

async function fetchOnce(
  context: BrowserContext, rawUrl: string, referer: string,
  temporaryDirectory: string, signal: AbortSignal,
): Promise<DownloadedBugImage> {
  if (/^blob:/i.test(rawUrl)) throw new Error("暂不支持 blob 视频，请使用原始视频附件");
  if (/\.(?:m3u8|mpd)(?:$|[?#])/i.test(rawUrl)) throw new Error("暂不支持 HLS/DASH 流媒体，请使用 MP4/WebM 视频附件");
  let current = (await assertSafeImageUrl(rawUrl)).href;
  for (let redirect = 0; redirect <= 5; redirect++) {
    signal.throwIfAborted();
    const cookies = await context.cookies(current);
    const response = await fetch(current, {
      redirect: "manual", signal: AbortSignal.any([signal, AbortSignal.timeout(120000)]),
      headers: { Referer: referer, Cookie: cookies.map((cookie) => cookie.name + "=" + cookie.value).join("; ") },
    });
    if (response.status >= 300 && response.status < 400 && response.headers.get("location")) {
      const next = new URL(response.headers.get("location")!, current).href;
      await response.body?.cancel();
      current = (await assertSafeImageUrl(next)).href;
      continue;
    }
    if (!response.ok) { await response.body?.cancel(); throw new Error("下载返回 HTTP " + response.status); }
    const contentType = response.headers.get("content-type") ?? "";
    const fileName = dispositionName(response.headers.get("content-disposition") ?? "");
    if (nonMediaFilename(fileName) || /^application\/(?:zip|x-rar-compressed|vnd\.rar|x-7z-compressed|pdf|msword|vnd\.openxmlformats-officedocument\.[^;]+)(?:;|$)/i.test(contentType)) {
      await response.body?.cancel();
      return { body: Buffer.alloc(0), url: current, format: "", contentType, fileName, skipped: true };
    }
    if (/mpegurl|dash\+xml/i.test(contentType)) { await response.body?.cancel(); throw new Error("暂不支持 HLS/DASH 流媒体"); }
    if (!response.body) throw new Error("媒体内容为空");
    const temporaryPath = path.join(temporaryDirectory, randomUUID() + ".partial");
    let file: Awaited<ReturnType<typeof open>> | undefined;
    try {
      file = await open(temporaryPath, "wx");
      const hash = createHash("sha256");
      let size = 0;
      let prefix = Buffer.alloc(0);
      let detected: ReturnType<typeof detectVideoFormat> = null;
      const declared = Number(response.headers.get("content-length") ?? 0);
      if (declared > MAX_VIDEO_BYTES) throw new Error("视频超过 250 MB");
      for await (const value of response.body) {
        signal.throwIfAborted();
        const chunk = Buffer.from(value);
        size += chunk.length;
        if (prefix.length < 65536) prefix = Buffer.concat([prefix, chunk.subarray(0, 65536 - prefix.length)]);
        detected = detectVideoFormat(prefix);
        const limit = detected ? MAX_VIDEO_BYTES : MAX_IMAGE_BYTES;
        if (size > limit || (prefix.length >= 16 && declared > limit))
          throw new Error(detected ? "视频超过 250 MB" : "图片超过 50 MB");
        hash.update(chunk);
        // FileHandle.write can be partial; writeFile writes the entire chunk at the current position.
        await file.writeFile(chunk);
      }
      await file.close(); file = undefined;
      if (!size) throw new Error("媒体内容为空");
      let format: string;
      if (detected) format = detected.format;
      else {
        try {
          const metadata = await sharp(temporaryPath, { animated: false, limitInputPixels: 250_000_000 }).metadata();
          if (!metadata.format) throw new Error();
          format = metadata.format;
        } catch { throw new Error("响应内容不是有效图片或支持的视频"); }
      }
      return { body: Buffer.alloc(0), url: current, format, contentType: detected?.mimeType ?? contentType,
        fileName: dispositionName(response.headers.get("content-disposition") ?? ""), temporaryPath,
        mediaType: detected ? "video" : "image", sha256: hash.digest("hex") };
    } catch (error) {
      await response.body.cancel().catch(() => {});
      await file?.close().catch(() => {});
      await rm(temporaryPath, { force: true });
      throw error;
    }
  }
  throw new Error("媒体重定向次数过多");
}

async function fetchCandidate(context: BrowserContext, candidate: BugImageCandidate,
  referer: string, temporaryDirectory: string, signal: AbortSignal) {
  let lastError = "媒体下载失败";
  for (const url of candidate.urls) {
    for (let attempt = 0; attempt < 2; attempt++) {
      signal.throwIfAborted();
      try { return await fetchOnce(context, url, referer, temporaryDirectory, signal); }
      catch (error) {
        signal.throwIfAborted();
        lastError = asMessage(error);
        if (/仅允许|已拒绝|不是有效|超过|内容为空|暂不支持/.test(lastError)) break;
      }
    }
  }
  throw new Error(lastError);
}

async function revealAllImageContent(page: Page, stopped: () => boolean): Promise<BugImageDOMRecord[]> {
  const records = new Map<string, BugImageDOMRecord>();
  const collect = async () => {
    for (const record of await page.evaluate(readBugImagesDOM))
      records.set(record.kind + "\u0000" + record.urls.join("\u0000"), record);
  };
  let stable = 0;
  let lastSignature = "";
  await collect();
  for (let round = 0; round < 100 && stable < 2 && !stopped(); round++) {
    const snapshot = await page.evaluate(() => {
      const pattern = /^(展开|展开全部|查看更多|加载更多|更多评论|全部评论|更多记录|查看全部)(?:\s*\(?.*\)?)?$/;
      const elements = [...document.querySelectorAll("button,a,[role='button']")].filter((element) => {
        const rect = element.getBoundingClientRect();
        return pattern.test(element.textContent?.trim() ?? "") && rect.width > 0 && rect.height > 0;
      });
      elements.slice(0, 8).forEach((element) => (element as HTMLElement).click());
      const candidates = [...new Set([
        ...document.querySelectorAll(".detail-container-left__scroll-wrapper"),
        ...document.querySelectorAll(".detail-container-left"),
        ...document.querySelectorAll(".detail-container-content,.detail-item__content-wrapper"),
      ])] as HTMLElement[];
      const scrolling = candidates.filter((element) => element.scrollHeight > element.clientHeight + 2 &&
        /auto|scroll/.test(getComputedStyle(element).overflowY));
      const containers = scrolling.length ? scrolling : [document.scrollingElement || document.documentElement] as HTMLElement[];
      for (const container of containers)
        container.scrollTop = Math.min(container.scrollHeight - container.clientHeight,
          container.scrollTop + Math.max(1, Math.floor(container.clientHeight * 0.8)));
      return { clicked: elements.length, atBottom: containers.every((container) =>
        container.scrollTop + container.clientHeight >= container.scrollHeight - 2) };
    });
    await page.waitForTimeout(350);
    await collect();
    const signature = await page.evaluate(() => [
      document.body.innerText.length,
      ...Array.from(document.querySelectorAll(".detail-container-left__scroll-wrapper,.detail-container-left,.detail-container-content,.detail-item__content-wrapper"))
        .map((element) => [element.scrollTop, element.scrollHeight, element.clientHeight].join(":")),
      document.scrollingElement?.scrollTop ?? 0,
      document.scrollingElement?.scrollHeight ?? document.documentElement.scrollHeight,
      ...Array.from(document.querySelectorAll("img,video,source")).map((element) => element.getAttribute("src") || element.getAttribute("data-src") || ""),
    ].join("|"));
    stable = snapshot.atBottom && !snapshot.clicked && signature === lastSignature ? stable + 1 : 0;
    lastSignature = signature;
  }
  await page.evaluate(() => {
    for (const element of document.querySelectorAll(".detail-container-left__scroll-wrapper,.detail-container-left,.detail-container-content,.detail-item__content-wrapper"))
      element.scrollTop = 0;
    window.scrollTo(0, 0);
  });
  return [...records.values()];
}

function csvCell(value: unknown) {
  const text = String(value ?? "");
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

async function writeManifest(root: string, rows: ManifestRow[]) {
  const header = [
    "Bug单号",
    "标题",
    "来源位置",
    "原地址",
    "保存文件",
    "SHA-256",
    "状态",
    "失败原因",
  ];
  const lines = [
    header,
    ...rows.map((row) => [
      row.bugId,
      row.title,
      row.source,
      row.originalUrl,
      row.savedFile,
      row.sha256,
      row.status,
      row.error,
    ]),
  ];
  await writeFile(
    path.join(root, "提取清单.csv"),
    `\uFEFF${lines.map((line) => line.map(csvCell).join(",")).join("\r\n")}\r\n`,
    "utf8",
  );
}

function availableFilePath(directory: string, stem: string, extension: string) {
  let candidate = path.join(directory, `${stem}.${extension}`);
  for (let index = 2; existsSync(candidate); index++)
    candidate = path.join(directory, `${stem} (${index}).${extension}`);
  return candidate;
}

export async function extractBugImagesToDirectory(input: {
  context: BrowserContext;
  page: Page;
  pages?: Page[];
  tickets: BugImageTicket[];
  outputPath: string;
  progress: (progress: Progress) => void;
  stopped: () => boolean;
  readCandidates?: (page: Page, ticket: BugImageTicket, stopped: () => boolean) => Promise<BugImageCandidate[]>;
  downloadCandidate?: (candidate: BugImageCandidate, referer: string) => Promise<DownloadedBugImage>;
}): Promise<BugImageExportResult> {
  const { context, page, tickets, outputPath, progress, stopped } = input;
  const readCandidates = input.readCandidates ?? (async (targetPage: Page, ticket: BugImageTicket, isStopped: () => boolean) => {
    await targetPage.goto(ticket.url, { waitUntil: "domcontentloaded", timeout: 45000 });
    const checkLogin = () => {
      if (/\/ptlogin\/|\/login(?:[/?]|$)/i.test(targetPage.url()))
        throw new Error("TAPD 登录已失效，请重新登录后再试");
    };
    checkLogin();
    try {
      await targetPage.locator(".bug-detail .detail-container-content,.bug-detail .detail-item__content-wrapper,.detail-container-content,.detail-item__content-wrapper").first()
        .waitFor({ state: "visible", timeout: 15000 });
      await targetPage.locator(".bug-detail .el-loading-mask:visible,.bug-detail .el-loading-spinner:visible,.bug-detail [aria-busy='true']:visible,.detail-container-content .el-loading-mask:visible").first()
        .waitFor({ state: "hidden", timeout: 15000 });
    } catch (error) { checkLogin(); throw error; }
    checkLogin();
    const records = await revealAllImageContent(targetPage, isStopped);
    if (isStopped()) return [];
    return normalizeBugImageCandidates(records, targetPage.url());
  });
  await mkdir(outputPath, { recursive: false });
  const temporaryDirectory = path.join(outputPath, ".partial-downloads");
  await mkdir(temporaryDirectory);
  const controller = new AbortController();
  let canceled = stopped();
  let halted = false;
  let resultMessage = "";
  const isStopped = () => canceled || halted || stopped();
  const timer = setInterval(() => { if (stopped()) { canceled = true; controller.abort(); } }, 100);
  const downloadLimit = pLimit(4);
  const urlCache = new Map<string, Promise<DownloadedBugImage>>();
  const rowsByTicket: ManifestRow[][] = tickets.map(() => []);
  let imageCount = 0, videoCount = 0, duplicateCount = 0, failedCount = 0, nextTicket = 0, completed = 0;
  const emit = (message: string) => progress({ phase: "extracting-images", message,
    current: completed, total: tickets.length, imageCount, videoCount, failedCount });
  const downloadCandidate = input.downloadCandidate ?? ((candidate: BugImageCandidate, referer: string) =>
    fetchCandidate(context, candidate, referer, temporaryDirectory, controller.signal));
  async function processTicket(targetPage: Page, ticketIndex: number) {
    const ticket = tickets[ticketIndex];
    const rows = rowsByTicket[ticketIndex];
    const ticketDir = path.join(outputPath, sanitizePathPart(ticket.shortId, "Bug") + "-" + sanitizePathPart(ticket.title, "未命名", 70));
    await mkdir(ticketDir, { recursive: false });
    const row = (source: string, originalUrl: string, values: Partial<ManifestRow>): ManifestRow => ({ bugId: ticket.shortId,
      title: ticket.title, source, originalUrl, savedFile: "", sha256: "", status: "失败", error: "", ...values });
    let candidates: BugImageCandidate[];
    try {
      emit("正在读取 Bug #" + ticket.shortId + "（完成 " + completed + "/" + tickets.length + "）");
      candidates = await readCandidates(targetPage, ticket, isStopped);
    } catch (error) {
      if (isStopped()) return;
      failedCount++;
      rows.push(row("单据", ticket.url, { error: asMessage(error) }));
      if (/登录已失效/.test(asMessage(error))) { resultMessage = asMessage(error); halted = true; controller.abort(); }
      return;
    }
    if (isStopped()) return;
    if (!candidates.length) { rows.push(row("单据", ticket.url, { status: "无图片或视频" })); return; }
    const hashes = new Map<string, string>();
    // Downloads overlap, but commits below retain the original candidate order.
    const pending = candidates.map((candidate) => {
      const key = candidate.urls.join("\u0000");
      let promise = urlCache.get(key);
      if (!promise) {
        promise = downloadLimit(async () => {
          if (isStopped()) throw new Error("已取消媒体下载");
          return downloadCandidate(candidate, ticket.url);
        });
        urlCache.set(key, promise);
      }
      return promise.then((value) => ({ value, error: null }), (error: unknown) => ({ value: null, error }));
    });
    for (let index = 0; index < candidates.length; index++) {
      const candidate = candidates[index];
      const result = await pending[index];
      // A completed file is retained even when cancellation arrives while later resources download.
      if (!result.value) {
        if (isStopped()) continue;
        failedCount++;
        rows.push(row(candidate.source, candidate.urls[0], { error: asMessage(result.error) }));
        continue;
      }
      const downloaded = result.value;
      if (downloaded.skipped) {
        rows.push(row(candidate.source, candidate.urls[0], { status: "跳过非媒体附件" }));
        continue;
      }
      try {
        const hash = downloaded.sha256 || createHash("sha256").update(downloaded.body).digest("hex");
        const duplicate = hashes.get(hash);
        if (duplicate) {
          duplicateCount++;
          rows.push(row(candidate.source, candidate.urls[0], { status: "重复", savedFile: duplicate, sha256: hash }));
          continue;
        }
        const extension = extensionFor(downloaded.format, downloaded.contentType);
        const supplied = downloaded.fileName || candidate.fileName;
        const stem = String(index + 1).padStart(2, "0") + "-" + candidate.source + "-" + sanitizePathPart(supplied.replace(/\.[a-z0-9]{1,8}$/i, ""), "媒体", 70);
        const filename = availableFilePath(ticketDir, stem, extension);
        if (downloaded.temporaryPath) await copyFile(downloaded.temporaryPath, filename, constants.COPYFILE_EXCL);
        else await writeFile(filename, downloaded.body, { flag: "wx" });
        const relative = path.relative(outputPath, filename).replace(/\\/g, "/");
        hashes.set(hash, relative);
        if (downloaded.mediaType === "video" || /^video\//i.test(downloaded.contentType)) videoCount++;
        else imageCount++;
        rows.push(row(candidate.source, candidate.urls[0], { status: "成功", savedFile: relative, sha256: hash }));
      } catch (error) {
        failedCount++;
        rows.push(row(candidate.source, candidate.urls[0], { error: asMessage(error) }));
      }
      emit("正在提取 Bug #" + ticket.shortId + " 媒体（" + (index + 1) + "/" + candidates.length + "）");
    }
  }
  try {
    const workers = await Promise.allSettled((input.pages?.length ? input.pages : [page]).slice(0, 2).map(async (targetPage) => {
      while (!isStopped()) {
        const index = nextTicket++;
        if (index >= tickets.length) break;
        try { await processTicket(targetPage, index); }
        catch (error) {
          failedCount++;
          const ticket = tickets[index];
          rowsByTicket[index].push({ bugId: ticket.shortId, title: ticket.title, source: "单据", originalUrl: ticket.url,
            savedFile: "", sha256: "", status: "失败", error: asMessage(error) });
        }
        completed++;
      }
    }));
    for (const worker of workers) if (worker.status === "rejected") {
      failedCount++;
      resultMessage = `部分媒体提取失败：${asMessage(worker.reason)}`;
    }
  } finally {
    canceled = canceled || stopped();
    clearInterval(timer);
    controller.abort();
    // Queue entries observe cancellation and settle before temporary files are removed.
    await Promise.allSettled([...urlCache.values()]);
    await rm(temporaryDirectory, { recursive: true, force: true });
    await writeManifest(outputPath, rowsByTicket.flat());
  }
  progress({ phase: canceled || failedCount ? "incomplete" : "ready",
    message: resultMessage || (canceled ? "已停止提取，保留 " : "媒体提取完成：") + imageCount + " 张图片、" + videoCount + " 个视频，重复 " + duplicateCount + " 项，失败 " + failedCount + " 项",
    current: completed, total: tickets.length, imageCount, videoCount, failedCount });
  return { outputPath, bugCount: tickets.length, imageCount, videoCount, duplicateCount, failedCount, canceled,
    ...(resultMessage ? { message: resultMessage } : {}) };
}
