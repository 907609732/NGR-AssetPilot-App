/* NGR AssetPilot V3.0.0 module: desktop-bridge.js */
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

  function raceAbort(operation, signal) {
    if (!signal) return operation;
    if (signal.aborted) return Promise.reject(new DOMException("请求已终止", "AbortError"));
    return new Promise((resolve, reject) => {
      const onAbort = () => reject(new DOMException("请求已终止", "AbortError"));
      signal.addEventListener("abort", onAbort, { once: true });
      operation.then(
        (value) => {
          signal.removeEventListener("abort", onAbort);
          resolve(value);
        },
        (error) => {
          signal.removeEventListener("abort", onAbort);
          reject(error);
        },
      );
    });
  }

  async function request(url, options = {}) {
    if (!hasCapability("network.request")) {
      if (!browserFetch) throw new Error("当前环境不支持网络请求");
      return browserFetch(url, options);
    }

    const headers = {};
    if (options.headers instanceof Headers) options.headers.forEach((value, key) => { headers[key] = value; });
    else Object.assign(headers, options.headers || {});
    const requestUrl = String(url);
    let service;
    if (options.service !== undefined) {
      if (!(["ai", "translation"].includes(options.service))) throw new TypeError("不支持的桌面网络服务类型");
      service = options.service;
    } else {
      service = "ai";
      try {
        const hostname = new URL(requestUrl).hostname.toLowerCase();
        if (hostname === "fanyi-api.baidu.com") service = "translation";
      } catch {
        // The main process performs the authoritative URL validation.
      }
    }
    const operation = invoke("network.request", {
      service,
      url: requestUrl,
      method: String(options.method || "GET").toUpperCase(),
      headers,
      body: options.body == null ? null : String(options.body),
      timeoutMs: Number(options.timeoutMs || 0) || undefined,
    });
    return createDesktopResponse(await raceAbort(operation, options.signal));
  }

  async function getCredentials() {
    if (!hasCapability("credentials.get")) return null;
    return invoke("credentials.get");
  }

  async function getCredentialStatus() {
    if (!hasCapability("credentials.getStatus")) return null;
    return invoke("credentials.getStatus");
  }

  async function setCredentials(credentials) {
    if (!hasCapability("credentials.set")) return false;
    await invoke("credentials.set", credentials || {});
    return true;
  }

  async function clearCredentials() {
    if (!hasCapability("credentials.clear")) return false;
    await invoke("credentials.clear");
    return true;
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

  async function saveBackup(suggestedName, bytes, options = {}) {
    if (!hasCapability("backup.save")) return null;
    return invoke("backup.save", {
      suggestedName,
      data: bytes instanceof Uint8Array ? bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) : bytes,
      automatic: Boolean(options.automatic),
    });
  }

  async function openBackup() {
    if (!hasCapability("backup.open")) return null;
    return invoke("backup.open");
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

  const localImageSearch = Object.freeze({
    isAvailable: () => hasCapability("localImageSearch.getModelStatus"),
    getModelStatus: () => invoke("localImageSearch.getModelStatus"),
    downloadModel: () => invoke("localImageSearch.downloadModel"),
    cancelModelDownload: () => invoke("localImageSearch.cancelModelDownload"),
    importModel: () => invoke("localImageSearch.importModel"),
    exportModel: () => invoke("localImageSearch.exportModel"),
    removeModel: () => invoke("localImageSearch.removeModel"),
    listLibraries: () => invoke("localImageSearch.listLibraries"),
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
    getCredentials,
    getCredentialStatus,
    setCredentials,
    clearCredentials,
    selectExportDirectory,
    writeFileInChunks,
    saveBackup,
    openBackup,
    getUpdateState,
    checkForUpdates,
    downloadUpdate,
    installUpdate,
    onUpdateStateChanged,
    onBeforeQuit,
    readyToQuit,
    openExternal,
    localImageSearch,
  });
  globalScope.ngrFetch = request;
})(window);
