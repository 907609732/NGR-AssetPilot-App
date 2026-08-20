import { createHash, randomBytes, randomUUID } from "node:crypto";
import { isIP } from "node:net";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { DesktopError, isPlainRecord } from "../shared/core.mjs";

const REGISTRY_VERSION = 1;
const MAX_REGISTRY_BYTES = 512 * 1024;
const IMPORT_JOURNAL_VERSION = 1;
const CUSTOM_PROVIDER_IDS = new Set(["user-ai", "user-translation-model"]);
const BAIDU_AI_ENDPOINT = "https://fanyi-api.baidu.com/ait/api/aiTextTranslate";
const BAIDU_LEGACY_ENDPOINT = "https://fanyi-api.baidu.com/api/trans/vip/translate";

const BUILTIN_PROVIDERS = Object.freeze([
  Object.freeze({
    id: "openai",
    name: "OpenAI",
    service: "ai",
    baseUrl: "https://api.openai.com/v1",
    apiFormat: "responses",
    model: "gpt-4.1-mini",
    builtin: true,
    trust: "builtin",
    allowLoopback: false,
  }),
  Object.freeze({
    id: "moonshot",
    name: "Moonshot",
    service: "ai",
    baseUrl: "https://api.moonshot.cn/v1",
    apiFormat: "chat",
    model: "moonshot-v1-8k-vision-preview",
    builtin: true,
    trust: "builtin",
    allowLoopback: false,
  }),
  Object.freeze({
    id: "baidu",
    name: "百度翻译",
    service: "translation",
    baseUrl: BAIDU_AI_ENDPOINT,
    apiFormat: "baidu-ai",
    model: "",
    builtin: true,
    trust: "builtin",
    allowLoopback: false,
  }),
]);

function clonePublicProvider(provider, hasSecret = false) {
  return Object.freeze({
    id: provider.id,
    name: provider.name,
    service: provider.service,
    baseUrl: provider.baseUrl,
    apiFormat: provider.apiFormat,
    model: provider.model,
    builtin: Boolean(provider.builtin),
    trust: provider.trust,
    allowLoopback: Boolean(provider.allowLoopback),
    hasSecret: Boolean(hasSecret),
  });
}

function isLoopbackHostname(hostname) {
  const value = String(hostname || "").toLowerCase();
  return value === "localhost" || value === "127.0.0.1" || value === "[::1]" || value === "::1";
}

function resemblesLoopbackHostname(hostname) {
  const value = String(hostname || "").toLowerCase();
  if (isLoopbackHostname(value)) return false;
  return value.split(".").includes("localhost") || /^127(?:[.-]|$)/.test(value);
}

function normalizeBaseUrl(value, { builtin = false } = {}) {
  if (typeof value !== "string" || !value.trim() || value.length > 4096) {
    throw new DesktopError("PROVIDER_URL_INVALID", "模型服务地址无效");
  }
  const raw = value.trim();
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new DesktopError("PROVIDER_URL_INVALID", "模型服务地址无效");
  }
  if (parsed.username || parsed.password || parsed.hash || parsed.search) {
    throw new DesktopError("PROVIDER_URL_INVALID", "模型服务地址不能包含凭据、查询参数或片段");
  }
  const loopback = isLoopbackHostname(parsed.hostname);
  const ipKind = isIP(parsed.hostname.replace(/^\[|\]$/g, ""));
  if (resemblesLoopbackHostname(parsed.hostname)) {
    throw new DesktopError("PROVIDER_HOST_SPOOFED", "模型服务地址使用了伪造的本机域名");
  }
  if (ipKind && !loopback) {
    throw new DesktopError("PROVIDER_IP_NOT_ALLOWED", "自定义模型服务不允许使用非回环 IP 地址");
  }
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopback)) {
    throw new DesktopError("PROVIDER_PROTOCOL_NOT_ALLOWED", "远程模型服务必须使用 HTTPS，本机服务可使用回环 HTTP");
  }
  if (!builtin && parsed.protocol === "http:" && loopback && !parsed.port) {
    throw new DesktopError("PROVIDER_PORT_REQUIRED", "本机模型服务必须明确填写端口");
  }
  const decodedPath = (() => {
    try {
      return decodeURIComponent(parsed.pathname);
    } catch {
      throw new DesktopError("PROVIDER_URL_INVALID", "模型服务路径编码无效");
    }
  })();
  if (decodedPath.split("/").some((part) => part === "." || part === "..") || /[\u0000-\u001f\\]/.test(decodedPath)) {
    throw new DesktopError("PROVIDER_URL_INVALID", "模型服务路径无效");
  }
  parsed.pathname = parsed.pathname.replace(/\/+$/, "") || "/";
  return {
    baseUrl: `${parsed.origin}${parsed.pathname === "/" ? "" : parsed.pathname}`,
    allowLoopback: loopback,
  };
}

