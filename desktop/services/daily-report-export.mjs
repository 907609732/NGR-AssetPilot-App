import ExcelJS from "exceljs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { DesktopError, isPlainRecord } from "../shared/core.mjs";

const MAX_ROWS = 1000;
const MAX_CELL_CHARACTERS = 5000;
const FIELD_DEFINITIONS = Object.freeze([
  ["objectName", "物件名称", 65],
  ["workUnit", "工作量单位", 16],
  ["dueDate", "期望完成日期", 15],
  ["productionLevel", "制作等级", 10],
  ["vendor", "推荐供应商", 28],
  ["testOrder", "是否测试单", 12],
  ["requirementType", "需求内容", 12],
  ["dimensionLength", "尺寸(长)", 10],
  ["dimensionWidth", "尺寸(宽)", 10],
  ["productionMethod", "制作方式", 12],
  ["workload", "数量/预估工作量", 18],
  ["producer", "制作人员", 13],
]);

function requiredText(value, field, rowIndex, { allowBlank = false } = {}) {
  const text = String(value ?? "").trim();
  if (!allowBlank && !text) throw new DesktopError("DAILY_REPORT_ROW_INVALID", `第 ${rowIndex + 1} 行 ${field} 不能为空`);
  if (text.length > MAX_CELL_CHARACTERS) throw new DesktopError("DAILY_REPORT_CELL_TOO_LONG", `第 ${rowIndex + 1} 行 ${field} 超过长度限制`);
  return text;
}

function positiveNumber(value, field, rowIndex) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) throw new DesktopError("DAILY_REPORT_ROW_INVALID", `第 ${rowIndex + 1} 行 ${field} 必须大于 0`);
  return number;
}

function parseIsoDate(value, rowIndex) {
  const match = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) throw new DesktopError("DAILY_REPORT_ROW_INVALID", `第 ${rowIndex + 1} 行日期无效`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    throw new DesktopError("DAILY_REPORT_ROW_INVALID", `第 ${rowIndex + 1} 行日期无效`);
  }
  return date;
}

function sanitizeRow(value, rowIndex) {
  if (!isPlainRecord(value)) throw new DesktopError("DAILY_REPORT_ROW_INVALID", `第 ${rowIndex + 1} 行数据无效`);
  return {
    objectName: requiredText(value.objectName, "物件名称", rowIndex),
    workUnit: requiredText(value.workUnit, "工作量单位", rowIndex),
    dueDate: parseIsoDate(value.dueDate, rowIndex),
    productionLevel: requiredText(value.productionLevel, "制作等级", rowIndex, { allowBlank: true }),
    vendor: requiredText(value.vendor, "推荐供应商", rowIndex),
    testOrder: requiredText(value.testOrder, "是否测试单", rowIndex),
    requirementType: requiredText(value.requirementType, "需求内容", rowIndex),
    dimensionLength: positiveNumber(value.dimensionLength, "尺寸(长)", rowIndex),
    dimensionWidth: positiveNumber(value.dimensionWidth, "尺寸(宽)", rowIndex),
    productionMethod: requiredText(value.productionMethod, "制作方式", rowIndex),
    workload: positiveNumber(value.workload, "数量/预估工作量", rowIndex),
    producer: requiredText(value.producer, "制作人员", rowIndex),
  };
}

function validateRequest(payload) {
  if (!isPlainRecord(payload)) throw new DesktopError("DAILY_REPORT_REQUEST_INVALID", "日报导出请求无效");
  const year = Number(payload.year);
  const month = Number(payload.month);
  if (!Number.isInteger(year) || year < 2000 || year > 2100) throw new DesktopError("DAILY_REPORT_REQUEST_INVALID", "目标年份无效");
  if (!Number.isInteger(month) || month < 1 || month > 12) throw new DesktopError("DAILY_REPORT_REQUEST_INVALID", "目标月份无效");
  if (!Array.isArray(payload.rows) || !payload.rows.length || payload.rows.length > MAX_ROWS) {
    throw new DesktopError("DAILY_REPORT_REQUEST_INVALID", `日报必须包含 1 到 ${MAX_ROWS} 行`);
  }
  return {
    year,
    month,
    producer: requiredText(payload.producer, "制作人员", 0),
    rows: payload.rows.map(sanitizeRow),
  };
}

