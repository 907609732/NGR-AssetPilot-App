"use strict";

const { contextBridge, ipcRenderer } = require("electron");

// Electron's sandboxed preload only receives a restricted `require` shim.
// Keep this immutable channel table self-contained so the real packaged
// renderer does not depend on an unsupported relative CommonJS import.
const channels = Object.freeze({
  environmentGetInfo: "ngr:environment:get-info",
  credentialsGetStatus: "ngr:credentials:get-status",
  credentialsGet: "ngr:credentials:get",
  credentialsSet: "ngr:credentials:set",
  credentialsClear: "ngr:credentials:clear",
  networkRequest: "ngr:network:request",
  filesSelectExportDirectory: "ngr:files:select-export-directory",
  filesWriteFile: "ngr:files:write-file",
  backupSave: "ngr:backup:save",
  backupOpen: "ngr:backup:open",
  updaterCheck: "ngr:updater:check",
  updaterDownload: "ngr:updater:download",
  updaterInstall: "ngr:updater:install",
  updaterGetState: "ngr:updater:get-state",
  updaterStateChanged: "ngr:updater:state-changed",
  shellOpenExternal: "ngr:shell:open-external",
  localImageSearchGetModelStatus: "ngr:local-image-search:get-model-status",
  localImageSearchDownloadModel: "ngr:local-image-search:download-model",
  localImageSearchCancelModelDownload: "ngr:local-image-search:cancel-model-download",
  localImageSearchImportModel: "ngr:local-image-search:import-model",
  localImageSearchExportModel: "ngr:local-image-search:export-model",
  localImageSearchRemoveModel: "ngr:local-image-search:remove-model",
  localImageSearchListLibraries: "ngr:local-image-search:list-libraries",
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
    get: () => invoke(channels.credentialsGet),
    set: (credentials) => invoke(channels.credentialsSet, credentials),
    clear: () => invoke(channels.credentialsClear),
  },
  network: {
    request: (request) => invoke(channels.networkRequest, request),
  },
  files: {
    selectExportDirectory: () => invoke(channels.filesSelectExportDirectory),
    writeFile: (request) => invoke(channels.filesWriteFile, request),
  },
  backup: {
    save: (request) => invoke(channels.backupSave, request),
    open: () => invoke(channels.backupOpen),
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
    getModelStatus: () => invoke(channels.localImageSearchGetModelStatus),
    downloadModel: () => invoke(channels.localImageSearchDownloadModel),
    cancelModelDownload: () => invoke(channels.localImageSearchCancelModelDownload),
    importModel: () => invoke(channels.localImageSearchImportModel),
    exportModel: () => invoke(channels.localImageSearchExportModel),
    removeModel: () => invoke(channels.localImageSearchRemoveModel),
    listLibraries: () => invoke(channels.localImageSearchListLibraries),
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
