import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { _electron as electron } from "playwright";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const appEntry = path.join(projectRoot, "desktop", "main", "index.mjs");

async function waitForMaximizedWindow(electronApp, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  let stableSince = 0;
  while (Date.now() < deadline) {
    const ready = await electronApp.evaluate(({ BrowserWindow }) => {
      const mainWindow = BrowserWindow.getAllWindows()[0];
      return Boolean(mainWindow?.isVisible() && mainWindow.isMaximized());
    });
    if (ready) {
      stableSince ||= Date.now();
      if (Date.now() - stableSince >= 750) return;
    } else {
      stableSince = 0;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.fail("main window did not remain visible and maximized");
}

test("Electron development app boots with the Dev identity and an isolated renderer", { timeout: 45_000 }, async () => {
  fs.mkdirSync(path.join(projectRoot, ".tmp"), { recursive: true });
  const runRoot = fs.mkdtempSync(path.join(projectRoot, ".tmp", "electron-smoke-"));
  const appData = path.join(runRoot, "Roaming");
  const localAppData = path.join(runRoot, "Local");
  fs.mkdirSync(appData, { recursive: true });
  fs.mkdirSync(localAppData, { recursive: true });

  const electronApp = await electron.launch({
    args: [appEntry],
    cwd: projectRoot,
    env: {
      ...process.env,
      APPDATA: appData,
      LOCALAPPDATA: localAppData,
      NGR_E2E_USER_DATA: path.join(runRoot, "UserData"),
      ELECTRON_ENABLE_LOGGING: "0",
    },
  });

  try {
    const window = await electronApp.firstWindow();
    await window.waitForLoadState("domcontentloaded");
    await window.waitForFunction(() => Boolean(window.ngrDesktop?.environment?.getInfo));

    const environment = await window.evaluate(() => window.ngrDesktop.environment.getInfo());
    assert.equal(environment.platform, "win32");
    assert.equal(environment.edition, "dev");
    assert.equal(environment.distribution, "development");
    await waitForMaximizedWindow(electronApp);

    const renderer = await window.evaluate(() => ({
      url: location.href,
      title: document.title,
      nodeRequireType: typeof window.require,
      nodeProcessType: typeof window.process,
      bridgeNamespaces: Object.keys(window.ngrDesktop).sort(),
      editionBadge: document.querySelector("#editionBadge")?.textContent,
    }));

    assert.match(renderer.url, /^ngr-assetpilot:\/\/app\//);
    assert.match(renderer.title, /NGR AssetPilot Dev/);
    assert.equal(renderer.nodeRequireType, "undefined");
    assert.equal(renderer.nodeProcessType, "undefined");
    assert.match(renderer.editionBadge, /DEV 开发版/);
    assert.deepEqual(renderer.bridgeNamespaces, [
      "app",
      "backup",
      "credentials",
      "environment",
      "files",
      "localImageSearch",
      "network",
      "shell",
      "updater",
    ]);

    const homeLayout = await window.evaluate(() => {
      const work = document.querySelector("#workEntry").getBoundingClientRect();
      const detect = document.querySelector("#detectEntry").getBoundingClientRect();
      const local = document.querySelector("#localImageSearchEntry").getBoundingClientRect();
      return {
        visible: [work, detect, local].every((rect) => rect.width > 0 && rect.height > 0),
      };
    });
    assert.equal(homeLayout.visible, true);

    await window.locator("#workEntry").click();
    await window.waitForFunction(() => document.querySelector("#workView")?.classList.contains("active"));
    assert.equal(await window.locator("#workProjectName").inputValue(), "");
    assert.match(await window.locator(".toolbar-download-action").innerText(), /下载命名完成的图片/);
    await window.locator("#workBasePrefix .prefix-picker-trigger").click();
    assert.equal(await window.locator("#workBasePrefix .prefix-picker-edit").innerText(), "＋ 新建/编辑前缀");
    await window.locator("#workBasePrefix .prefix-picker-edit").click();
    await window.locator("#prefixLibraryNewValue").fill("T_UI_TestCustom");
    await window.locator("#prefixLibraryAdd").click();
    await window.locator("#prefixLibraryClose").click();
    await window.locator("#rulesEntry").click();
    await window.waitForFunction(() => document.querySelector("#rulesView")?.classList.contains("active"));
    await window.locator("#backButton").click();
    await window.waitForFunction(() => document.querySelector("#workView")?.classList.contains("active"));
    await window.locator("#backButton").click();
    await window.waitForFunction(() => document.querySelector("#homeView")?.classList.contains("active"));

    const placement = await window.evaluate(() => ({
      homeContainsMigration: document.querySelector("#homeView")?.contains(document.querySelector("#workspaceMigrationCard")),
      settingsContainsMigration: document.querySelector("#generalSettingsView")?.contains(document.querySelector("#workspaceMigrationCard")),
    }));
    assert.equal(placement.homeContainsMigration, false);
    assert.equal(placement.settingsContainsMigration, true);
    await window.locator("#localImageSearchEntry").click();
    await window.waitForFunction(() => (
      document.querySelector("#localImageSearchView")?.classList.contains("active")
      && document.querySelector("#localSearchRuntimeStatus")?.textContent?.includes("Windows 桌面版")
    ));
    const localSearch = await window.evaluate(async () => ({
      model: await window.ngrDesktop.localImageSearch.getModelStatus(),
      libraries: await window.ngrDesktop.localImageSearch.listLibraries(),
      exposedMethods: Object.keys(window.ngrDesktop.localImageSearch).sort(),
    }));
    assert.equal(localSearch.model.ready, false);
    assert.equal(localSearch.model.state, "missing");
    assert.deepEqual(localSearch.libraries, []);
    assert.ok(localSearch.exposedMethods.includes("searchByImage"));
    assert.ok(localSearch.exposedMethods.includes("revealResult"));
    await window.locator("#rulesEntry").click();
    await window.waitForFunction(() => document.querySelector("#localImageSearchSettingsView")?.classList.contains("active"));
    await window.locator("#backButton").click();
    await window.waitForFunction(() => document.querySelector("#localImageSearchView")?.classList.contains("active"));
    await window.locator("#backButton").click();
    await window.locator("#rulesEntry").click();
    await window.waitForFunction(() => (
      document.querySelector("#generalSettingsView")?.classList.contains("active")
      && Boolean(document.querySelector("#workspaceMigrationCard")?.getClientRects().length)
    ));
  } finally {
    await electronApp.close();
    fs.rmSync(runRoot, { recursive: true, force: true });
  }
});

test("Electron test app boots with the Test identity and a visible badge", { timeout: 30_000 }, async () => {
  const runRoot = fs.mkdtempSync(path.join(projectRoot, ".tmp", "electron-test-smoke-"));
  const electronApp = await electron.launch({
    args: [appEntry, "--ngr-edition=test"],
    cwd: projectRoot,
    env: {
      ...process.env,
      NGR_E2E_USER_DATA: path.join(runRoot, "UserData"),
      ELECTRON_ENABLE_LOGGING: "0",
    },
  });
  try {
    const window = await electronApp.firstWindow();
    await window.waitForFunction(() => document.querySelector("#editionBadge")?.textContent?.includes("TEST"));
    const state = await window.evaluate(async () => ({
      info: await window.ngrDesktop.environment.getInfo(),
      title: document.title,
      badge: document.querySelector("#editionBadge")?.textContent,
    }));
    assert.equal(state.info.edition, "test");
    assert.match(state.title, /NGR AssetPilot Test/);
    assert.match(state.badge, /TEST 测试版/);
  } finally {
    await electronApp.close();
    fs.rmSync(runRoot, { recursive: true, force: true });
  }
});
