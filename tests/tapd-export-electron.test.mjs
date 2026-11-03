import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { _electron as electron } from "playwright";
import ExcelJS from "exceljs";
import sharp from "sharp";
import { LocalStore } from "../desktop/services/tapd-report-runtime.mjs";
import { weekPeriod } from "../integrations/tapd-report/src/shared/report.ts";

test("源码报表界面可勾选导出含图片 Excel，并明确显示快照时间和内置模块身份", { timeout: 60_000 }, async () => {
  const root = path.resolve(import.meta.dirname, "..");
  await fs.mkdir(path.join(root, ".tmp"), { recursive: true });
  const runRoot = await fs.mkdtemp(path.join(root, ".tmp", "tapd-export-e2e-"));
  const userData = path.join(runRoot, "UserData");
  const period = weekPeriod();
  const mediaRoot = path.join(runRoot, `TAPD-Bug图片--${period.start}至${period.end}`);
  const mediaFolder = path.join(mediaRoot, "101-图片导出验收");
  await fs.mkdir(mediaFolder, { recursive: true });
  await sharp({ create: { width: 240, height: 160, channels: 3, background: "#267ed8" } }).png()
    .toFile(path.join(mediaFolder, "01-描述-业务截图.png"));
  const store = await LocalStore.open(path.join(userData, "tapd-report"));
  try {
    store.capture({
      id: "export-fixture", capturedAt: "2026-10-13T17:00:37.968Z", account: "测试用户",
      scope: { kind: "range", period }, total: 1, loaded: 1, complete: true, issues: [], groups: [],
      items: [{ key: "1:Bug:101", id: "101", shortId: "101", workspaceId: "1", workspaceName: "测试项目",
        type: "Bug", typeLabel: "Bug", title: "【S2】【运营活动】图片导出验收", status: "已解决", owner: "测试用户",
        processedAt: `${period.start} 10:00:00`, url: "https://tapd.tencent.com/tapd_fe/1/bug/detail/101" }],
    });
    store.recordExport(mediaRoot, "bug-images", false);
  } finally { store.close(); }
  const app = await electron.launch({ args: [path.join(root, "desktop/main/index.mjs")], cwd: root,
    env: { ...process.env, NGR_E2E_USER_DATA: userData, ELECTRON_ENABLE_LOGGING: "0" } });
  try {
    const main = await app.firstWindow();
    await main.waitForFunction(() => Boolean(window.ngrDesktop?.tapdReport));
    const nextWindow = app.waitForEvent("window");
    await main.locator("#moreFeaturesEntry").click();
    await main.locator("#tapdReportEntry").click();
    const report = await nextWindow;
    await report.getByRole("checkbox", { name: "月报附带 Bug 图片", exact: true }).check();
    await report.getByRole("checkbox", { name: "导出草稿", exact: true }).check();
    const outputPath = path.join(runRoot, "with-images.xlsx");
    await app.evaluate(({ dialog }, filePath) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath });
    }, outputPath);
    await report.getByRole("button", { name: "下载月报 Excel", exact: true }).click();
    await report.getByText("月报已保存，含 Bug 图片附件", { exact: true }).waitFor();
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(outputPath);
    const images = workbook.getWorksheet("Bug图片附件");
    assert.ok(images);
    assert.equal(images.getImages().length, 1);
    assert.equal(images.getRow(2).getCell(1).value.text, "#101");
    assert.match(await report.locator("footer").innerText(), /TAPD 报表.*内置模块/);
    assert.match(await report.locator(".capture-snapshot").innerText(), /2026.10.14.*01:00/);
  } finally { await app.close(); }
});
