/* NGR AssetPilot V2.25 module: workspace-storage.js */
let namingWorkspaceDbPromise = null;
let namingWorkspaceSaveTimer = null;
let namingWorkspaceSaveChain = Promise.resolve();
let namingWorkspacePersistenceReady = false;
let namingWorkspaceWasRestored = false;
let namingWorkspaceRestoreWarning = "";
let namingWorkspaceListenersBound = false;
const namingWorkspacePersistedFileKeys = new Set();
const namingWorkspaceDirtyFileKeys = new Set();

function openNamingWorkspaceDb() {
  if (!("indexedDB" in window)) return Promise.reject(new Error("当前浏览器不支持 IndexedDB 本地存储"));
  if (namingWorkspaceDbPromise) return namingWorkspaceDbPromise;
  namingWorkspaceDbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(NAMING_WORKSPACE_DB_NAME, NAMING_WORKSPACE_DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains("workspace")) db.createObjectStore("workspace", { keyPath: "key" });
      if (!db.objectStoreNames.contains("files")) db.createObjectStore("files", { keyPath: "key" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("无法打开命名进度数据库"));
    request.onblocked = () => reject(new Error("命名进度数据库正在被其他页面占用，请关闭其他工具页面后重试"));
  });
  return namingWorkspaceDbPromise;
}

function idbRequest(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("IndexedDB 请求失败"));
  });
}

function idbTransactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error || new Error("IndexedDB 写入失败"));
    transaction.onabort = () => reject(transaction.error || new Error("IndexedDB 写入已中止"));
  });
}

function getWorkspaceAssetFileKey(sessionId, assetId) {
  return `asset:${sessionId}:${assetId}`;
}

function getWorkspaceReferenceFileKey(sessionId) {
  return `reference:${sessionId}`;
}

function serializeNamingAsset(asset) {
  const { file, url, ...metadata } = asset;
  return { ...metadata, url: "" };
}

function serializeNamingSession(session) {
  const metadata = { ...session };
  const sessionAssets = metadata.assets;
  delete metadata.assets;
  delete metadata.referenceFile;
  return {
    ...metadata,
    assets: (sessionAssets || []).map(serializeNamingAsset),
    referenceName: session.referenceName || session.referenceFile?.name || "",
    albumSettings: normalizeAlbumSettings(session.albumSettings),
    albumPage: normalizeAlbumPage(session.albumPage),
    albumEditorOpen: Boolean(session.albumEditorOpen),
    listDisplayMode: normalizeListDisplayMode(session.listDisplayMode),
    listSortMode: normalizeListSortMode(session.listSortMode),
  };
}

function buildNamingWorkspaceSnapshot() {
  saveCurrentNamingSession({ persist: false });
  return {
    key: NAMING_WORKSPACE_KEY,
    schemaVersion: 1,
    appVersion: APP_VERSION,
    savedAt: Date.now(),
    activeNamingSessionId,
    sessions: namingSessions.map(serializeNamingSession),
  };
}

function collectNamingWorkspaceFileChanges() {
  const validKeys = new Set();
  const recordsToWrite = [];
  namingSessions.forEach((session) => {
    (session.assets || []).forEach((asset) => {
      if (!asset.file) return;
      const key = getWorkspaceAssetFileKey(session.id, asset.id);
      validKeys.add(key);
      if (!namingWorkspacePersistedFileKeys.has(key) || namingWorkspaceDirtyFileKeys.has(key)) {
        recordsToWrite.push({ key, workspaceKey: NAMING_WORKSPACE_KEY, sessionId: session.id, assetId: asset.id, kind: "asset", storedAt: Date.now(), file: asset.file });
      }
    });
    if (session.referenceFile) {
      const key = getWorkspaceReferenceFileKey(session.id);
      validKeys.add(key);
      if (!namingWorkspacePersistedFileKeys.has(key) || namingWorkspaceDirtyFileKeys.has(key)) {
        recordsToWrite.push({ key, workspaceKey: NAMING_WORKSPACE_KEY, sessionId: session.id, kind: "reference", storedAt: Date.now(), file: session.referenceFile });
      }
    }
  });
  const staleKeys = [...namingWorkspacePersistedFileKeys].filter((key) => !validKeys.has(key));
  return { recordsToWrite, staleKeys };
}

