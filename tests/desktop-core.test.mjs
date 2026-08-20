import assert from "node:assert/strict";
import { createCipheriv, createHash, pbkdf2Sync, randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

import { CredentialStore } from "../desktop/services/credential-store.mjs";
import { DirectoryTokenStore, validateRelativeExportPath } from "../desktop/services/directory-tokens.mjs";
import { ExternalAppRegistry } from "../desktop/services/external-app-registry.mjs";
import { NetworkClient, validateNetworkUrl } from "../desktop/services/network-client.mjs";
import { ProviderRegistry, validateProviderBaseUrl } from "../desktop/services/provider-registry.mjs";
import { BackupFileService } from "../desktop/services/backup-files.mjs";
import { RuntimeLogger } from "../desktop/services/runtime-logger.mjs";
import {
  decryptTestSecretsBlob,
  TEST_SECRETS_AAD,
} from "../desktop/services/test-secrets.mjs";
import { UpdaterController, updaterMetadata } from "../desktop/services/updater-controller.mjs";
import { installAppProtocol, resolveAppResource } from "../desktop/main/protocol.mjs";
import { registerDesktopIpc } from "../desktop/main/ipc.mjs";
import { QuitCoordinator } from "../desktop/main/lifecycle.mjs";
import {
  createSecureWindowOptions,
  isAllowedExternalUrl,
  isTrustedAppUrl,
} from "../desktop/main/security.mjs";

const require = createRequire(import.meta.url);
const ipcChannels = require("../desktop/shared/ipc-channels.cjs");

async function withTempDirectory(run) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ngr-desktop-core-"));
  try {
    return await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("external app registry detects ArtHub, hides paths, and only launches registered ids", async () => {
  await withTempDirectory(async (userDataPath) => {
    const artHubPath = path.join(userDataPath, "ArtHub.exe");
    const customPath = path.join(userDataPath, "Uploader.exe");
    await writeFile(artHubPath, "test executable");
    await writeFile(customPath, "test executable");
    const opened = [];
    let selectedPath = customPath;
    const registry = new ExternalAppRegistry({
      userDataPath,
      artHubCandidates: [artHubPath],
      getWindow: () => null,
      dialog: {
        async showOpenDialog() { return { canceled: false, filePaths: [selectedPath] }; },
      },
      shell: {
        async openPath(executablePath) { opened.push(executablePath); return ""; },
      },
    });
    const initialized = await registry.initialize();
    assert.deepEqual(initialized.apps, [{
      id: "arthub", name: "ArtHub", builtin: true, configured: true, available: true,
    }]);
    assert.doesNotMatch(JSON.stringify(initialized), /ArtHub\.exe/);
    assert.deepEqual(await registry.launch({ appId: "arthub" }), { opened: true, appId: "arthub", name: "ArtHub" });
    assert.deepEqual(opened, [artHubPath]);
    await assert.rejects(() => registry.launch({ appId: "missing" }), { code: "APP_NOT_FOUND" });

    const added = await registry.choose();
    const custom = added.apps.find((app) => !app.builtin);
    assert.equal(custom.name, "Uploader");
    assert.equal(custom.available, true);
    assert.doesNotMatch(JSON.stringify(added), /Uploader\.exe/);
    await registry.launch({ appId: custom.id });
    assert.deepEqual(opened, [artHubPath, customPath]);
    const removed = await registry.remove({ appId: custom.id });
    assert.equal(removed.apps.length, 1);
    await assert.rejects(() => registry.remove({ appId: "arthub" }), { code: "BUILTIN_APP_REQUIRED" });

    selectedPath = path.join(userDataPath, "not-an-app.txt");
    await writeFile(selectedPath, "no");
    await assert.rejects(() => registry.choose({ appId: "arthub" }), { code: "APP_EXECUTABLE_INVALID" });
  });
});

test("custom scheme resolves only app-hosted resources and adds a strict CSP", async () => {
  await withTempDirectory(async (appRoot) => {
    await writeFile(path.join(appRoot, "index.html"), "<!doctype html><title>NGR</title>");
    assert.equal(resolveAppResource(appRoot, "ngr-assetpilot://app/"), path.join(appRoot, "index.html"));
    assert.equal(resolveAppResource(appRoot, "ngr-assetpilot://evil/index.html"), null);
    assert.equal(resolveAppResource(appRoot, "https://app/index.html"), null);
    assert.equal(resolveAppResource(appRoot, "ngr-assetpilot://app/a%5cb.txt"), null);

    let handler;
    const fakeProtocol = {
      async handle(scheme, value) {
        assert.equal(scheme, "ngr-assetpilot");
        handler = value;
      },
    };
    await installAppProtocol({ protocol: fakeProtocol, appRoot });
    const response = await handler({ method: "GET", url: "ngr-assetpilot://app/" });
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-security-policy"), /connect-src 'none'/);
    assert.match(await response.text(), /NGR/);
    const missing = await handler({ method: "GET", url: "ngr-assetpilot://app/missing.js" });
    assert.equal(missing.status, 404);
  });
});

test("window settings and navigation helpers enforce the renderer boundary", () => {
  const options = createSecureWindowOptions({ preloadPath: "C:\\safe\\preload.cjs", isPackaged: true });
  assert.equal(options.webPreferences.nodeIntegration, false);
  assert.equal(options.webPreferences.contextIsolation, true);
  assert.equal(options.webPreferences.sandbox, true);
  assert.equal(options.webPreferences.webSecurity, true);
  assert.equal(options.webPreferences.webviewTag, false);
  assert.equal(options.webPreferences.devTools, false);
  assert.equal(isTrustedAppUrl("ngr-assetpilot://app/js/main.js"), true);
  assert.equal(isTrustedAppUrl("ngr-assetpilot://other/js/main.js"), false);
  assert.equal(isAllowedExternalUrl("https://ngr.lttlt.top/help"), true);
  assert.equal(isAllowedExternalUrl("https://github.com/907609732/NGR-AssetPilot-App/releases"), true);
  assert.equal(isAllowedExternalUrl("https://doc.weixin.qq.com/forms/ACwAeQeSAD0AawAWwZXAN0CNcmlvfsE1f?page=1"), true);
  assert.equal(isAllowedExternalUrl("https://doc.weixin.qq.com/forms/a-different-form?page=1"), false);
  assert.equal(isAllowedExternalUrl("https://doc.weixin.qq.com/forms/ACwAeQeSAD0AawAWwZXAN0CNcmlvfsE1f?page=2"), false);
  assert.equal(isAllowedExternalUrl("http://doc.weixin.qq.com/forms/ACwAeQeSAD0AawAWwZXAN0CNcmlvfsE1f?page=1"), false);
  assert.equal(isAllowedExternalUrl("https://example.com/help"), false);
  assert.equal(isAllowedExternalUrl("http://example.com/help"), false);
  assert.equal(isAllowedExternalUrl("https://user:pass@example.com/help"), false);
});

test("preload exposes only the nested ngrDesktop contract", async () => {
  const preloadSource = await readFile(new URL("../desktop/preload/index.cjs", import.meta.url), "utf8");
  const calls = [];
  let exposed;
  const fakeElectron = {
    contextBridge: {
      exposeInMainWorld(name, api) {
        assert.equal(name, "ngrDesktop");
        exposed = api;
      },
    },
    ipcRenderer: {
      invoke: async (channel, payload) => {
        calls.push([channel, payload]);
        return { ok: true };
      },
      on() {},
      removeListener() {},
      send() {},
    },
  };
  const module = { exports: {} };
  const wrapper = new vm.Script(`(function(require,module,exports){${preloadSource}\n})`);
  wrapper.runInThisContext()(
    (specifier) => {
      if (specifier === "electron") return fakeElectron;
      throw new Error(`Unexpected preload dependency: ${specifier}`);
    },
    module,
    module.exports,
  );
  assert.deepEqual(Object.keys(exposed), [
    "environment",
    "credentials",
    "providers",
    "network",
    "files",
    "backup",
    "updater",
    "shell",
    "externalApps",
    "localImageSearch",
    "app",
  ]);
  assert.equal(Object.isFrozen(exposed), true);
  assert.doesNotMatch(preloadSource, /require\(["']\.\.?[\\/]/, "sandboxed preload must be self-contained");
  assert.equal(typeof exposed.credentials.get, "undefined");
  assert.equal(typeof exposed.credentials.set, "undefined");
  assert.equal(typeof exposed.providers.upsert, "function");
  assert.equal(typeof exposed.network.cancel, "function");
  assert.equal(typeof exposed.files.writeFile, "function");
  assert.equal(typeof exposed.backup.beginImport, "function");
  assert.equal(typeof exposed.backup.finishImport, "function");
  assert.equal(typeof exposed.backup.cancelImport, "function");
  assert.equal(typeof exposed.backup.save, "undefined");
  assert.equal(typeof exposed.backup.open, "undefined");
  assert.equal(typeof exposed.backup.beginApply, "function");
  assert.equal(typeof exposed.backup.importLegacySecrets, "function");
  assert.equal(typeof exposed.backup.commitApply, "function");
  assert.equal(typeof exposed.backup.getApplyState, "function");
  assert.equal(typeof exposed.backup.rollbackApply, "function");
  assert.equal(typeof exposed.backup.finalizeApply, "function");
  assert.equal(typeof exposed.localImageSearch.searchByImage, "function");
  assert.equal(typeof exposed.localImageSearch.importModel, "function");
  assert.equal(typeof exposed.localImageSearch.exportModel, "function");
  assert.equal(typeof exposed.localImageSearch.listModels, "function");
  assert.equal(typeof exposed.localImageSearch.validateModel, "function");
  assert.equal(typeof exposed.localImageSearch.setActiveModel, "function");
  assert.equal(typeof exposed.localImageSearch.getEngineStatus, "function");
  assert.equal(typeof exposed.localImageSearch.listAssetFolders, "function");
  assert.equal(typeof exposed.localImageSearch.listAssets, "function");
  assert.equal(typeof exposed.app.onBeforeQuit, "function");
  await exposed.shell.openExternal({ url: "https://example.com" });
  assert.deepEqual(calls.at(-1), [ipcChannels.shellOpenExternal, { url: "https://example.com" }]);
  await exposed.localImageSearch.setActiveModel({ modelId: "custom-model" });
  assert.deepEqual(calls.at(-1), [ipcChannels.localImageSearchSetActiveModel, { modelId: "custom-model" }]);
  await exposed.localImageSearch.getModelStatus({ modelId: "builtin-q4" });
  assert.deepEqual(calls.at(-1), [ipcChannels.localImageSearchGetModelStatus, { modelId: "builtin-q4" }]);
  await exposed.localImageSearch.downloadModel({ modelId: "builtin-q4" });
  assert.deepEqual(calls.at(-1), [ipcChannels.localImageSearchDownloadModel, { modelId: "builtin-q4" }]);
  await exposed.localImageSearch.cancelModelDownload({ modelId: "builtin-q4" });
  assert.deepEqual(calls.at(-1), [ipcChannels.localImageSearchCancelModelDownload, { modelId: "builtin-q4" }]);
  await exposed.localImageSearch.exportModel({ modelId: "builtin-q4" });
  assert.deepEqual(calls.at(-1), [ipcChannels.localImageSearchExportModel, { modelId: "builtin-q4" }]);
  await exposed.localImageSearch.listAssetFolders({ libraryId: "library-1", parentPrefix: "ui" });
  assert.deepEqual(calls.at(-1), [ipcChannels.localImageSearchListAssetFolders, { libraryId: "library-1", parentPrefix: "ui" }]);
  await exposed.localImageSearch.listAssets({ libraryId: "library-1", page: 2, pageSize: 100 });
  assert.deepEqual(calls.at(-1), [ipcChannels.localImageSearchListAssets, { libraryId: "library-1", page: 2, pageSize: 100 }]);
  await exposed.backup.finishImport({ sessionId: "import-session" });
  assert.deepEqual(calls.at(-1), [ipcChannels.backupFinishImport, { sessionId: "import-session" }]);
  await exposed.backup.beginApply();
  assert.deepEqual(calls.at(-1), [ipcChannels.backupBeginApply, undefined]);
});

test("IPC handlers reject non-main-frame and non-app senders", async () => {
  const handlers = new Map();
  const listeners = new Map();
  const runtimeEvents = [];
  const ipcMain = {
    handle(channel, handler) { handlers.set(channel, handler); },
    removeHandler(channel) { handlers.delete(channel); },
    on(channel, listener) { listeners.set(channel, listener); },
    removeListener(channel) { listeners.delete(channel); },
  };
  const mainFrame = { routingId: 10, url: "ngr-assetpilot://app/" };
  const webContents = { id: 9, mainFrame, getURL: () => mainFrame.url };
  const window = { isDestroyed: () => false, webContents };
  const dispose = registerDesktopIpc({
    ipcMain,
    dialog: {},
    shell: {},
    getWindow: () => window,
    credentialStore: {},
    providerRegistry: {},
    networkClient: { request: async (payload) => ({ requestId: payload.requestId, ok: true }) },
    directoryTokens: {},
    backupService: {},
    updater: {},
    lifecycle: {},
    environmentInfo: () => ({ safe: true }),
    runtimeLogger: {
      info(stage, details) { runtimeEvents.push({ level: "info", stage, details }); },
      warn(stage, _error, details) { runtimeEvents.push({ level: "warn", stage, details }); },
    },
  });
  const handler = handlers.get(ipcChannels.environmentGetInfo);
  assert.deepEqual(await handler({ sender: webContents, senderFrame: mainFrame }), { safe: true });
  await assert.rejects(
    () => handler({ sender: webContents, senderFrame: { routingId: 11, url: "ngr-assetpilot://app/frame" } }),
    { code: "IPC_SENDER_REJECTED" },
  );
  await assert.rejects(
    () => handler({ sender: webContents, senderFrame: { routingId: 10, url: "https://evil.example/" } }),
    { code: "IPC_SENDER_REJECTED" },
  );
  const networkHandler = handlers.get(ipcChannels.networkRequest);
  assert.deepEqual(
    await networkHandler({ sender: webContents, senderFrame: mainFrame }, { requestId: "request-1" }),
    { requestId: "request-1", ok: true },
  );
  assert.deepEqual(runtimeEvents.map(({ stage }) => stage), ["network-request:start", "network-request:complete"]);
  assert.equal(runtimeEvents[1].details.operationId, "request-1");
  dispose();
  assert.equal(handlers.size, 0);
  assert.equal(listeners.size, 0);
});

test("safeStorage credential repository never falls back to plaintext", async () => {
  await withTempDirectory(async (userDataPath) => {
    const fakeSafeStorage = {
      isEncryptionAvailable: () => true,
      encryptString: (value) => Buffer.from(`protected:${value}`, "utf8"),
      decryptString: (value) => {
        const text = value.toString("utf8");
        if (!text.startsWith("protected:")) throw new Error("not protected");
        return text.slice("protected:".length);
      },
    };
    const store = new CredentialStore({ safeStorage: fakeSafeStorage, userDataPath });
    await store.set({ kimi: { apiKey: "unit-test-only", model: "mock" } });
    const disk = await readFile(path.join(userDataPath, "credentials.v2.json"), "utf8");
    assert.doesNotMatch(disk, /unit-test-only/);
    assert.deepEqual(JSON.parse(JSON.stringify(await store.get())), {
      kimi: { apiKey: "unit-test-only", model: "mock" },
    });
    const status = await store.getStatus();
    assert.equal(status.available, true);
    assert.equal(status.configured, true);
    assert.equal(status.providers.kimi, true);
    await store.clear();
    assert.equal((await store.getStatus()).configured, false);

    const unavailable = new CredentialStore({
      safeStorage: { ...fakeSafeStorage, isEncryptionAvailable: () => false },
      userDataPath,
    });
    await assert.rejects(() => unavailable.set({ value: "no" }), { code: "CREDENTIAL_STORAGE_UNAVAILABLE" });
  });
});

test("provider registry keeps secrets in DPAPI storage and exposes metadata only", async () => {
  await withTempDirectory(async (userDataPath) => {
    const fakeSafeStorage = {
      isEncryptionAvailable: () => true,
      encryptString: (value) => Buffer.from(`protected:${value}`, "utf8"),
      decryptString: (value) => value.toString("utf8").slice("protected:".length),
    };
    const credentialStore = new CredentialStore({ safeStorage: fakeSafeStorage, userDataPath });
    const registry = new ProviderRegistry({ credentialStore, userDataPath });
    await registry.initialize();
    await registry.upsert({
      provider: { id: "openai", apiFormat: "responses", model: "gpt-test" },
      secretAction: "replace",
      secret: { apiKey: "provider-secret-test-only" },
    });
    await registry.upsert({
      provider: {
        id: "user-ai",
        service: "ai",
        baseUrl: "http://127.0.0.1:11434/v1",
        apiFormat: "chat",
        model: "local-model",
      },
      secretAction: "replace",
      secret: { apiKey: "local-secret-test-only" },
    });
    const publicProviders = await registry.list();
    assert.equal(publicProviders.find((provider) => provider.id === "openai").hasSecret, true);
    assert.equal(JSON.stringify(publicProviders).includes("provider-secret-test-only"), false);
    assert.doesNotMatch(await readFile(path.join(userDataPath, "credentials.v2.json"), "utf8"), /provider-secret-test-only/);
    assert.doesNotMatch(await readFile(path.join(userDataPath, "providers.v1.json"), "utf8"), /secret-test-only/);
    const resolved = await registry.resolveRequest({
      providerId: "openai",
      operation: "responses",
      body: { model: "gpt-test", input: [] },
    });
    assert.equal(resolved.url.href, "https://api.openai.com/v1/responses");
    assert.equal(resolved.headers.authorization, "Bearer provider-secret-test-only");
    assert.equal(validateProviderBaseUrl("http://127.0.0.1:11434/v1").allowLoopback, true);
    assert.throws(() => validateProviderBaseUrl("http://127.0.0.1/v1"), { code: "PROVIDER_PORT_REQUIRED" });
    assert.throws(() => validateProviderBaseUrl("https://192.0.2.8/v1"), { code: "PROVIDER_IP_NOT_ALLOWED" });
    assert.throws(() => validateProviderBaseUrl("https://user:pass@example.com/v1"), { code: "PROVIDER_URL_INVALID" });
    assert.throws(() => validateProviderBaseUrl("https://localhost.evil.example/v1"), { code: "PROVIDER_HOST_SPOOFED" });
    const localProvider = publicProviders.find((provider) => provider.id === "user-ai");
    assert.equal(registry.isRedirectAuthorized(localProvider, new URL("http://127.0.0.1:11434/v1/models")), true);
    assert.equal(registry.isRedirectAuthorized(localProvider, new URL("http://127.0.0.1:11434/admin")), false);
    assert.equal(registry.isRedirectAuthorized(localProvider, new URL("http://user@127.0.0.1:11434/v1/models")), false);
  });
});

test("legacy credential migration verifies v2 then archives the recoverable v1 file", async () => {
  await withTempDirectory(async (userDataPath) => {
    const fakeSafeStorage = {
      isEncryptionAvailable: () => true,
      encryptString: (value) => Buffer.from(`protected:${value}`, "utf8"),
      decryptString: (value) => value.toString("utf8").slice("protected:".length),
    };
    const legacy = { kimi: { provider: "kimi", apiKey: "legacy-secret-test-only", apiFormat: "chat" } };
    await writeFile(path.join(userDataPath, "credentials.v1.json"), JSON.stringify({
      version: 1,
      protection: "electron-safe-storage",
      ciphertext: fakeSafeStorage.encryptString(JSON.stringify(legacy)).toString("base64"),
    }));
    const credentialStore = new CredentialStore({ safeStorage: fakeSafeStorage, userDataPath });
    const registry = new ProviderRegistry({ credentialStore, userDataPath });
    await registry.initialize();
    assert.equal((await registry.list()).find((provider) => provider.id === "moonshot").hasSecret, true);
    assert.equal((await credentialStore.getProviderSecret("moonshot")).apiKey, "legacy-secret-test-only");
    await access(path.join(userDataPath, "credentials.v1.json.migrated-backup"));
    await assert.rejects(() => access(path.join(userDataPath, "credentials.v1.json")));
    const restarted = new ProviderRegistry({ credentialStore, userDataPath });
    await restarted.initialize();
    assert.equal((await restarted.list()).find((provider) => provider.id === "moonshot").hasSecret, true);
  });
});

test("provider registry remains usable when Windows credential encryption is temporarily unavailable", async () => {
  await withTempDirectory(async (userDataPath) => {
    const credentialStore = new CredentialStore({
      safeStorage: {
        isEncryptionAvailable: () => false,
        encryptString() { throw new Error("unavailable"); },
        decryptString() { throw new Error("unavailable"); },
      },
      userDataPath,
    });
    const registry = new ProviderRegistry({ credentialStore, userDataPath });
    await registry.initialize();
    const providers = await registry.list();
    assert.ok(providers.some((provider) => provider.id === "openai"));
    assert.equal(providers.every((provider) => provider.hasSecret === false), true);
    await assert.rejects(() => registry.upsert({
      provider: { id: "openai" },
      secretAction: "replace",
      secret: { apiKey: "cannot-save" },
    }), { code: "CREDENTIAL_STORAGE_UNAVAILABLE" });
  });
});

test("provider registry compensates secret changes when metadata persistence fails", async () => {
  await withTempDirectory(async (userDataPath) => {
    const fakeSafeStorage = {
      isEncryptionAvailable: () => true,
      encryptString: (value) => Buffer.from(`protected:${value}`, "utf8"),
      decryptString: (value) => value.toString("utf8").slice("protected:".length),
    };
    const credentialStore = new CredentialStore({ safeStorage: fakeSafeStorage, userDataPath });
    const registry = new ProviderRegistry({ credentialStore, userDataPath });
    await registry.initialize();
    await registry.upsert({
      provider: { id: "user-ai", service: "ai", baseUrl: "https://models.example/v1", apiFormat: "chat", model: "before" },
      secretAction: "replace",
      secret: { apiKey: "before-secret" },
    });
    await rm(path.join(userDataPath, "providers.v1.json"));
    await mkdir(path.join(userDataPath, "providers.v1.json"));
    await assert.rejects(() => registry.upsert({
      provider: { id: "user-ai", service: "ai", baseUrl: "https://models.example/v2", apiFormat: "chat", model: "after" },
      secretAction: "replace",
      secret: { apiKey: "after-secret" },
    }), { code: "PROVIDER_REGISTRY_WRITE_FAILED" });
    assert.equal((await credentialStore.getProviderSecret("user-ai")).apiKey, "before-secret");
    assert.equal((await registry.list()).find((provider) => provider.id === "user-ai").model, "before");
  });
});

test("provider backup import replaces all supplied secrets or restores the prior state", async () => {
  await withTempDirectory(async (userDataPath) => {
    const fakeSafeStorage = {
      isEncryptionAvailable: () => true,
      encryptString: (value) => Buffer.from(`protected:${value}`, "utf8"),
      decryptString: (value) => value.toString("utf8").slice("protected:".length),
    };
    const credentialStore = new CredentialStore({ safeStorage: fakeSafeStorage, userDataPath });
    const registry = new ProviderRegistry({ credentialStore, userDataPath });
    await registry.initialize();
    await registry.upsert({
      provider: { id: "openai", apiFormat: "responses", model: "before" },
      secretAction: "replace",
      secret: { apiKey: "before-secret" },
    });
    await rm(path.join(userDataPath, "providers.v1.json"));
    await mkdir(path.join(userDataPath, "providers.v1.json"));
    await assert.rejects(() => registry.importLegacy({
      onlyIfEmpty: false,
      ai: { provider: "openai", apiFormat: "responses", model: "after", apiKey: "after-secret" },
      translation: {
        provider: "baidu",
        baiduAppId: "after-app-id",
        baiduSecret: "after-baidu-secret",
      },
    }), { code: "PROVIDER_REGISTRY_WRITE_FAILED" });
    assert.equal((await credentialStore.getProviderSecret("openai")).apiKey, "before-secret");
    assert.equal(await credentialStore.getProviderSecret("baidu"), null);
    assert.equal((await registry.list()).find((provider) => provider.id === "openai").model, "before");
  });
});

test("streamed backup secrets decrypt only in main and provider transaction survives crashes", async () => {
  await withTempDirectory(async (userDataPath) => {
    const fakeSafeStorage = {
      isEncryptionAvailable: () => true,
      encryptString: (value) => Buffer.from(`protected:${value}`, "utf8"),
      decryptString: (value) => value.toString("utf8").slice("protected:".length),
    };
    const credentialStore = new CredentialStore({ safeStorage: fakeSafeStorage, userDataPath });
    const registry = new ProviderRegistry({ credentialStore, userDataPath });
    await registry.initialize();
    await registry.upsert({
      provider: { id: "openai", apiFormat: "responses", model: "before" },
      secretAction: "replace",
      secret: { apiKey: "before-secret" },
    });
    const dialog = {
      async showSaveDialog() { return { canceled: true }; },
      async showOpenDialog() { return { canceled: true }; },
    };
    const service = new BackupFileService({
      dialog,
      getWindow: () => null,
      userDataPath,
      providerRegistry: registry,
    });
    const password = "test-password-123";
    const credentials = {
      ai: { provider: "openai", apiFormat: "responses", model: "after", apiKey: "after-secret" },
      translation: {},
    };
    const salt = randomBytes(16);
    const iv = randomBytes(12);
    const key = pbkdf2Sync(password, salt, 600_000, 32, "sha256");
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const plaintext = Buffer.from(JSON.stringify({
      format: "NGR_ASSETPILOT_SECRETS",
      version: 1,
      createdAt: "2026-08-20T00:00:00.000Z",
      credentials,
    }));
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
    const encryptedBlock = Buffer.from(JSON.stringify({
      format: "NGR_ASSETPILOT_SECRETS",
      version: 1,
      kdf: { algorithm: "PBKDF2", hash: "SHA-256", iterations: 600_000, salt: salt.toString("base64") },
      cipher: { algorithm: "AES-256-GCM", iv: iv.toString("base64"), ciphertext: ciphertext.toString("base64") },
    }));
    key.fill(0);
    plaintext.fill(0);

    const transaction = await service.beginApply(31);
    await assert.rejects(() => registry.upsert({
      provider: { id: "openai", apiFormat: "responses", model: "concurrent" },
      secretAction: "keep",
    }), { code: "PROVIDER_IMPORT_BUSY" });
    await assert.rejects(
      () => service.importLegacySecrets({ transactionId: transaction.transactionId, data: encryptedBlock, password }, 32),
      { code: "BACKUP_APPLY_INVALID" },
    );
    await assert.rejects(
      () => service.importLegacySecrets({ transactionId: transaction.transactionId, data: encryptedBlock, password: "wrong-password-123" }, 31),
      { code: "DECRYPTION_FAILED" },
    );
    const imported = await service.importLegacySecrets({
      transactionId: transaction.transactionId,
      data: encryptedBlock,
      password,
    }, 31);
    assert.equal(imported.imported, true);
    assert.equal(JSON.stringify(imported).includes("after-secret"), false);
    assert.equal((await credentialStore.getProviderSecret("openai")).apiKey, "after-secret");
    const journalText = await readFile(path.join(userDataPath, "provider-import-transaction.v1.json"), "utf8");
    assert.doesNotMatch(journalText, /before-secret|after-secret|test-password/);

    await service.rollbackApply({ transactionId: transaction.transactionId }, 31);
    assert.equal((await credentialStore.getProviderSecret("openai")).apiKey, "before-secret");
    await service.finalizeApply({ transactionId: transaction.transactionId }, 31);

    const crashTransaction = await service.beginApply(31);
    await service.importLegacySecrets({
      transactionId: crashTransaction.transactionId,
      data: encryptedBlock,
      password,
    }, 31);
    assert.equal((await credentialStore.getProviderSecret("openai")).apiKey, "after-secret");
    const restartedCredentialStore = new CredentialStore({ safeStorage: fakeSafeStorage, userDataPath });
    const restartedRegistry = new ProviderRegistry({ credentialStore: restartedCredentialStore, userDataPath });
    await restartedRegistry.initialize();
    assert.equal((await restartedCredentialStore.getProviderSecret("openai")).apiKey, "before-secret");
    assert.equal((await restartedRegistry.getImportTransactionState(crashTransaction.transactionId)).phase, "rolled-back");
    await restartedRegistry.finalizeImportTransaction(crashTransaction.transactionId);
    encryptedBlock.fill(0);
  });
});

test("directory tokens are owner-bound and support ordered chunk writes", async () => {
  await withTempDirectory(async (rootPath) => {
    const tokens = new DirectoryTokenStore();
    const { token } = await tokens.grant(rootPath, 7);
    await tokens.writeFile(
      {
        directoryToken: token,
        relativePath: "nested/result.txt",
        data: new TextEncoder().encode("hello ").buffer,
        offset: 0,
        truncate: true,
        final: false,
      },
      7,
    );
    const result = await tokens.writeFile(
      {
        directoryToken: token,
        relativePath: "nested/result.txt",
        data: new TextEncoder().encode("world").buffer,
        offset: 6,
        final: true,
      },
      7,
    );
    assert.equal(result.nextOffset, 11);
    assert.equal(await readFile(path.join(rootPath, "nested", "result.txt"), "utf8"), "hello world");
    await assert.rejects(
      () => tokens.writeFile({ directoryToken: token, relativePath: "../escape", data: new ArrayBuffer(0) }, 7),
      { code: "EXPORT_PATH_INVALID" },
    );
    await assert.rejects(
      () => tokens.writeFile({ directoryToken: token, relativePath: "other.txt", data: new ArrayBuffer(0) }, 8),
      { code: "EXPORT_TOKEN_INVALID" },
    );
    assert.throws(() => validateRelativeExportPath("CON.txt"), { code: "EXPORT_PATH_INVALID" });
  });
});

test("network client enforces service allowlists, redirects, timeouts, and response limits", async () => {
  assert.equal(validateNetworkUrl("https://api.moonshot.cn/v1/chat/completions", "ai").hostname, "api.moonshot.cn");
  assert.equal(validateNetworkUrl("http://127.0.0.1:11434/v1/chat", "ai").port, "11434");
  assert.throws(() => validateNetworkUrl("http://api.moonshot.cn/v1", "ai"), {
    code: "NETWORK_PROTOCOL_NOT_ALLOWED",
  });
  assert.throws(() => validateNetworkUrl("https://example.com/collect", "ai"), {
    code: "NETWORK_HOST_NOT_ALLOWED",
  });

  const urls = [];
  const client = new NetworkClient({
    fetchImpl: async (url) => {
      urls.push(url);
      if (urls.length === 1) {
        return new Response(null, { status: 302, headers: { location: "/v1/final" } });
      }
      return new Response('{"ok":true}', {
        status: 200,
        headers: { "content-type": "application/json", "x-request-id": "safe-id" },
      });
    },
  });
  const response = await client.request({
    service: "ai",
    url: "https://api.moonshot.cn/v1/start",
    method: "POST",
    headers: { authorization: "Bearer test-only" },
    body: { input: "test" },
  });
  assert.equal(response.ok, true);
  assert.equal(response.bodyText, '{"ok":true}');
  assert.equal(response.headers["x-request-id"], "safe-id");
  assert.equal(urls.length, 2);

  const crossOriginClient = new NetworkClient({
    fetchImpl: async () =>
      new Response(null, { status: 307, headers: { location: "https://api.openai.com/v1/redirected" } }),
  });
  await assert.rejects(
    () =>
      crossOriginClient.request({
        service: "ai",
        url: "https://api.moonshot.cn/v1/start",
        method: "GET",
      }),
    { code: "NETWORK_CROSS_ORIGIN_REDIRECT" },
  );

  const oversizedClient = new NetworkClient({
    fetchImpl: async () =>
      new Response("small", { status: 200, headers: { "content-length": String(2 * 1024 * 1024 + 1) } }),
  });
  await assert.rejects(
    () => oversizedClient.request({ service: "translation", url: "https://fanyi-api.baidu.com/mock" }),
    { code: "NETWORK_RESPONSE_TOO_LARGE" },
  );
});

test("network cancellation is registered before provider resolution completes", async () => {
  let releaseResolution;
  let resolutionStarted;
  let fetchCalls = 0;
  const started = new Promise((resolve) => { resolutionStarted = resolve; });
  const providerRegistry = {
    async resolveRequest() {
      resolutionStarted();
      return new Promise((resolve) => { releaseResolution = resolve; });
    },
    isRedirectAuthorized: () => true,
  };
  const client = new NetworkClient({
    providerRegistry,
    fetchImpl: async () => {
      fetchCalls += 1;
      return new Response("unexpected");
    },
  });
  const pending = client.request({
    requestId: "resolve_cancel_01",
    providerId: "openai",
    operation: "responses",
    body: {},
  }, 42);
  await started;
  assert.deepEqual(client.cancel({ requestId: "resolve_cancel_01" }, 42), {
    canceled: true,
    requestId: "resolve_cancel_01",
  });
  releaseResolution({
    provider: { id: "openai", service: "ai" },
    url: new URL("https://api.openai.com/v1/responses"),
    method: "POST",
    headers: { authorization: "Bearer test-only" },
    body: {},
    maximumTimeout: 120_000,
  });
  await assert.rejects(pending, { code: "NETWORK_CANCELED" });
  assert.equal(fetchCalls, 0);
});

test("network body AbortError maps to cancel and timeout public error codes", async () => {
  function createBlockedFetch() {
    let readStarted;
    const started = new Promise((resolve) => { readStarted = resolve; });
    return {
      started,
      fetchImpl: async (_url, options) => {
        let streamController;
        const stream = new ReadableStream({
          start(controller) {
            streamController = controller;
          },
          pull() {
            readStarted();
          },
        });
        options.signal.addEventListener("abort", () => {
          streamController.error(new DOMException("aborted", "AbortError"));
        }, { once: true });
        return new Response(stream, { status: 200 });
      },
    };
  }

  const canceledFetch = createBlockedFetch();
  const canceledClient = new NetworkClient({ fetchImpl: canceledFetch.fetchImpl });
  const canceled = canceledClient.request({
    requestId: "body_cancel_01",
    service: "ai",
    url: "https://api.openai.com/v1/responses",
  }, 7);
  await canceledFetch.started;
  assert.equal(canceledClient.cancel({ requestId: "body_cancel_01" }, 7).canceled, true);
  await assert.rejects(canceled, { code: "NETWORK_CANCELED" });

  const timedFetch = createBlockedFetch();
  const timedClient = new NetworkClient({ fetchImpl: timedFetch.fetchImpl });
  const timed = timedClient.request({
    requestId: "body_timeout_01",
    service: "ai",
    url: "https://api.openai.com/v1/responses",
    timeoutMs: 1_000,
  }, 7);
  await timedFetch.started;
  await assert.rejects(timed, { code: "NETWORK_TIMEOUT" });
});

test("backup sessions are owner-bound, chunked, atomic, and recover known journal parts", async () => {
  await withTempDirectory(async (userDataPath) => {
    const finalPath = path.join(userDataPath, "workspace.ngrap");
    let saveTarget = finalPath;
    const dialog = {
      async showSaveDialog() { return { canceled: false, filePath: saveTarget }; },
      async showOpenDialog() { return { canceled: false, filePaths: [finalPath] }; },
    };
    const service = new BackupFileService({ dialog, getWindow: () => null, userDataPath });
    const begin = await service.beginExport({ suggestedName: "workspace.ngrap", expectedSize: 11 }, 9);
    const first = new TextEncoder().encode("hello ");
    await service.writeExportChunk({ sessionId: begin.sessionId, offset: 0, data: first }, 9);
    await assert.rejects(
      () => service.writeExportChunk({ sessionId: begin.sessionId, offset: 6, data: new Uint8Array(0) }, 10),
      { code: "BACKUP_SESSION_INVALID" },
    );
    const second = new TextEncoder().encode("world");
    await service.writeExportChunk({ sessionId: begin.sessionId, offset: 6, data: second }, 9);
    const finished = await service.finishExport({ sessionId: begin.sessionId }, 9);
    assert.equal(finished.bytesWritten, 11);
    assert.equal(await readFile(finalPath, "utf8"), "hello world");

    const opened = await service.beginImport(9);
    const activeJournal = JSON.parse(await readFile(path.join(userDataPath, "backup-sessions.v2.json"), "utf8"));
    assert.deepEqual(activeJournal.sessions.map((session) => session.type), ["import"]);
    const firstRead = await service.readImportChunk({ sessionId: opened.sessionId, offset: 0, length: 5 }, 9);
    assert.equal(new TextDecoder().decode(firstRead.data), "hello");
    await assert.rejects(
      () => service.readImportChunk({ sessionId: opened.sessionId, offset: 0, length: 5 }, 9),
      { code: "BACKUP_CHUNK_INVALID" },
    );
    const rest = await service.readImportChunk({ sessionId: opened.sessionId, offset: 5, length: 20 }, 9);
    assert.equal(new TextDecoder().decode(rest.data), " world");
    assert.equal(rest.done, true);
    assert.equal((await service.finishImport({ sessionId: opened.sessionId }, 9)).bytesRead, 11);
    assert.deepEqual(JSON.parse(await readFile(path.join(userDataPath, "backup-sessions.v2.json"), "utf8")).sessions, []);

    saveTarget = path.join(userDataPath, "streamed.ngrap");
    const streamed = await service.beginExport({ suggestedName: "streamed.ngrap", expectedSize: null }, 9);
    await service.writeExportChunk({ sessionId: streamed.sessionId, offset: 0, data: new TextEncoder().encode("stream") }, 9);
    assert.equal((await service.finishExport({ sessionId: streamed.sessionId }, 9)).bytesWritten, 6);
    assert.equal(await readFile(saveTarget, "utf8"), "stream");
    await service.dispose();

    const stalePart = path.join(userDataPath, "old.ngrap.ngr-backup-00000000-0000-4000-8000-000000000000.part");
    const unrelatedPart = path.join(userDataPath, "keep.part");
    await writeFile(stalePart, "stale");
    await writeFile(unrelatedPart, "keep");
    await writeFile(path.join(userDataPath, "backup-sessions.v2.json"), JSON.stringify({
      version: 2,
      sessions: [{
        type: "export",
        sessionId: "00000000-0000-4000-8000-000000000000",
        finalPath: path.join(userDataPath, "old.ngrap"),
        partPath: stalePart,
      }, {
        type: "export",
        sessionId: "10000000-0000-4000-8000-000000000000",
        finalPath: path.join(userDataPath, "different.ngrap"),
        partPath: unrelatedPart,
      }, {
        type: "import",
        sessionId: "20000000-0000-4000-8000-000000000000",
        sourceSize: 42,
      }],
    }));
    const restarted = new BackupFileService({ dialog, getWindow: () => null, userDataPath });
    await restarted.initialize();
    await assert.rejects(() => access(stalePart));
    assert.equal(await readFile(unrelatedPart, "utf8"), "keep");
    assert.deepEqual(JSON.parse(await readFile(path.join(userDataPath, "backup-sessions.v2.json"), "utf8")).sessions, []);
  });
});

test("quit coordinator runs finalizers in parallel with renderer persistence and stays bounded", async () => {
  const app = new EventEmitter();
  let quitCalls = 0;
  app.quit = () => { quitCalls += 1; };
  const window = new EventEmitter();
  let quitPayload;
  window.isDestroyed = () => false;
  window.webContents = {
    isDestroyed: () => false,
    send(_channel, payload) { quitPayload = payload; },
  };
  let releaseFinalizer;
  let finalizerCalls = 0;
  const coordinator = new QuitCoordinator({ app, channel: "before-quit-test", timeoutMs: 200 });
  coordinator.attachWindow(window);
  coordinator.addFinalizer("slow", async () => {
    finalizerCalls += 1;
    await new Promise((resolve) => { releaseFinalizer = resolve; });
  });
  const event = { prevented: false, preventDefault() { this.prevented = true; } };
  app.emit("before-quit", event);
  assert.equal(event.prevented, true);
  assert.equal(finalizerCalls, 1, "finalizer must start before the renderer acknowledges quit");
  assert.equal(coordinator.ready(quitPayload.requestId), true);
  assert.equal(quitCalls, 0, "quit waits until subsystem finalizers finish");
  releaseFinalizer();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(quitCalls, 1);
  coordinator.dispose();

  const unresponsiveApp = new EventEmitter();
  let boundedQuitCalls = 0;
  unresponsiveApp.quit = () => { boundedQuitCalls += 1; };
  const unresponsiveWindow = new EventEmitter();
  unresponsiveWindow.isDestroyed = () => false;
  unresponsiveWindow.webContents = { isDestroyed: () => false, send() {} };
  let unresponsiveFinalizers = 0;
  const bounded = new QuitCoordinator({ app: unresponsiveApp, channel: "before-quit-test", timeoutMs: 25 });
  bounded.attachWindow(unresponsiveWindow);
  bounded.addFinalizer("always-runs", async () => { unresponsiveFinalizers += 1; });
  unresponsiveApp.emit("before-quit", { preventDefault() {} });
  assert.equal(unresponsiveFinalizers, 1);
  await new Promise((resolve) => setTimeout(resolve, 45));
  assert.equal(boundedQuitCalls, 1, "deadline must release quit when renderer never responds");
  bounded.dispose();
});

test("runtime logger rotates locally, redacts paths and secrets, and tracks clean shutdown", async () => {
  await withTempDirectory(async (userDataPath) => {
    const messages = [];
    const logger = {
      transports: { file: {}, remote: {} },
      initialize() {},
      info(message) { messages.push(message); },
      warn(message) { messages.push(message); },
      error(message) { messages.push(message); },
    };
    const runtime = new RuntimeLogger({
      app: { getPath: (name) => name === "userData" ? userDataPath : "" },
      logger,
      edition: "dev",
    });
    const initialized = await runtime.initialize();
    assert.equal(initialized.previousCleanShutdown, true);
    assert.equal(logger.transports.file.maxSize, 5 * 1024 * 1024);
    assert.equal(logger.transports.remote.level, false);
    runtime.error("renderer-process-gone", { code: "RENDERER_GONE", message: "secret body" }, {
      providerId: "openai",
      reason: "C:\\Users\\private\\query.png",
      prompt: "must-not-log",
      secret: "must-not-log",
    });
    const joined = messages.join("\n");
    assert.doesNotMatch(joined, /private|query\.png|must-not-log|secret body/);
    assert.match(joined, /\[redacted\]/);
    const restarted = new RuntimeLogger({
      app: { getPath: (name) => name === "userData" ? userDataPath : "" },
      logger,
      edition: "dev",
    });
    assert.equal((await restarted.initialize()).previousCleanShutdown, false);
    await restarted.markCleanShutdown();
    assert.equal(JSON.parse(await readFile(path.join(userDataPath, "runtime-state.json"), "utf8")).cleanShutdown, true);
  });
});

test("test-secret binary format decrypts only after hash, key-share, and GCM validation", () => {
  const plaintext = Buffer.from(JSON.stringify({ kimi: { apiKey: "fixture-not-real" } }), "utf8");
  const key = randomBytes(32);
  const keyShareA = randomBytes(32);
  const keyShareB = Buffer.alloc(32);
  for (let index = 0; index < 32; index += 1) keyShareB[index] = key[index] ^ keyShareA[index];
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(TEST_SECRETS_AAD, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  const blob = Buffer.concat([Buffer.from("NGRSEC1\0", "ascii"), keyShareB, iv, tag, ciphertext]);
  const config = {
    schemaVersion: 1,
    algorithm: "aes-256-gcm",
    keyShare: keyShareA.toString("base64"),
    resourceName: "test-secrets.bin",
    blobSha256: createHash("sha256").update(blob).digest("hex"),
  };
  assert.deepEqual(JSON.parse(JSON.stringify(decryptTestSecretsBlob(blob, config))), {
    kimi: { apiKey: "fixture-not-real" },
  });
  const tampered = Buffer.from(blob);
  tampered[tampered.length - 1] ^= 1;
  assert.throws(() => decryptTestSecretsBlob(tampered, config), { code: "TEST_SECRETS_HASH_MISMATCH" });
  key.fill(0);
  keyShareA.fill(0);
  keyShareB.fill(0);
  plaintext.fill(0);
});

test("updater is disabled for non-installer builds and uses an explicit download phase", async () => {
  const disabled = new UpdaterController({ enabled: false, currentVersion: "3.0.0" });
  assert.equal(disabled.getState().phase, "disabled");
  await assert.rejects(() => disabled.check(), { code: "UPDATER_DISABLED" });

  class FakeUpdater extends EventEmitter {
    setFeedURL(feed) {
      this.feed = feed;
    }
    async checkForUpdates() {
      const updateInfo = {
        version: "3.0.2",
        releaseName: "本地 AI 搜图增强",
        releaseNotes: "<p>新增自定义前缀<br>优化更新弹窗</p>",
        releaseDate: "2026-08-20T08:00:00.000Z",
        files: [{ url: "NGR-AssetPilot-3.0.2-Setup-x64.exe", size: 123456789 }],
      };
      this.emit("update-available", updateInfo);
      return { updateInfo };
    }
    async downloadUpdate() {
      this.emit("download-progress", { percent: 50, transferred: 5, total: 10, bytesPerSecond: 2 });
      this.emit("update-downloaded", { version: "3.0.2" });
    }
    quitAndInstall(...args) {
      this.quitAndInstallArgs = args;
    }
  }
  const fake = new FakeUpdater();
  const updater = new UpdaterController({
    autoUpdater: fake,
    enabled: true,
    currentVersion: "3.0.1",
    installLaunchDelayMs: 0,
    channel: "latest",
    feed: { provider: "github", owner: "907609732", repo: "NGR-AssetPilot-App" },
  });
  const states = [];
  const unsubscribe = updater.subscribe((state) => states.push(state));
  const available = await updater.check();
  assert.equal(available.phase, "available");
  assert.equal(available.channel, "latest");
  assert.equal(available.releaseNotes, "新增自定义前缀\n优化更新弹窗");
  assert.equal(available.downloadSize, 123456789);
  assert.equal(fake.allowPrerelease, false);
  assert.equal(fake.allowDowngrade, false);
  assert.equal(fake.channel, "latest");
  assert.deepEqual(fake.feed, {
    provider: "github",
    owner: "907609732",
    repo: "NGR-AssetPilot-App",
    channel: "latest",
  });
  assert.equal((await updater.download()).phase, "downloaded");
  assert.equal(updater.install().accepted, true);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(fake.quitAndInstallArgs, [false, true]);
  assert.ok(states.some((state) => state.phase === "downloading"));
  unsubscribe();
  updater.dispose();
  assert.equal(updaterMetadata.normalizeReleaseNotes("<script>x</script><p>A&amp;B</p>"), "xA&B");
});

test("all packaged editions contain current entrypoints and a self-contained preload", {
  skip: process.env.NGR_VERIFY_PACKAGED_ARTIFACTS !== "1",
}, async (t) => {
  const asar = require("@electron/asar");
  const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const archivePathFor = (relativePath) => relativePath.split("/").join(path.sep);
  const requestedEditions = new Set(
    String(process.env.NGR_VERIFY_PACKAGED_EDITIONS || "prod,dev,test")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  );
  for (const { edition, entryPath } of [
    { edition: "prod", entryPath: "desktop/main/prod-index.mjs" },
    { edition: "dev", entryPath: "desktop/main/index.mjs" },
    { edition: "test", entryPath: "desktop/main/test-index.mjs" },
  ].filter(({ edition }) => requestedEditions.has(edition))) {
    const archivePath = path.join(projectRoot, "artifacts", edition, "win-unpacked", "resources", "app.asar");
    try { await access(archivePath); } catch { t.skip(`${edition} packaged artifact is not present`); return; }
    const packagedJson = JSON.parse(asar.extractFile(archivePath, "package.json").toString("utf8"));
    assert.equal(packagedJson.main, entryPath);
    for (const relativePath of ["desktop/main/bootstrap.mjs", entryPath, "desktop/preload/index.cjs", "desktop/shared/ipc-channels.cjs"]) {
      const source = await readFile(path.join(projectRoot, relativePath));
      const packaged = asar.extractFile(archivePath, archivePathFor(relativePath));
      assert.equal(Buffer.compare(source, packaged), 0, `${edition}: ${relativePath} must match source`);
    }
    const preload = asar.extractFile(archivePath, archivePathFor("desktop/preload/index.cjs")).toString("utf8");
    assert.doesNotMatch(preload, /require\(["']\.\.?[\\/]/);
    const embeddedChannels = [...preload.matchAll(/"(ngr:[^"]+)"/g)].map((match) => match[1]).sort();
    assert.deepEqual(embeddedChannels, Object.values(ipcChannels).sort());
    const entry = asar.extractFile(archivePath, archivePathFor(entryPath)).toString("utf8");
    assert.doesNotMatch(entry, /^await\s/m);
    assert.match(entry, /\.catch\(reportStartupFailure\)/);
    const archiveEntries = new Set(asar.listPackage(archivePath));
    assert.equal(archiveEntries.has(`${path.sep}desktop${path.sep}services${path.sep}test-secrets.mjs`), false);
  }
});
