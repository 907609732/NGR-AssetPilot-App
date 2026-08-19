import { APP_HOST, APP_SCHEME } from "../shared/constants.mjs";

export function isTrustedAppUrl(rawUrl) {
  if (typeof rawUrl !== "string" || rawUrl.length > 4096) return false;
  try {
    const parsed = new URL(rawUrl);
    return (
      parsed.protocol === `${APP_SCHEME}:` &&
      parsed.hostname === APP_HOST &&
      !parsed.port &&
      !parsed.username &&
      !parsed.password
    );
  } catch {
    return false;
  }
}

export function isAllowedExternalUrl(rawUrl) {
  if (typeof rawUrl !== "string" || rawUrl.length > 4096) return false;
  try {
    const parsed = new URL(rawUrl);
    const allowedHosts = new Set(["ngr.lttlt.top", "github.com"]);
    return (
      parsed.protocol === "https:" &&
      !parsed.port &&
      !parsed.username &&
      !parsed.password &&
      allowedHosts.has(parsed.hostname.toLowerCase())
    );
  } catch {
    return false;
  }
}

export function createSecureWindowOptions({ preloadPath, isPackaged }) {
  return {
    width: 1440,
    height: 920,
    minWidth: 1100,
    minHeight: 700,
    show: false,
    backgroundColor: "#07111f",
    autoHideMenuBar: true,
    webPreferences: {
      preload: preloadPath,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      safeDialogs: true,
      devTools: !isPackaged,
      spellcheck: false,
    },
  };
}

export function hardenSession(session) {
  session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  session.setPermissionCheckHandler(() => false);
  session.setDevicePermissionHandler?.(() => false);
}

export function hardenWindow(window, { shell }) {
  const contents = window.webContents;
  contents.setWindowOpenHandler(({ url }) => {
    if (isAllowedExternalUrl(url)) {
      void shell.openExternal(url, { activate: true }).catch(() => {});
    }
    return { action: "deny" };
  });

  const preventUntrustedNavigation = (event, url) => {
    if (!isTrustedAppUrl(url)) event.preventDefault();
  };
  contents.on("will-navigate", preventUntrustedNavigation);
  contents.on("will-redirect", preventUntrustedNavigation);
  contents.on("will-attach-webview", (event) => event.preventDefault());
  contents.on("render-process-gone", () => {
    if (!window.isDestroyed()) window.hide();
  });
  window.removeMenu?.();
}
