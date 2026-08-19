/* NGR AssetPilot V3.0.0 module: workspace-migration.js */
(function initializeWorkspaceMigrationModule(globalScope) {
  "use strict";

  const SETTINGS_SCHEMA_VERSION = 1;
  const MIGRATION_NOTICE_KEY = "ngr-assetpilot-desktop-migration-v1";
  const settingsKeys = () => [APP_VERSION_KEY, ...APP_STORAGE_KEYS];
  let desktopInfo = { isDesktop: false, edition: "dev" };
  let credentialSaveChain = Promise.resolve();
  let desktopQuitListenerBound = false;

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
    let stored = {};
    try {
      stored = normalizeCredentialPayload(await globalScope.NgrDesktopBridge.getCredentials());
    } catch (error) {
      console.warn("桌面凭据读取失败，将以未配置状态启动", error?.message || error);
      stored = normalizeCredentialPayload({});
    }
    aiSettings = normalizeAiSettings({
      ...aiSettings,
      provider: stored.ai.provider || aiSettings.provider,
      apiFormat: stored.ai.apiFormat || aiSettings.apiFormat,
      baseUrl: stored.ai.baseUrl || aiSettings.baseUrl,
      apiKey: stored.ai.apiKey,
      model: stored.ai.model || aiSettings.model,
      providerNote: stored.ai.providerNote || aiSettings.providerNote,
    });
    translationSettings = normalizeTranslationSettings({
      ...translationSettings,
      provider: stored.translation.provider || translationSettings.provider,
      baiduAppId: stored.translation.baiduAppId,
      baiduSecret: stored.translation.baiduSecret,
      baiduEndpoint: stored.translation.baiduEndpoint || translationSettings.baiduEndpoint,
      textBaseUrl: stored.translation.textBaseUrl || translationSettings.textBaseUrl,
      textApiKey: stored.translation.textApiKey,
      textModel: stored.translation.textModel || translationSettings.textModel,
    });
    return true;
  }

  function queueDesktopCredentialSave() {
    if (!isDesktop()) return Promise.resolve(false);
    const credentials = collectCurrentCredentials();
    credentialSaveChain = credentialSaveChain
      .catch(() => false)
      .then(() => globalScope.NgrDesktopBridge.setCredentials(credentials));
    credentialSaveChain.catch((error) => {
      console.error("桌面凭据保存失败", error?.message || error);
      if (typeof showToast === "function") showToast("凭据未能写入 Windows 安全存储");
    });
    return credentialSaveChain;
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
    if (isDesktop() && globalScope.NgrDesktopBridge.hasCapability("backup.save")) {
      const result = await globalScope.NgrDesktopBridge.saveBackup(filename, bytes, options);
      if (result?.canceled) throw new DOMException("用户取消保存", "AbortError");
      return result;
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
    const includeSecrets = Boolean(els.includeBackupSecrets?.checked);
    const password = els.workspaceBackupPassword?.value || "";
    if (includeSecrets && password.length < globalScope.NgrWorkspaceBackup.MIN_PASSWORD_LENGTH) {
      showToast(`携带凭据时，迁移密码至少需要 ${globalScope.NgrWorkspaceBackup.MIN_PASSWORD_LENGTH} 个字符`);
      els.workspaceBackupPassword?.focus();
      return;
    }
    setMigrationBusy(true, "正在整理工作区和图片…");
    try {
      const archive = await createCurrentArchive({ includeSecrets, password });
      const filename = `NGR-AssetPilot-${APP_VERSION}-${timestampForFilename()}.ngrap`;
      await saveArchiveBytes(archive.bytes, filename);
      els.workspaceBackupPassword.value = "";
      setMigrationBusy(false, `迁移包已生成：${filename}`);
      showToast(includeSecrets ? "迁移包已导出，凭据已用密码加密" : "迁移包已导出（不含凭据）");
    } catch (error) {
      setMigrationBusy(false, `导出失败：${error?.message || "未知错误"}`);
      if (error?.name !== "AbortError") showToast(`迁移包导出失败：${error?.message || "未知错误"}`);
    }
  }

  function normalizeOpenedBackup(result) {
    if (!result || result.canceled) return null;
    const data = result.data ?? result.bytes ?? result.buffer;
    if (data instanceof Uint8Array) return { name: result.name || "workspace.ngrap", bytes: data };
    if (data instanceof ArrayBuffer) return { name: result.name || "workspace.ngrap", bytes: new Uint8Array(data) };
    if (ArrayBuffer.isView(data)) return { name: result.name || "workspace.ngrap", bytes: new Uint8Array(data.buffer, data.byteOffset, data.byteLength) };
    throw new Error("桌面端没有返回有效的迁移包数据");
  }

  function snapshotLocalSettings() {
    return Object.fromEntries(settingsKeys().map((key) => [key, localStorage.getItem(key)]));
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

  function buildImportedWorkspaceState(parsed) {
    const sessions = new Map(parsed.workspace.sessions.map((session) => [session.id, session]));
    const seenKeys = new Set();
    const records = parsed.files.map((descriptor) => {
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
      const file = new File([descriptor.data], safeArchiveNamePart(descriptor.name), {
        type: descriptor.type || "application/octet-stream",
        lastModified: Number(descriptor.lastModified || Date.now()),
      });
      return {
        key,
        workspaceKey: NAMING_WORKSPACE_KEY,
        sessionId: session.id,
        ...(descriptor.kind === "asset" ? { assetId: descriptor.assetId } : {}),
        kind: descriptor.kind,
        storedAt: Number(descriptor.storedAt || Date.now()),
        file,
      };
    });
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
    const archive = await createCurrentArchive({ includeSecrets: false });
    const filename = `NGR-AssetPilot-导入前自动备份-${timestampForFilename()}.ngrap`;
    await saveArchiveBytes(archive.bytes, filename, { automatic: true });
    return filename;
  }

  async function applyImportedArchive(parsed) {
    const importedState = buildImportedWorkspaceState(parsed);
    const previousWorkspace = await readRawWorkspaceState();
    const previousSettings = snapshotLocalSettings();
    const previousCredentials = isDesktop() ? await globalScope.NgrDesktopBridge.getCredentials().catch(() => null) : null;
    const importedEntries = isDesktop()
      ? parsed.settings.entries
      : mergeSecretsIntoEntries(parsed.settings.entries, parsed.secrets || collectCurrentCredentials());
    validateImportedSettingKeys(importedEntries);

    await replaceRawWorkspaceState(importedState);
    try {
      applyLocalSettings(importedEntries);
      if (isDesktop() && parsed.secrets) await globalScope.NgrDesktopBridge.setCredentials(normalizeCredentialPayload(parsed.secrets));
      localStorage.setItem(MIGRATION_NOTICE_KEY, "completed");
    } catch (error) {
      await replaceRawWorkspaceState(previousWorkspace).catch(() => false);
      applyLocalSettings(previousSettings);
      if (isDesktop() && previousCredentials) await globalScope.NgrDesktopBridge.setCredentials(previousCredentials).catch(() => false);
      throw error;
    }
  }

  async function importWorkspaceBackupBytes(bytes, sourceName = "workspace.ngrap") {
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
    if (isDesktop() && globalScope.NgrDesktopBridge.hasCapability("backup.open")) {
      try {
        const opened = normalizeOpenedBackup(await globalScope.NgrDesktopBridge.openBackup());
        if (opened) await importWorkspaceBackupBytes(opened.bytes, opened.name);
      } catch (error) {
        setMigrationBusy(false, `读取失败：${error?.message || "未知错误"}`);
        showToast(`无法读取迁移包：${error?.message || "未知错误"}`);
      }
      return;
    }
    els.workspaceBackupInput?.click();
  }

  async function importWorkspaceBackupFile(event) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
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
      const isTest = desktopInfo.edition === "test";
      editionBadge.textContent = isTest ? "TEST 测试版" : "DEV 开发版";
      editionBadge.classList.remove("hidden", "dev", "test");
      editionBadge.classList.add(isTest ? "test" : "dev");
      document.title = `${isTest ? "NGR AssetPilot Test" : "NGR AssetPilot Dev"}｜AI资源领航`;
    }
    if (els.workspaceMigrationIntro && desktopInfo.isDesktop && !localStorage.getItem(MIGRATION_NOTICE_KEY)) {
      els.workspaceMigrationIntro.textContent = "首次使用桌面版？请从原网页版导出 .ngrap，再在这里导入。原数据不会被自动删除。";
      els.workspaceMigrationCard?.classList.add("needs-migration");
    }
  }

  function initializeWorkspaceMigration() {
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
    collectSettingsForBackup,
    collectCurrentCredentials,
    normalizeCredentialPayload,
    createCurrentArchive,
    importWorkspaceBackupBytes,
    initializeWorkspaceMigration,
    registerDesktopQuitPersistence,
  });
  globalScope.hydrateDesktopCredentials = hydrateDesktopCredentials;
  globalScope.queueDesktopCredentialSave = queueDesktopCredentialSave;
  globalScope.initializeWorkspaceMigration = initializeWorkspaceMigration;
  globalScope.registerDesktopQuitPersistence = registerDesktopQuitPersistence;
})(window);
