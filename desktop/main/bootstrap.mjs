import electron from "electron";
import { appendFileSync, cpSync, existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { APP_URL } from "../shared/constants.mjs";
import { errorCodeOnly } from "../shared/core.mjs";
import { BackupFileService } from "../services/backup-files.mjs";
import { CredentialStore } from "../services/credential-store.mjs";
import { DirectoryTokenStore } from "../services/directory-tokens.mjs";
import { NetworkClient } from "../services/network-client.mjs";
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
} = electron;
const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(moduleDirectory, "../../app");
const preloadPath = path.resolve(moduleDirectory, "../preload/index.cjs");

function writeStartupLog(app, stage, details = {}) {
  try {
    const userDataPath = app.getPath("userData");
    mkdirSync(userDataPath, { recursive: true });
    appendFileSync(path.join(userDataPath, "desktop-startup.log"), `${JSON.stringify({
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
  if (!["dev", "test"].includes(edition)) throw new Error("桌面版本必须是 dev 或 test");
  const isTestEdition = edition === "test";
  const applicationName = isTestEdition ? "NGR AssetPilot Test" : "NGR AssetPilot Dev";
  const applicationId = `com.chenyuecai.ngrassetpilot.${edition}`;
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
      const migrationSources = isTestEdition
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
  app.setAppUserModelId(applicationId);
  await installAppProtocol({ protocol, appRoot });
  writeStartupLog(app, "protocol-ready");
  hardenSession(session.defaultSession);

  const credentialStore = new CredentialStore({ safeStorage, userDataPath: app.getPath("userData") });
  writeStartupLog(app, "credentials-ready");

  const isPortable = Boolean(process.env.PORTABLE_EXECUTABLE_FILE);
  const updateChannel = isTestEdition ? "test" : "dev";
  const updaterRequested = false;
  const autoUpdater = await resolveAutoUpdater(updaterRequested);
  const updater = new UpdaterController({
    autoUpdater,
    enabled: updaterRequested && Boolean(autoUpdater),
    currentVersion: app.getVersion(),
  });
  const directoryTokens = new DirectoryTokenStore();
  const networkClient = new NetworkClient({ fetchImpl: net.fetch.bind(net) });
  const lifecycle = new QuitCoordinator({ app, channel: channels.appBeforeQuit });
  const backupService = new BackupFileService({ dialog, getWindow: () => mainWindow });
  const localImageSearch = new LocalImageSearchController({
    userDataPath: app.getPath("userData"),
    dialog,
    shell,
    netFetch: net.fetch.bind(net),
    getWindow: () => mainWindow,
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
    networkClient,
    directoryTokens,
    backupService,
    updater,
    lifecycle,
    environmentInfo,
    localImageSearch,
  });

  const showMainWindowMaximized = () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (!mainWindow.isMaximized()) mainWindow.maximize();
    if (!mainWindow.isVisible()) mainWindow.show();
  };
  mainWindow.once("ready-to-show", showMainWindowMaximized);
  mainWindow.on("closed", () => {
    directoryTokens.revokeOwner(rendererOwnerId);
    mainWindow = null;
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
    updater.dispose();
    lifecycle.dispose();
    void localImageSearch.dispose();
  });
}

export function reportStartupFailure(error) {
  const code = errorCodeOnly(error, "DESKTOP_STARTUP_FAILED");
  process.stderr.write(`[desktop] startup failed (${code})\n`);
  process.exitCode = 1;
}
