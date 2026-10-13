import ExcelJS from "exceljs";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
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
import type { ExportKind, LocalState, Period } from "../shared/types";

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
export async function writeExport(
  path: string,
  kind: ExportKind,
  state: LocalState,
  period: Period,
  draft: boolean,
  template: string,
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
      kind === "md" ? weeklyMarkdown(report, draft) : weeklyText(report, draft),
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
  workbook.creator = "TAPD月报工具";
  workbook.modified = new Date();
  // Exclusive creation also guards a race after choosing a versioned filename.
  const buffer = await workbook.xlsx.writeBuffer();
  await writeFile(path, Buffer.from(buffer), { flag: "wx" });
}
