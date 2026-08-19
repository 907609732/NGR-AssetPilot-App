import channels from "../shared/ipc-channels.cjs";
import { DesktopError, isPlainRecord, publicError } from "../shared/core.mjs";
import { isAllowedExternalUrl, isTrustedAppUrl } from "./security.mjs";

export function registerDesktopIpc({
  ipcMain,
  dialog,
  shell,
  getWindow,
  credentialStore,
  networkClient,
  directoryTokens,
  backupService,
  updater,
  lifecycle,
  environmentInfo,
  localImageSearch,
}) {
  const registered = [];

  function assertTrustedSender(event) {
    const window = getWindow();
    if (!window || window.isDestroyed() || event.sender !== window.webContents) {
      throw new DesktopError("IPC_SENDER_REJECTED", "桌面请求来源无效");
    }
    const frame = event.senderFrame;
    const mainFrame = event.sender.mainFrame;
    if (
      !frame ||
      !mainFrame ||
      frame.routingId !== mainFrame.routingId ||
      !isTrustedAppUrl(frame.url || event.sender.getURL())
    ) {
      throw new DesktopError("IPC_SENDER_REJECTED", "桌面请求来源无效");
    }
    return window;
  }

  function handle(channel, handler) {
    ipcMain.handle(channel, async (event, ...args) => {
      try {
        assertTrustedSender(event);
        if (args.length > 1) throw new DesktopError("IPC_ARGUMENTS_INVALID", "桌面请求参数无效");
        return await handler(event, args[0]);
      } catch (error) {
        throw publicError(error);
      }
    });
    registered.push(channel);
  }

  handle(channels.environmentGetInfo, async () => environmentInfo());
  handle(channels.credentialsGetStatus, async () => credentialStore.getStatus());
  handle(channels.credentialsGet, async () => credentialStore.get());
  handle(channels.credentialsSet, async (_event, payload) => credentialStore.set(payload));
  handle(channels.credentialsClear, async () => credentialStore.clear());
  handle(channels.networkRequest, async (_event, payload) => networkClient.request(payload));

  handle(channels.filesSelectExportDirectory, async (event) => {
    const window = getWindow();
    const result = await dialog.showOpenDialog(window, {
      title: "选择导出目录",
      buttonLabel: "选择此目录",
      properties: ["openDirectory", "createDirectory"],
    });
    if (result.canceled || !result.filePaths?.[0]) return { canceled: true };
    const grant = await directoryTokens.grant(result.filePaths[0], event.sender.id);
    return { canceled: false, ...grant };
  });
  handle(channels.filesWriteFile, async (event, payload) => directoryTokens.writeFile(payload, event.sender.id));

  handle(channels.backupSave, async (_event, payload) => backupService.save(payload));
  handle(channels.backupOpen, async () => backupService.open());
  handle(channels.updaterGetState, async () => updater.getState());
  handle(channels.updaterCheck, async () => updater.check());
  handle(channels.updaterDownload, async () => updater.download());
  handle(channels.updaterInstall, async () => updater.install());
  const disposeUpdaterSubscription = typeof updater.subscribe === "function"
    ? updater.subscribe((state) => {
        const window = getWindow();
        if (!window || window.isDestroyed()) return;
        window.webContents.send(channels.updaterStateChanged, state);
      })
    : () => {};

  handle(channels.shellOpenExternal, async (_event, payload) => {
    const rawUrl = typeof payload === "string" ? payload : payload?.url;
    if (!isAllowedExternalUrl(rawUrl)) {
      throw new DesktopError("EXTERNAL_URL_NOT_ALLOWED", "仅允许打开可信 HTTPS 外链");
    }
    await shell.openExternal(rawUrl, { activate: true });
    return { opened: true };
  });

  handle(channels.localImageSearchGetModelStatus, async () => localImageSearch.getModelStatus());
  handle(channels.localImageSearchDownloadModel, async () => localImageSearch.downloadModel());
  handle(channels.localImageSearchCancelModelDownload, async () => localImageSearch.cancelModelDownload());
  handle(channels.localImageSearchImportModel, async () => localImageSearch.importModel());
  handle(channels.localImageSearchExportModel, async () => localImageSearch.exportModel());
  handle(channels.localImageSearchRemoveModel, async () => localImageSearch.removeModel());
  handle(channels.localImageSearchListLibraries, async () => localImageSearch.listLibraries());
  handle(channels.localImageSearchCreateLibrary, async () => localImageSearch.createLibrary());
  handle(channels.localImageSearchRemoveLibrary, async (_event, payload) => localImageSearch.removeLibrary(payload));
  handle(channels.localImageSearchStartIndex, async (_event, payload) => localImageSearch.startIndex(payload));
  handle(channels.localImageSearchGetJobStatus, async (_event, payload) => localImageSearch.getJobStatus(payload));
  handle(channels.localImageSearchCancelJob, async (_event, payload) => localImageSearch.cancelJob(payload));
  handle(channels.localImageSearchSearchByImage, async (_event, payload) => localImageSearch.searchByImage(payload));
  handle(channels.localImageSearchSearchByText, async (_event, payload) => localImageSearch.searchByText(payload));
  handle(channels.localImageSearchGetThumbnail, async (_event, payload) => localImageSearch.getThumbnail(payload));
  handle(channels.localImageSearchOpenResult, async (_event, payload) => localImageSearch.openResult(payload));
  handle(channels.localImageSearchRevealResult, async (_event, payload) => localImageSearch.revealResult(payload));

  const readyListener = (event, payload) => {
    try {
      assertTrustedSender(event);
      if (!isPlainRecord(payload) || typeof payload.requestId !== "string") return;
      lifecycle.ready(payload.requestId);
    } catch {
      // Invalid asynchronous senders are deliberately ignored.
    }
  };
  ipcMain.on(channels.appReadyToQuit, readyListener);

  return () => {
    disposeUpdaterSubscription();
    for (const channel of registered) ipcMain.removeHandler(channel);
    ipcMain.removeListener(channels.appReadyToQuit, readyListener);
  };
}
