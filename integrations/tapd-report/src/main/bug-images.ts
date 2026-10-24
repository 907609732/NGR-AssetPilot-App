import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { existsSync } from "node:fs";
import { mkdir, readdir, realpath, stat, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import path from "node:path";
import sharp from "sharp";
import type { APIRequestContext, BrowserContext, Page } from "playwright-core";
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
  kind: "image" | "attachment";
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

  document.querySelectorAll("img").forEach((image) => {
    const img = image as HTMLImageElement;
    const link = img.closest("a[href]") as HTMLAnchorElement | null;
    const linkHref = link?.getAttribute("href") ?? "";
    const originalLink = /(?:attach|download|file)|\.(?:png|jpe?g|gif|webp|bmp|tiff?|avif|svg)(?:$|[?#])/i.test(
      linkHref,
    )
      ? [linkHref]
      : [];
    const urls = unique([
      ...originalLink,
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

  document.querySelectorAll("a[href]").forEach((element) => {
    const link = element as HTMLAnchorElement;
    if (link.querySelector("img")) return;
    const href = link.getAttribute("href") ?? "";
    const name =
      link.getAttribute("download") ||
      link.getAttribute("title") ||
      link.textContent?.trim() ||
      "图片附件";
    const imageName = /\.(?:png|jpe?g|gif|webp|bmp|tiff?|avif|svg)(?:$|[?#])/i.test(
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
  return records;
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
      !attachment &&
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
    const urls = record.urls
      .map((raw) => {
        try {
          return new URL(raw, pageUrl).href;
        } catch {
          return "";
        }
      })
      .filter((url) => url.startsWith("https://"));
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
    candidates.push({ source, urls, fileName: record.fileName });
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
  request: APIRequestContext,
  rawUrl: string,
  referer: string,
) {
  let current = (await assertSafeImageUrl(rawUrl)).href;
  for (let redirect = 0; redirect <= 5; redirect++) {
    const response = await request.get(current, {
      failOnStatusCode: false,
      headers: { Referer: referer },
      maxRedirects: 0,
      timeout: 30000,
    });
    const status = response.status();
    const headers = response.headers();
    if (status >= 300 && status < 400 && headers.location) {
      const next = new URL(headers.location, current).href;
      await response.dispose();
      current = (await assertSafeImageUrl(next)).href;
      continue;
    }
    if (status < 200 || status >= 300) {
      await response.dispose();
      throw new Error(`下载返回 HTTP ${status}`);
    }
    const declared = Number(headers["content-length"] ?? 0);
    if (declared > MAX_IMAGE_BYTES) {
      await response.dispose();
      throw new Error("图片超过 50 MB");
    }
    const body = await response.body();
    await response.dispose();
    if (!body.length) throw new Error("图片内容为空");
    if (body.length > MAX_IMAGE_BYTES) throw new Error("图片超过 50 MB");
    let metadata: sharp.Metadata;
    try {
      metadata = await sharp(body, {
        animated: false,
        limitInputPixels: 250_000_000,
      }).metadata();
    } catch {
      throw new Error("响应内容不是有效图片");
    }
    if (!metadata.format) throw new Error("响应内容不是有效图片");
    return {
      body,
      url: current,
      format: metadata.format,
      contentType: headers["content-type"] ?? "",
      fileName: dispositionName(headers["content-disposition"] ?? ""),
    };
  }
  throw new Error("图片重定向次数过多");
}

async function fetchCandidate(
  request: APIRequestContext,
  candidate: BugImageCandidate,
  referer: string,
) {
  let lastError = "图片下载失败";
  for (const url of candidate.urls) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return await fetchOnce(request, url, referer);
      } catch (error) {
        lastError = asMessage(error);
        const permanent = /仅允许|已拒绝|不是有效图片|超过 50 MB|内容为空/.test(
          lastError,
        );
        if (attempt === 0 && !permanent)
          await new Promise((resolve) => setTimeout(resolve, 300));
        else break;
      }
    }
  }
  throw new Error(lastError);
}

async function revealAllImageContent(page: Page, stopped: () => boolean) {
  let stable = 0;
  let lastHeight = 0;
  for (let round = 0; round < 30 && stable < 2 && !stopped(); round++) {
    const clicked = await page.evaluate(() => {
      const pattern = /^(展开|展开全部|查看更多|加载更多|更多评论|全部评论|更多记录|查看全部)(?:\s*\(?.*\)?)?$/;
      const elements = [
        ...document.querySelectorAll("button,a,[role='button']"),
      ].filter((element) => {
        const text = element.textContent?.trim() ?? "";
        const rect = element.getBoundingClientRect();
        return pattern.test(text) && rect.width > 0 && rect.height > 0;
      });
      elements.slice(0, 8).forEach((element) =>
        (element as HTMLElement).click(),
      );
      window.scrollTo(0, document.documentElement.scrollHeight);
      return elements.length;
    });
    await page.waitForTimeout(350);
    const height = await page.evaluate(() => document.documentElement.scrollHeight);
    stable = !clicked && height === lastHeight ? stable + 1 : 0;
    lastHeight = height;
  }
  await page.evaluate(() => window.scrollTo(0, 0));
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
  tickets: BugImageTicket[];
  outputPath: string;
  progress: (progress: Progress) => void;
  stopped: () => boolean;
  readCandidates?: (
    page: Page,
    ticket: BugImageTicket,
    stopped: () => boolean,
  ) => Promise<BugImageCandidate[]>;
  downloadCandidate?: (
    candidate: BugImageCandidate,
    referer: string,
  ) => Promise<DownloadedBugImage>;
}): Promise<BugImageExportResult> {
  const { context, page, tickets, outputPath, progress, stopped } = input;
  const readCandidates =
    input.readCandidates ??
    (async (targetPage: Page, ticket: BugImageTicket, isStopped: () => boolean) => {
      await targetPage.goto(ticket.url, {
        waitUntil: "domcontentloaded",
        timeout: 45000,
      });
      if (/\/ptlogin\/|\/login(?:[/?]|$)/i.test(targetPage.url()))
        throw new Error("TAPD 登录已失效，请重新登录后再试");
      await targetPage
        .waitForLoadState("networkidle", { timeout: 10000 })
        .catch(() => {});
      await revealAllImageContent(targetPage, isStopped);
      if (isStopped()) return [];
      return normalizeBugImageCandidates(
        await targetPage.evaluate(readBugImagesDOM),
        targetPage.url(),
      );
    });
  const downloadCandidate =
    input.downloadCandidate ??
    ((candidate: BugImageCandidate, referer: string) =>
      fetchCandidate(context.request, candidate, referer));
  await mkdir(outputPath, { recursive: false });
  const rows: ManifestRow[] = [];
  let imageCount = 0;
  let duplicateCount = 0;
  let failedCount = 0;
  let canceled = false;
  let resultMessage = "";

  for (let ticketIndex = 0; ticketIndex < tickets.length; ticketIndex++) {
    if (stopped()) {
      canceled = true;
      break;
    }
    const ticket = tickets[ticketIndex];
    progress({
      phase: "extracting-images",
      message: `正在读取 Bug #${ticket.shortId}（${ticketIndex + 1}/${tickets.length}）`,
      current: ticketIndex + 1,
      total: tickets.length,
      imageCount,
      failedCount,
    });
    const ticketDir = path.join(
      outputPath,
      `${sanitizePathPart(ticket.shortId, "Bug")}-${sanitizePathPart(ticket.title, "未命名", 70)}`,
    );
    await mkdir(ticketDir, { recursive: false });
    let candidates: BugImageCandidate[];
    try {
      candidates = await readCandidates(page, ticket, stopped);
      if (stopped()) {
        canceled = true;
        break;
      }
    } catch (error) {
      failedCount++;
      rows.push({
        bugId: ticket.shortId,
        title: ticket.title,
        source: "单据",
        originalUrl: ticket.url,
        savedFile: "",
        sha256: "",
        status: "失败",
        error: asMessage(error),
      });
      if (/登录已失效/.test(asMessage(error))) {
        resultMessage = asMessage(error);
        progress({
          phase: "incomplete",
          message: "TAPD 登录已失效，已保留当前提取结果。请重新登录后再试。",
          current: ticketIndex + 1,
          total: tickets.length,
          imageCount,
          failedCount,
        });
        break;
      }
      continue;
    }

    if (!candidates.length) {
      rows.push({
        bugId: ticket.shortId,
        title: ticket.title,
        source: "单据",
        originalUrl: ticket.url,
        savedFile: "",
        sha256: "",
        status: "无图片",
        error: "",
      });
      continue;
    }

    const hashes = new Map<string, string>();
    const urlCache = new Map<string, DownloadedBugImage>();
    for (let index = 0; index < candidates.length; index++) {
      if (stopped()) {
        canceled = true;
        break;
      }
      const candidate = candidates[index];
      const originalUrl = candidate.urls[0];
      try {
        let downloaded = urlCache.get(originalUrl);
        if (!downloaded) {
          downloaded = await downloadCandidate(candidate, ticket.url);
          urlCache.set(originalUrl, downloaded);
        }
        const hash = createHash("sha256").update(downloaded.body).digest("hex");
        const duplicate = hashes.get(hash);
        if (duplicate) {
          duplicateCount++;
          rows.push({
            bugId: ticket.shortId,
            title: ticket.title,
            source: candidate.source,
            originalUrl,
            savedFile: duplicate,
            sha256: hash,
            status: "重复",
            error: "",
          });
          continue;
        }
        const extension = extensionFor(downloaded.format, downloaded.contentType);
        const supplied = downloaded.fileName || candidate.fileName;
        const withoutExtension = supplied.replace(/\.[a-z0-9]{1,8}$/i, "");
        const stem = `${String(index + 1).padStart(2, "0")}-${candidate.source}-${sanitizePathPart(withoutExtension, "图片", 70)}`;
        const filename = availableFilePath(ticketDir, stem, extension);
        await writeFile(filename, downloaded.body, { flag: "wx" });
        const relative = path.relative(outputPath, filename).replace(/\\/g, "/");
        hashes.set(hash, relative);
        imageCount++;
        rows.push({
          bugId: ticket.shortId,
          title: ticket.title,
          source: candidate.source,
          originalUrl,
          savedFile: relative,
          sha256: hash,
          status: "成功",
          error: "",
        });
      } catch (error) {
        failedCount++;
        rows.push({
          bugId: ticket.shortId,
          title: ticket.title,
          source: candidate.source,
          originalUrl,
          savedFile: "",
          sha256: "",
          status: "失败",
          error: asMessage(error),
        });
      }
      progress({
        phase: "extracting-images",
        message: `正在提取 Bug #${ticket.shortId} 的图片（${index + 1}/${candidates.length}）`,
        current: ticketIndex + 1,
        total: tickets.length,
        imageCount,
        failedCount,
      });
    }
    if (canceled) break;
  }

  await writeManifest(outputPath, rows);
  progress({
    phase: canceled || failedCount ? "incomplete" : "ready",
    message: canceled
      ? `已停止提取，保留 ${imageCount} 张图片，失败 ${failedCount} 项`
      : resultMessage ||
        `图片提取完成：${imageCount} 张，重复 ${duplicateCount} 张，失败 ${failedCount} 项`,
    current: tickets.length,
    total: tickets.length,
    imageCount,
    failedCount,
  });
  return {
    outputPath,
    bugCount: tickets.length,
    imageCount,
    duplicateCount,
    failedCount,
    canceled,
    ...(resultMessage ? { message: resultMessage } : {}),
  };
}
