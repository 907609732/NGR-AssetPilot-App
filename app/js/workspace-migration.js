/* NGR AssetPilot V3.0.2 module: workspace-migration.js */
(function initializeWorkspaceMigrationModule(globalScope) {
  "use strict";

  const SETTINGS_SCHEMA_VERSION = 1;
  const MIGRATION_NOTICE_KEY = "ngr-assetpilot-desktop-migration-v1";
  const IMPORT_STAGING_DB = "ngr-assetpilot-import-staging-v1";
  const IMPORT_APPLY_JOURNAL_DB = "ngr-assetpilot-import-apply-journal-v1";
  const IMPORT_APPLY_JOURNAL_ID = "active";
  const settingsKeys = () => [APP_VERSION_KEY, ...APP_STORAGE_KEYS];
  let desktopInfo = { isDesktop: false, edition: "dev" };
  let credentialSaveChain = Promise.resolve();
  let desktopQuitListenerBound = false;
  let stagingCleanupPromise = Promise.resolve();

  function isDesktop() {
    return Boolean(globalScope.NgrDesktopBridge?.isDesktopRuntime());
  }

  function readJsonObject(rawValue) {
    try {
      const parsed = JSON.parse(rawValue || "null");
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }

  function redactStoredSettings(key, rawValue) {
    if (rawValue == null) return null;
    if (key === AI_SETTINGS_KEY) {
      const value = readJsonObject(rawValue);
      delete value.apiKey;
      return JSON.stringify(value);
    }
    if (key === TRANSLATION_SETTINGS_KEY) {
      const value = readJsonObject(rawValue);
      delete value.baiduAppId;
      delete value.baiduSecret;
      delete value.textApiKey;
      return JSON.stringify(value);
    }
    return String(rawValue);
  }

  function collectSettingsForBackup() {
    const entries = {};
    settingsKeys().forEach((key) => {
      entries[key] = redactStoredSettings(key, localStorage.getItem(key));
    });
    entries[APP_VERSION_KEY] = APP_VERSION;
    return {
      schemaVersion: SETTINGS_SCHEMA_VERSION,
      appVersion: APP_VERSION,
      entries,
    };
  }

  function collectCurrentCredentials() {
    const currentAi = typeof aiSettings === "undefined" ? {} : aiSettings || {};
    const currentTranslation = typeof translationSettings === "undefined" ? {} : translationSettings || {};
    return {
      ai: {
        provider: String(currentAi.provider || ""),
        apiFormat: String(currentAi.apiFormat || ""),
        baseUrl: String(currentAi.baseUrl || ""),
        apiKey: String(currentAi.apiKey || ""),
        model: String(currentAi.model || ""),
        providerNote: String(currentAi.providerNote || ""),
      },
      translation: {
        provider: String(currentTranslation.provider || ""),
        baiduAppId: String(currentTranslation.baiduAppId || ""),
        baiduSecret: String(currentTranslation.baiduSecret || ""),
        baiduEndpoint: String(currentTranslation.baiduEndpoint || ""),
        textBaseUrl: String(currentTranslation.textBaseUrl || ""),
        textApiKey: String(currentTranslation.textApiKey || ""),
        textModel: String(currentTranslation.textModel || ""),
      },
    };
  }

  function aiProviderId(settings = aiSettings || {}) {
    if (settings.provider === "kimi") return "moonshot";
    if (settings.provider === "compatible" || settings.provider === "custom") return "user-ai";
    return "openai";
  }

  function translationProviderId(settings = translationSettings || {}) {
    if (settings.provider === "baidu") return "baidu";
    if (settings.provider === "cfc") return "baidu-cfc";
    if (settings.provider === "model") return "user-translation-model";
    return "";
  }

  function normalizeCredentialPayload(value) {
    const source = value?.credentials && typeof value.credentials === "object" ? value.credentials : value || {};
    const aiSource = [source.ai, source.kimi, source.openai]
      .find((candidate) => candidate && typeof candidate === "object" && Object.keys(candidate).length) || {};
    const translationSource = [source.translation, source.baidu]
      .find((candidate) => candidate && typeof candidate === "object" && Object.keys(candidate).length) || {};
    return {
      ai: {
        provider: String(aiSource.provider || (source.kimi ? "kimi" : "")),
        apiFormat: String(aiSource.apiFormat || ""),
        baseUrl: String(aiSource.baseUrl || ""),
        apiKey: String(aiSource.apiKey || source.aiApiKey || source.kimiApiKey || ""),
        model: String(aiSource.model || ""),
        providerNote: String(aiSource.providerNote || ""),
      },
      translation: {
        provider: String(translationSource.provider || (source.baidu ? "baidu" : "")),
        baiduAppId: String(translationSource.baiduAppId || translationSource.appId || source.baiduAppId || ""),
        baiduSecret: String(translationSource.baiduSecret || translationSource.secret || source.baiduSecret || ""),
        baiduEndpoint: String(translationSource.baiduEndpoint || translationSource.endpoint || ""),
        textBaseUrl: String(translationSource.textBaseUrl || ""),
        textApiKey: String(translationSource.textApiKey || source.textApiKey || ""),
        textModel: String(translationSource.textModel || ""),
      },
    };
  }

  async function hydrateDesktopCredentials() {
    if (!isDesktop()) return false;
    const hasSavedTranslationChoice = Boolean(localStorage.getItem(TRANSLATION_SETTINGS_KEY));
    const legacy = collectCurrentCredentials();
    try {
      if (legacy.ai.apiKey || legacy.translation.baiduSecret || legacy.translation.textApiKey) {
        await globalScope.NgrDesktopBridge.importLegacyProviders({ ...legacy, onlyIfEmpty: true });
      }
    } catch (error) {
      console.warn("旧版桌面凭据迁移失败，将保留未配置状态", error?.message || error);
    }
    let providers = [];
    try {
      providers = await globalScope.NgrDesktopBridge.listProviders();
    } catch (error) {
      console.warn("桌面模型服务配置读取失败", error?.message || error);
    }
    const byId = new Map(providers.map((provider) => [provider.id, provider]));
    const ai = byId.get(aiProviderId(aiSettings));
    const managedCfc = byId.get("baidu-cfc")?.managed ? byId.get("baidu-cfc") : null;
    const translation = !hasSavedTranslationChoice && managedCfc
      ? managedCfc
      : byId.get(translationProviderId(translationSettings));
    aiSettings = normalizeAiSettings({
      ...aiSettings,
      providerId: ai?.id || aiProviderId(aiSettings),
      apiFormat: ai?.apiFormat || aiSettings.apiFormat,
      baseUrl: ai?.baseUrl || aiSettings.baseUrl,
      apiKey: "",
      hasSecret: Boolean(ai?.hasSecret),
      model: ai?.model || aiSettings.model,
      providerNote: ai?.name || aiSettings.providerNote,
    });
    translationSettings = normalizeTranslationSettings({
      ...translationSettings,
      provider: !hasSavedTranslationChoice && managedCfc ? "cfc" : translationSettings.provider,
      providerId: translation?.id || translationProviderId(translationSettings),
      baiduCredentialType: translation?.apiFormat === "baidu-ai" ? "apiKey" : translationSettings.baiduCredentialType,
      baiduAppId: "",
      baiduSecret: "",
      textApiKey: "",
      managed: Boolean(translation?.managed),
      managedCfcAvailable: Boolean(managedCfc),
      hasSecret: Boolean(translation?.hasSecret),
      baiduEndpoint: ["baidu", "baidu-cfc"].includes(translation?.id)
        ? translation.baseUrl
        : translationSettings.baiduEndpoint,
      textBaseUrl: translation?.id === "user-translation-model" ? translation.baseUrl : translationSettings.textBaseUrl,
      textModel: translation?.id === "user-translation-model" ? translation.model : translationSettings.textModel,
    });
    saveAiSettings(aiSettings, { skipDesktopSync: true });
    saveTranslationSettings(translationSettings, { skipDesktopSync: true });
    return true;
  }

  function queueDesktopCredentialSave() {
    if (!isDesktop()) return Promise.resolve(false);
    credentialSaveChain = credentialSaveChain
      .catch(() => false)
      .then(async () => {
        const aiId = aiProviderId(aiSettings);
        const aiResult = await globalScope.NgrDesktopBridge.upsertProvider({
          provider: {
            id: aiId,
            service: "ai",
            name: aiSettings.providerNote || undefined,
            baseUrl: aiSettings.baseUrl,
            apiFormat: aiSettings.apiFormat,
            model: aiSettings.model,
          },
          secretAction: aiSettings.apiKey ? "replace" : "keep",
          secret: aiSettings.apiKey ? { apiKey: aiSettings.apiKey } : undefined,
        });
        aiSettings.providerId = aiId;
        aiSettings.hasSecret = Boolean(aiResult?.hasSecret);
        aiSettings.apiKey = "";
        if (els?.openaiApiKey) {
          els.openaiApiKey.value = "";
          els.openaiApiKey.placeholder = aiSettings.hasSecret ? "已安全保存；留空表示保持不变" : "sk-...";
        }

        const translationId = translationProviderId(translationSettings);
        if (translationId) {
          const isBaidu = translationId === "baidu" || translationId === "baidu-cfc";
          const secretPresent = isBaidu
            ? Boolean(translationSettings.baiduAppId && translationSettings.baiduSecret)
            : Boolean(translationSettings.textApiKey);
          const result = await globalScope.NgrDesktopBridge.upsertProvider({
            provider: isBaidu ? {
              id: translationId,
              apiFormat: translationSettings.baiduCredentialType === "apiKey" ? "baidu-ai" : "baidu",
            } : {
              id: translationId,
              service: "translation",
              name: "自定义翻译模型",
              baseUrl: translationSettings.textBaseUrl,
              apiFormat: "chat",
              model: translationSettings.textModel,
            },
            secretAction: secretPresent ? "replace" : "keep",
            secret: isBaidu
              ? {
                  appId: translationSettings.baiduAppId,
                  credentialType: translationSettings.baiduCredentialType,
                  [translationSettings.baiduCredentialType === "apiKey" ? "apiKey" : "secret"]: translationSettings.baiduSecret,
                }
              : { apiKey: translationSettings.textApiKey },
          });
          translationSettings.providerId = translationId;
          translationSettings.managed = Boolean(result?.managed);
          translationSettings.managedCfcAvailable = Boolean(
            translationSettings.managedCfcAvailable || result?.managed,
          );
          translationSettings.hasSecret = Boolean(result?.hasSecret);
          translationSettings.baiduAppId = "";
          translationSettings.baiduSecret = "";
          translationSettings.textApiKey = "";
          if (els?.baiduTranslateAppId) els.baiduTranslateAppId.value = "";
          if (els?.baiduTranslateSecret) els.baiduTranslateSecret.value = "";
          if (els?.textTranslateApiKey) els.textTranslateApiKey.value = "";
        }
        saveAiSettings(aiSettings, { skipDesktopSync: true });
        saveTranslationSettings(translationSettings, { skipDesktopSync: true });
        return true;
      });
    credentialSaveChain.catch((error) => {
      console.error("桌面凭据保存失败", error?.message || error);
      if (typeof showToast === "function") showToast("凭据未能写入 Windows 安全存储");
    });
    return credentialSaveChain;
  }

  async function clearActiveAiCredential() {
    if (!isDesktop()) return false;
    const id = aiProviderId(aiSettings);
    const result = await globalScope.NgrDesktopBridge.upsertProvider({
      provider: {
        id,
        service: "ai",
        name: aiSettings.providerNote || undefined,
        baseUrl: aiSettings.baseUrl,
        apiFormat: aiSettings.apiFormat,
        model: aiSettings.model,
      },
      secretAction: "clear",
    });
    aiSettings.apiKey = "";
    aiSettings.hasSecret = Boolean(result?.hasSecret);
    els.openaiApiKey.value = "";
    fillAiSettings();
    await saveAiSettings(aiSettings, { skipDesktopSync: true });
    return true;
  }

  async function clearActiveTranslationCredential() {
    if (!isDesktop()) return false;
    const id = translationProviderId(translationSettings);
    if (!id) return false;
    const result = await globalScope.NgrDesktopBridge.upsertProvider({
      provider: id === "baidu" || id === "baidu-cfc" ? {
        id,
        apiFormat: translationSettings.baiduCredentialType === "apiKey" ? "baidu-ai" : "baidu",
      } : {
        id,
        service: "translation",
        name: "自定义翻译模型",
        baseUrl: translationSettings.textBaseUrl,
        apiFormat: "chat",
        model: translationSettings.textModel,
      },
      secretAction: "clear",
    });
    translationSettings.baiduAppId = "";
    translationSettings.baiduSecret = "";
    translationSettings.textApiKey = "";
    translationSettings.managed = Boolean(result?.managed);
    translationSettings.managedCfcAvailable = Boolean(
      translationSettings.managedCfcAvailable || result?.managed,
    );
    translationSettings.hasSecret = Boolean(result?.hasSecret);
    fillTranslationSettings();
    await saveTranslationSettings(translationSettings, { skipDesktopSync: true });
    return true;
  }

  async function readRawWorkspaceState() {
    const db = await openNamingWorkspaceDb();
    const transaction = db.transaction(["workspace", "files"], "readonly");
    const done = idbTransactionDone(transaction);
    const workspaceRequest = idbRequest(transaction.objectStore("workspace").get(NAMING_WORKSPACE_KEY));
    const filesRequest = idbRequest(transaction.objectStore("files").getAll());
    const [workspace, files] = await Promise.all([workspaceRequest, filesRequest]);
    await done;
    return { workspace, files: files || [] };
  }

  function replaceRawWorkspaceState(state) {
    return openNamingWorkspaceDb().then((db) => {
      const transaction = db.transaction(["workspace", "files"], "readwrite");
      const workspaceStore = transaction.objectStore("workspace");
      const fileStore = transaction.objectStore("files");
      workspaceStore.clear();
      fileStore.clear();
      if (state.workspace) workspaceStore.put(state.workspace);
      (state.files || []).forEach((record) => fileStore.put(record));
      return idbTransactionDone(transaction);
    });
  }

  function safeArchiveNamePart(value) {
    return String(value || "file")
      .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
      .replace(/[. ]+$/g, "")
      .slice(0, 100) || "file";
  }

  function buildFileArchivePath(record, index) {
    const category = record.kind === "reference" ? "references" : "assets";
    const name = safeArchiveNamePart(record.file?.name || `${record.kind || "asset"}.bin`);
    return `files/${category}/${String(index + 1).padStart(6, "0")}-${name}`;
  }

  async function collectArchiveFiles(records) {
    const result = [];
    for (let index = 0; index < records.length; index += 1) {
      const record = records[index];
      if (!record?.file || typeof record.file.arrayBuffer !== "function") continue;
      result.push({
        path: buildFileArchivePath(record, index),
        key: record.key,
        workspaceKey: record.workspaceKey,
        sessionId: record.sessionId,
        assetId: record.assetId,
        kind: record.kind,
        storedAt: record.storedAt,
        name: record.file.name,
        type: record.file.type,
        lastModified: record.file.lastModified,
        data: new Uint8Array(await record.file.arrayBuffer()),
      });
    }
    return result;
  }

  async function createCurrentArchive(options = {}) {
    if (isDesktop()) {
      const error = new Error("桌面版只允许使用流式备份，当前运行环境缺少所需能力");
      error.code = "DESKTOP_STREAM_REQUIRED";
      throw error;
    }
    await saveNamingWorkspaceNow({ force: true });
    const raw = await readRawWorkspaceState();
    const workspace = raw.workspace || buildNamingWorkspaceSnapshot();
    const files = await collectArchiveFiles(raw.files);
    return globalScope.NgrWorkspaceBackup.buildArchive({
      settings: collectSettingsForBackup(),
      workspace,
      files,
      secrets: options.includeSecrets ? collectCurrentCredentials() : null,
    }, {
      password: options.password || "",
      appVersion: APP_VERSION,
      fflate: globalScope.fflate,
    });
  }

  function createStreamingFileRecords(records) {
    return records
      .map((record, index) => {
        if (!record?.file || typeof record.file.arrayBuffer !== "function") return null;
        return {
          path: buildFileArchivePath(record, index),
          key: record.key,
          workspaceKey: record.workspaceKey,
          sessionId: record.sessionId,
          assetId: record.assetId,
          kind: record.kind,
          storedAt: record.storedAt,
          name: record.file.name,
          mimeType: record.file.type,
          lastModified: record.file.lastModified,
          file: record.file,
        };
      })
      .filter(Boolean);
  }

  async function saveCurrentArchiveStreaming(filename) {
    if (!isDesktop() || typeof Worker !== "function"
      || typeof globalScope.NgrDesktopBridge?.beginBackupStream !== "function") return null;
    await saveNamingWorkspaceNow({ force: true });
    const raw = await readRawWorkspaceState();
    const workspace = raw.workspace || buildNamingWorkspaceSnapshot();
    const settings = collectSettingsForBackup();
    globalScope.NgrWorkspaceBackup.validateSettings(settings);
    globalScope.NgrWorkspaceBackup.validateWorkspace(workspace);
    const begin = await globalScope.NgrDesktopBridge.beginBackupStream(filename);
    if (begin?.canceled) throw new DOMException("用户取消保存", "AbortError");
    let worker;
    try {
      worker = new Worker(`js/workspace-backup-stream-worker.js?v=${encodeURIComponent(APP_VERSION)}`);
    } catch (error) {
      await globalScope.NgrDesktopBridge.cancelBackupStream(begin.sessionId).catch(() => {});
      throw error;
    }
    let offset = 0;
    let settled = false;
    return new Promise((resolve, reject) => {
      const cleanup = () => worker.terminate();
      const fail = async (error) => {
        if (settled) return;
        settled = true;
        await globalScope.NgrDesktopBridge.cancelBackupStream(begin.sessionId).catch(() => {});
        cleanup();
        reject(error);
      };
      worker.onerror = (event) => {
        void fail(new Error(event.message || "流式备份 Worker 异常退出"));
      };
      worker.onmessage = async (event) => {
        const message = event.data || {};
        if (message.type === "chunk") {
          try {
            const result = await globalScope.NgrDesktopBridge.writeBackupStreamChunk(
              begin.sessionId,
              offset,
              message.data,
            );
            offset = Number(result?.nextOffset ?? (offset + message.data.byteLength));
            worker.postMessage({ type: "ack", acknowledgmentId: message.acknowledgmentId });
          } catch (error) {
            worker.postMessage({
              type: "ack",
              acknowledgmentId: message.acknowledgmentId,
              error: error?.message || "备份分块写入失败",
            });
            await fail(error);
          }
          return;
        }
        if (message.type === "error") {
          const error = new Error(message.message || "流式备份失败");
          error.code = message.code || "STREAM_BACKUP_FAILED";
          await fail(error);
          return;
        }
        if (message.type === "done" && !settled) {
          try {
            const result = await globalScope.NgrDesktopBridge.finishBackupStream(begin.sessionId);
            settled = true;
            cleanup();
            resolve({ result, manifest: message.manifest });
          } catch (error) {
            await fail(error);
          }
        }
      };
      try {
        worker.postMessage({
          type: "start",
          payload: {
            settings,
            workspace,
            files: createStreamingFileRecords(raw.files || []),
            appVersion: APP_VERSION,
            createdAt: new Date().toISOString(),
          },
        });
      } catch (error) {
        void fail(error);
      }
    });
  }

  function timestampForFilename() {
    return new Date().toISOString().replace(/[:.]/g, "-");
  }

  function downloadBytes(bytes, filename) {
    const blob = new Blob([bytes], { type: "application/vnd.ngr.assetpilot+zip" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.click();
    globalScope.setTimeout(() => URL.revokeObjectURL(url), 1500);
  }

  async function saveArchiveBytes(bytes, filename, options = {}) {
    if (isDesktop()) {
      const error = new Error("桌面版已停用整包备份接口，请使用流式备份");
      error.code = "DESKTOP_STREAM_REQUIRED";
      throw error;
    }
    downloadBytes(bytes, filename);
    return { saved: true, filename };
  }

  function setMigrationBusy(busy, message = "") {
    [els.exportWorkspaceBackup, els.importWorkspaceBackup].forEach((button) => {
      if (button) button.disabled = busy;
    });
    if (els.workspaceMigrationStatus && message) els.workspaceMigrationStatus.textContent = message;
  }

  async function exportWorkspaceBackup() {
    const includeSecrets = !isDesktop() && Boolean(els.includeBackupSecrets?.checked);
    const password = els.workspaceBackupPassword?.value || "";
    if (includeSecrets && password.length < globalScope.NgrWorkspaceBackup.MIN_PASSWORD_LENGTH) {
      showToast(`携带凭据时，迁移密码至少需要 ${globalScope.NgrWorkspaceBackup.MIN_PASSWORD_LENGTH} 个字符`);
      els.workspaceBackupPassword?.focus();
      return;
    }
    setMigrationBusy(true, "正在整理工作区和图片…");
    try {
      const filename = `NGR-AssetPilot-${APP_VERSION}-${timestampForFilename()}.ngrap`;
      const streamed = !includeSecrets ? await saveCurrentArchiveStreaming(filename) : null;
      if (isDesktop() && !streamed) {
        const error = new Error("桌面版流式备份能力不可用，请更新或重新安装软件");
        error.code = "DESKTOP_STREAM_REQUIRED";
        throw error;
      }
      if (!isDesktop() && !streamed) {
        const archive = await createCurrentArchive({ includeSecrets, password });
        await saveArchiveBytes(archive.bytes, filename);
      }
      els.workspaceBackupPassword.value = "";
      setMigrationBusy(false, `迁移包已生成：${filename}`);
      showToast(includeSecrets ? "迁移包已导出，凭据已用密码加密" : "迁移包已导出（不含凭据）");
    } catch (error) {
      setMigrationBusy(false, `导出失败：${error?.message || "未知错误"}`);
      if (error?.name !== "AbortError") showToast(`迁移包导出失败：${error?.message || "未知错误"}`);
    }
  }

  function openImportStagingDb() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(IMPORT_STAGING_DB, 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        const chunks = db.createObjectStore("chunks", { keyPath: ["sessionId", "path", "sequence"] });
        chunks.createIndex("by-session", "sessionId", { unique: false });
        chunks.createIndex("by-entry", ["sessionId", "path"], { unique: false });
        const entries = db.createObjectStore("entries", { keyPath: ["sessionId", "path"] });
        entries.createIndex("by-session", "sessionId", { unique: false });
        db.createObjectStore("sessions", { keyPath: "sessionId" });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("无法打开导入暂存数据库"));
    });
  }

  async function readStagedFileBlob(descriptor) {
    const sessionId = String(descriptor?.stagingSessionId || "");
    const path = globalScope.NgrWorkspaceBackup.validateArchivePath(descriptor?.path);
    if (!sessionId || !Number.isSafeInteger(Number(descriptor?.stagingChunkCount))) {
      throw new Error("导入暂存文件描述无效");
    }
    const db = await openImportStagingDb();
    try {
      const transaction = db.transaction("chunks", "readonly");
      const done = idbTransactionDone(transaction);
      const records = await idbRequest(
        transaction.objectStore("chunks").index("by-entry").getAll(IDBKeyRange.only([sessionId, path])),
      );
      await done;
      records.sort((left, right) => left.sequence - right.sequence);
      if (records.length !== Number(descriptor.stagingChunkCount)) throw new Error(`导入暂存文件不完整：${path}`);
      const blob = new Blob(records.map((record) => record.data), { type: descriptor.type || "application/octet-stream" });
      if (blob.size !== Number(descriptor.size)) throw new Error(`导入暂存文件大小错误：${path}`);
      return blob;
    } finally {
      db.close();
    }
  }

  async function clearImportStagingSession(sessionId) {
    if (!sessionId || !("indexedDB" in globalScope)) return;
    const db = await openImportStagingDb();
    try {
      const transaction = db.transaction(["chunks", "entries", "sessions"], "readwrite");
      const done = idbTransactionDone(transaction);
      const range = IDBKeyRange.only(String(sessionId));
      for (const storeName of ["chunks", "entries"]) {
        const store = transaction.objectStore(storeName);
        const request = store.index("by-session").openKeyCursor(range);
        request.onsuccess = () => {
          const cursor = request.result;
          if (!cursor) return;
          store.delete(cursor.primaryKey);
          cursor.continue();
        };
      }
      transaction.objectStore("sessions").delete(String(sessionId));
      await done;
    } finally {
      db.close();
    }
  }

  async function clearAllImportStagingSessions() {
    if (!("indexedDB" in globalScope)) return;
    const db = await openImportStagingDb();
    let sessionIds;
    try {
      const transaction = db.transaction("sessions", "readonly");
      const done = idbTransactionDone(transaction);
      sessionIds = await idbRequest(transaction.objectStore("sessions").getAllKeys());
      await done;
    } finally {
      db.close();
    }
    for (const sessionId of sessionIds) await clearImportStagingSession(sessionId);
  }

  function openWorkspaceApplyJournalDb() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(IMPORT_APPLY_JOURNAL_DB, 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        db.createObjectStore("meta", { keyPath: "id" });
        db.createObjectStore("files", { keyPath: "key" });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("无法打开迁移回滚日志"));
    });
  }

  async function prepareWorkspaceApplyJournal(transactionId) {
    if (!/^[0-9a-f-]{36}$/i.test(String(transactionId || ""))) throw new Error("迁移应用事务无效");
    const previousWorkspace = await readRawWorkspaceState();
    const db = await openWorkspaceApplyJournalDb();
    try {
      const transaction = db.transaction(["meta", "files"], "readwrite");
      const done = idbTransactionDone(transaction);
      const meta = transaction.objectStore("meta");
      const files = transaction.objectStore("files");
      meta.clear();
      files.clear();
      meta.put({
        id: IMPORT_APPLY_JOURNAL_ID,
        transactionId: String(transactionId),
        workspace: previousWorkspace.workspace || null,
        settings: snapshotLocalSettings({ redactSecrets: true }),
        migrationNotice: localStorage.getItem(MIGRATION_NOTICE_KEY),
        createdAt: Date.now(),
      });
      previousWorkspace.files.forEach((record) => files.put(record));
      await done;
    } finally {
      db.close();
    }
  }

  async function readWorkspaceApplyJournal() {
    const db = await openWorkspaceApplyJournalDb();
    try {
      const transaction = db.transaction(["meta", "files"], "readonly");
      const done = idbTransactionDone(transaction);
      const metaRequest = idbRequest(transaction.objectStore("meta").get(IMPORT_APPLY_JOURNAL_ID));
      const filesRequest = idbRequest(transaction.objectStore("files").getAll());
      const [meta, files] = await Promise.all([metaRequest, filesRequest]);
      await done;
      if (!meta) return null;
      if (!/^[0-9a-f-]{36}$/i.test(String(meta.transactionId || "")) || !meta.settings || typeof meta.settings !== "object") {
        throw new Error("迁移回滚日志无效");
      }
      return { ...meta, files: files || [] };
    } finally {
      db.close();
    }
  }

  async function clearWorkspaceApplyJournal() {
    const db = await openWorkspaceApplyJournalDb();
    try {
      const transaction = db.transaction(["meta", "files"], "readwrite");
      transaction.objectStore("meta").clear();
      transaction.objectStore("files").clear();
      await idbTransactionDone(transaction);
    } finally {
      db.close();
    }
  }

  function restoreLocalSettings(snapshot) {
    settingsKeys().forEach((key) => {
      const value = snapshot?.[key];
      if (value == null) localStorage.removeItem(key);
      else localStorage.setItem(key, String(value));
    });
  }

  async function restoreWorkspaceApplyJournal(journal) {
    await replaceRawWorkspaceState({ workspace: journal.workspace, files: journal.files || [] });
    restoreLocalSettings(journal.settings);
    if (journal.migrationNotice == null) localStorage.removeItem(MIGRATION_NOTICE_KEY);
    else localStorage.setItem(MIGRATION_NOTICE_KEY, String(journal.migrationNotice));
  }

  async function recoverInterruptedWorkspaceImport() {
    if (!isDesktop() || !("indexedDB" in globalScope)) return false;
    const journal = await readWorkspaceApplyJournal();
    if (!journal) return false;
    const bridge = globalScope.NgrDesktopBridge;
    if (
      typeof bridge?.getBackupApplyState !== "function" ||
      typeof bridge?.rollbackBackupApply !== "function" ||
      typeof bridge?.finalizeBackupApply !== "function"
    ) {
      throw new Error("检测到未完成的迁移，但当前版本缺少恢复能力；为保护原工作区已停止启动");
    }
    const state = await bridge.getBackupApplyState(journal.transactionId);
    if (state?.phase === "committed") {
      await clearWorkspaceApplyJournal();
      await bridge.finalizeBackupApply(journal.transactionId).catch(() => {});
      return true;
    }
    await restoreWorkspaceApplyJournal(journal);
    if (state?.phase === "prepared") await bridge.rollbackBackupApply(journal.transactionId);
    await clearWorkspaceApplyJournal();
    if (state?.phase !== "missing") await bridge.finalizeBackupApply(journal.transactionId).catch(() => {});
    return true;
  }

  function snapshotLocalSettings(options = {}) {
    return Object.fromEntries(settingsKeys().map((key) => {
      const value = localStorage.getItem(key);
      return [key, options.redactSecrets ? redactStoredSettings(key, value) : value];
    }));
  }

  function validateImportedSettingKeys(entries) {
    const allowed = new Set(settingsKeys());
    Object.keys(entries || {}).forEach((key) => {
      if (!allowed.has(key)) throw new Error(`迁移包包含不受支持的设置项：${key}`);
    });
  }

  function mergeSecretsIntoEntries(entries, secrets) {
    const result = { ...entries };
    if (!secrets) return result;
    const normalized = normalizeCredentialPayload(secrets);
    const ai = readJsonObject(result[AI_SETTINGS_KEY]);
    ["provider", "apiFormat", "baseUrl", "model", "providerNote"].forEach((key) => {
      if (normalized.ai[key]) ai[key] = normalized.ai[key];
    });
    ai.apiKey = normalized.ai.apiKey;
    result[AI_SETTINGS_KEY] = JSON.stringify(ai);
    const translation = readJsonObject(result[TRANSLATION_SETTINGS_KEY]);
    ["provider", "baiduEndpoint", "textBaseUrl", "textModel"].forEach((key) => {
      if (normalized.translation[key]) translation[key] = normalized.translation[key];
    });
    translation.baiduAppId = normalized.translation.baiduAppId;
    translation.baiduSecret = normalized.translation.baiduSecret;
    translation.textApiKey = normalized.translation.textApiKey;
    result[TRANSLATION_SETTINGS_KEY] = JSON.stringify(translation);
    return result;
  }

  function applyLocalSettings(entries) {
    validateImportedSettingKeys(entries);
    settingsKeys().forEach((key) => {
      const value = entries[key];
      if (value == null) localStorage.removeItem(key);
      else localStorage.setItem(key, String(value));
    });
    localStorage.setItem(APP_VERSION_KEY, APP_VERSION);
  }

  async function buildImportedWorkspaceState(parsed) {
    const sessions = new Map(parsed.workspace.sessions.map((session) => [session.id, session]));
    const seenKeys = new Set();
    const records = [];
    for (const descriptor of parsed.files) {
      const session = sessions.get(String(descriptor.sessionId || ""));
      if (!session) throw new Error("迁移包文件引用了不存在的命名记录");
      let key;
      if (descriptor.kind === "reference") {
        key = getWorkspaceReferenceFileKey(session.id);
      } else {
        const asset = session.assets.find((item) => item.id === descriptor.assetId);
        if (!asset) throw new Error("迁移包文件引用了不存在的图片记录");
        key = getWorkspaceAssetFileKey(session.id, asset.id);
      }
      if (seenKeys.has(key)) throw new Error("迁移包包含重复的工作区文件");
      seenKeys.add(key);
      const source = descriptor.stagingSessionId
        ? await readStagedFileBlob(descriptor)
        : descriptor.data;
      const file = new File([source], safeArchiveNamePart(descriptor.name), {
        type: descriptor.type || "application/octet-stream",
        lastModified: Number(descriptor.lastModified || Date.now()),
      });
      records.push({
        key,
        workspaceKey: NAMING_WORKSPACE_KEY,
        sessionId: session.id,
        ...(descriptor.kind === "asset" ? { assetId: descriptor.assetId } : {}),
        kind: descriptor.kind,
        storedAt: Number(descriptor.storedAt || Date.now()),
        file,
      });
    }
    parsed.workspace.sessions.forEach((session) => {
      session.assets.forEach((asset) => {
        if (!seenKeys.has(getWorkspaceAssetFileKey(session.id, asset.id))) throw new Error("迁移包缺少命名图片文件");
      });
      if (session.referenceName && !seenKeys.has(getWorkspaceReferenceFileKey(session.id))) throw new Error("迁移包缺少参考效果图文件");
    });
    return {
      workspace: { ...parsed.workspace, key: NAMING_WORKSPACE_KEY, appVersion: APP_VERSION, savedAt: Date.now() },
      files: records,
    };
  }

  async function createAutomaticPreImportBackup() {
    const filename = `NGR-AssetPilot-导入前自动备份-${timestampForFilename()}.ngrap`;
    const streamed = await saveCurrentArchiveStreaming(filename);
    if (isDesktop() && !streamed) {
      const error = new Error("无法创建流式导入前备份，已取消导入且未修改工作区");
      error.code = "DESKTOP_STREAM_REQUIRED";
      throw error;
    }
    if (!isDesktop() && !streamed) {
      const archive = await createCurrentArchive({ includeSecrets: false });
      await saveArchiveBytes(archive.bytes, filename, { automatic: true });
    }
    return filename;
  }

  async function applyImportedArchive(parsed) {
    const importedState = await buildImportedWorkspaceState(parsed);
    const previousWorkspace = await readRawWorkspaceState();
    const previousSettings = snapshotLocalSettings();
    const previousMigrationNotice = localStorage.getItem(MIGRATION_NOTICE_KEY);
    const importedEntries = isDesktop()
      ? parsed.settings.entries
      : mergeSecretsIntoEntries(parsed.settings.entries, parsed.secrets || collectCurrentCredentials());
    validateImportedSettingKeys(importedEntries);

    let workspaceReplaced = false;
    try {
      await replaceRawWorkspaceState(importedState);
      workspaceReplaced = true;
      applyLocalSettings(importedEntries);
      localStorage.setItem(MIGRATION_NOTICE_KEY, "completed");
    } catch (error) {
      let rollbackError = null;
      if (workspaceReplaced) {
        try {
          await replaceRawWorkspaceState(previousWorkspace);
        } catch (candidate) {
          rollbackError = candidate;
        }
      }
      try {
        restoreLocalSettings(previousSettings);
        if (previousMigrationNotice == null) localStorage.removeItem(MIGRATION_NOTICE_KEY);
        else localStorage.setItem(MIGRATION_NOTICE_KEY, previousMigrationNotice);
      } catch (candidate) {
        rollbackError ||= candidate;
      }
      if (rollbackError) {
        const failed = new Error("迁移导入失败，且当前工作区未能自动恢复；请保留自动备份并重新启动软件");
        failed.code = "WORKSPACE_IMPORT_ROLLBACK_FAILED";
        throw failed;
      }
      throw error;
    }
  }

  function createImportWorkerClient(worker) {
    const pending = new Map();
    let sequence = 0;
    const failAll = (error) => {
      for (const request of pending.values()) request.reject(error);
      pending.clear();
    };
    worker.onerror = (event) => failAll(new Error(event.message || "流式导入 Worker 异常退出"));
    worker.onmessage = (event) => {
      const message = event.data || {};
      const request = pending.get(message.requestId);
      if (!request) return;
      pending.delete(message.requestId);
      if (message.type === "import-error") {
        const error = new Error(message.message || "流式导入失败");
        error.code = message.code || "STREAM_IMPORT_FAILED";
        request.reject(error);
      } else {
        request.resolve(message);
      }
    };
    return {
      request(type, payload = {}, transfer = []) {
        const requestId = `import_${Date.now().toString(36)}_${++sequence}`;
        return new Promise((resolve, reject) => {
          pending.set(requestId, { resolve, reject });
          try {
            worker.postMessage({ type, requestId, ...payload }, transfer);
          } catch (error) {
            pending.delete(requestId);
            reject(error);
          }
        });
      },
      close() {
        failAll(new Error("流式导入 Worker 已关闭"));
        worker.terminate();
      },
    };
  }

  function asTransferableArrayBuffer(value) {
    if (value instanceof ArrayBuffer) return value;
    if (ArrayBuffer.isView(value)) {
      return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
    }
    throw new Error("桌面端返回了无效的备份分块");
  }

  async function importWorkspaceBackupStream() {
    await stagingCleanupPromise;
    const begin = await globalScope.NgrDesktopBridge.beginBackupImport();
    if (!begin || begin.canceled) return;
    const password = els.workspaceBackupPassword?.value || "";
    let worker = null;
    let client = null;
    let parsed = null;
    let stagingSessionId = "";
    let sourceFinished = false;
    let applyTransactionId = "";
    let applyJournalPrepared = false;
    let applyCommitted = false;
    setMigrationBusy(true, `正在流式校验 ${begin.name || "workspace.ngrap"}…`);
    try {
      worker = new Worker(`js/workspace-backup-stream-worker.js?v=${encodeURIComponent(APP_VERSION)}`);
      client = createImportWorkerClient(worker);
      await client.request("import-start", {
        payload: { sessionId: begin.sessionId, hasPassword: Boolean(password) },
      });
      let offset = 0;
      if (Number(begin.size) === 0) {
        const empty = new ArrayBuffer(0);
        const result = await client.request("import-chunk", {
          sessionId: begin.sessionId,
          data: empty,
          final: true,
        }, [empty]);
        parsed = result.parsed || null;
        stagingSessionId = String(parsed?.stagingSessionId || "");
      }
      while (offset < Number(begin.size)) {
        const chunk = await globalScope.NgrDesktopBridge.readBackupImportChunk(
          begin.sessionId,
          offset,
          Math.min(Number(begin.chunkSize || 1024 * 1024), Number(begin.size) - offset),
        );
        if (Number(chunk?.offset) !== offset || Number(chunk?.nextOffset) <= offset || Number(chunk?.nextOffset) > Number(begin.size)) {
          throw new Error("备份分块顺序或长度无效");
        }
        const data = asTransferableArrayBuffer(chunk.data);
        if (data.byteLength !== Number(chunk.nextOffset) - offset) throw new Error("备份分块长度与偏移不一致");
        offset = Number(chunk.nextOffset);
        const final = offset === Number(begin.size);
        const result = await client.request("import-chunk", {
          sessionId: begin.sessionId,
          data,
          final,
        }, [data]);
        if (final) {
          if (!result.complete || !result.parsed) throw new Error("备份流结束但没有生成已校验的暂存数据");
          parsed = result.parsed;
          stagingSessionId = String(parsed.stagingSessionId || "");
        } else {
          const processedMiB = (offset / (1024 * 1024)).toFixed(0);
          const totalMiB = (Number(begin.size) / (1024 * 1024)).toFixed(0);
          setMigrationBusy(true, `正在校验 ${begin.name || "workspace.ngrap"}：${processedMiB}/${totalMiB} MiB…`);
        }
      }
      if (!parsed) throw new Error("备份未能完成流式校验");
      await globalScope.NgrDesktopBridge.finishBackupImport(begin.sessionId);
      sourceFinished = true;
      client.close();
      client = null;
      worker = null;

      setMigrationBusy(true, "校验通过，正在创建导入前自动备份…");
      await createAutomaticPreImportBackup();
      setMigrationBusy(true, "正在事务性导入工作区…");
      const applyTransaction = await globalScope.NgrDesktopBridge.beginBackupApply();
      applyTransactionId = String(applyTransaction?.transactionId || "");
      await prepareWorkspaceApplyJournal(applyTransactionId);
      applyJournalPrepared = true;
      await applyImportedArchive(parsed);
      if (parsed.legacySecretBlock) {
        const imported = await globalScope.NgrDesktopBridge.importBackupLegacySecrets(
          applyTransactionId,
          parsed.legacySecretBlock,
          password,
        );
        if (!imported?.imported) throw new Error("迁移包中的凭据未能导入 Windows 安全存储");
      }
      await globalScope.NgrDesktopBridge.commitBackupApply(applyTransactionId);
      applyCommitted = true;
      try {
        await clearWorkspaceApplyJournal();
        applyJournalPrepared = false;
        await globalScope.NgrDesktopBridge.finalizeBackupApply(applyTransactionId);
        applyTransactionId = "";
      } catch (cleanupError) {
        console.warn("迁移已提交，清理恢复日志失败；下次启动会自动完成", cleanupError?.message || cleanupError);
      }
      els.workspaceBackupPassword.value = "";
      setMigrationBusy(false, "迁移完成，正在重新载入工作区…");
      showToast("迁移完成，工作区即将重新载入");
      globalScope.setTimeout(() => globalScope.location.reload(), 500);
    } catch (error) {
      if (applyTransactionId && !applyCommitted) {
        try {
          await globalScope.NgrDesktopBridge.rollbackBackupApply(applyTransactionId);
          if (applyJournalPrepared) await restoreWorkspaceApplyJournal(await readWorkspaceApplyJournal());
          await clearWorkspaceApplyJournal();
          applyJournalPrepared = false;
          await globalScope.NgrDesktopBridge.finalizeBackupApply(applyTransactionId).catch(() => {});
          applyTransactionId = "";
        } catch (rollbackError) {
          const failed = new Error("迁移导入失败，且回滚尚未完成；请重新启动软件以自动恢复导入前状态");
          failed.code = "WORKSPACE_IMPORT_ROLLBACK_PENDING";
          error = failed;
          console.error("迁移回滚将在下次启动继续", rollbackError?.message || rollbackError);
        }
      }
      const message = error?.code === "PASSWORD_REQUIRED" ? "该迁移包包含加密凭据，请输入迁移密码"
        : error?.code === "DECRYPTION_FAILED" ? "迁移密码错误或迁移包已损坏"
          : error?.message || "未知错误";
      setMigrationBusy(false, `导入失败：${message}`);
      showToast(`迁移包导入失败：${message}`);
      if (["PASSWORD_REQUIRED", "PASSWORD_TOO_SHORT", "DECRYPTION_FAILED"].includes(error?.code)) els.workspaceBackupPassword?.focus();
    } finally {
      if (!sourceFinished) {
        await globalScope.NgrDesktopBridge.cancelBackupImport(begin.sessionId).catch(() => {});
      }
      client?.close();
      worker?.terminate();
      if (parsed?.legacySecretBlock instanceof ArrayBuffer) {
        try { new Uint8Array(parsed.legacySecretBlock).fill(0); } catch {}
      }
      if (stagingSessionId) await clearImportStagingSession(stagingSessionId).catch(() => {});
    }
  }

  async function importWorkspaceBackupBytes(bytes, sourceName = "workspace.ngrap") {
    if (isDesktop()) {
      const error = new Error("桌面版已停用整包导入接口，请使用流式导入");
      error.code = "DESKTOP_STREAM_REQUIRED";
      throw error;
    }
    const password = els.workspaceBackupPassword?.value || "";
    setMigrationBusy(true, `正在校验 ${sourceName}…`);
    try {
      const parsed = await globalScope.NgrWorkspaceBackup.parseArchive(bytes, {
        password,
        fflate: globalScope.fflate,
      });
      setMigrationBusy(true, "校验通过，正在创建导入前自动备份…");
      await createAutomaticPreImportBackup();
      setMigrationBusy(true, "正在事务性导入工作区…");
      await applyImportedArchive(parsed);
      els.workspaceBackupPassword.value = "";
      setMigrationBusy(false, "迁移完成，正在重新载入工作区…");
      showToast("迁移完成，工作区即将重新载入");
      globalScope.setTimeout(() => globalScope.location.reload(), 500);
    } catch (error) {
      const message = error?.code === "PASSWORD_REQUIRED" ? "该迁移包包含加密凭据，请输入迁移密码"
        : error?.code === "DECRYPTION_FAILED" ? "迁移密码错误或迁移包已损坏"
          : error?.message || "未知错误";
      setMigrationBusy(false, `导入失败：${message}`);
      showToast(`迁移包导入失败：${message}`);
      if (["PASSWORD_REQUIRED", "PASSWORD_TOO_SHORT", "DECRYPTION_FAILED"].includes(error?.code)) els.workspaceBackupPassword?.focus();
    }
  }

  async function chooseWorkspaceBackup() {
    if (isDesktop()) {
      const requiredCapabilities = [
        "backup.beginImport",
        "backup.readImportChunk",
        "backup.finishImport",
        "backup.beginApply",
        "backup.commitApply",
        "backup.getApplyState",
        "backup.rollbackApply",
        "backup.finalizeApply",
      ];
      if (requiredCapabilities.every((capability) => globalScope.NgrDesktopBridge.hasCapability(capability))) {
        await importWorkspaceBackupStream();
        return;
      }
      const message = "当前桌面版缺少安全流式导入能力，请更新或重新安装软件";
      setMigrationBusy(false, `读取失败：${message}`);
      showToast(message);
      return;
    }
    els.workspaceBackupInput?.click();
  }

  async function importWorkspaceBackupFile(event) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (isDesktop()) {
      showToast("桌面版仅允许通过安全流式导入选择迁移包");
      return;
    }
    await importWorkspaceBackupBytes(new Uint8Array(await file.arrayBuffer()), file.name);
  }

  function syncPasswordControl() {
    if (!els.workspaceBackupPassword) return;
    els.workspaceBackupPassword.placeholder = els.includeBackupSecrets?.checked
      ? "设置至少 12 位迁移密码"
      : "导入加密迁移包时填写密码";
  }

  async function initializeDesktopPresentation() {
    try {
      desktopInfo = await globalScope.NgrDesktopBridge.getInfo();
    } catch (error) {
      console.warn("无法读取桌面版本信息", error?.message || error);
      desktopInfo = { isDesktop: isDesktop(), edition: "dev" };
    }
    document.documentElement.classList.toggle("desktop-runtime", Boolean(desktopInfo.isDesktop));
    const editionBadge = document.getElementById("editionBadge");
    if (editionBadge && desktopInfo.isDesktop) {
      const isProduction = desktopInfo.edition === "prod";
      const isTest = desktopInfo.edition === "test";
      editionBadge.classList.remove("dev", "test");
      if (isProduction) {
        editionBadge.textContent = "";
        editionBadge.classList.add("hidden");
        document.title = "NGR AssetPilot｜AI资源领航";
      } else {
        editionBadge.textContent = isTest ? "TEST 测试版" : "DEV 开发版";
        editionBadge.classList.remove("hidden");
        editionBadge.classList.add(isTest ? "test" : "dev");
        document.title = `${isTest ? "NGR AssetPilot Test" : "NGR AssetPilot Dev"}｜AI资源领航`;
      }
    }
    if (els.workspaceMigrationIntro && desktopInfo.isDesktop && !localStorage.getItem(MIGRATION_NOTICE_KEY)) {
      els.workspaceMigrationIntro.textContent = "首次使用桌面版？请从原网页版导出 .ngrap，再在这里导入。原数据不会被自动删除。";
      els.workspaceMigrationCard?.classList.add("needs-migration");
    }
    if (desktopInfo.isDesktop && els.includeBackupSecrets) {
      els.includeBackupSecrets.checked = false;
      els.includeBackupSecrets.disabled = true;
      els.includeBackupSecrets.closest("label")?.setAttribute(
        "title",
        "Windows 安全存储中的密钥不会返回界面，也不会从桌面版迁移包导出",
      );
      const note = els.workspaceMigrationCard?.querySelector(".workspace-migration-note");
      if (note) note.textContent = "桌面版不会导出 Windows 安全存储中的密钥；在新设备导入后，请重新填写模型服务密钥。旧版含加密凭据的 .ngrap 仍可导入，凭据块安全上限为 8 MiB。";
      syncPasswordControl();
    }
  }

  function initializeWorkspaceMigration() {
    if (isDesktop()) {
      stagingCleanupPromise = clearAllImportStagingSessions().catch((error) => {
        console.warn("无法清理上次未完成的导入暂存", error?.message || error);
      });
    }
    els.exportWorkspaceBackup?.addEventListener("click", exportWorkspaceBackup);
    els.importWorkspaceBackup?.addEventListener("click", chooseWorkspaceBackup);
    els.workspaceBackupInput?.addEventListener("change", importWorkspaceBackupFile);
    els.includeBackupSecrets?.addEventListener("change", syncPasswordControl);
    syncPasswordControl();
    initializeDesktopPresentation();
  }

  function registerDesktopQuitPersistence() {
    if (desktopQuitListenerBound || !isDesktop() || !globalScope.NgrDesktopBridge.hasCapability("app.onBeforeQuit")) return false;
    desktopQuitListenerBound = true;
    globalScope.NgrDesktopBridge.onBeforeQuit(async (payload = {}) => {
      const requestId = typeof payload === "string" ? payload : payload.requestId;
      try {
        await saveNamingWorkspaceNow({ force: true }).catch(() => false);
        await credentialSaveChain.catch(() => false);
      } finally {
        if (typeof requestId === "string") globalScope.NgrDesktopBridge.readyToQuit(requestId);
      }
    });
    return true;
  }

  globalScope.NgrWorkspaceMigration = Object.freeze({
    hydrateDesktopCredentials,
    queueDesktopCredentialSave,
    clearActiveAiCredential,
    clearActiveTranslationCredential,
    collectSettingsForBackup,
    collectCurrentCredentials,
    normalizeCredentialPayload,
    createCurrentArchive,
    importWorkspaceBackupBytes,
    recoverInterruptedWorkspaceImport,
    initializeWorkspaceMigration,
    registerDesktopQuitPersistence,
  });
  globalScope.hydrateDesktopCredentials = hydrateDesktopCredentials;
  globalScope.queueDesktopCredentialSave = queueDesktopCredentialSave;
  globalScope.clearActiveAiCredential = clearActiveAiCredential;
  globalScope.clearActiveTranslationCredential = clearActiveTranslationCredential;
  globalScope.initializeWorkspaceMigration = initializeWorkspaceMigration;
  globalScope.registerDesktopQuitPersistence = registerDesktopQuitPersistence;
})(window);
