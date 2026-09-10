import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { _electron as electron } from "playwright";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const appEntry = path.join(projectRoot, "desktop", "main", "index.mjs");
const defaultTargets = ["figma-rest", "openai-api", "baidu-translate", "aliyun-sts", "tencent-sts", "github-api", "huggingface"];
const targetIds = String(process.env.NGR_DIAGNOSTICS_TARGETS || "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const selectedTargets = targetIds.length ? targetIds : defaultTargets;
const routeMode = ["system", "direct", "compare"].includes(process.env.NGR_DIAGNOSTICS_ROUTE)
  ? process.env.NGR_DIAGNOSTICS_ROUTE
  : "system";

fs.mkdirSync(path.join(projectRoot, ".tmp"), { recursive: true });
const runRoot = fs.mkdtempSync(path.join(projectRoot, ".tmp", "verify-network-diagnostics-"));
const electronApp = await electron.launch({
  args: [appEntry],
  cwd: projectRoot,
  env: {
    ...process.env,
    APPDATA: path.join(runRoot, "Roaming"),
    LOCALAPPDATA: path.join(runRoot, "Local"),
    NGR_E2E_USER_DATA: path.join(runRoot, "UserData"),
    ELECTRON_ENABLE_LOGGING: "0",
  },
});

try {
  const window = await electronApp.firstWindow();
  await window.waitForLoadState("domcontentloaded");
  await window.waitForFunction(() => Boolean(window.ngrDesktop?.diagnostics?.listCatalog));
  const report = await window.evaluate(async ({ ids, mode }) => {
    const catalog = await window.ngrDesktop.diagnostics.listCatalog();
    const available = new Set(catalog.targets.map((target) => target.id));
    const targetIds = ids.filter((id) => available.has(id));
    const requestId = `manual_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 12)}`;
    const run = await window.ngrDesktop.diagnostics.run({ requestId, targetIds, routeMode: mode });
    return { online: catalog.online, run };
  }, { ids: selectedTargets, mode: routeMode });
  assert.ok(report.run.results.length > 0, "未返回任何诊断结果");
  const rows = report.run.results.map((result) => ({
    service: result.targetName,
    route: result.route,
    result: result.resultCode,
    http: result.status ?? "-",
    latencyMs: result.latencyMs ?? "-",
  }));
  console.log(`系统在线状态：${report.online ? "在线" : "离线"}`);
  console.table(rows);
} finally {
  await electronApp.close();
  fs.rmSync(runRoot, { recursive: true, force: true });
}