function normalizeProvider(input, existing) {
  if (!isPlainRecord(input)) throw new DesktopError("PROVIDER_INVALID", "模型服务配置无效");
  const id = String(input.id || "").trim();
  const builtin = BUILTIN_PROVIDERS.find((provider) => provider.id === id);
  if (builtin) {
    const baiduApiFormat = input.apiFormat === "baidu" ? "baidu" : "baidu-ai";
    return {
      ...builtin,
      apiFormat: builtin.id === "baidu"
        ? baiduApiFormat
        : input.apiFormat === "chat" ? "chat"
          : input.apiFormat === "responses" ? "responses"
            : existing?.apiFormat || builtin.apiFormat,
      model: String(input.model || existing?.model || builtin.model).trim().slice(0, 256),
      baseUrl: builtin.id === "baidu" && baiduApiFormat === "baidu" ? BAIDU_LEGACY_ENDPOINT : builtin.baseUrl,
    };
  }
  if (!CUSTOM_PROVIDER_IDS.has(id)) {
    throw new DesktopError("PROVIDER_ID_INVALID", "自定义模型服务标识无效");
  }
  const service = id === "user-ai" ? "ai" : "translation";
  if (input.service !== undefined && input.service !== service) {
    throw new DesktopError("PROVIDER_SERVICE_INVALID", "模型服务类型无效");
  }
  const { baseUrl, allowLoopback } = normalizeBaseUrl(input.baseUrl);
  return {
    id,
    name: String(input.name || (service === "ai" ? "自定义 AI" : "自定义翻译模型")).trim().slice(0, 80),
    service,
    baseUrl,
    apiFormat: input.apiFormat === "responses" ? "responses" : "chat",
    model: String(input.model || "").trim().slice(0, 256),
    builtin: false,
    trust: "user-approved",
    allowLoopback,
  };
}

function normalizeSecret(provider, value) {
  if (provider.id === "baidu") {
    if (!isPlainRecord(value)) throw new DesktopError("PROVIDER_SECRET_INVALID", "百度翻译凭据无效");
    const appId = String(value.appId || "").trim();
    const apiKey = String(value.apiKey || "").trim();
    const secret = String(value.secret || "").trim();
    if (!appId || (!apiKey && !secret) || (apiKey && secret) || appId.length > 1024 || Math.max(apiKey.length, secret.length) > 4096) {
      throw new DesktopError("PROVIDER_SECRET_INVALID", "百度翻译 App ID 或密钥无效");
    }
    return apiKey ? { appId, apiKey } : { appId, secret };
  }
  const apiKey = typeof value === "string" ? value.trim() : String(value?.apiKey || "").trim();
  if (!apiKey || apiKey.length > 16 * 1024 || /[\r\n]/.test(apiKey)) {
    throw new DesktopError("PROVIDER_SECRET_INVALID", "API Key 无效");
  }
  return { apiKey };
}

function cloneSecretMap(value) {
  const output = Object.create(null);
  for (const [providerId, secret] of Object.entries(value || {})) {
    output[providerId] = isPlainRecord(secret) ? { ...secret } : secret;
  }
  return output;
}

function providerEndpoint(provider, operation) {
  if (provider.id === "baidu") return provider.baseUrl;
  const suffix = operation === "responses" ? "/responses" : "/chat/completions";
  if (new RegExp(`${suffix.replace(/\//g, "\\/")}$`, "i").test(provider.baseUrl)) return provider.baseUrl;
  return `${provider.baseUrl}${suffix}`;
}

function isPathAuthorized(provider, candidateUrl) {
  const base = new URL(provider.baseUrl);
  const candidate = new URL(candidateUrl);
  if (candidate.origin !== base.origin || candidate.username || candidate.password || candidate.hash) return false;
  const basePath = base.pathname.replace(/\/+$/, "") || "/";
  return basePath === "/" || candidate.pathname === basePath || candidate.pathname.startsWith(`${basePath}/`);
}

