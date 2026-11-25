import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { _electron, chromium } from "playwright-core";
import sharp from "sharp";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const [packagedExe, browserExe = process.env.NGR_TEST_BROWSER_EXE] = process.argv.slice(2);
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "ngr-local-tools-e2e-"));
const input = path.join(scratch, "images");
const output = path.join(scratch, "copies");
await fs.mkdir(input);
await fs.mkdir(output);
await sharp({ create: { width: 64, height: 64, channels: 3, background: "#057d87" } })
  .png().toFile(path.join(input, "icon_button.png"));
await sharp({ create: { width: 63, height: 63, channels: 3, background: "#c12a60" } })
  .jpeg().toFile(path.join(input, "fake.jpg"));
const original = await fs.readFile(path.join(input, "icon_button.png"));
const instance = await _electron.launch({
  executablePath: path.resolve(packagedExe || "node_modules/electron/dist/electron.exe"),
  args: packagedExe ? [] : [".", "--ngr-edition=test"],
  env: { ...process.env, NGR_E2E_USER_DATA: path.join(scratch, "profile") },
});
let browser;
let client;
try {
  const desktop = await instance.firstWindow();
  await instance.evaluate(({ dialog, shell, clipboard }, locations) => {
    globalThis.ngrTestApprove = false;
    globalThis.ngrTestOpenLink = "";
    globalThis.ngrTestClipboard = "";
    shell.openExternal = async url => { globalThis.ngrTestOpenLink = url; };
    clipboard.writeText = value => { globalThis.ngrTestClipboard = value; };
    dialog.showOpenDialog = async (_window, options) => ({
      canceled: false,
      filePaths: [/导出/.test(options.title) ? locations.output : locations.input],
    });
    dialog.showMessageBox = async (windowOrOptions, options = windowOrOptions) => {
      const cancel = options.cancelId ?? 0;
      const approve = options.buttons.findIndex((_button, index) => index !== cancel);
      return { response: globalThis.ngrTestApprove && approve >= 0 ? approve : cancel };
    };
  }, { input, output });
  const action = (name, details = {}) => desktop.evaluate(
    ([action, extra]) => window.ngrDesktop.localTools.action({ action, ...extra }), [name, details]);
  await desktop.getByRole("button", { name: "MCP 使用说明" }).click();
  await desktop.getByRole("dialog", { name: "连接 AI 或打开本机网页" }).waitFor();
  await desktop.getByRole("checkbox", { name: "启用 MCP" }).click();
  await desktop.waitForFunction(() => document.getElementById("localToolsMcp").checked);
  await desktop.getByRole("checkbox", { name: "启用本机网页" }).click();
  await desktop.waitForFunction(() => document.getElementById("localToolsWeb").checked);
  await desktop.getByRole("button", { name: "复制令牌" }).click();
  const token = await instance.evaluate(() => globalThis.ngrTestClipboard);
  const { mcpUrl } = await action("status");
  assert.ok(token);

  client = new Client({ name: "ngr-local-e2e", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(mcpUrl), {
    requestInit: { headers: { Authorization: "Bearer " + token } },
  }));
  const names = (await client.listTools()).tools.map(tool => tool.name);
  for (const name of ["finder_search", "finder_create", "start_naming", "start_slice_check", "export_named_copies"]) {
    assert.ok(names.includes(name), "missing tool: " + name);
  }
  const call = async (name, args = {}) => {
    const result = await client.callTool({ name, arguments: args });
    assert.equal(result.isError, undefined, JSON.stringify(result.content));
    return result.structuredContent;
  };
  const refused = await client.callTool({ name: "finder_create", arguments: { kind: "group", name: "拒绝写入样本" } });
  const refusedSearch = await call("finder_search", { query: "拒绝写入样本" });
  assert.equal(refused.structuredContent?.status, "cancelled");
  assert.equal(refusedSearch.total, 0);
  await instance.evaluate(() => { globalThis.ngrTestApprove = true; });
  await call("finder_create", { kind: "group", name: "浏览器验收组" });

  await desktop.getByRole("button", { name: "在浏览器打开" }).click();
  const link = await instance.evaluate(() => globalThis.ngrTestOpenLink);
  assert.match(link, /^http:\/\/127\.0\.0\.1:5199\/#ticket=/);
  browser = await chromium.launch({ executablePath: browserExe, headless: true,
    args: ["--disable-background-networking"] });
  const page = await browser.newPage();
  await page.goto(link);
  await page.getByRole("navigation", { name: "功能导航" }).waitFor();
  await page.getByRole("link", { name: "快速找界面" }).click();
  const finder = page.frameLocator("#finder-frame");
  await finder.getByText("浏览器验收组", { exact: true }).first().waitFor();
  const rowId = await finder.getByRole("row").filter({ hasText: "浏览器验收组" }).getAttribute("data-folder-id");
  assert.match(rowId, /^[a-z0-9_-]+$/i);
  const entry = finder.locator(`tr[data-folder-id="${rowId}"]`);
  await entry.locator('td[data-column="name"] .dossier-cell-value').click();
  await entry.getByRole("textbox", { name: "编辑名称", exact: true }).fill("网页保存后的组");
  await entry.getByRole("button", { name: "保存", exact: true }).click();
  await finder.getByText("网页保存后的组", { exact: true }).first().waitFor();
  assert.match(JSON.stringify(await call("finder_search", { query: "网页保存后的组" })), /网页保存后的组/);

  await page.getByRole("link", { name: "UI 切图检测" }).click();
  await page.getByRole("button", { name: "选择文件夹" }).click();
  await page.getByText("icon_button.png", { exact: true }).first().waitFor();
  const sources = await call("list_sources");
  assert.equal(sources.sources.length, 1);
  const sourceId = sources.sources[0].sourceId;
  const outside = await client.callTool({
    name: "start_slice_check", arguments: { sourceId, relativePaths: ["../private.png"] },
  });
  assert.equal(outside.isError, true);
  let sliceJob = await call("start_slice_check", { sourceId });
  const waitJob = async job => {
    for (let step = 0; step < 90; step++) {
      const result = await call("get_asset_job", { jobId: job.jobId });
      if (["completed", "failed", "cancelled"].includes(result.status)) {
        assert.equal(result.status, "completed", JSON.stringify(result));
        return result;
      }
      await delay(350);
    }
    assert.fail("local asset job timed out");
  };
  sliceJob = await waitJob(sliceJob);
  assert.equal(sliceJob.results.find(file => file.relativePath === "icon_button.png").format, "PNG");
  assert.ok(sliceJob.results.find(file => file.relativePath === "fake.jpg").issues.length);
  await page.locator("#select-all").check();
  await page.locator("#start-job").click();
  await page.locator("#job-status").filter({ hasText: /完成/ }).waitFor({ timeout: 30_000 });

  await page.getByRole("link", { name: "AI 自动命名" }).click();
  await page.locator("#naming-mode").selectOption("local");
  const file = page.getByText("icon_button.png", { exact: true }).first();
  await file.waitFor();
  await page.locator("#file-list").getByRole("checkbox", { name: /icon_button/ }).check();
  await page.locator("#start-job").click();
  const exportButton = page.getByRole("button", { name: "导出命名副本" });
  await exportButton.waitFor({ timeout: 30_000 });
  await exportButton.click();
  await page.locator("#export-status").filter({ hasText: /已导出|导出完成/ }).waitFor();
  const copyDirs = await fs.readdir(output);
  assert.ok(copyDirs.length);
  assert.deepEqual(await fs.readFile(path.join(input, "icon_button.png")), original);

  await action("set", { feature: "web", enabled: false });
  assert.equal((await fetch("http://127.0.0.1:5199/api/session")).status, 404);
  await action("rotateToken");
  await assert.rejects(client.listTools());
  console.log(JSON.stringify({ packaged: Boolean(packagedExe), browser: true, mcpTools: names,
    finderEditing: true, pngDetection: true, namingExport: true, sourcePreserved: true }));
} finally {
  await client?.close().catch(() => {});
  await browser?.close().catch(() => {});
  await instance.close().catch(() => {});
}
