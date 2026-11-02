import ExcelJS from "exceljs";
import sharp from "sharp";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, extname, basename, join } from "node:path";
import {
  buildReport,
  captureCovers,
  captureScopeLabel,
  effortText,
  inPeriod,
  reportGroups,
  weeklyMarkdown,
  weeklyText,
} from "../shared/report";
import type { BugMediaGroup, ExportKind, LocalState, Period } from "../shared/types";

export interface ReportBugImage {
  bugId: string;
  mediaId: string;
  title: string;
  source: string;
  fileName: string;
  width: number;
  height: number;
  url: string;
}
export interface EmbeddedBugImage extends Omit<ReportBugImage, "mediaId"> {
  absolutePath: string;
  mimeType?: string;
}

export const safeFilename = (text: string) =>
  text
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")
    .replace(/[. ]+$/, "")
    .slice(0, 120) || "报表";
export function suggestedName(
  kind: ExportKind,
  period: Period,
  state: LocalState,
  draft: boolean,
) {
  const prefix = draft ? "草稿--" : "";
  return kind === "xlsx"
    ? `${prefix}基地--${Number(period.start.slice(5, 7))}月UI提单--${safeFilename(state.settings.person)}.xlsx`
    : `${prefix}${kind === "csv" ? "TAPD原始清单" : "周报"}--${period.start}至${period.end}.${kind}`;
}
export function unusedPath(path: string) {
  const ext = extname(path),
    stem = basename(path, ext);
  let n = 2,
    next = path;
  while (existsSync(next)) next = join(dirname(path), `${stem} (${n++})${ext}`);
  return next;
}
function csvCell(value: string) {
  // Keep spreadsheet applications from interpreting TAPD titles as formulas.
  const text = /^[\s]*[=+@-]/.test(value) ? `'${value}` : value;
  return `"${text.replace(/"/g, '""')}"`;
}
export function rawCsv(state: LocalState, period: Period): string {
  const header = [
    "完整ID",
    "短ID",
    "项目ID",
    "项目",
    "类型",
    "原始标题",
    "状态",
    "当前处理人",
    "处理时间（北京时间）",
    "链接",
    "采集时间",
    "采集完整性",
    "采集范围",
  ];
  const rows = (state.capture?.items ?? [])
    .filter((i) => inPeriod(i.processedAt.slice(0, 10), period))
    .map((i) => [
      i.id,
      i.shortId,
      i.workspaceId,
      i.workspaceName,
      i.type,
      i.title,
      i.status,
      i.owner,
      i.processedAt,
      i.url,
      state.capture!.capturedAt,
      state.capture!.complete && captureCovers(state.capture, period)
        ? "完整"
        : "所选范围未完整采集",
      captureScopeLabel(state.capture!),
    ]);
  return (
    "\uFEFF" +
    [header, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n")
  );
}
export function exportProblems(state: LocalState, period: Period): string[] {
  const report = buildReport(state, period);
  const issues = [...report.issues];
  if (!state.capture) issues.unshift("尚未采集 TAPD");
  else if (!state.capture.complete) issues.unshift("采集不完整，请重新抓取");
  if (!report.entries.length) issues.push("所选日期没有纳入的事项");
  return issues;
}
export function selectReportBugImages(state: LocalState, period: Period, groups: BugMediaGroup[]): ReportBugImage[] {
  const mediaByBug = new Map(groups.map((group) => [group.bugId, group]));
  const rawByKey = new Map((state.capture?.items ?? []).map((item) => [item.key, item]));
  const seen = new Set<string>();
  const selected: ReportBugImage[] = [];
  for (const entry of buildReport(state, period).entries) {
    for (const key of entry.sourceKeys) {
      const raw = rawByKey.get(key);
      if (!raw || raw.type.toLowerCase() !== "bug" || seen.has(raw.shortId)) continue;
      seen.add(raw.shortId);
      const group = mediaByBug.get(raw.shortId);
      for (const item of group?.items ?? []) {
        if (item.kind !== "image") continue;
        selected.push({
          bugId: raw.shortId, mediaId: item.id, title: entry.title,
          source: item.source, fileName: item.fileName,
          width: item.width, height: item.height, url: raw.url,
        });
      }
    }
  }
  return selected;
}

async function addBugImageAppendix(workbook: ExcelJS.Workbook, images: EmbeddedBugImage[]) {
  const sheet = workbook.addWorksheet("Bug图片附件");
  sheet.columns = [
    { header: "Bug 单号", key: "bugId", width: 18 },
    { header: "Bug 标题", key: "title", width: 52 },
    { header: "来源", key: "source", width: 12 },
    { header: "文件名", key: "fileName", width: 40 },
    { header: "图片", key: "image", width: 50 },
  ];
  sheet.getRow(1).height = 28;
  sheet.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
  sheet.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF285CE3" } };
  sheet.views = [{ state: "frozen", ySplit: 1 }];
  for (const image of images) {
    const row = sheet.addRow({ title: image.title, source: image.source, fileName: image.fileName });
    row.height = 155;
    row.alignment = { vertical: "middle", wrapText: true };
    const label = `#${image.bugId}`;
    row.getCell(1).value = /^https:\/\/tapd\.tencent\.com\/tapd_fe\/\d+\//.test(image.url)
      ? { text: label, hyperlink: image.url }
      : label;
    const format = image.mimeType?.replace(/^image\//, "") || extname(image.absolutePath).slice(1).toLowerCase();
    const extension = format === "jpg" ? "jpeg" : format;
    const imageId = extension === "png" || extension === "jpeg" || extension === "gif"
      ? workbook.addImage({ filename: image.absolutePath, extension })
      : workbook.addImage({ buffer: await sharp(await readFile(image.absolutePath), { animated: false, limitInputPixels: 250_000_000 }).rotate().png().toBuffer(), extension: "png" });
    const scale = Math.min(330 / Math.max(image.width, 1), 190 / Math.max(image.height, 1), 1);
    sheet.addImage(imageId, {
      tl: { col: 4.1, row: row.number - 1 + 0.08 },
      ext: { width: Math.max(1, Math.round(image.width * scale)), height: Math.max(1, Math.round(image.height * scale)) },
      editAs: "oneCell",
    });
  }
}
export async function writeExport(
  path: string,
  kind: ExportKind,
  state: LocalState,
  period: Period,
  draft: boolean,
  template: string,
  images: EmbeddedBugImage[] = [],
) {
  const problems = exportProblems(state, period);
  if (kind !== "csv" && problems.length && !draft)
    throw new Error(
      `请先完成整理，或选择导出草稿：${problems.slice(0, 3).join("；")}`,
    );
  const report = buildReport(state, period);
  if (kind === "csv")
    return writeFile(path, rawCsv(state, period), {
      encoding: "utf8",
      flag: "wx",
    });
  if (kind !== "xlsx")
    return writeFile(
      path,
      kind === "md"
        ? weeklyMarkdown(report, draft, state.settings.weeklyContent)
        : weeklyText(report, draft, state.settings.weeklyContent),
      { encoding: "utf8", flag: "wx" },
    );
  const source = new ExcelJS.Workbook();
  await source.xlsx.readFile(template);
  const original = source.worksheets[0];
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet(original.name, {
    pageSetup: structuredClone(original.pageSetup),
    properties: structuredClone(original.properties),
  });
  for (let col = 1; col <= 12; col++) {
    sheet.getColumn(col).width = original.getColumn(col).width;
    sheet.getCell(1, col).value = original.getCell(1, col).value;
    sheet.getCell(1, col).style = structuredClone(
      original.getCell(1, col).style,
    );
  }
  sheet.getRow(1).height = original.getRow(1).height;
  const styles = Array.from({ length: 12 }, (_, i) =>
    structuredClone(original.getCell(2, i + 1).style),
  );
  const defaultHeight = original.getRow(2).height ?? 80;
  for (const group of reportGroups(report.entries)) {
    group.entries.forEach((entry, index) => {
      const prefix =
        index === 0 ? `${group.label}${effortText(group.units)}人天` : "";
      const name = `${draft ? "【草稿】" : ""}${prefix}【${entry.category || "待分类"}】${entry.title}`;
      const s = state.settings;
      const row = sheet.addRow([
        name,
        s.unit,
        new Date(`${entry.dates.at(-1)}T00:00:00Z`),
        s.productionLevel || null,
        s.supplier,
        s.testOrder,
        s.content,
        s.width,
        s.height,
        s.method,
        entry.units / 100,
        s.person,
      ]);
      row.eachCell({ includeEmpty: true }, (cell, col) => {
        if (col <= 12) cell.style = structuredClone(styles[col - 1]);
      });
      row.getCell(3).numFmt = "yyyy/m/d";
      row.getCell(11).numFmt = "0.##";
      const textUnits = [...name].reduce(
        (sum, ch) => sum + (ch.charCodeAt(0) > 255 ? 2 : 1),
        0,
      );
      row.height = Math.max(defaultHeight, Math.ceil(textUnits / 58) * 15 + 12);
    });
  }
  sheet.pageSetup.printArea = `A1:L${Math.max(1, sheet.rowCount)}`;
  if (images.length) await addBugImageAppendix(workbook, images);
  workbook.creator = "TAPD月报工具";
  workbook.modified = new Date();
  // Exclusive creation also guards a race after choosing a versioned filename.
  const buffer = await workbook.xlsx.writeBuffer();
  await writeFile(path, Buffer.from(buffer), { flag: "wx" });
}
