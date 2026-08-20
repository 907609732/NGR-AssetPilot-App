import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runRoot = path.join(projectRoot, ".tmp", `packaged-smoke-${Date.now()}`);
const packageJson = JSON.parse(fs.readFileSync(path.join(projectRoot, "package.json"), "utf8"));
const allTargets = [
  { edition: "prod", product: "NGR AssetPilot", executable: "NGR AssetPilot.exe", artifact: null, badge: null },
  { edition: "dev", product: "NGR AssetPilot Dev", executable: "NGR AssetPilot Dev.exe", artifact: `NGR-AssetPilot-Dev-${packageJson.version}-portable-x64.exe`, badge: "DEV 开发版" },
  { edition: "test", product: "NGR AssetPilot Test", executable: "NGR AssetPilot Test.exe", artifact: `NGR-AssetPilot-Test-${packageJson.version}-portable-x64.exe`, badge: "TEST 测试版" },
];
const requestedEdition = process.argv[2];
const targets = requestedEdition ? allTargets.filter(({ edition }) => edition === requestedEdition) : allTargets;
assert.ok(targets.length > 0, "请指定 prod、dev 或 test");

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
    // Wait for the renderer before evaluating the main process. On fresh
    // Windows runners the packaged app can still be completing startup, and
    // an immediate main-process evaluation may lose its Playwright promise.
    const window = await electronApp.firstWindow({ timeout: 60_000 });
    const appInfo = await electronApp.evaluate(({ app }) => ({ name: app.getName(), userData: app.getPath("userData") }));
    assert.equal(appInfo.name, target.product);
    assert.equal(path.resolve(appInfo.userData), path.resolve(userDataPath));
    await window.waitForFunction(() => Boolean(window.ngrDesktop?.environment));
    if (target.badge) {
      await window.waitForFunction(
        (expected) => document.querySelector("#editionBadge")?.textContent?.includes(expected),
        target.badge.split(" ")[0],
      );
    }
    const state = await window.evaluate(async () => ({
      info: await window.ngrDesktop.environment.getInfo(),
      credentials: await window.ngrDesktop.credentials.getStatus(),
      model: await window.ngrDesktop.localImageSearch.getModelStatus(),
      offlineTranslationStatus: await window.ngrDesktop.offlineTranslation.getStatus(),
      offlineTranslationResult: await window.ngrDesktop.offlineTranslation.translate({
        text: "下载按钮",
        from: "zh",
        to: "en",
      }),
      apiSettingsPlacement: {
        aiInApi: document.querySelector("#apiSettingsView")?.contains(document.querySelector(".ai-panel")),
        translationInApi: document.querySelector("#apiSettingsView")?.contains(document.querySelector("#translatorSettings")),
        translatorGearExists: Boolean(document.querySelector("#translatorSettingsToggle")),
      },
      badge: document.querySelector("#editionBadge")?.textContent,
      badgeHidden: document.querySelector("#editionBadge")?.classList.contains("hidden"),
      appVersionTexts: [...document.querySelectorAll("[data-app-version]")].map((node) => node.textContent),
      title: document.title,
      nodeRequireType: typeof window.require,
    }));
    assert.equal(state.info.edition, target.edition);
    assert.equal(state.info.distribution, "installer");
    assert.equal(state.info.updaterEnabled, target.edition === "prod");
    assert.equal(state.info.updaterChannel, target.edition === "prod" ? "latest" : target.edition);
    assert.ok(state.appVersionTexts.length > 0);
    assert.deepEqual([...new Set(state.appVersionTexts)], [`V${packageJson.version}`]);
    if (target.badge) {
      assert.match(state.badge, new RegExp(target.badge));
      assert.equal(state.badgeHidden, false);
    } else {
      assert.equal(state.badge, "");
      assert.equal(state.badgeHidden, true);
    }
    assert.match(state.title, new RegExp(target.product));
    assert.equal(state.nodeRequireType, "undefined");
    assert.equal(state.credentials.available, true);
    assert.equal(state.credentials.configured, false);
    assert.equal(typeof state.model.ready, "boolean");
    assert.equal(state.offlineTranslationStatus.ready, true);
    assert.equal(state.offlineTranslationStatus.missingFile, null);
    assert.equal(state.offlineTranslationStatus.totalBytes, 122855036);
    assert.match(state.offlineTranslationResult.text, /Download/i);
    assert.deepEqual(state.apiSettingsPlacement, {
      aiInApi: true,
      translationInApi: true,
      translatorGearExists: false,
    });

    let portableBytes = null;
    if (target.artifact) {
      const portablePath = path.join(projectRoot, "artifacts", target.edition, target.artifact);
      const portableStats = fs.statSync(portablePath);
      assert.ok(portableStats.size > 10 * 1024 * 1024, `${target.product} 便携包大小异常`);
      portableBytes = portableStats.size;
    }

    if (target.edition === "prod") {
      const resourcesPath = path.join(projectRoot, "artifacts", "prod", "win-unpacked", "resources");
      const appUpdate = fs.readFileSync(path.join(resourcesPath, "app-update.yml"), "utf8");
      assert.match(appUpdate, /^provider:\s*github$/m);
      assert.match(appUpdate, /^owner:\s*['\"]?907609732['\"]?$/m);
      assert.match(appUpdate, /^repo:\s*NGR-AssetPilot-App$/m);
      assert.match(appUpdate, /^channel:\s*latest$/m);

      const latestPath = path.join(projectRoot, "artifacts", "prod", "latest.yml");
      const latest = fs.readFileSync(latestPath, "utf8");
      const installerName = `NGR-AssetPilot-${packageJson.version}-Setup-x64.exe`;
      const installerPath = path.join(projectRoot, "artifacts", "prod", installerName);
      const installerSize = fs.statSync(installerPath).size;
      const installerSha512 = crypto.createHash("sha512").update(fs.readFileSync(installerPath)).digest("base64");
      assert.match(latest, new RegExp(`^version:\\s*${packageJson.version.replaceAll(".", "\\.")}$`, "m"));
      assert.match(latest, new RegExp(`^path:\\s*${installerName.replaceAll(".", "\\.")}$`, "m"));
      assert.match(latest, new RegExp(`^\\s*size:\\s*${installerSize}$`, "m"));
      assert.ok(latest.includes(`sha512: ${installerSha512}`));
      assert.equal(fs.existsSync(`${installerPath}.blockmap`), true);
    }
    process.stdout.write(`${JSON.stringify({ edition: target.edition, product: target.product, packagedSmoke: true, portableBytes })}\n`);
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
