import electron from "electron";
import electronLog from "electron-log/main.js";
import { appendFileSync, cpSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { APP_URL } from "../shared/constants.mjs";
import { errorCodeOnly } from "../shared/core.mjs";
import { BackupFileService } from "../services/backup-files.mjs";
import { CredentialStore } from "../services/credential-store.mjs";
import { DirectoryTokenStore } from "../services/directory-tokens.mjs";
import { ExternalAppRegistry } from "../services/external-app-registry.mjs";
import { NetworkClient } from "../services/network-client.mjs";
import { ProviderRegistry } from "../services/provider-registry.mjs";
import { RuntimeLogger } from "../services/runtime-logger.mjs";
import { UpdaterController } from "../services/updater-controller.mjs";
import { LocalImageSearchController } from "../services/local-image-search/controller.mjs";
import { registerDesktopIpc } from "./ipc.mjs";
import { QuitCoordinator } from "./lifecycle.mjs";
import { installAppProtocol, registerAppScheme } from "./protocol.mjs";
import { createSecureWindowOptions, hardenSession, hardenWindow } from "./security.mjs";
import channels from "../shared/ipc-channels.cjs";

const {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  net,
  protocol,
  safeStorage,
  session,
  shell,
  utilityProcess,
} = electron;
const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(moduleDirectory, "../../app");
const preloadPath = path.resolve(moduleDirectory, "../preload/index.cjs");

function writeStartupLog(app, stage, details = {}) {
  try {
    const userDataPath = app.getPath("userData");
    mkdirSync(userDataPath, { recursive: true });
    const logPath = path.join(userDataPath, "desktop-startup.log");
    if (existsSync(logPath) && statSync(logPath).size >= 1024 * 1024) {
      const previousPath = `${logPath}.1`;
      rmSync(previousPath, { force: true });
      renameSync(logPath, previousPath);
    }
    appendFileSync(logPath, `${JSON.stringify({
      at: new Date().toISOString(),
      stage,
      ...details,
    })}\n`, "utf8");
  } catch {
    // Startup diagnostics must never prevent the application from opening.
  }
}

async function resolveAutoUpdater(enabled) {
  if (!enabled) return null;
  try {
    const module = await import("electron-updater");
    return module.autoUpdater ?? module.default?.autoUpdater ?? null;
  } catch {
    return null;
  }
}

function migrateLegacyLocalImageSearch(appDataPath, userDataPath, legacyNames) {
  const target = path.join(userDataPath, "local-image-search");
  if (existsSync(target)) return null;
  for (const legacyName of legacyNames) {
    const source = path.join(appDataPath, legacyName, "local-image-search");
    if (!existsSync(source)) continue;
    const staging = `${target}.migrating`;
    mkdirSync(userDataPath, { recursive: true });
    rmSync(staging, { recursive: true, force: true });
    try {
      cpSync(source, staging, { recursive: true, force: false, errorOnExist: true });
      renameSync(staging, target);
      return legacyName;
    } catch (error) {
      rmSync(staging, { recursive: true, force: true });
      throw error;
    }
  }
  return null;
}

export async function runDesktopApp({ edition = "dev" } = {}) {
  if (!["prod", "dev", "test"].includes(edition)) throw new Error("桌面版本必须是 prod、dev 或 test");
  const isTestEdition = edition === "test";
  const isProductionEdition = edition === "prod";
  const applicationName = isProductionEdition
    ? "NGR AssetPilot"
    : isTestEdition ? "NGR AssetPilot Test" : "NGR AssetPilot Dev";
  const applicationId = isProductionEdition
    ? "com.chenyuecai.ngrassetpilot"
    : `com.chenyuecai.ngrassetpilot.${edition}`;
  const appDataPath = app.getPath("appData");
  const e2eUserDataPath = process.env.NGR_E2E_USER_DATA;
  const userDataPath = typeof e2eUserDataPath === "string" && path.isAbsolute(e2eUserDataPath)
    ? path.resolve(e2eUserDataPath)
    : path.join(appDataPath, applicationName);
  registerAppScheme(protocol);
  app.setName(applicationName);
  app.setPath("userData", userDataPath);
  let migratedLocalSearchFrom = null;
  let migrationError = null;
  if (!e2eUserDataPath) {
    try {
      const migrationSources = isProductionEdition
        ? ["NGR AssetPilot Dev", "NGR AssetPilot Public Test"]
        : isTestEdition
          ? ["NGR AssetPilot Dev", "NGR AssetPilot", "NGR AssetPilot Public Test"]
          : ["NGR AssetPilot", "NGR AssetPilot Public Test"];
      migratedLocalSearchFrom = migrateLegacyLocalImageSearch(appDataPath, userDataPath, migrationSources);
    } catch (error) {
      migrationError = errorCodeOnly(error);
    }
  }
  writeStartupLog(app, "bootstrap-start", { edition, migratedLocalSearchFrom, migrationError });

  const hasSingleInstanceLock = app.requestSingleInstanceLock();
  writeStartupLog(app, "single-instance", { acquired: hasSingleInstanceLock });
  if (!hasSingleInstanceLock) {
    app.quit();
    return;
  }

  let mainWindow = null;
  app.on("second-instance", () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });

  await app.whenReady();
  writeStartupLog(app, "app-ready");
  const runtimeLogger = new RuntimeLogger({ app, logger: electronLog, edition });
  await runtimeLogger.initialize().catch((error) => writeStartupLog(app, "runtime-log-failed", {
    code: errorCodeOnly(error),
  }));
  app.setAppUserModelId(applicationId);
  await installAppProtocol({ protocol, appRoot });
  writeStartupLog(app, "protocol-ready");
  hardenSession(session.defaultSession);

  const credentialStore = new CredentialStore({ safeStorage, userDataPath: app.getPath("userData") });
  const providerRegistry = new ProviderRegistry({
    credentialStore,
    userDataPath: app.getPath("userData"),
  });
  await providerRegistry.initialize();
  writeStartupLog(app, "credentials-ready");

  const isPortable = Boolean(process.env.PORTABLE_EXECUTABLE_FILE);
  const updateChannel = isProductionEdition ? "latest" : isTestEdition ? "test" : "dev";
  const updaterRequested = app.isPackaged && isProductionEdition;
  const autoUpdater = await resolveAutoUpdater(updaterRequested);
  const updater = new UpdaterController({
    autoUpdater,
    enabled: updaterRequested && Boolean(autoUpdater),
    currentVersion: app.getVersion(),
    channel: updateChannel,
    feed: isProductionEdition
      ? {
          provider: "github",
          owner: "907609732",
          repo: "NGR-AssetPilot-App",
        }
      : null,
  });
  const directoryTokens = new DirectoryTokenStore();
  const externalApps = new ExternalAppRegistry({
    userDataPath: app.getPath("userData"),
    dialog,
    shell,
    getWindow: () => mainWindow,
  });
  await externalApps.initialize();
  const networkClient = new NetworkClient({
    fetchImpl: net.fetch.bind(net),
    providerRegistry,
  });
  const lifecycle = new QuitCoordinator({ app, channel: channels.appBeforeQuit });
  const backupService = new BackupFileService({
    dialog,
    getWindow: () => mainWindow,
    userDataPath: app.getPath("userData"),
    providerRegistry,
  });
  await backupService.initialize();
  const localImageSearch = new LocalImageSearchController({
    userDataPath: app.getPath("userData"),
    dialog,
    shell,
    netFetch: net.fetch.bind(net),
    getWindow: () => mainWindow,
    utilityProcess,
    onEngineEvent: (event = {}) => {
      const stage = `local-search:${String(event.stage || "engine-event")}`;
      const details = {
        operationId: event.requestId,
        jobId: event.jobId,
        workerExitCode: event.exitCode,
        reason: event.role,
        errorCode: event.errorCode,
      };
      if (["worker-exit", "request-timeout", "index-failed"].includes(event.stage)) {
        runtimeLogger.warn(stage, { code: event.errorCode || event.stage }, details);
      } else {
        runtimeLogger.info(stage, details);
      }
    },
  });
  lifecycle.addFinalizer("desktop-services", async () => {
    const results = await Promise.allSettled([
      Promise.resolve().then(() => localImageSearch.dispose()),
      Promise.resolve().then(() => networkClient.dispose()),
      Promise.resolve().then(() => backupService.dispose?.()),
      Promise.resolve().then(() => updater.dispose()),
    ]);
    const failed = results.find((result) => result.status === "rejected");
    if (failed) {
      runtimeLogger.warn("quit-finalizer-failed", failed.reason);
      return;
    }
    await runtimeLogger.markCleanShutdown();
  });

  mainWindow = new BrowserWindow(createSecureWindowOptions({ preloadPath, isPackaged: app.isPackaged }));
  writeStartupLog(app, "window-created");
  const rendererOwnerId = mainWindow.webContents.id;
  hardenWindow(mainWindow, { shell });
  lifecycle.attachWindow(mainWindow);

  const environmentInfo = () => ({
    platform: process.platform,
    arch: process.arch,
    version: app.getVersion(),
    isPackaged: app.isPackaged,
    isPortable,
    edition,
    distribution: isPortable ? "portable" : app.isPackaged ? "installer" : "development",
    updaterEnabled: updater.getState().enabled,
    updaterChannel: updateChannel,
    credentialProtection: "windows-dpapi",
    migratedLocalSearchFrom,
  });
  const disposeIpc = registerDesktopIpc({
    ipcMain,
    dialog,
    shell,
    getWindow: () => mainWindow,
    credentialStore,
    providerRegistry,
    networkClient,
    directoryTokens,
    backupService,
    updater,
    lifecycle,
    environmentInfo,
    localImageSearch,
    externalApps,
    runtimeLogger,
  });

  const showMainWindowMaximized = () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (!mainWindow.isMaximized()) mainWindow.maximize();
    if (!mainWindow.isVisible()) mainWindow.show();
  };
  mainWindow.once("ready-to-show", showMainWindowMaximized);
  mainWindow.on("closed", () => {
    if (rendererRecoveryTimer) clearTimeout(rendererRecoveryTimer);
    rendererRecoveryTimer = null;
    networkClient.cancelOwner(rendererOwnerId);
    void backupService.disposeOwner(rendererOwnerId);
    directoryTokens.revokeOwner(rendererOwnerId);
    mainWindow = null;
  });
  let rendererReloadAttempts = 0;
  let rendererRecoveryTimer = null;
  mainWindow.webContents.on("render-process-gone", (_event, details) => {
    networkClient.cancelOwner(rendererOwnerId);
    void backupService.disposeOwner(rendererOwnerId);
    if (rendererRecoveryTimer) clearTimeout(rendererRecoveryTimer);
    rendererRecoveryTimer = null;
    const reason = String(details?.reason || "unknown");
    runtimeLogger.error("renderer-process-gone", { code: reason }, {
      reason,
      workerExitCode: Number(details?.exitCode || 0),
      reloadAttempt: rendererReloadAttempts,
    });
    if (lifecycle.allowQuit || !mainWindow || mainWindow.isDestroyed()) return;
    if (rendererReloadAttempts < 1) {
      rendererReloadAttempts += 1;
      setImmediate(() => {
        if (!mainWindow || mainWindow.isDestroyed()) return;
        mainWindow.webContents.once("did-finish-load", () => {
          showMainWindowMaximized();
          rendererRecoveryTimer = setTimeout(() => {
            rendererReloadAttempts = 0;
            rendererRecoveryTimer = null;
          }, 30_000);
          rendererRecoveryTimer.unref?.();
        });
        mainWindow.reload();
      });
      return;
    }
    void dialog.showMessageBox(mainWindow, {
      type: "error",
      title: "NGR AssetPilot 需要重新启动",
      message: "界面进程连续异常退出。为保护当前数据，软件已停止自动恢复。",
      detail: "请关闭并重新打开软件；本地素材和图库原文件不会被删除。",
      buttons: ["知道了"],
      noLink: true,
    });
  });
  try {
    await mainWindow.loadURL(APP_URL);
    showMainWindowMaximized();
    writeStartupLog(app, "renderer-loaded");
  } catch (error) {
    writeStartupLog(app, "renderer-load-failed", { code: errorCodeOnly(error) });
    throw error;
  }

  app.on("activate", () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.show();
      mainWindow.focus();
    }
  });
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
  app.once("will-quit", () => {
    disposeIpc();
    lifecycle.dispose();
  });
}

export function reportStartupFailure(error) {
  const code = errorCodeOnly(error, "DESKTOP_STARTUP_FAILED");
  process.stderr.write(`[desktop] startup failed (${code})\n`);
  process.exitCode = 1;
}