async function performNamingWorkspaceSave(options = {}) {
  if (!namingWorkspacePersistenceReady && !options.force) return false;
  setNamingWorkspaceSaveStatus("saving", options.manual ? "正在保存全部进度…" : "正在自动保存…");
  if (els.saveNamingWorkspace) els.saveNamingWorkspace.disabled = true;
  try {
    const db = await openNamingWorkspaceDb();
    const snapshot = buildNamingWorkspaceSnapshot();
    const changes = collectNamingWorkspaceFileChanges();
    const transaction = db.transaction(["workspace", "files"], "readwrite");
    transaction.objectStore("workspace").put(snapshot);
    const fileStore = transaction.objectStore("files");
    changes.recordsToWrite.forEach((record) => fileStore.put(record));
    changes.staleKeys.forEach((key) => fileStore.delete(key));
    await idbTransactionDone(transaction);

    changes.recordsToWrite.forEach((record) => {
      namingWorkspacePersistedFileKeys.add(record.key);
      namingWorkspaceDirtyFileKeys.delete(record.key);
    });
    changes.staleKeys.forEach((key) => {
      namingWorkspacePersistedFileKeys.delete(key);
      namingWorkspaceDirtyFileKeys.delete(key);
    });
    setNamingWorkspaceSaveStatus("saved", `已保存 ${formatWorkspaceSavedTime(snapshot.savedAt)}`);
    if (options.requestPersistence && navigator.storage?.persist) navigator.storage.persist().catch(() => false);
    if (options.manual) showToast(`命名进度已保存，共 ${namingSessions.length} 条记录`);
    return true;
  } catch (error) {
    const quotaError = error?.name === "QuotaExceededError";
    const message = quotaError ? "保存失败：浏览器本地空间不足" : `保存失败：${error?.message || "本地数据库不可用"}`;
    setNamingWorkspaceSaveStatus("error", message);
    if (options.manual) showToast(message);
    throw error;
  } finally {
    if (els.saveNamingWorkspace) els.saveNamingWorkspace.disabled = false;
  }
}

function saveNamingWorkspaceNow(options = {}) {
  if (namingWorkspaceSaveTimer) {
    window.clearTimeout(namingWorkspaceSaveTimer);
    namingWorkspaceSaveTimer = null;
  }
  const operation = namingWorkspaceSaveChain.then(() => performNamingWorkspaceSave(options));
  namingWorkspaceSaveChain = operation.catch(() => false);
  return operation;
}

function scheduleNamingWorkspaceSave() {
  if (!namingWorkspacePersistenceReady) return;
  if (namingWorkspaceSaveTimer) window.clearTimeout(namingWorkspaceSaveTimer);
  setNamingWorkspaceSaveStatus("pending", "有未保存修改");
  namingWorkspaceSaveTimer = window.setTimeout(() => {
    namingWorkspaceSaveTimer = null;
    saveNamingWorkspaceNow().catch(() => false);
  }, NAMING_WORKSPACE_SAVE_DELAY);
}

function markCurrentReferenceFileDirty() {
  const session = getActiveNamingSession();
  if (!session) return;
  namingWorkspaceDirtyFileKeys.add(getWorkspaceReferenceFileKey(session.id));
  scheduleNamingWorkspaceSave();
}

