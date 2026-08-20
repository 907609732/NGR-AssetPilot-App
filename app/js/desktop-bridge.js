/* NGR AssetPilot V3.0.4 module: desktop-bridge.js */
(function initializeDesktopBridge(globalScope) {
  "use strict";

  const nativeBridge = globalScope.ngrDesktop || null;
  const browserFetch = typeof globalScope.fetch === "function" ? globalScope.fetch.bind(globalScope) : null;
  const FILE_WRITE_CHUNK_SIZE = 1024 * 1024;

  function isDesktopRuntime() {
    return Boolean(nativeBridge);
  }

  function getCapability(path) {
    return String(path || "")
      .split(".")
      .filter(Boolean)
      .reduce((value, key) => value?.[key], nativeBridge);
  }

  function hasCapability(path) {
    return typeof getCapability(path) === "function";
  }

  async function invoke(path, payload) {
    const method = getCapability(path);
    if (typeof method !== "function") throw new Error(`桌面桥接能力不可用：${path}`);
    return method(payload);
  }

  async function getInfo() {
    if (!isDesktopRuntime()) return { runtime: "web", isDesktop: false, edition: "dev" };
    if (hasCapability("environment.getInfo")) return { isDesktop: true, ...(await invoke("environment.getInfo")) };
    if (hasCapability("getInfo")) return { isDesktop: true, ...(await invoke("getInfo")) };
    return { runtime: "desktop", isDesktop: true, edition: "dev" };
  }

  function createDesktopResponse(result = {}) {
    const responseBody = result.bodyText ?? result.body;
    const body = responseBody == null
      ? (result.data == null ? "" : typeof result.data === "string" ? result.data : JSON.stringify(result.data))
      : typeof responseBody === "string" ? responseBody : JSON.stringify(responseBody);
    const status = Number(result.status || result.statusCode || 0);
    return {
      ok: typeof result.ok === "boolean" ? result.ok : status >= 200 && status < 300,
      status,
      statusText: String(result.statusText || ""),
      headers: result.headers || {},
      url: String(result.url || ""),
      async json() {
        if (result.json && typeof result.json === "object") return result.json;
        return JSON.parse(body || "null");
      },
      async text() {
        return body;
      },
      async arrayBuffer() {
        return new TextEncoder().encode(body).buffer;
      },
    };
  }

  function createRequestId() {
    if (globalScope.crypto?.randomUUID) return globalScope.crypto.randomUUID();
    return `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 14)}`;
  }

  async function requestProvider(providerId, operation, body, options = {}) {
    if (!hasCapability("network.request")) throw new Error("桌面模型服务能力不可用");
    const requestId = createRequestId();
    const signal = options.signal;
    if (signal?.aborted) throw new DOMException("请求已终止", "AbortError");
    const onAbort = () => {
      if (hasCapability("network.cancel")) void invoke("network.cancel", { requestId }).catch(() => {});
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const result = await invoke("network.request", {
        requestId,
        providerId: String(providerId || ""),
        operation: String(operation || ""),
        body,
        timeoutMs: Number(options.timeoutMs || 0) || undefined,
      });
      return createDesktopResponse(result);
    } catch (error) {
      if (signal?.aborted || error?.code === "NETWORK_CANCELED") {
        throw new DOMException("请求已终止", "AbortError");
      }
      throw error;
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
  }

  async function request(url, options = {}) {
    if (!hasCapability("network.request")) {
      if (!browserFetch) throw new Error("当前环境不支持网络请求");
      return browserFetch(url, options);
    }

    throw new Error("桌面网络请求必须使用已保存并明确授权的模型服务");
  }

  async function getCredentialStatus() {
    if (!hasCapability("credentials.getStatus")) return null;
    return invoke("credentials.getStatus");
  }

  async function listProviders() {
    if (!hasCapability("providers.list")) return [];
    return invoke("providers.list");
  }

  async function upsertProvider(request) {
    if (!hasCapability("providers.upsert")) throw new Error("桌面模型服务配置能力不可用");
    return invoke("providers.upsert", request);
  }

  async function removeProvider(providerId) {
    if (!hasCapability("providers.remove")) throw new Error("桌面模型服务配置能力不可用");
    return invoke("providers.remove", { providerId });
  }

  async function importLegacyProviders(payload) {
    if (!hasCapability("providers.importLegacy")) return { imported: false, reason: "unsupported" };
    return invoke("providers.importLegacy", payload || {});
  }

  async function selectExportDirectory() {
    if (!hasCapability("files.selectExportDirectory")) return null;
    const selected = await invoke("files.selectExportDirectory");
    if (!selected) return null;
    return typeof selected === "string" ? { token: selected } : selected;
  }

  async function writeFileInChunks(directoryToken, relativePath, file) {
    if (!hasCapability("files.writeFile")) throw new Error("桌面文件写入能力不可用");
    const size = Number(file?.size || 0);
    if (!size) {
      await invoke("files.writeFile", {
        directoryToken,
        relativePath,
        data: new ArrayBuffer(0),
        offset: 0,
        truncate: true,
        final: true,
      });
      return;
    }
    for (let offset = 0; offset < size; offset += FILE_WRITE_CHUNK_SIZE) {
      const end = Math.min(size, offset + FILE_WRITE_CHUNK_SIZE);
      const data = await file.slice(offset, end).arrayBuffer();
      await invoke("files.writeFile", {
        directoryToken,
        relativePath,
        data,
        offset,
        truncate: offset === 0,
        final: end === size,
      });
    }
  }

  async function beginBackupStream(suggestedName) {
    if (!hasCapability("backup.beginExport")) throw new Error("桌面流式备份能力不可用");
    return invoke("backup.beginExport", { suggestedName, expectedSize: null });
  }

  async function writeBackupStreamChunk(sessionId, offset, data) {
    return invoke("backup.writeExportChunk", { sessionId, offset, data });
  }

  async function finishBackupStream(sessionId) {
    return invoke("backup.finishExport", { sessionId });
  }

  async function cancelBackupStream(sessionId) {
    return invoke("backup.cancelExport", { sessionId });
  }

  async function beginBackupImport() {
    if (!hasCapability("backup.beginImport")) throw new Error("桌面流式导入能力不可用");
    return invoke("backup.beginImport");
  }

  async function readBackupImportChunk(sessionId, offset, length = FILE_WRITE_CHUNK_SIZE) {
    if (!hasCapability("backup.readImportChunk")) throw new Error("桌面流式导入能力不可用");
    return invoke("backup.readImportChunk", {
      sessionId,
      offset,
      length: Math.min(Number(length || FILE_WRITE_CHUNK_SIZE), FILE_WRITE_CHUNK_SIZE),
    });
  }

  async function finishBackupImport(sessionId) {
    if (!hasCapability("backup.finishImport")) throw new Error("桌面流式导入提交能力不可用");
    return invoke("backup.finishImport", { sessionId });
  }

  async function cancelBackupImport(sessionId) {
    if (hasCapability("backup.cancelImport")) return invoke("backup.cancelImport", { sessionId });
    if (hasCapability("backup.closeImport")) return invoke("backup.closeImport", { sessionId });
    return { canceled: true, sessionId };
  }

  async function beginBackupApply() {
    if (!hasCapability("backup.beginApply")) throw new Error("桌面迁移事务能力不可用");
    return invoke("backup.beginApply");
  }

  async function importBackupLegacySecrets(transactionId, data, password) {
    if (!hasCapability("backup.importLegacySecrets")) throw new Error("桌面凭据迁移能力不可用");
    return invoke("backup.importLegacySecrets", { transactionId, data, password });
  }

  async function commitBackupApply(transactionId) {
    if (!hasCapability("backup.commitApply")) throw new Error("桌面迁移事务能力不可用");
    return invoke("backup.commitApply", { transactionId });
  }

  async function getBackupApplyState(transactionId) {
    if (!hasCapability("backup.getApplyState")) throw new Error("桌面迁移恢复能力不可用");
    return invoke("backup.getApplyState", { transactionId });
  }

  async function rollbackBackupApply(transactionId) {
    if (!hasCapability("backup.rollbackApply")) throw new Error("桌面迁移回滚能力不可用");
    return invoke("backup.rollbackApply", { transactionId });
  }

  async function finalizeBackupApply(transactionId) {
    if (!hasCapability("backup.finalizeApply")) throw new Error("桌面迁移事务清理能力不可用");
    return invoke("backup.finalizeApply", { transactionId });
  }

  async function getUpdateState() {
    if (!hasCapability("updater.getState")) return null;
    return invoke("updater.getState");
  }

  async function checkForUpdates() {
    if (!hasCapability("updater.check")) return null;
    return invoke("updater.check");
  }

  async function downloadUpdate() {
    if (!hasCapability("updater.download")) return null;
    return invoke("updater.download");
  }

  async function installUpdate() {
    if (!hasCapability("updater.install")) return null;
    return invoke("updater.install");
  }

  function onUpdateStateChanged(callback) {
    if (typeof callback !== "function") throw new TypeError("更新状态回调必须是函数");
    if (!hasCapability("updater.onStateChanged")) return () => {};
    return getCapability("updater.onStateChanged")(callback);
  }

  function onBeforeQuit(callback) {
    if (typeof callback !== "function") throw new TypeError("退出前回调必须是函数");
    if (!hasCapability("app.onBeforeQuit")) return () => {};
    return getCapability("app.onBeforeQuit")(callback);
  }

  function readyToQuit(requestId) {
    if (!hasCapability("app.readyToQuit")) return false;
    getCapability("app.readyToQuit")(requestId);
    return true;
  }

  async function openExternal(url) {
    if (hasCapability("shell.openExternal")) return invoke("shell.openExternal", { url: String(url) });
    globalScope.open(String(url), "_blank", "noopener,noreferrer");
    return true;
  }

  const externalApps = Object.freeze({
    isAvailable: () => hasCapability("externalApps.list"),
    list: () => invoke("externalApps.list"),
    choose: (request) => invoke("externalApps.choose", request),
    remove: (request) => invoke("externalApps.remove", request),
    launch: (request) => invoke("externalApps.launch", request),
  });

  const localImageSearch = Object.freeze({
    isAvailable: () => hasCapability("localImageSearch.getModelStatus"),
    getModelStatus: (request) => invoke("localImageSearch.getModelStatus", request),
    downloadModel: (request) => invoke("localImageSearch.downloadModel", request),
    cancelModelDownload: (request) => invoke("localImageSearch.cancelModelDownload", request),
    listModels: () => invoke("localImageSearch.listModels"),
    validateModel: (request) => invoke("localImageSearch.validateModel", request),
    importModel: (request) => invoke("localImageSearch.importModel", request),
    exportModel: (request) => invoke("localImageSearch.exportModel", request),
    removeModel: (request) => invoke("localImageSearch.removeModel", request),
    setActiveModel: (request) => invoke("localImageSearch.setActiveModel", request),
    getEngineStatus: (request) => invoke("localImageSearch.getEngineStatus", request),
    listLibraries: () => invoke("localImageSearch.listLibraries"),
    listAssetFolders: (request) => invoke("localImageSearch.listAssetFolders", request),
    listAssets: (request) => invoke("localImageSearch.listAssets", request),
    createLibrary: () => invoke("localImageSearch.createLibrary"),
    removeLibrary: (request) => invoke("localImageSearch.removeLibrary", request),
    startIndex: (request) => invoke("localImageSearch.startIndex", request),
    getJobStatus: (request) => invoke("localImageSearch.getJobStatus", request),
    cancelJob: (request) => invoke("localImageSearch.cancelJob", request),
    searchByImage: (request) => invoke("localImageSearch.searchByImage", request),
    searchByText: (request) => invoke("localImageSearch.searchByText", request),
    getThumbnail: (request) => invoke("localImageSearch.getThumbnail", request),
    openResult: (request) => invoke("localImageSearch.openResult", request),
    revealResult: (request) => invoke("localImageSearch.revealResult", request),
  });

  globalScope.NgrDesktopBridge = Object.freeze({
    isDesktopRuntime,
    hasCapability,
    getInfo,
    request,
    requestProvider,
    getCredentialStatus,
    listProviders,
    upsertProvider,
    removeProvider,
    importLegacyProviders,
    selectExportDirectory,
    writeFileInChunks,
    beginBackupStream,
    writeBackupStreamChunk,
    finishBackupStream,
    cancelBackupStream,
    beginBackupImport,
    readBackupImportChunk,
    finishBackupImport,
    cancelBackupImport,
    beginBackupApply,
    importBackupLegacySecrets,
    commitBackupApply,
    getBackupApplyState,
    rollbackBackupApply,
    finalizeBackupApply,
    getUpdateState,
    checkForUpdates,
    downloadUpdate,
    installUpdate,
    onUpdateStateChanged,
    onBeforeQuit,
    readyToQuit,
    openExternal,
    externalApps,
    localImageSearch,
  });
  globalScope.ngrFetch = request;
})(window);
