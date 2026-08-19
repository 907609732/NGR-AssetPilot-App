import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runRoot = path.join(projectRoot, ".tmp", `packaged-smoke-${Date.now()}`);
const targets = [
  { edition: "dev", product: "NGR AssetPilot Dev", executable: "NGR AssetPilot Dev.exe", artifact: "NGR-AssetPilot-Dev-3.0.0-portable-x64.exe", badge: "DEV 开发版" },
  { edition: "test", product: "NGR AssetPilot Test", executable: "NGR AssetPilot Test.exe", artifact: "NGR-AssetPilot-Test-3.0.0-portable-x64.exe", badge: "TEST 测试版" },
];

async function verifyTarget(target) {
  const executablePath = path.join(projectRoot, "artifacts", target.edition, "win-unpacked", target.executable);
  const userDataPath = path.join(runRoot, target.edition, "UserData");
  assert.equal(fs.existsSync(executablePath), true, `缺少 ${target.product} 可执行文件`);
  fs.mkdirSync(userDataPath, { recursive: true });
  const electronApp = await electron.launch({
    executablePath,
    env: { ...process.env, NGR_E2E_USER_DATA: userDataPath, ELECTRON_ENABLE_LOGGING: "0" },
    timeout: 60_000,
  });
  try {
    const appInfo = await electronApp.evaluate(({ app }) => ({ name: app.getName(), userData: app.getPath("userData") }));
    assert.equal(appInfo.name, target.product);
    assert.equal(path.resolve(appInfo.userData), path.resolve(userDataPath));
    const window = await electronApp.firstWindow({ timeout: 60_000 });
    await window.waitForFunction(() => document.querySelector("#editionBadge")?.textContent);
    const state = await window.evaluate(async () => ({
      info: await window.ngrDesktop.environment.getInfo(),
      credentials: await window.ngrDesktop.credentials.getStatus(),
      model: await window.ngrDesktop.localImageSearch.getModelStatus(),
      badge: document.querySelector("#editionBadge")?.textContent,
      title: document.title,
      nodeRequireType: typeof window.require,
    }));
    assert.equal(state.info.edition, target.edition);
    assert.equal(state.info.distribution, "installer");
    assert.match(state.badge, new RegExp(target.badge));
    assert.match(state.title, new RegExp(target.product));
    assert.equal(state.nodeRequireType, "undefined");
    assert.equal(state.credentials.available, true);
    assert.equal(state.credentials.configured, false);
    assert.equal(typeof state.model.ready, "boolean");

    const portablePath = path.join(projectRoot, "artifacts", target.edition, target.artifact);
    const portableStats = fs.statSync(portablePath);
    assert.ok(portableStats.size > 10 * 1024 * 1024, `${target.product} 便携包大小异常`);
    process.stdout.write(`${JSON.stringify({ edition: target.edition, product: target.product, packagedSmoke: true, portableBytes: portableStats.size })}\n`);
  } finally {
    await electronApp.close();
  }
}

try {
  for (const target of targets) await verifyTarget(target);
} finally {
  fs.rmSync(runRoot, { recursive: true, force: true });
}

process.stdout.write("PACKAGED_SMOKE_OK\n");