function safeFileSegment(value) {
  return String(value || "")
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-")
    .replace(/[. ]+$/g, "")
    .trim()
    .slice(0, 80) || "未命名";
}

function applyCellBorder(cell) {
  const side = { style: "thin", color: { argb: "FFD9E1E5" } };
  cell.border = { top: side, left: side, bottom: side, right: side };
}

export async function createDailyReportWorkbookBuffer(payload) {
  const request = validateRequest(payload);
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "NGR AssetPilot";
  workbook.created = new Date();
  workbook.modified = new Date();
  workbook.calcProperties.fullCalcOnLoad = false;
  const worksheet = workbook.addWorksheet("Sheet1", {
    views: [{ state: "frozen", ySplit: 1 }],
    pageSetup: { orientation: "landscape", fitToPage: true, fitToWidth: 1, fitToHeight: 0 },
  });
  worksheet.properties.defaultRowHeight = 80;
  worksheet.columns = FIELD_DEFINITIONS.map(([key, header, width]) => ({ key, header, width }));
  worksheet.autoFilter = { from: "A1", to: `L${request.rows.length + 1}` };

  const header = worksheet.getRow(1);
  header.height = 80;
  header.eachCell((cell) => {
    cell.font = { name: "Microsoft YaHei", size: 10, bold: true, color: { argb: "FF1B2428" } };
    cell.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
    applyCellBorder(cell);
  });

  for (const source of request.rows) {
    const row = worksheet.addRow(source);
    row.height = 80;
    row.eachCell({ includeEmpty: true }, (cell, columnNumber) => {
      cell.font = { name: "Microsoft YaHei", size: 10, color: { argb: "FF1B2428" } };
      cell.alignment = {
        horizontal: columnNumber === 1 ? "left" : "center",
        vertical: "middle",
        wrapText: columnNumber === 1,
      };
      applyCellBorder(cell);
    });
    row.getCell(3).numFmt = "yyyy/m/d";
    row.getCell(8).numFmt = "0";
    row.getCell(9).numFmt = "0";
  }

  const buffer = await workbook.xlsx.writeBuffer({ useStyles: true, useSharedStrings: true });
  return { buffer: Buffer.from(buffer), request };
}

export class DailyReportExportService {
  constructor({ dialog, getWindow }) {
    this.dialog = dialog;
    this.getWindow = getWindow;
  }

  async export(payload) {
    const { buffer, request } = await createDailyReportWorkbookBuffer(payload);
    const defaultName = `基地--${request.month}月UI提单--${safeFileSegment(request.producer)}.xlsx`;
    const result = await this.dialog.showSaveDialog(this.getWindow(), {
      title: "导出基地日报提单",
      defaultPath: defaultName,
      buttonLabel: "导出 Excel",
      filters: [{ name: "Excel 工作簿", extensions: ["xlsx"] }],
      properties: ["showOverwriteConfirmation", "createDirectory"],
    });
    if (result.canceled || !result.filePath) return { canceled: true };
    const targetPath = result.filePath.toLowerCase().endsWith(".xlsx") ? result.filePath : `${result.filePath}.xlsx`;
    await writeFile(targetPath, buffer, { flag: "w" });
    const totalWorkload = Math.round(request.rows.reduce((sum, row) => sum + row.workload, 0) * 100) / 100;
    return {
      canceled: false,
      fileName: path.basename(targetPath),
      rowCount: request.rows.length,
      totalWorkload,
    };
  }
}
