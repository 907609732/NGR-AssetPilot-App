import assert from "node:assert/strict";
import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

import { CredentialStore } from "../desktop/services/credential-store.mjs";
import { DirectoryTokenStore, validateRelativeExportPath } from "../desktop/services/directory-tokens.mjs";
import { NetworkClient, validateNetworkUrl } from "../desktop/services/network-client.mjs";
import {
  decryptTestSecretsBlob,
  TEST_SECRETS_AAD,
} from "../desktop/services/test-secrets.mjs";
import { UpdaterController, updaterMetadata } from "../desktop/services/updater-controller.mjs";
import { installAppProtocol, resolveAppResource } from "../desktop/main/protocol.mjs";
import { registerDesktopIpc } from "../desktop/main/ipc.mjs";
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
    "network",
    "files",
    "backup",
    "updater",
    "shell",
    "localImageSearch",
    "app",
  ]);
  assert.equal(Object.isFrozen(exposed), true);
  assert.doesNotMatch(preloadSource, /require\(["']\.\.?[\\/]/, "sandboxed preload must be self-contained");
  assert.equal(typeof exposed.credentials.set, "function");
  assert.equal(typeof exposed.files.writeFile, "function");
    assert.equal(typeof exposed.localImageSearch.searchByImage, "function");
    assert.equal(typeof exposed.localImageSearch.importModel, "function");
    assert.equal(typeof exposed.localImageSearch.exportModel, "function");
  assert.equal(typeof exposed.app.onBeforeQuit, "function");
  await exposed.shell.openExternal({ url: "https://example.com" });
  assert.deepEqual(calls.at(-1), [ipcChannels.shellOpenExternal, { url: "https://example.com" }]);
});

test("IPC handlers reject non-main-frame and non-app senders", async () => {
  const handlers = new Map();
  const listeners = new Map();
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
    networkClient: {},
    directoryTokens: {},
    backupService: {},
    updater: {},
    lifecycle: {},
    environmentInfo: () => ({ safe: true }),
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
    const disk = await readFile(path.join(userDataPath, "credentials.v1.json"), "utf8");
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
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(fake.quitAndInstallArgs, [true, true]);
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