function baiduSignedUrl(provider, secret, body) {
  if (!isPlainRecord(body)) throw new DesktopError("NETWORK_BODY_INVALID", "百度翻译请求数据无效");
  const query = String(body.q || "").trim();
  const from = String(body.from || "auto").trim();
  const to = String(body.to || "zh").trim();
  if (!query || query.length > 6000 || !/^[a-z]{2,8}$/i.test(from) || !/^[a-z]{2,8}$/i.test(to)) {
    throw new DesktopError("NETWORK_BODY_INVALID", "百度翻译请求数据无效");
  }
  const salt = randomBytes(12).toString("hex");
  const sign = createHash("md5").update(`${secret.appId}${query}${salt}${secret.secret}`, "utf8").digest("hex");
  const url = new URL(provider.baseUrl);
  url.search = new URLSearchParams({ q: query, from, to, appid: secret.appId, salt, sign }).toString();
  return url;
}

function baiduAiRequest(secret, body) {
  if (!isPlainRecord(body)) throw new DesktopError("NETWORK_BODY_INVALID", "百度翻译请求数据无效");
  const query = String(body.q || "").trim();
  const from = String(body.from || "auto").trim();
  const to = String(body.to || "zh").trim();
  if (!query || query.length > 6000 || !/^[a-z]{2,8}$/i.test(from) || !/^[a-z]{2,8}$/i.test(to)) {
    throw new DesktopError("NETWORK_BODY_INVALID", "百度翻译请求数据无效");
  }
  return {
    url: new URL(BAIDU_AI_ENDPOINT),
    headers: {
      accept: "application/json",
      authorization: `Bearer ${secret.apiKey}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ q: query, from, to, appid: secret.appId, model_type: "llm" }).toString(),
  };
}

export class ProviderRegistry {
  constructor({ credentialStore, userDataPath, fileName = "providers.v1.json" }) {
    if (!credentialStore) throw new TypeError("credentialStore is required");
    if (!path.isAbsolute(userDataPath)) throw new TypeError("userDataPath must be absolute");
    this.credentialStore = credentialStore;
    this.filePath = path.join(userDataPath, fileName);
    this.importJournalPath = path.join(userDataPath, "provider-import-transaction.v1.json");
    this.providerRollbackPath = `${this.filePath}.ngr-import-rollback`;
    this.credentialRollbackPath = `${this.credentialStore.filePath}.ngr-import-rollback`;
    this.providers = new Map(BUILTIN_PROVIDERS.map((provider) => [provider.id, { ...provider }]));
    this.activeImportTransactionId = null;
    this.initialized = false;
    this.initializePromise = null;
  }

  async initialize() {
    if (this.initialized) return;
    if (this.initializePromise) return this.initializePromise;
    this.initializePromise = this.#initializeInternal();
    try {
      await this.initializePromise;
      this.initialized = true;
    } finally {
      this.initializePromise = null;
    }
  }

  async #initializeInternal() {
    await this.#recoverImportTransaction();
    await this.#loadProvidersFromDisk();
    await this.#migrateLegacyStore();
  }

  #resetProviders() {
    this.providers = new Map(BUILTIN_PROVIDERS.map((provider) => [provider.id, { ...provider }]));
  }

  async #loadProvidersFromDisk() {
    this.#resetProviders();
    let raw = null;
    try {
      raw = await readFile(this.filePath);
    } catch (error) {
      if (error?.code !== "ENOENT") throw new DesktopError("PROVIDER_REGISTRY_READ_FAILED", "无法读取模型服务配置");
    }
    if (raw) {
      if (raw.byteLength > MAX_REGISTRY_BYTES) throw new DesktopError("PROVIDER_REGISTRY_CORRUPT", "模型服务配置无效");
      try {
        const data = JSON.parse(raw.toString("utf8"));
        if (data?.version !== REGISTRY_VERSION || !Array.isArray(data.providers)) throw new Error("invalid registry");
        for (const candidate of data.providers) {
          if (!CUSTOM_PROVIDER_IDS.has(candidate?.id)) continue;
          const provider = normalizeProvider(candidate);
          this.providers.set(provider.id, provider);
        }
        const overrides = isPlainRecord(data.builtinOverrides) ? data.builtinOverrides : {};
        for (const builtin of BUILTIN_PROVIDERS) {
          const override = isPlainRecord(overrides[builtin.id]) ? overrides[builtin.id] : {};
          this.providers.set(builtin.id, normalizeProvider({ id: builtin.id, ...override }, builtin));
        }
      } catch (error) {
        if (error instanceof DesktopError) throw error;
        throw new DesktopError("PROVIDER_REGISTRY_CORRUPT", "模型服务配置无效");
      }
    }
  }

  async beginImportTransaction() {
    await this.initialize();
    if (this.activeImportTransactionId) {
      throw new DesktopError("PROVIDER_IMPORT_BUSY", "已有凭据导入事务正在进行");
    }
    this.activeImportTransactionId = "preparing";
    try {
      const existing = await this.#readImportJournal();
      if (existing?.phase === "prepared") {
        this.activeImportTransactionId = existing.transactionId;
        throw new DesktopError("PROVIDER_IMPORT_BUSY", "已有凭据导入事务正在进行");
      }
      if (existing) await this.finalizeImportTransaction(existing.transactionId);
      await unlink(this.providerRollbackPath).catch(() => {});
      await unlink(this.credentialRollbackPath).catch(() => {});
      const transactionId = randomUUID();
      const providerExisted = await this.#snapshotFile(this.filePath, this.providerRollbackPath);
      const credentialExisted = await this.#snapshotFile(this.credentialStore.filePath, this.credentialRollbackPath);
      await this.#writeImportJournal({
        version: IMPORT_JOURNAL_VERSION,
        transactionId,
        phase: "prepared",
        providerExisted,
        credentialExisted,
      });
      this.activeImportTransactionId = transactionId;
      return { transactionId, phase: "prepared" };
    } catch (error) {
      if (this.activeImportTransactionId === "preparing") {
        await unlink(this.providerRollbackPath).catch(() => {});
        await unlink(this.credentialRollbackPath).catch(() => {});
        this.activeImportTransactionId = null;
      }
      throw error;
    }
  }

  async importLegacyInTransaction(transactionId, input) {
    const journal = await this.#requireImportTransaction(transactionId, "prepared");
    if (this.activeImportTransactionId !== transactionId) {
      throw new DesktopError("PROVIDER_IMPORT_TRANSACTION_NOT_FOUND", "模型服务导入事务不存在");
    }
    const result = await this.#importLegacy(input);
    return { ...result, transactionId: journal.transactionId };
  }

  async commitImportTransaction(transactionId) {
    const journal = await this.#requireImportTransaction(transactionId, "prepared");
    await this.#writeImportJournal({ ...journal, phase: "committed" });
    await unlink(this.providerRollbackPath).catch(() => {});
    await unlink(this.credentialRollbackPath).catch(() => {});
    if (this.activeImportTransactionId === transactionId) this.activeImportTransactionId = null;
    return { transactionId: journal.transactionId, phase: "committed" };
  }

  async rollbackImportTransaction(transactionId) {
    const journal = await this.#readImportJournal();
    if (!journal || journal.transactionId !== transactionId) {
      return { transactionId, phase: "missing" };
    }
    if (journal.phase === "committed") return { transactionId, phase: "committed" };
    if (journal.phase !== "rolled-back") {
      await this.#restoreImportSnapshot(journal);
      await this.#writeImportJournal({ ...journal, phase: "rolled-back" });
      await this.#loadProvidersFromDisk();
    }
    if (this.activeImportTransactionId === transactionId) this.activeImportTransactionId = null;
    return { transactionId, phase: "rolled-back" };
  }

  async getImportTransactionState(transactionId) {
    const journal = await this.#readImportJournal();
    if (!journal || journal.transactionId !== transactionId) return { transactionId, phase: "missing" };
    return { transactionId, phase: journal.phase };
  }

  async finalizeImportTransaction(transactionId) {
    const journal = await this.#readImportJournal();
    if (!journal || journal.transactionId !== transactionId) return { transactionId, finalized: false };
    if (journal.phase === "prepared") {
      throw new DesktopError("PROVIDER_IMPORT_NOT_FINISHED", "凭据导入事务尚未完成");
    }
    await unlink(this.providerRollbackPath).catch(() => {});
    await unlink(this.credentialRollbackPath).catch(() => {});
    await unlink(this.importJournalPath).catch(() => {});
    return { transactionId, finalized: true };
  }

  async #migrateLegacyStore() {
    if (!this.credentialStore.isAvailable?.()) return;
    const v2Exists = await this.credentialStore.exists();
    const legacy = await this.credentialStore.readLegacy?.();
    if (!legacy || !Object.keys(legacy).length) return;
    const migratedSecrets = Object.create(null);
    const ai = [legacy.ai, legacy.kimi, legacy.openai].find((value) => isPlainRecord(value)) || {};
    const providerId = ai.provider === "kimi" || legacy.kimi ? "moonshot"
      : ["compatible", "custom"].includes(ai.provider) ? "user-ai" : "openai";
    if (providerId === "user-ai" && ai.baseUrl) {
      this.providers.set(providerId, normalizeProvider({
        id: providerId,
        service: "ai",
        name: ai.providerNote || "自定义 AI",
        baseUrl: ai.baseUrl,
        apiFormat: ai.apiFormat,
        model: ai.model,
      }));
    }
    if (String(ai.apiKey || "").trim()) {
      migratedSecrets[providerId] = normalizeSecret(this.providers.get(providerId), { apiKey: ai.apiKey });
    }
    const translation = [legacy.translation, legacy.baidu].find((value) => isPlainRecord(value)) || {};
    if (String(translation.baiduAppId || translation.appId || "").trim() && String(translation.baiduSecret || translation.secret || "").trim()) {
      const legacyProvider = normalizeProvider({ id: "baidu", apiFormat: "baidu" }, this.providers.get("baidu"));
      this.providers.set("baidu", legacyProvider);
      migratedSecrets.baidu = normalizeSecret(legacyProvider, {
        appId: translation.baiduAppId || translation.appId,
        secret: translation.baiduSecret || translation.secret,
      });
    }
    if (String(translation.textApiKey || "").trim() && translation.textBaseUrl) {
      const custom = normalizeProvider({
        id: "user-translation-model",
        service: "translation",
        name: "自定义翻译模型",
        baseUrl: translation.textBaseUrl,
        apiFormat: "chat",
        model: translation.textModel,
      });
      this.providers.set(custom.id, custom);
      migratedSecrets[custom.id] = normalizeSecret(custom, { apiKey: translation.textApiKey });
    }
    await this.#persist();
    const currentSecrets = v2Exists ? await this.credentialStore.get() : Object.create(null);
    const nextSecrets = Object.assign(Object.create(null), migratedSecrets, currentSecrets);
    await this.credentialStore.set(nextSecrets);
    const verifiedSecrets = await this.credentialStore.get();
    for (const providerId of Object.keys(migratedSecrets)) {
      if (!verifiedSecrets[providerId]) {
        throw new DesktopError("CREDENTIAL_STORE_WRITE_FAILED", "旧版凭据迁移校验失败");
      }
    }
    await this.#verifyPersisted();
    await this.credentialStore.archiveLegacy?.();
  }

  async list() {
    await this.initialize();
    const status = await this.credentialStore.getStatus();
    return [...this.providers.values()].map((provider) => clonePublicProvider(provider, status.providers?.[provider.id]));
  }

  async upsert(input) {
    await this.initialize();
    this.#assertMutationAllowed();
    if (!isPlainRecord(input)) throw new DesktopError("PROVIDER_INVALID", "模型服务配置无效");
    const provider = normalizeProvider(input.provider, this.providers.get(input.provider?.id));
    const action = input.secretAction || "keep";
    if (!["keep", "replace", "clear"].includes(action)) {
      throw new DesktopError("PROVIDER_SECRET_ACTION_INVALID", "凭据保存方式无效");
    }
    const secret = action === "replace" ? normalizeSecret(provider, input.secret) : undefined;
    const previousProvider = this.providers.get(provider.id);
    const previousSecret = await this.credentialStore.getProviderSecret(provider.id);
    let secretChanged = false;
    try {
      await this.credentialStore.updateProviderSecret(provider.id, action, secret);
      secretChanged = action !== "keep";
      this.providers.set(provider.id, provider);
      await this.#persist();
    } catch (error) {
      if (previousProvider) this.providers.set(provider.id, previousProvider);
      else this.providers.delete(provider.id);
      if (secretChanged) {
        try {
          await this.#restoreSecret(provider.id, previousSecret);
        } catch {
          throw new DesktopError(
            "PROVIDER_UPDATE_ROLLBACK_FAILED",
            "模型服务保存失败，且无法恢复原凭据；请重新启动后检查配置",
          );
        }
      }
      throw error;
    }
    return (await this.list()).find((candidate) => candidate.id === provider.id);
  }

  async remove(input) {
    await this.initialize();
    this.#assertMutationAllowed();
    const id = String(input?.providerId || "");
    if (!CUSTOM_PROVIDER_IDS.has(id)) throw new DesktopError("PROVIDER_REMOVE_NOT_ALLOWED", "内置模型服务不能删除");
    const previousProvider = this.providers.get(id);
    const previousSecret = await this.credentialStore.getProviderSecret(id);
    let secretChanged = false;
    try {
      await this.credentialStore.updateProviderSecret(id, "clear");
      secretChanged = true;
      this.providers.delete(id);
      await this.#persist();
    } catch (error) {
      if (previousProvider) this.providers.set(id, previousProvider);
      if (secretChanged) {
        try {
          await this.#restoreSecret(id, previousSecret);
        } catch {
          throw new DesktopError(
            "PROVIDER_REMOVE_ROLLBACK_FAILED",
            "模型服务删除失败，且无法恢复原凭据；请重新启动后检查配置",
          );
        }
      }
      throw error;
    }
    return { removed: true, providerId: id };
  }

  async importLegacy(input) {
    await this.initialize();
    this.#assertMutationAllowed();
    return this.#importLegacy(input);
  }

  async #importLegacy(input) {
    if (!isPlainRecord(input)) throw new DesktopError("LEGACY_CREDENTIALS_INVALID", "旧版凭据格式无效");
    const status = await this.credentialStore.getStatus();
    if (input.onlyIfEmpty === true && status.configured) {
      return { imported: false, reason: "already-configured", providers: await this.list() };
    }
    const ai = isPlainRecord(input.ai) ? input.ai : {};
    const translation = isPlainRecord(input.translation) ? input.translation : {};
    const previousProviders = this.providers;
    const previousSecrets = await this.credentialStore.get();
    const nextProviders = new Map([...previousProviders].map(([id, provider]) => [id, { ...provider }]));
    const nextSecrets = cloneSecretMap(previousSecrets);
    const apply = (provider, secret) => {
      nextProviders.set(provider.id, provider);
      nextSecrets[provider.id] = secret;
    };
    let imported = false;
    if (String(ai.apiKey || "").trim()) {
      const id = ai.provider === "kimi" ? "moonshot" : ["compatible", "custom"].includes(ai.provider) ? "user-ai" : "openai";
      const provider = normalizeProvider({
        id,
        service: "ai",
        name: ai.providerNote || undefined,
        baseUrl: ai.baseUrl,
        apiFormat: ai.apiFormat,
        model: ai.model,
      }, nextProviders.get(id));
      apply(provider, normalizeSecret(provider, { apiKey: ai.apiKey }));
      imported = true;
    }
    if (String(translation.baiduAppId || "").trim() && String(translation.baiduSecret || "").trim()) {
      const provider = normalizeProvider({ id: "baidu", apiFormat: "baidu" }, nextProviders.get("baidu"));
      apply(provider, normalizeSecret(provider, {
        appId: translation.baiduAppId,
        secret: translation.baiduSecret,
      }));
      imported = true;
    }
    if (String(translation.textApiKey || "").trim() && translation.textBaseUrl) {
      const provider = normalizeProvider({
        id: "user-translation-model",
        service: "translation",
        baseUrl: translation.textBaseUrl,
        apiFormat: "chat",
        model: translation.textModel,
      }, nextProviders.get("user-translation-model"));
      apply(provider, normalizeSecret(provider, { apiKey: translation.textApiKey }));
      imported = true;
    }
    if (!imported) return { imported: false, reason: "no-secrets", providers: await this.list() };

    let credentialsChanged = false;
    let registryChanged = false;
    try {
      await this.credentialStore.set(nextSecrets);
      credentialsChanged = true;
      this.providers = nextProviders;
      await this.#persist();
      registryChanged = true;
      await this.credentialStore.get();
      await this.#verifyPersisted();
    } catch (error) {
      this.providers = previousProviders;
      try {
        if (registryChanged) await this.#persist();
        if (credentialsChanged) {
          await this.credentialStore.set(previousSecrets);
        }
      } catch {
        throw new DesktopError(
          "PROVIDER_IMPORT_ROLLBACK_FAILED",
          "模型服务导入失败，且无法恢复原凭据；旧数据仍保留在迁移包中",
        );
      }
      throw error;
    }
    return { imported: true, providers: await this.list() };
  }

  async resolveRequest(input) {
    await this.initialize();
    if (!isPlainRecord(input)) throw new DesktopError("NETWORK_REQUEST_INVALID", "网络请求格式无效");
    const providerId = String(input.providerId || "");
    const provider = this.providers.get(providerId);
    if (!provider) throw new DesktopError("PROVIDER_NOT_FOUND", "模型服务未配置或未获授权");
    const secret = await this.credentialStore.getProviderSecret(providerId);
    if (!secret) throw new DesktopError("PROVIDER_SECRET_MISSING", "模型服务凭据尚未配置");
    if (provider.id === "baidu") {
      if (input.operation !== "translate") throw new DesktopError("PROVIDER_OPERATION_NOT_ALLOWED", "模型服务操作未获授权");
      if (secret.apiKey) {
        const request = baiduAiRequest(secret, input.body);
        return {
          provider: { ...provider, baseUrl: BAIDU_AI_ENDPOINT, apiFormat: "baidu-ai" },
          url: request.url,
          method: "POST",
          headers: request.headers,
          body: request.body,
          maximumTimeout: 30_000,
        };
      }
      return {
        provider,
        url: baiduSignedUrl(provider, secret, input.body),
        method: "GET",
        headers: { accept: "application/json" },
        body: undefined,
        maximumTimeout: 30_000,
      };
    }
    const operation = input.operation === "responses" ? "responses" : input.operation === "chat" ? "chat" : null;
    if (!operation || operation !== provider.apiFormat) {
      throw new DesktopError("PROVIDER_OPERATION_NOT_ALLOWED", "模型服务接口格式与已授权配置不一致");
    }
    return {
      provider,
      url: new URL(providerEndpoint(provider, operation)),
      method: "POST",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${secret.apiKey}`,
        "content-type": "application/json",
      },
      body: input.body,
      maximumTimeout: provider.service === "translation" ? 30_000 : 120_000,
    };
  }

  isRedirectAuthorized(provider, url) {
    try {
      const normalized = normalizeBaseUrl(provider.baseUrl, { builtin: provider.builtin });
      void normalized;
      return isPathAuthorized(provider, url);
    } catch {
      return false;
    }
  }

  #assertMutationAllowed() {
    if (this.activeImportTransactionId) {
      throw new DesktopError("PROVIDER_IMPORT_BUSY", "模型服务正在执行迁移导入，请稍后重试");
    }
  }

  async #snapshotFile(sourcePath, rollbackPath) {
    let raw;
    try {
      raw = await readFile(sourcePath);
    } catch (error) {
      if (error?.code === "ENOENT") return false;
      throw new DesktopError("PROVIDER_IMPORT_SNAPSHOT_FAILED", "无法创建模型服务导入回滚点");
    }
    try {
      await writeFile(rollbackPath, raw, { flag: "wx", mode: 0o600 });
      return true;
    } catch {
      throw new DesktopError("PROVIDER_IMPORT_SNAPSHOT_FAILED", "无法创建模型服务导入回滚点");
    }
  }

  async #restoreFile(targetPath, rollbackPath, existed) {
    if (!existed) {
      await unlink(targetPath).catch((error) => {
        if (error?.code !== "ENOENT") throw error;
      });
      return;
    }
    const raw = await readFile(rollbackPath);
    const temporaryPath = `${targetPath}.${randomUUID()}.ngr-import-restore.tmp`;
    try {
      await writeFile(temporaryPath, raw, { flag: "wx", mode: 0o600 });
      await rename(temporaryPath, targetPath);
    } catch (error) {
      await unlink(temporaryPath).catch(() => {});
      throw error;
    }
  }

  async #readImportJournal() {
    let raw;
    try {
      raw = await readFile(this.importJournalPath);
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      throw new DesktopError("PROVIDER_IMPORT_JOURNAL_READ_FAILED", "无法读取模型服务导入事务");
    }
    if (raw.byteLength > 64 * 1024) {
      throw new DesktopError("PROVIDER_IMPORT_JOURNAL_CORRUPT", "模型服务导入事务无效");
    }
    try {
      const journal = JSON.parse(raw.toString("utf8"));
      if (
        journal?.version !== IMPORT_JOURNAL_VERSION ||
        typeof journal.transactionId !== "string" ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(journal.transactionId) ||
        !["prepared", "committed", "rolled-back"].includes(journal.phase) ||
        typeof journal.providerExisted !== "boolean" ||
        typeof journal.credentialExisted !== "boolean"
      ) {
        throw new Error("invalid journal");
      }
      return journal;
    } catch {
      throw new DesktopError("PROVIDER_IMPORT_JOURNAL_CORRUPT", "模型服务导入事务无效");
    }
  }

  async #writeImportJournal(journal) {
    const directory = path.dirname(this.importJournalPath);
    const temporaryPath = `${this.importJournalPath}.${randomUUID()}.tmp`;
    await mkdir(directory, { recursive: true });
    try {
      await writeFile(temporaryPath, JSON.stringify(journal), { encoding: "utf8", flag: "wx", mode: 0o600 });
      await rename(temporaryPath, this.importJournalPath);
    } catch {
      await unlink(temporaryPath).catch(() => {});
      throw new DesktopError("PROVIDER_IMPORT_JOURNAL_WRITE_FAILED", "无法保存模型服务导入事务");
    }
  }

  async #requireImportTransaction(transactionId, phase) {
    const journal = await this.#readImportJournal();
    if (!journal || journal.transactionId !== transactionId) {
      throw new DesktopError("PROVIDER_IMPORT_TRANSACTION_NOT_FOUND", "模型服务导入事务不存在");
    }
    if (journal.phase !== phase) {
      throw new DesktopError("PROVIDER_IMPORT_TRANSACTION_STATE_INVALID", "模型服务导入事务状态无效");
    }
    return journal;
  }

  async #restoreImportSnapshot(journal) {
    try {
      await this.#restoreFile(
        this.credentialStore.filePath,
        this.credentialRollbackPath,
        journal.credentialExisted,
      );
      await this.#restoreFile(this.filePath, this.providerRollbackPath, journal.providerExisted);
    } catch {
      throw new DesktopError("PROVIDER_IMPORT_ROLLBACK_FAILED", "无法恢复导入前的模型服务与凭据");
    }
  }

  async #recoverImportTransaction() {
    const journal = await this.#readImportJournal();
    if (!journal) {
      await unlink(this.providerRollbackPath).catch(() => {});
      await unlink(this.credentialRollbackPath).catch(() => {});
      return;
    }
    if (journal.phase === "prepared") {
      await this.#restoreImportSnapshot(journal);
      await this.#writeImportJournal({ ...journal, phase: "rolled-back" });
    }
    await unlink(this.providerRollbackPath).catch(() => {});
    await unlink(this.credentialRollbackPath).catch(() => {});
  }

  async #restoreSecret(providerId, secret) {
    if (secret) return this.credentialStore.updateProviderSecret(providerId, "replace", secret);
    return this.credentialStore.updateProviderSecret(providerId, "clear");
  }

  async #persist() {
    const providers = [...this.providers.values()].filter((provider) => !provider.builtin);
    const builtinOverrides = Object.fromEntries(BUILTIN_PROVIDERS.map((builtin) => {
      const current = this.providers.get(builtin.id) || builtin;
      return [builtin.id, { apiFormat: current.apiFormat, model: current.model }];
    }));
    const data = JSON.stringify({ version: REGISTRY_VERSION, providers, builtinOverrides }, null, 2);
    const directory = path.dirname(this.filePath);
    const temporary = `${this.filePath}.tmp`;
    await mkdir(directory, { recursive: true });
    try {
      await writeFile(temporary, data, { encoding: "utf8", mode: 0o600, flag: "w" });
      await rename(temporary, this.filePath);
    } catch {
      await unlink(temporary).catch(() => {});
      throw new DesktopError("PROVIDER_REGISTRY_WRITE_FAILED", "无法保存模型服务配置");
    }
  }

  async #verifyPersisted() {
    let raw;
    try {
      raw = await readFile(this.filePath);
      if (raw.byteLength > MAX_REGISTRY_BYTES) throw new Error("registry too large");
      const data = JSON.parse(raw.toString("utf8"));
      if (data?.version !== REGISTRY_VERSION || !Array.isArray(data.providers)) throw new Error("invalid registry");
      const savedIds = new Set(data.providers.map((provider) => provider?.id));
      for (const provider of this.providers.values()) {
        if (!provider.builtin && !savedIds.has(provider.id)) throw new Error("provider missing");
      }
    } catch {
      throw new DesktopError("PROVIDER_REGISTRY_WRITE_FAILED", "模型服务配置写入校验失败");
    }
  }
}

export { BUILTIN_PROVIDERS, normalizeBaseUrl as validateProviderBaseUrl };
