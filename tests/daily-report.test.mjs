import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import ExcelJS from "exceljs";

import { createDailyReportWorkbookBuffer, DailyReportExportService } from "../desktop/services/daily-report-export.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const coreSource = await readFile(path.join(projectRoot, "app/js/daily-report-core.js"), "utf8");
const browserGlobal = {};
vm.runInNewContext(coreSource, { window: browserGlobal, globalThis: browserGlobal, Date, Number, String, Object, Array, Map, Set, Math, RegExp });
const core = browserGlobal.NgrDailyReportCore;

const SEPTEMBER_SAMPLE = `9/1（S2）1人天【商业化】蛋糕型小额抽奖（升层版）-还原
9/2（S2）1人天【运营活动】迷你冬活-子活动页-还原
9/3（S2）1人天 【运营活动】迷你冬活-抽奖页-还原
9/4（S2）1人天 【运营活动】角色活动-联调
9/7（S2）1人天【运营活动】李白角色活动-迭代-还原
9/8（S2）1人天【运营活动】迷你冬活-抽奖页奖励展示-还原
【运营活动】王者周年庆拍照活动（10月中旬上线）-最新活动界面还原
【运营活动】迷你冬活-活动图标【雯雯】
9/9（S2）1人天 【运营活动】泉渊角色活动-迭代需求——图标【雯雯】
【运营活动】迷你冬活-子页背景（x3）
9/10（S2）1人天 【商业化】蛋糕型小额抽奖（升层版）-奖励结算新增界面
9/11（S2）1人天【运营活动】迷你冬活-活动主页背景
【运营活动】迷你冬活-配图资源【雯雯】
9/14（S2）1人天【运营活动】李白角色活动-联调
9/15（S2）1人天【商业化】首充有礼，弹窗内字体大小不一致【OT】
【商业化】首充有礼，拍脸图一加ACE 2V未铺满   且前往充值的按钮层级不对【OT】
9/16（S2）1人天 【运营活动】春归节-活动中心-兑换商店-还原
9/17（S2）1人天 【运营活动】春归节-活动中心-闹春归途-还原
【商业化】商业化集卡活动-还原迭代需求
9/18（S2）1人天【商业化】蛋糕型小额抽奖（升层版）-还原联调
9/20（S2）1人天【运营活动】春归节-活动中心-集合页-还原
9/21（S1）1人天【运营活动】王者周年庆拍照 背景留言板浮
9/22（S2）1人天【商业化】蛋糕型小额抽奖（升层版）-奖励结算新增界面
9/23（S3）1人天 【运营活动】三丽鸥：活动界面 - 预约活动页-拍脸
9/24（S2）1人天 【运营活动】春归节-活动中心-集合页-还原
9/28（S1）1人天【运营活动】春归节-活动中心-开启 toast-还原
9/29-9/30（S2）2人天【商业化】春归节-活动中心-福气连珠（消消乐）活动页-还原

共计22人天任务（当月满勤天,实际出勤天)`;

test("九月自然语言日报解析为可浏览的 27 行并严格对账 22 人天", () => {
  const result = core.parseDailyReport(SEPTEMBER_SAMPLE, { year: 2026 });
  assert.equal(result.groups.length, 21);
  assert.equal(result.rows.length, 27);
  assert.equal(result.declaredTotal, 22);
  assert.equal(result.calculatedTotal, 22);
  assert.equal(result.errors.length, 0);
  assert.deepEqual(Array.from(result.rows.filter((row) => row.groupId === "group-6"), (row) => row.workload), [0.34, 0.33, 0.33]);
  assert.equal(result.rows.at(-1).dueDate, "2026-09-30");
  assert.equal(result.rows.at(-1).workload, 2);
  assert.match(result.rows[0].objectName, /^9\/1（S2）1人天/);
  assert.equal(result.rows[6].inheritedDate, true);
});

test("八月之前的完整样式兼容标题行、续行、范围和缺失等级", () => {
  const input = `8/5（S2）1人天
【商业化】竹庭清赏活动-联调
【商业化】三丽鸥正式资源替换
8/10-8/13（S2）4人天【商业化】三丽鸥玩法拼接
6/29-6/30 2人天
（S2）【商业化】泉渊背景制作
（S1）【运营活动】赐福活动还原
共计7人天任务`;
  const result = core.parseDailyReport(input, { year: 2026 });
  assert.equal(result.rows.length, 5);
  assert.deepEqual(Array.from(result.rows.slice(0, 2), (row) => row.workload), [0.5, 0.5]);
  assert.equal(result.rows[2].dueDate, "2026-08-13");
  assert.equal(result.rows[2].workload, 4);
  assert.equal(result.rows[3].parsedLevel, "S2");
  assert.equal(result.rows[4].parsedLevel, "S1");
  assert.equal(result.calculatedTotal, 7);
  assert.equal(result.errors.length, 0);
});

