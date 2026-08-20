"use strict";

const { contextBridge, ipcRenderer } = require("electron");

// Electron's sandboxed preload only receives a restricted `require` shim.
// Keep this immutable channel table self-contained so the real packaged
// renderer does not depend on an unsupported relative CommonJS import.
const channels = Object.freeze({
  environmentGetInfo: "ngr:environment:get-info",
  credentialsGetStatus: "ngr:credentials:get-status",
  providersList: "ngr:providers:list",
  providersUpsert: "ngr:providers:upsert",
  providersRemove: "ngr:providers:remove",
  providersImportLegacy: "ngr:providers:import-legacy",
  networkRequest: "ngr:network:request",
  networkCancel: "ngr:network:cancel",
  filesSelectExportDirectory: "ngr:files:select-export-directory",
  filesWriteFile: "ngr:files:write-file",
  backupBeginExport: "ngr:backup:begin-export",
  backupWriteExportChunk: "ngr:backup:write-export-chunk",
  backupFinishExport: "ngr:backup:finish-export",
  backupCancelExport: "ngr:backup:cancel-export",
  backupBeginImport: "ngr:backup:begin-import",
  backupReadImportChunk: "ngr:backup:read-import-chunk",
  backupFinishImport: "ngr:backup:finish-import",
  backupCancelImport: "ngr:backup:cancel-import",
  backupCloseImport: "ngr:backup:close-import",
  backupBeginApply: "ngr:backup:begin-apply",
  backupImportLegacySecrets: "ngr:backup:import-legacy-secrets",
  backupCommitApply: "ngr:backup:commit-apply",
  backupGetApplyState: "ngr:backup:get-apply-state",
  backupRollbackApply: "ngr:backup:rollback-apply",
  backupFinalizeApply: "ngr:backup:finalize-apply",
  updaterCheck: "ngr:updater:check",
  updaterDownload: "ngr:updater:download",
  updaterInstall: "ngr:updater:install",
  updaterGetState: "ngr:updater:get-state",
  updaterStateChanged: "ngr:updater:state-changed",
  shellOpenExternal: "ngr:shell:open-external",
  localImageSearchGetModelStatus: "ngr:local-image-search:get-model-status",
  localImageSearchListModels: "ngr:local-image-search:list-models",
  localImageSearchValidateModel: "ngr:local-image-search:validate-model",
  localImageSearchDownloadModel: "ngr:local-image-search:download-model",
  localImageSearchCancelModelDownload: "ngr:local-image-search:cancel-model-download",
  localImageSearchImportModel: "ngr:local-image-search:import-model",
  localImageSearchExportModel: "ngr:local-image-search:export-model",
  localImageSearchRemoveModel: "ngr:local-image-search:remove-model",
  localImageSearchSetActiveModel: "ngr:local-image-search:set-active-model",
  localImageSearchGetEngineStatus: "ngr:local-image-search:get-engine-status",
  localImageSearchListLibraries: "ngr:local-image-search:list-libraries",
  localImageSearchListAssetFolders: "ngr:local-image-search:list-asset-folders",
  localImageSearchListAssets: "ngr:local-image-search:list-assets",
  localImageSearchCreateLibrary: "ngr:local-image-search:create-library",
  localImageSearchRemoveLibrary: "ngr:local-image-search:remove-library",
  localImageSearchStartIndex: "ngr:local-image-search:start-index",
  localImageSearchGetJobStatus: "ngr:local-image-search:get-job-status",
  localImageSearchCancelJob: "ngr:local-image-search:cancel-job",
  localImageSearchSearchByImage: "ngr:local-image-search:search-by-image",
  localImageSearchSearchByText: "ngr:local-image-search:search-by-text",
  localImageSearchGetThumbnail: "ngr:local-image-search:get-thumbnail",
  localImageSearchOpenResult: "ngr:local-image-search:open-result",
  localImageSearchRevealResult: "ngr:local-image-search:reveal-result",
  appBeforeQuit: "ngr:app:before-quit",
  appReadyToQuit: "ngr:app:ready-to-quit",
});

