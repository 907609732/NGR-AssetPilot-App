import channels from "../shared/ipc-channels.cjs";
import { DesktopError, isPlainRecord, publicError } from "../shared/core.mjs";
import { isAllowedExternalUrl, isTrustedAppUrl } from "./security.mjs";

const AUDITED_CHANNELS = new Map([
  [channels.providersUpsert, "provider-upsert"],
  [channels.providersRemove, "provider-remove"],
  [channels.providersImportLegacy, "provider-import-legacy"],
  [channels.networkRequest, "network-request"],
  [channels.networkCancel, "network-cancel"],
  [channels.backupBeginExport, "backup-export-begin"],
  [channels.backupFinishExport, "backup-export-finish"],
  [channels.backupCancelExport, "backup-export-cancel"],
  [channels.backupBeginImport, "backup-import-begin"],
  [channels.backupFinishImport, "backup-import-finish"],
  [channels.backupCancelImport, "backup-import-cancel"],
  [channels.backupBeginApply, "backup-apply-begin"],
  [channels.backupImportLegacySecrets, "backup-secrets-import"],
  [channels.backupCommitApply, "backup-apply-commit"],
  [channels.backupRollbackApply, "backup-apply-rollback"],
  [channels.backupFinalizeApply, "backup-apply-finalize"],
  [channels.updaterCheck, "updater-check"],
  [channels.updaterDownload, "updater-download"],
  [channels.updaterInstall, "updater-install"],
  [channels.localImageSearchValidateModel, "local-model-validate"],
  [channels.localImageSearchDownloadModel, "local-model-download"],
  [channels.localImageSearchCancelModelDownload, "local-model-download-cancel"],
  [channels.localImageSearchImportModel, "local-model-import"],
  [channels.localImageSearchExportModel, "local-model-export"],
  [channels.localImageSearchRemoveModel, "local-model-remove"],
  [channels.localImageSearchStartIndex, "local-index-start"],
  [channels.localImageSearchCancelJob, "local-index-cancel"],
]);

function auditDetails(...values) {
  const details = {};
  for (const value of values) {
    if (!isPlainRecord(value)) continue;
    const operationId = value.operationId || value.requestId || value.sessionId || value.transactionId;
    if (!details.operationId && typeof operationId === "string") details.operationId = operationId;
    if (!details.jobId && typeof value.jobId === "string") details.jobId = value.jobId;
    if (!details.providerId && typeof value.providerId === "string") details.providerId = value.providerId;
  }
  return details;
}

export function registerDesktopIpc({
  ipcMain,
  dialog,
  shell,
  getWindow,
  credentialStore,
  providerRegistry,
  networkClient,
  directoryTokens,
  backupService,
  updater,
  lifecycle,
  environmentInfo,
  localImageSearch,
  runtimeLogger = null,
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
      const auditStage = AUDITED_CHANNELS.get(channel);
      const requestDetails = auditDetails(args[0]);
      try {
        assertTrustedSender(event);
        if (args.length > 1) throw new DesktopError("IPC_ARGUMENTS_INVALID", "桌面请求参数无效");
        if (auditStage) runtimeLogger?.info(`${auditStage}:start`, requestDetails);
        const result = await handler(event, args[0]);
        if (auditStage) runtimeLogger?.info(`${auditStage}:complete`, auditDetails(requestDetails, result));
        return result;
      } catch (error) {
        if (auditStage) runtimeLogger?.warn(`${auditStage}:failed`, error, requestDetails);
        throw publicError(error);
      }
    });
    registered.push(channel);
  }

  handle(channels.environmentGetInfo, async () => environmentInfo());
  handle(channels.credentialsGetStatus, async () => credentialStore.getStatus());
  handle(channels.providersList, async () => providerRegistry.list());
  handle(channels.providersUpsert, async (_event, payload) => providerRegistry.upsert(payload));
  handle(channels.providersRemove, async (_event, payload) => providerRegistry.remove(payload));
  handle(channels.providersImportLegacy, async (_event, payload) => providerRegistry.importLegacy(payload));
  handle(channels.networkRequest, async (event, payload) => networkClient.request(payload, event.sender.id));
  handle(channels.networkCancel, async (event, payload) => networkClient.cancel(payload, event.sender.id));

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

  handle(channels.backupBeginExport, async (event, payload) => backupService.beginExport(payload, event.sender.id));
  handle(channels.backupWriteExportChunk, async (event, payload) => backupService.writeExportChunk(payload, event.sender.id));
  handle(channels.backupFinishExport, async (event, payload) => backupService.finishExport(payload, event.sender.id));
  handle(channels.backupCancelExport, async (event, payload) => backupService.cancelExport(payload, event.sender.id));
  handle(channels.backupBeginImport, async (event) => backupService.beginImport(event.sender.id));
  handle(channels.backupReadImportChunk, async (event, payload) => backupService.readImportChunk(payload, event.sender.id));
  handle(channels.backupFinishImport, async (event, payload) => backupService.finishImport(payload, event.sender.id));
  handle(channels.backupCancelImport, async (event, payload) => backupService.cancelImport(payload, event.sender.id));
  handle(channels.backupCloseImport, async (event, payload) => backupService.closeImport(payload, event.sender.id));
  handle(channels.backupBeginApply, async (event) => backupService.beginApply(event.sender.id));
  handle(channels.backupImportLegacySecrets, async (event, payload) => backupService.importLegacySecrets(payload, event.sender.id));
  handle(channels.backupCommitApply, async (event, payload) => backupService.commitApply(payload, event.sender.id));
  handle(channels.backupGetApplyState, async (event, payload) => backupService.getApplyState(payload, event.sender.id));
  handle(channels.backupRollbackApply, async (event, payload) => backupService.rollbackApply(payload, event.sender.id));
  handle(channels.backupFinalizeApply, async (event, payload) => backupService.finalizeApply(payload, event.sender.id));
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

  handle(channels.localImageSearchGetModelStatus, async (_event, payload) => localImageSearch.getModelStatus(payload));
  handle(channels.localImageSearchListModels, async () => localImageSearch.listModels());
  handle(channels.localImageSearchValidateModel, async (_event, payload) => localImageSearch.validateModel(payload));
  handle(channels.localImageSearchDownloadModel, async (_event, payload) => localImageSearch.downloadModel(payload));
  handle(channels.localImageSearchCancelModelDownload, async (_event, payload) => localImageSearch.cancelModelDownload(payload));
  handle(channels.localImageSearchImportModel, async (_event, payload) => localImageSearch.importModel(payload));
  handle(channels.localImageSearchExportModel, async (_event, payload) => localImageSearch.exportModel(payload));
  handle(channels.localImageSearchRemoveModel, async (_event, payload) => localImageSearch.removeModel(payload));
  handle(channels.localImageSearchSetActiveModel, async (_event, payload) => localImageSearch.setActiveModel(payload));
  handle(channels.localImageSearchGetEngineStatus, async (_event, payload) => localImageSearch.getEngineStatus(payload));
  handle(channels.localImageSearchListLibraries, async () => localImageSearch.listLibraries());
  handle(channels.localImageSearchListAssetFolders, async (_event, payload) => localImageSearch.listAssetFolders(payload));
  handle(channels.localImageSearchListAssets, async (_event, payload) => localImageSearch.listAssets(payload));
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
    networkClient.dispose?.();
    for (const channel of registered) ipcMain.removeHandler(channel);
    ipcMain.removeListener(channels.appReadyToQuit, readyListener);
  };
}
