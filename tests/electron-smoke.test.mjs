import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { _electron as electron } from "playwright";
import { loadManagedProviderConfig } from "../desktop/services/managed-provider-config.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const appEntry = path.join(projectRoot, "desktop", "main", "index.mjs");
const cloudConfigured = Boolean(await loadManagedProviderConfig(path.join(projectRoot, "build/generated/managed-provider-config.json")));

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
      "autoStart",
      "backup",
      "credentials",
      "dailyReport",
      "diagnostics",
      "environment",
      "externalApps",
      "files",
      "keepAwake",
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
      const dailyReport = document.querySelector("#dailyReportEntry").getBoundingClientRect();
      const home = document.querySelector("#homeView").getBoundingClientRect();
      return {
        visible: [work, detect, local, dailyReport].every((rect) => rect.width > 0 && rect.height > 0),
        localRestored: Math.abs(local.width - work.width) < 2 && Math.abs(local.height - work.height) < 2,
        dailyReportSecondary: dailyReport.width >= 150 && dailyReport.width <= 210 && dailyReport.height >= 40 && dailyReport.height <= 54,
        dailyReportAtBottomCenter: Math.abs((dailyReport.left + dailyReport.width / 2) - (home.left + home.width / 2)) < 2 && home.bottom - dailyReport.bottom <= 30,
      };
    });
    assert.equal(homeLayout.visible, true);
    assert.equal(homeLayout.localRestored, true);
    assert.equal(homeLayout.dailyReportSecondary, true);
    assert.equal(homeLayout.dailyReportAtBottomCenter, true);
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
    await window.locator("#detectionSettingsEntry").click();
    await window.waitForFunction(() => document.querySelector("#detectionSettingsView")?.classList.contains("active"));
    assert.equal(await window.locator('[data-detection-modes="planner"]').isVisible(), true);
    assert.equal(await window.locator('[data-detection-modes="ngr"]').first().isHidden(), true);
    await window.locator("#detectionProfileMode").selectOption("ngr");
    assert.equal(await window.locator('[data-detection-modes="ngr"]').first().isVisible(), true);
    assert.equal(await window.locator('[data-detection-modes="planner"]').isHidden(), true);
    await window.locator("#detectionMinWidth").fill("64");
    await window.locator("#detectionMaxFileSizeMb").fill("2.5");
    await window.locator("#detectionPcEffectWidth").fill("3000");
    await window.locator("#saveDetectionProfile").click();
    await window.locator("#backToDetection").click();
    await window.waitForFunction(() => document.querySelector("#detectView")?.classList.contains("active"));
    assert.match(await validDetectionRow.getAttribute("class"), /\bhas-issue\b/);
    await window.locator("#detectionRulesToggle").click();
    assert.match(await window.locator("#detectionActiveRuleSummary").innerText(), /图集宽高为 2 的倍数/);
    assert.match(await window.locator("#detectionGeneralRuleSummary").innerText(), /最小尺寸 64x1 px/);
    await window.locator("#backButton").click();
    await window.waitForFunction(() => document.querySelector("#homeView")?.classList.contains("active"));

    await window.locator("#dailyReportEntry").click();
    await window.waitForFunction(() => document.querySelector("#dailyReportView")?.classList.contains("active"));
    assert.equal(await window.locator("#dailyReportYear").count(), 0);
    assert.equal(await window.locator("#dailyReportReset").innerText(), "清除所有数据");
    assert.match(await window.locator("#dailyReportReset").getAttribute("class"), /\bdanger-action\b/);
    assert.ok((await window.locator("#dailyReportSource").boundingBox()).height >= 500);
    await window.locator("#dailyReportSource").fill([
      "8/5（S2）1人天",
      "【商业化】竹庭清赏活动-联调",
      "【运营活动】三丽鸥正式资源替换",
      "共计1人天任务",
    ].join("\n"));
    await window.locator("#dailyReportParse").click();
    await window.waitForFunction(() => document.querySelector("#dailyReportVisibleCount")?.textContent === "显示 2 / 2 行");
    assert.deepEqual(await window.locator('#dailyReportTableBody input[data-field="workload"]').evaluateAll((inputs) => inputs.map((input) => input.value)), ["0.5", "0.5"]);
    assert.match(await window.locator("#dailyReportCategorySummary").innerText(), /商业化 1/);
    assert.match(await window.locator("#dailyReportCategorySummary").innerText(), /运营活动 1/);
    assert.equal(await window.locator("#dailyReportCopy").isEnabled(), true);
    assert.equal(await window.locator("#dailyReportExport").isEnabled(), true);
    await window.screenshot({ path: path.join(projectRoot, ".tmp", "daily-report-preview.png"), fullPage: true });
    await window.locator("#dailyReportCategoryFilter").selectOption("商业化");
    await window.waitForFunction(() => document.querySelector("#dailyReportVisibleCount")?.textContent === "显示 1 / 2 行");
    await window.locator('#dailyReportTableBody textarea[data-field="objectName"]').fill("【商业化】竹庭清赏活动-联调修改");
    await window.locator('#dailyReportTableBody textarea[data-field="objectName"]').blur();
    assert.match(await window.locator('#dailyReportTableBody textarea[data-field="objectName"]').inputValue(), /修改$/);
    window.once("dialog", (dialog) => dialog.accept());
    await window.locator("#dailyReportReset").click();
    await window.waitForFunction(() => document.querySelector("#dailyReportVisibleCount")?.textContent === "显示 0 / 0 行");
    assert.equal(await window.locator("#dailyReportSource").inputValue(), "");
    assert.equal(await window.locator("#dailyReportDefaultProducer").inputValue(), "陈月财");
    await window.locator("#backButton").click();
    await window.waitForFunction(() => document.querySelector("#homeView")?.classList.contains("active"));

    await window.locator("#workEntry").click();
    await window.waitForFunction(() => document.querySelector("#workView")?.classList.contains("active"));
    assert.equal(await window.locator("#feedbackFormLink").isHidden(), true);
    assert.equal(await window.locator("#workProjectName").inputValue(), "");
    assert.match(await window.locator(".toolbar-download-action").innerText(), /下载命名完成的图片/);
    assert.deepEqual(await window.locator("#namingModeSelect option").evaluateAll((options) => (
      options.map((option) => option.value)
    )), ["translate:local", "translate:cfc", "translate:baidu", "translate:model", "local", "ai"]);
    assert.equal(await window.locator("#namingModeSelect").inputValue(), cloudConfigured ? "translate:cfc" : "translate:local");
    assert.equal(await window.locator("#translatorProvider").inputValue(), cloudConfigured ? "cfc" : "local");
    assert.equal(await window.locator('#namingModeSelect option[value="translate:cfc"]').evaluate((option) => option.disabled), !cloudConfigured);
    assert.equal(await window.locator('#translatorProvider option[value="cfc"]').evaluate((option) => option.disabled), !cloudConfigured);
    await window.locator(".naming-service-settings-action").click();
    await window.locator("#namingModeSelect").selectOption("translate:baidu");
    await window.waitForFunction(() => document.querySelector("#translatorProvider")?.value === "baidu");
    assert.match(await window.locator("#runSelectedNaming").innerText(), /自有百度翻译/);
    assert.equal(await window.evaluate(() => localStorage.getItem("ngr-ai-autoname-translation-provider-user-selected")), "1");
    await window.locator("#translatorToggle").click();
    await window.locator("#translatorInput").fill("登录按钮");
    await window.locator("#translatorToName").click();
    await window.locator("#toastAction").waitFor({ state: "visible" });
    assert.match(await window.locator("#toastMessage").innerText(), /请填写百度翻译凭据/);
    assert.equal(await window.locator("#toastAction").innerText(), "前往配置");
    await window.locator("#toastAction").click();
    await window.waitForFunction(() => document.querySelector("#apiSettingsView")?.classList.contains("active"));
    await window.locator("#backButton").click();
    await window.waitForFunction(() => document.querySelector("#workView")?.classList.contains("active"));
    await window.locator(".naming-service-settings-action").click();
    await window.locator("#namingModeSelect").selectOption("local");
    assert.equal(await window.locator("#translatorProvider").inputValue(), "baidu");
    assert.match(await window.locator("#runSelectedNaming").innerText(), /本地知识库/);
    await window.locator(".naming-service-settings-action").click();
    await window.locator("#namingModeSelect").selectOption("translate:local");
    await window.waitForFunction(() => document.querySelector("#translatorProvider")?.value === "local");
    await window.locator("#translatorClose").click();
    assert.match(await window.locator("#translatorPanel").getAttribute("class"), /collapsed/);
    await window.locator("#externalAppMenu").waitFor({ state: "visible" });
    assert.equal(await window.locator("#workView #externalAppMenu").count(), 0);
    assert.equal(await window.locator(".topbar #externalAppMenu").count(), 1);
    await window.locator('#externalAppQuickList [data-app-id="arthub"]').waitFor({ state: "visible" });
    await window.locator('#externalAppQuickList [data-app-id="figma"]').waitFor({ state: "visible" });
    await window.locator('#externalAppQuickList [data-app-id="ngr-online-ai-search"]').waitFor({ state: "visible" });
    assert.match(await window.locator('#externalAppQuickList [data-app-id="arthub"]').getAttribute("data-tooltip"), /ArtHub/);
    assert.match(await window.locator('#externalAppQuickList [data-app-id="figma"]').getAttribute("data-tooltip"), /Figma/);
    assert.equal(
      await window.locator('#externalAppQuickList [data-app-id="ngr-online-ai-search"]').getAttribute("data-tooltip"),
      "打开 NGR在线AI搜图",
    );
    assert.equal(await window.locator("#externalAppPrimary").getAttribute("data-tooltip"), "配置快捷应用");
    await window.locator('#externalAppQuickList [data-app-id="figma"]').hover();
    assert.match(await window.locator('#externalAppQuickList [data-app-id="figma"]').evaluate((node) => (
      getComputedStyle(node, "::after").content
    )), /Figma/);
    await window.locator("#externalAppPrimary").click();
    await window.locator("#externalAppList").waitFor({ state: "visible" });
    assert.match(await window.locator("#externalAppList").innerText(), /ArtHub/);
    assert.match(await window.locator("#externalAppList").innerText(), /Figma/);
    assert.match(await window.locator("#externalAppList").innerText(), /NGR在线AI搜图/);
    assert.match(await window.locator("#externalAppList").innerText(), /使用默认浏览器打开/);
    assert.equal(await window.locator("#externalAppAdd").isVisible(), true);
    await window.locator("#externalAppPrimary").click();
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
    await window.locator("#translatorProvider").selectOption("model");
    await window.waitForFunction(() => document.querySelector("#namingModeSelect")?.value === "translate:model");
    assert.match(await window.locator("#runSelectedNaming").innerText(), /OpenAI 兼容模型/);
    await window.locator("#translatorProvider").selectOption("local");
    await window.waitForFunction(() => document.querySelector("#namingModeSelect")?.value === "translate:local");
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
