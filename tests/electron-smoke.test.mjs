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
    await window.waitForFunction((version) => (
      [...document.querySelectorAll("[data-app-version]")]
        .every((node) => node.textContent === `V${version}`)
    ), environment.version);
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
      "externalApps",
      "files",
      "localImageSearch",
      "network",
      "offlineTranslation",
      "providers",
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
    assert.equal(await window.locator("#feedbackFormLink").isVisible(), true);
    assert.match(await window.locator("#feedbackFormLink").innerText(), /反馈与建议/);

    await window.locator("#detectEntry").click();
    await window.waitForFunction(() => document.querySelector("#detectView")?.classList.contains("active"));
    await window.locator("#detectionSingleInput").setInputFiles([
      {
        name: "valid.png",
        mimeType: "image/png",
        buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAACXBIWXMAAAPoAAAD6AG1e1JrAAAARUlEQVRYhe3XsREAMAhC0czAmEzh5maLpHmFvXcifE6m+3OOBeIEQ4T1hsuIwopHGFUcLyAJJBtQWli+iklUs1FO+1wHFywT7GqIQKHAAAAAAElFTkSuQmCC", "base64"),
      },
      {
        name: "wrong.jpg",
        mimeType: "image/jpeg",
        buffer: Buffer.from("/9j/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCAAgACADASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAT/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFgEBAQEAAAAAAAAAAAAAAAAAAAQH/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAwDAQACEQMRAD8AiAQNRAAAAAAf/9k=", "base64"),
      },
      {
        name: "disguised.png",
        mimeType: "image/png",
        buffer: Buffer.from("/9j/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCAAgACADASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAT/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFgEBAQEAAAAAAAAAAAAAAAAAAAQH/8QAFBEBAAAAAAAAAAAAAAAAAAAAAAP/aAAwDAQACEQMRAD8AiAQNRAAAAAAf/9k=", "base64"),
      },
    ]);
    await window.waitForFunction(() => document.querySelector("#detectionCount")?.textContent?.includes("3 张 / 2 张问题"));
    const validDetectionRow = window.locator(".detection-item", { hasText: "valid.png" });
    const wrongDetectionRow = window.locator(".detection-item", { hasText: "wrong.jpg" });
    const disguisedDetectionRow = window.locator(".detection-item", { hasText: "disguised.png" });
    assert.match(await validDetectionRow.getAttribute("class"), /\bpassed\b/);
    assert.match(await wrongDetectionRow.innerText(), /NGR只允许png格式，不允许其他格式/);
    assert.match(await disguisedDetectionRow.innerText(), /检测到 JPEG/);
    await window.locator("#detectionModeSelect").selectOption("planner");
    assert.match(await wrongDetectionRow.innerText(), /NGR只允许png格式，不允许其他格式/);
    await window.locator("#backButton").click();
    await window.waitForFunction(() => document.querySelector("#homeView")?.classList.contains("active"));

    await window.locator("#workEntry").click();
    await window.waitForFunction(() => document.querySelector("#workView")?.classList.contains("active"));
    assert.equal(await window.locator("#feedbackFormLink").isHidden(), true);
    assert.equal(await window.locator("#workProjectName").inputValue(), "");
    assert.match(await window.locator(".toolbar-download-action").innerText(), /下载命名完成的图片/);
    await window.locator("#externalAppMenu").waitFor({ state: "visible" });
    assert.match(await window.locator("#externalAppPrimaryLabel").innerText(), /ArtHub/);
    await window.evaluate(() => {
      const image = new File(
        ['<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" fill="#0f766e"/></svg>'],
        "folder-drop-smoke.svg",
        { type: "image/svg+xml", lastModified: 1 },
      );
      const rootDirectory = {
        kind: "directory",
        name: "smoke-folder",
        async *values() {
          yield { kind: "file", name: image.name, getFile: async () => image };
        },
      };
      const dropEvent = new Event("drop", { bubbles: true, cancelable: true });
      Object.defineProperty(dropEvent, "dataTransfer", {
        value: {
          items: [{
            kind: "file",
            getAsFileSystemHandle: () => Promise.resolve(rootDirectory),
            webkitGetAsEntry: () => null,
            getAsFile: () => null,
          }],
          files: [],
        },
      });
      document.querySelector("#uploadDropZone").dispatchEvent(dropEvent);
    });
    await window.waitForFunction(() => document.querySelector("#assetList")?.textContent?.includes("folder-drop-smoke"));
    assert.match(await window.locator("#fileCount").innerText(), /1 张/);
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
    assert.ok(localSearch.exposedMethods.includes("listAssetFolders"));
    assert.ok(localSearch.exposedMethods.includes("listAssets"));
    assert.equal(await window.locator("#localSearchContentTitle").innerText(), "素材库");
    assert.equal(await window.locator("#localSearchBrowser").isVisible(), true);
    assert.equal(await window.locator("#localSearchSearchSurface").isHidden(), true);
    assert.equal(await window.locator("#localSearchQuickLibrarySelect").isDisabled(), true);
    assert.match(await window.locator("#localSearchAssetEmpty").innerText(), /尚未选择图库|尚未建立素材目录/);
    if (await window.locator("#localSearchGuideOverlay").isVisible()) {
      await window.locator("#localSearchGuideStart").click();
    }
    await window.locator("#rulesEntry").click();
    await window.waitForFunction(() => document.querySelector("#localImageSearchSettingsView")?.classList.contains("active"));
    await window.locator("#localSearchManageModels").click();
    await window.locator("#localSearchModelManagerOverlay:not(.hidden)").waitFor();
    assert.equal(await window.locator("#localSearchManagedModels .local-search-managed-model").count(), 2);
    const managedModelText = await window.locator("#localSearchManagedModels").innerText();
    assert.match(managedModelText, /稳定 GPU 版/);
    assert.match(managedModelText, /旧版兼容/);
    assert.match(managedModelText, /内置|已认证/);
    await window.locator("#localSearchCustomImportStart").click();
    await window.locator("#localSearchCustomModelName").fill("E2E 离线向量模型");
    await window.locator("#localSearchCustomModelType").selectOption("image-text");
    assert.equal(await window.locator("#localSearchCustomTextFields").isVisible(), true);
    await window.locator("#localSearchCustomPixelType").selectOption("uint8");
    assert.equal(await window.locator("#localSearchCustomScale").inputValue(), "1");
    assert.deepEqual(await Promise.all([
      "#localSearchCustomMeanR", "#localSearchCustomMeanG", "#localSearchCustomMeanB",
    ].map((selector) => window.locator(selector).inputValue())), ["0", "0", "0"]);
    await window.locator("#localSearchCustomPixelType").selectOption("float32");
    assert.equal(await window.locator("#localSearchCustomScale").inputValue(), "0.003921568627451");
    await window.locator("#localSearchCancelModelWizard").click();
    await window.locator("#localSearchModelManagerClose").click();
    await window.locator("#backButton").click();
    await window.waitForFunction(() => document.querySelector("#localImageSearchView")?.classList.contains("active"));
    assert.equal(await window.locator("#localSearchClearImageQuery").isDisabled(), true);
    assert.equal(await window.locator("#localSearchClearTextQuery").isDisabled(), true);
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
    await window.locator('#generalSettingsView [data-settings-view="apiSettings"]').click();
    await window.waitForFunction(() => document.querySelector("#apiSettingsView")?.classList.contains("active"));
    const apiPlacement = await window.evaluate(() => ({
      aiInApi: document.querySelector("#apiSettingsView")?.contains(document.querySelector(".ai-panel")),
      translationInApi: document.querySelector("#apiSettingsView")?.contains(document.querySelector("#translatorSettings")),
      aiInNaming: document.querySelector("#rulesView")?.contains(document.querySelector(".ai-panel")),
      translationInFloatingPanel: document.querySelector("#translatorPanel")?.contains(document.querySelector("#translatorSettings")),
      translatorGearExists: Boolean(document.querySelector("#translatorSettingsToggle")),
      activeTab: document.querySelector('#apiSettingsView [data-settings-view="apiSettings"]')?.getAttribute("aria-current"),
    }));
    assert.deepEqual(apiPlacement, {
      aiInApi: true,
      translationInApi: true,
      aiInNaming: false,
      translationInFloatingPanel: false,
      translatorGearExists: false,
      activeTab: "page",
    });
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