async function restoreNamingWorkspaceFromStorage() {
  namingWorkspaceWasRestored = false;
  namingWorkspaceRestoreWarning = "";
  try {
    const db = await openNamingWorkspaceDb();
    const transaction = db.transaction(["workspace", "files"], "readonly");
    const transactionDone = idbTransactionDone(transaction);
    const workspaceRequest = idbRequest(transaction.objectStore("workspace").get(NAMING_WORKSPACE_KEY));
    const filesRequest = idbRequest(transaction.objectStore("files").getAll());
    const [snapshot, fileRecords] = await Promise.all([workspaceRequest, filesRequest]);
    await transactionDone;
    if (!snapshot) return false;
    const hasInvalidSession = Array.isArray(snapshot.sessions) && snapshot.sessions.some((session) => !session || typeof session.id !== "string" || !Array.isArray(session.assets));
    if (!Array.isArray(snapshot.sessions) || !snapshot.sessions.length || hasInvalidSession) {
      namingWorkspaceRestoreWarning = "本地命名进度数据损坏，已保留原存档并以空白记录启动";
      return false;
    }

    namingWorkspacePersistedFileKeys.clear();
    (fileRecords || []).forEach((record) => namingWorkspacePersistedFileKeys.add(record.key));

    const filesByKey = new Map((fileRecords || []).map((record) => [record.key, record]));
    let missingFileCount = 0;
    const restoredSessions = snapshot.sessions.map((savedSession) => {
      const restoredAssets = (savedSession.assets || []).flatMap((metadata) => {
        const record = filesByKey.get(getWorkspaceAssetFileKey(savedSession.id, metadata.id));
        if (!record?.file) {
          missingFileCount += 1;
          return [];
        }
        const wasRunning = metadata.namingStatus === "running";
        const restoredAsset = {
          ...metadata,
          file: record.file,
          url: "",
          namingStatus: wasRunning ? "idle" : metadata.namingStatus || "idle",
          statusMessage: wasRunning ? "上次命名任务已中断，可继续处理" : metadata.statusMessage || "",
        };
        if (restoredAsset.customBasePrefix != null && !restoredAsset.customBasePrefixId) {
          restoredAsset.customBasePrefixId = getPrefixEntryForValue(restoredAsset.customBasePrefix).id;
        }
        return [restoredAsset];
      });
      const referenceRecord = filesByKey.get(getWorkspaceReferenceFileKey(savedSession.id));
      if (savedSession.referenceName && !referenceRecord?.file) missingFileCount += 1;
      return {
        ...savedSession,
        params: {
          ...(savedSession.params || {}),
          basePrefixId: getPrefixEntryForValue(savedSession.params?.basePrefixId || savedSession.params?.basePrefix).id,
        },
        assets: restoredAssets,
        referenceFile: referenceRecord?.file || null,
        referenceName: savedSession.referenceName || referenceRecord?.file?.name || "",
        listDisplayMode: normalizeListDisplayMode(savedSession.listDisplayMode),
        listSortMode: normalizeListSortMode(savedSession.listSortMode),
        albumSettings: normalizeAlbumSettings(savedSession.albumSettings),
        albumPage: normalizeAlbumPage(savedSession.albumPage),
        albumEditorOpen: Boolean(savedSession.albumEditorOpen),
      };
    });

    namingSessions = restoredSessions;
    activeNamingSessionId = restoredSessions.some((session) => session.id === snapshot.activeNamingSessionId)
      ? snapshot.activeNamingSessionId
      : restoredSessions[0].id;
    namingWorkspaceWasRestored = true;
    if (missingFileCount) namingWorkspaceRestoreWarning = `有 ${missingFileCount} 张图片文件未能恢复，其他命名数据已保留`;
    return true;
  } catch (error) {
    namingWorkspaceRestoreWarning = `本地命名进度读取失败：${error?.message || "数据不可用"}`;
    return false;
  }
}

function enableNamingWorkspacePersistence() {
  namingWorkspacePersistenceReady = true;
  bindNamingWorkspaceStorage();
  if (namingWorkspaceWasRestored) {
    const restoredCount = namingSessions.reduce((count, session) => count + (session.assets?.length || 0), 0);
    setNamingWorkspaceSaveStatus("saved", `已恢复 ${namingSessions.length} 条记录 / ${restoredCount} 张图片`);
    showToast(namingWorkspaceRestoreWarning || `已恢复上次命名进度，共 ${restoredCount} 张图片`);
  } else if (namingWorkspaceRestoreWarning) {
    setNamingWorkspaceSaveStatus("error", namingWorkspaceRestoreWarning);
    showToast(namingWorkspaceRestoreWarning);
  }
}

function bindNamingWorkspaceStorage() {
  if (namingWorkspaceListenersBound) return;
  namingWorkspaceListenersBound = true;
  els.saveNamingWorkspace?.addEventListener("click", () => {
    saveNamingWorkspaceNow({ manual: true, force: true, requestPersistence: true }).catch(() => false);
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden" && namingWorkspaceSaveTimer) saveNamingWorkspaceNow({ force: true }).catch(() => false);
  });
  window.addEventListener("pagehide", () => {
    if (namingWorkspaceSaveTimer) saveNamingWorkspaceNow({ force: true }).catch(() => false);
  });
}

function setNamingWorkspaceSaveStatus(state, text) {
  if (!els.namingSaveStatus) return;
  els.namingSaveStatus.className = `naming-save-status is-${state}`;
  els.namingSaveStatus.textContent = text;
}

function formatWorkspaceSavedTime(timestamp) {
  return new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(new Date(timestamp));
}