function invoke(channel, payload) {
  return payload === undefined ? ipcRenderer.invoke(channel) : ipcRenderer.invoke(channel, payload);
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

const api = deepFreeze({
  environment: {
    getInfo: () => invoke(channels.environmentGetInfo),
  },
  credentials: {
    getStatus: () => invoke(channels.credentialsGetStatus),
  },
  providers: {
    list: () => invoke(channels.providersList),
    upsert: (request) => invoke(channels.providersUpsert, request),
    remove: (request) => invoke(channels.providersRemove, request),
    importLegacy: (request) => invoke(channels.providersImportLegacy, request),
  },
  network: {
    request: (request) => invoke(channels.networkRequest, request),
    cancel: (request) => invoke(channels.networkCancel, request),
  },
  files: {
    selectExportDirectory: () => invoke(channels.filesSelectExportDirectory),
    writeFile: (request) => invoke(channels.filesWriteFile, request),
  },
  backup: {
    beginExport: (request) => invoke(channels.backupBeginExport, request),
    writeExportChunk: (request) => invoke(channels.backupWriteExportChunk, request),
    finishExport: (request) => invoke(channels.backupFinishExport, request),
    cancelExport: (request) => invoke(channels.backupCancelExport, request),
    beginImport: () => invoke(channels.backupBeginImport),
    readImportChunk: (request) => invoke(channels.backupReadImportChunk, request),
    finishImport: (request) => invoke(channels.backupFinishImport, request),
    cancelImport: (request) => invoke(channels.backupCancelImport, request),
    closeImport: (request) => invoke(channels.backupCloseImport, request),
    beginApply: () => invoke(channels.backupBeginApply),
    importLegacySecrets: (request) => invoke(channels.backupImportLegacySecrets, request),
    commitApply: (request) => invoke(channels.backupCommitApply, request),
    getApplyState: (request) => invoke(channels.backupGetApplyState, request),
    rollbackApply: (request) => invoke(channels.backupRollbackApply, request),
    finalizeApply: (request) => invoke(channels.backupFinalizeApply, request),
  },
  updater: {
    check: () => invoke(channels.updaterCheck),
    download: () => invoke(channels.updaterDownload),
    install: () => invoke(channels.updaterInstall),
    getState: () => invoke(channels.updaterGetState),
    onStateChanged(callback) {
      if (typeof callback !== "function") throw new TypeError("callback must be a function");
      const listener = (_event, state) => callback(state);
      ipcRenderer.on(channels.updaterStateChanged, listener);
      return () => ipcRenderer.removeListener(channels.updaterStateChanged, listener);
    },
  },
  shell: {
    openExternal: (urlOrRequest) =>
      invoke(
        channels.shellOpenExternal,
        typeof urlOrRequest === "string" ? { url: urlOrRequest } : urlOrRequest,
      ),
  },
  localImageSearch: {
    getModelStatus: (request) => invoke(channels.localImageSearchGetModelStatus, request),
    listModels: () => invoke(channels.localImageSearchListModels),
    validateModel: (request) => invoke(channels.localImageSearchValidateModel, request),
    downloadModel: (request) => invoke(channels.localImageSearchDownloadModel, request),
    cancelModelDownload: (request) => invoke(channels.localImageSearchCancelModelDownload, request),
    importModel: (request) => invoke(channels.localImageSearchImportModel, request),
    exportModel: (request) => invoke(channels.localImageSearchExportModel, request),
    removeModel: (request) => invoke(channels.localImageSearchRemoveModel, request),
    setActiveModel: (request) => invoke(channels.localImageSearchSetActiveModel, request),
    getEngineStatus: (request) => invoke(channels.localImageSearchGetEngineStatus, request),
    listLibraries: () => invoke(channels.localImageSearchListLibraries),
    listAssetFolders: (request) => invoke(channels.localImageSearchListAssetFolders, request),
    listAssets: (request) => invoke(channels.localImageSearchListAssets, request),
    createLibrary: () => invoke(channels.localImageSearchCreateLibrary),
    removeLibrary: (request) => invoke(channels.localImageSearchRemoveLibrary, request),
    startIndex: (request) => invoke(channels.localImageSearchStartIndex, request),
    getJobStatus: (request) => invoke(channels.localImageSearchGetJobStatus, request),
    cancelJob: (request) => invoke(channels.localImageSearchCancelJob, request),
    searchByImage: (request) => invoke(channels.localImageSearchSearchByImage, request),
    searchByText: (request) => invoke(channels.localImageSearchSearchByText, request),
    getThumbnail: (request) => invoke(channels.localImageSearchGetThumbnail, request),
    openResult: (request) => invoke(channels.localImageSearchOpenResult, request),
    revealResult: (request) => invoke(channels.localImageSearchRevealResult, request),
  },
  app: {
    onBeforeQuit(callback) {
      if (typeof callback !== "function") throw new TypeError("callback must be a function");
      const listener = (_event, payload) => callback(payload);
      ipcRenderer.on(channels.appBeforeQuit, listener);
      return () => ipcRenderer.removeListener(channels.appBeforeQuit, listener);
    },
    readyToQuit(requestIdOrPayload) {
      const requestId =
        typeof requestIdOrPayload === "string" ? requestIdOrPayload : requestIdOrPayload?.requestId;
      if (typeof requestId !== "string") throw new TypeError("requestId is required");
      ipcRenderer.send(channels.appReadyToQuit, { requestId });
    },
  },
});

contextBridge.exposeInMainWorld("ngrDesktop", api);