test("两位数月份、小数人天和跨年范围按结束日期处理", () => {
  const result = core.parseDailyReport(`12/31-1/2（S2）1.5人天【运营活动】跨年任务\n共计1.5人天任务`, { year: 2026 });
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].dueDate, "2027-01-02");
  assert.equal(result.rows[0].workload, 1.5);
  assert.equal(result.errors.length, 0);
});

test("无日期、非法日期、缺失工时和汇总差异会被明确拦截", () => {
  const result = core.parseDailyReport(`孤立任务\n2/30（S2）【商业化】错误任务\n共计1人天任务`, { year: 2026 });
  assert.ok(result.errors.some((issue) => issue.code === "TASK_WITHOUT_DATE"));
  assert.ok(result.errors.some((issue) => issue.code === "INVALID_DATE"));
  assert.ok(result.errors.some((issue) => issue.code === "MISSING_WORKLOAD"));
  assert.ok(result.errors.some((issue) => issue.code === "SUMMARY_MISMATCH"));
});

test("复制内容固定为 12 列且日期适合直接粘贴 Excel 或 WPS", () => {
  const result = core.parseDailyReport(`8/1（S2）1人天【商业化】任务\n共计1人天任务`, { year: 2026 });
  const lines = core.toTsv(result.rows).split("\r\n");
  assert.equal(lines.length, 2);
  assert.equal(lines[0].split("\t").length, 12);
  assert.equal(lines[1].split("\t").length, 12);
  assert.match(lines[1], /2026\/8\/1/);
});

test("人工修改工时后会重新计算并阻断不一致汇总", () => {
  const parsed = core.parseDailyReport(`8/1（S2）1人天【商业化】任务\n共计1人天任务`, { year: 2026 });
  parsed.rows[0].workload = 0.75;
  const validation = core.validateRows(parsed.rows, parsed.declaredTotal);
  assert.equal(validation.calculatedTotal, 0.75);
  assert.equal(validation.difference, -0.25);
  assert.ok(validation.errors.some((issue) => issue.code === "SUMMARY_MISMATCH"));
});

test("Excel 导出保留真实日期、数值、完整表头和八月样本列宽", async () => {
  const parsed = core.parseDailyReport(`8/1（S2）1人天【商业化】任务\n共计1人天任务`, { year: 2026 });
  const payload = { year: 2026, month: 8, producer: "陈月财", rows: JSON.parse(JSON.stringify(parsed.rows)) };
  const { buffer } = await createDailyReportWorkbookBuffer(payload);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const sheet = workbook.getWorksheet("Sheet1");
  assert.deepEqual(sheet.getRow(1).values.slice(1), Array.from(core.HEADERS));
  assert.equal(sheet.getColumn(1).width, 65);
  assert.equal(sheet.properties.defaultRowHeight, 80);
  assert.equal(sheet.getRow(1).height, 80);
  assert.equal(sheet.getRow(2).height, 80);
  assert.equal(sheet.getCell("A1").fill.type, "pattern");
  assert.equal(sheet.getCell("A1").fill.pattern, "none");
  assert.equal(sheet.getCell("A2").value, parsed.rows[0].objectName);
  assert.ok(sheet.getCell("C2").value instanceof Date);
  assert.equal(sheet.getCell("C2").numFmt, "yyyy/m/d");
  assert.equal(sheet.getCell("K2").value, 1);
  assert.equal(sheet.getCell("K2").numFmt, undefined);
  assert.equal(sheet.autoFilter, "A1:L2");
});

test("导出服务只返回文件名并支持取消保存", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "ngr-daily-report-"));
  try {
    const parsed = core.parseDailyReport(`8/1（S2）1人天【商业化】任务\n共计1人天任务`, { year: 2026 });
    const output = path.join(temp, "日报.xlsx");
    const service = new DailyReportExportService({
      getWindow: () => null,
      dialog: { showSaveDialog: async () => ({ canceled: false, filePath: output }) },
    });
    const rows = JSON.parse(JSON.stringify(parsed.rows));
    const result = await service.export({ year: 2026, month: 8, producer: "陈月财", rows });
    assert.deepEqual(result, { canceled: false, fileName: "日报.xlsx", rowCount: 1, totalWorkload: 1 });
    assert.ok((await readFile(output)).length > 1000);
    const canceled = new DailyReportExportService({
      getWindow: () => null,
      dialog: { showSaveDialog: async () => ({ canceled: true }) },
    });
    assert.deepEqual(await canceled.export({ year: 2026, month: 8, producer: "陈月财", rows }), { canceled: true });
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
