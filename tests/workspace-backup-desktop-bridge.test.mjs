import assert from "node:assert/strict";
import { Blob } from "node:buffer";
import { createHash, webcrypto } from "node:crypto";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { unzipSync, zipSync } from "fflate";

const source = fs.readFileSync(new URL("../app/js/desktop-bridge.js", import.meta.url), "utf8");
const migrationSource = fs.readFileSync(new URL("../app/js/workspace-migration.js", import.meta.url), "utf8");
const mainSource = fs.readFileSync(new URL("../app/js/main.js", import.meta.url), "utf8");
const backupWorkerSource = fs.readFileSync(new URL("../app/js/workspace-backup-stream-worker.js", import.meta.url), "utf8");
const backupCoreSource = fs.readFileSync(new URL("../app/js/workspace-backup.js", import.meta.url), "utf8");
const fflateSource = fs.readFileSync(new URL("../app/vendor/fflate-0.8.3.min.js", import.meta.url), "utf8");

function createBridgeContext(overrides = {}) {
  const calls = [];
  const native = {
    environment: { getInfo: async () => ({ edition: "dev", distribution: "development" }) },
    credentials: {
      getStatus: async () => ({ configured: true }),
    },
    providers: {
      list: async () => [{ id: "openai", hasSecret: true }],
      upsert: async (payload) => { calls.push(["providers.upsert", payload]); return { ...payload.provider, hasSecret: true }; },
      remove: async (payload) => { calls.push(["providers.remove", payload]); return { removed: true }; },
      importLegacy: async (payload) => { calls.push(["providers.importLegacy", payload]); return { imported: true }; },
    },
    network: {
      request: async (payload) => {
        calls.push(["network.request", payload]);
        return { ok: true, status: 200, bodyText: JSON.stringify({ providerId: payload.providerId }), url: "https://redacted.invalid/v1" };
      },
      cancel: async (payload) => { calls.push(["network.cancel", payload]); return { canceled: true }; },
    },
    files: {
      selectExportDirectory: async () => ({ canceled: false, token: "directory-token" }),
      writeFile: async (payload) => { calls.push(["files.writeFile", payload]); return { bytesWritten: payload.data.byteLength }; },
    },
    backup: {
      beginApply: async () => ({ transactionId: "00000000-0000-4000-8000-000000000099", phase: "prepared" }),
      importLegacySecrets: async (payload) => { calls.push(["backup.importLegacySecrets", payload]); return { imported: true }; },
      commitApply: async (payload) => ({ ...payload, phase: "committed" }),
      getApplyState: async (payload) => ({ ...payload, phase: "committed" }),
      rollbackApply: async (payload) => ({ ...payload, phase: "rolled-back" }),
      finalizeApply: async (payload) => ({ ...payload, finalized: true }),
    },
    app: {
      onBeforeQuit: (callback) => { calls.push(["app.onBeforeQuit", callback]); return () => calls.push(["app.unsubscribe"]); },
      readyToQuit: (requestId) => { calls.push(["app.readyToQuit", requestId]); },
    },
    shell: { openExternal: async () => ({ opened: true }) },
    ...overrides,
  };
  const window = {
    ngrDesktop: native,
    fetch: async () => { throw new Error("desktop requests must not call browser fetch"); },
    open() {},
  };
  const context = {
    ArrayBuffer,
    DOMException,
    Headers,
    Promise,
    TextEncoder,
    Uint8Array,
    URL,
    window,
  };
  vm.createContext(context);
  vm.runInContext(source, context);
  return { bridge: window.NgrDesktopBridge, calls };
}

test("桌面网络桥接只提交 providerId 并兼容 bodyText 响应", async () => {
  const { bridge, calls } = createBridgeContext();
  const aiResponse = await bridge.requestProvider("moonshot", "chat", { model: "test" });
  assert.equal((await aiResponse.json()).providerId, "moonshot");
  const request = calls.find(([name]) => name === "network.request")[1];
  assert.equal(request.providerId, "moonshot");
  assert.equal(request.operation, "chat");
  assert.deepEqual(request.body, { model: "test" });
  assert.equal(Object.hasOwn(request, "url"), false);
  assert.equal(Object.hasOwn(request, "headers"), false);
  await assert.rejects(() => bridge.request("https://api.moonshot.cn/v1"), /必须使用已保存/);
});

test("桌面目录写入按 1 MiB 分块并携带偏移与终止标记", async () => {
  const { bridge, calls } = createBridgeContext();
  const bytes = new Uint8Array(2 * 1024 * 1024 + 17);
  bytes.fill(7);
  await bridge.writeFileInChunks("directory-token", "Project/image.png", new Blob([bytes]));
  const writes = calls.filter(([name]) => name === "files.writeFile").map(([, payload]) => payload);
  assert.equal(writes.length, 3);
  assert.deepEqual(writes.map((write) => write.offset), [0, 1024 * 1024, 2 * 1024 * 1024]);
  assert.deepEqual(writes.map((write) => write.truncate), [true, false, false]);
  assert.deepEqual(writes.map((write) => write.final), [false, false, true]);
  assert.equal(writes.reduce((total, write) => total + write.data.byteLength, 0), bytes.byteLength);
});

test("约 1 GiB 素材导出协议保持 1 MiB 有界分块", { timeout: 30_000 }, async () => {
  const chunkSize = 1024 * 1024;
  const totalSize = 1024 * chunkSize;
  const reusableChunk = new ArrayBuffer(chunkSize);
  const writes = [];
  const { bridge } = createBridgeContext({
    files: {
      selectExportDirectory: async () => ({ canceled: false, token: "directory-token" }),
      writeFile: async (payload) => {
        writes.push({
          offset: payload.offset,
          byteLength: payload.data.byteLength,
          truncate: payload.truncate,
          final: payload.final,
        });
        return { bytesWritten: payload.data.byteLength };
      },
    },
  });
  const virtualOneGiBFile = {
    size: totalSize,
    slice(start, end) {
      const length = end - start;
      return { arrayBuffer: async () => length === chunkSize ? reusableChunk : reusableChunk.slice(0, length) };
    },
  };

  await bridge.writeFileInChunks("directory-token", "Project/large.bin", virtualOneGiBFile);
  assert.equal(writes.length, 1024);
  assert.equal(writes.reduce((total, write) => total + write.byteLength, 0), totalSize);
  assert.equal(Math.max(...writes.map((write) => write.byteLength)), chunkSize);
  assert.equal(writes[0].truncate, true);
  assert.equal(writes.at(-1).final, true);
});

test("桌面备份和凭据只通过窄桥接能力传递", async () => {
  const { bridge, calls } = createBridgeContext();
  assert.equal((await bridge.getInfo()).isDesktop, true);
  assert.equal(typeof bridge.getCredentials, "undefined");
  assert.doesNotMatch(migrationSource, /NgrDesktopBridge\.(?:get|set)Credentials/);
  assert.match(migrationSource, /importLegacyProviders/);
  assert.deepEqual(await bridge.listProviders(), [{ id: "openai", hasSecret: true }]);
  await bridge.upsertProvider({ provider: { id: "openai" }, secretAction: "keep" });
  assert.equal(calls.some(([name]) => name === "providers.upsert"), true);
  assert.equal(typeof bridge.saveBackup, "undefined");
  assert.equal(typeof bridge.openBackup, "undefined");
  assert.equal(source.includes('backup.save'), false);
  assert.equal(source.includes('backup.open'), false);
  const apply = await bridge.beginBackupApply();
  const encrypted = new Uint8Array([1, 2, 3]).buffer;
  await bridge.importBackupLegacySecrets(apply.transactionId, encrypted, "test-password");
  const importCall = calls.find(([name]) => name === "backup.importLegacySecrets")[1];
  assert.equal(importCall.transactionId, apply.transactionId);
  assert.equal(importCall.password, "test-password");
  assert.deepEqual([...new Uint8Array(importCall.data)], [1, 2, 3]);
  assert.doesNotMatch(migrationSource, /NgrDesktopBridge\.openBackup|NgrDesktopBridge\.saveBackup/);
  assert.ok(
    mainSource.indexOf("recoverInterruptedWorkspaceImport") < mainSource.indexOf("resetAppLocalStorageOnVersionChange"),
    "crash recovery must run before version reset and workspace bootstrap",
  );
});

test("桌面流式备份桥接不需要预先构造完整 ZIP", async () => {
  const calls = [];
  const { bridge } = createBridgeContext({
    backup: {
      beginExport: async (payload) => {
        calls.push(["begin", payload]);
        return { canceled: false, sessionId: "stream-session", chunkSize: 1024 * 1024 };
      },
      writeExportChunk: async (payload) => {
        calls.push(["write", payload]);
        return { nextOffset: payload.offset + payload.data.byteLength };
      },
      finishExport: async (payload) => { calls.push(["finish", payload]); return { bytesWritten: 3 }; },
      cancelExport: async (payload) => { calls.push(["cancel", payload]); return { canceled: true }; },
    },
  });
  const begin = await bridge.beginBackupStream("workspace.ngrap");
  assert.deepEqual(JSON.parse(JSON.stringify(calls[0])), ["begin", { suggestedName: "workspace.ngrap", expectedSize: null }]);
  await bridge.writeBackupStreamChunk(begin.sessionId, 0, new Uint8Array([1, 2, 3]).buffer);
  await bridge.finishBackupStream(begin.sessionId);
  await bridge.cancelBackupStream(begin.sessionId);
  assert.deepEqual(calls.map(([name]) => name), ["begin", "write", "finish", "cancel"]);
});

test("2 GiB 桌面导入传输协议始终只读取 1 MiB 有界分块", { timeout: 30_000 }, async () => {
  const chunkBytes = 1024 * 1024;
  const totalBytes = 2 * 1024 * 1024 * 1024;
  const reusable = new ArrayBuffer(chunkBytes);
  let readCalls = 0;
  let largestRequest = 0;
  const { bridge } = createBridgeContext({
    backup: {
      beginImport: async () => ({ canceled: false, sessionId: "import-session", size: totalBytes, chunkSize: chunkBytes }),
      readImportChunk: async (payload) => {
        readCalls += 1;
        largestRequest = Math.max(largestRequest, payload.length);
        return {
          offset: payload.offset,
          nextOffset: payload.offset + payload.length,
          done: payload.offset + payload.length === totalBytes,
          data: reusable,
        };
      },
      finishImport: async () => ({ finished: true }),
      cancelImport: async () => ({ canceled: true }),
    },
  });
  const begin = await bridge.beginBackupImport();
  for (let offset = 0; offset < begin.size; offset += chunkBytes) {
    const result = await bridge.readBackupImportChunk(begin.sessionId, offset, chunkBytes);
    assert.equal(result.data.byteLength, chunkBytes);
  }
  await bridge.finishBackupImport(begin.sessionId);
  assert.equal(readCalls, 2048);
  assert.equal(largestRequest, chunkBytes);
  assert.doesNotMatch(source, /new Uint8Array\(begin\.size\)/);
});

test("隔离 Worker 使用 fflate 流式生成可校验的 v1 .ngrap", async () => {
  const chunks = [];
  const messages = [];
  let context;
  const sandbox = {
    ArrayBuffer,
    Blob,
    DOMException,
    Promise,
    TextDecoder,
    TextEncoder,
    Uint8Array,
    URL,
    atob: (value) => Buffer.from(value, "base64").toString("binary"),
    btoa: (value) => Buffer.from(value, "binary").toString("base64"),
    crypto: webcrypto,
    queueMicrotask,
    setTimeout,
  };
  sandbox.self = sandbox;
  sandbox.postMessage = (message) => {
    messages.push(message);
    if (message.type === "chunk") {
      chunks.push(Buffer.from(message.data));
      queueMicrotask(() => {
        void context.self.onmessage({ data: { type: "ack", acknowledgmentId: message.acknowledgmentId } });
      });
    }
  };
  sandbox.importScripts = (...paths) => {
    for (const scriptPath of paths) {
      vm.runInContext(scriptPath.includes("fflate") ? fflateSource : backupCoreSource, context);
    }
  };
  context = vm.createContext(sandbox);
  vm.runInContext(backupWorkerSource, context);
  await context.self.onmessage({
    data: {
      type: "start",
      payload: {
        appVersion: "V3.0.6",
        createdAt: "2026-08-20T00:00:00.000Z",
        settings: { schemaVersion: 1, entries: { sample: "value" } },
        workspace: { schemaVersion: 1, sessions: [] },
        files: [{
          path: "files/assets/000001-sample.txt",
          key: "sample",
          workspaceKey: "default",
          sessionId: "session-1",
          assetId: "asset-1",
          kind: "asset",
          storedAt: 1,
          name: "sample.txt",
          mimeType: "text/plain",
          lastModified: 1,
          file: new Blob(["hello"], { type: "text/plain" }),
        }],
      },
    },
  });
  const workerError = messages.find((message) => message.type === "error");
  assert.equal(workerError, undefined, workerError?.message);
  assert.ok(messages.some((message) => message.type === "done"));
  assert.ok(chunks.length > 1, "streaming worker should emit multiple bounded chunks");
  assert.ok(chunks.every((chunk) => chunk.byteLength <= 1024 * 1024));
  const entries = unzipSync(Buffer.concat(chunks));
  assert.equal(new TextDecoder().decode(entries["files/assets/000001-sample.txt"]), "hello");
  const manifest = JSON.parse(new TextDecoder().decode(entries["manifest.json"]));
  assert.equal(manifest.format, "NGR_ASSETPILOT_BACKUP");
  assert.equal(manifest.entries.find((entry) => entry.path.endsWith("sample.txt")).size, 5);
});

test("隔离 Worker 流式校验 v1 .ngrap 并只把文件块留在 staging", async () => {
  const fileBytes = new TextEncoder().encode("streamed import payload");
  const settingsBytes = new TextEncoder().encode(JSON.stringify({ schemaVersion: 1, entries: { sample: "value" } }));
  const workspace = {
    schemaVersion: 1,
    sessions: [{ id: "session-1", referenceName: "", assets: [{ id: "asset-1" }] }],
  };
  const workspaceBytes = new TextEncoder().encode(JSON.stringify(workspace));
  const secretBytes = new TextEncoder().encode('{"encrypted":"renderer-must-not-decrypt"}');
  const hash = (value) => createHash("sha256").update(value).digest("hex");
  const manifest = {
    format: "NGR_ASSETPILOT_BACKUP",
    formatVersion: 1,
    archiveId: "archive-test",
    appVersion: "V3.0.6",
    createdAt: "2026-08-20T00:00:00.000Z",
    includesSecrets: true,
    encryption: { algorithm: "AES-256-GCM", kdf: "PBKDF2-HMAC-SHA256", iterations: 600000 },
    settingsSchemaVersion: 1,
    workspaceSchemaVersion: 1,
    entries: [
      { path: "settings.json", size: settingsBytes.byteLength, sha256: hash(settingsBytes) },
      { path: "workspace.json", size: workspaceBytes.byteLength, sha256: hash(workspaceBytes) },
      { path: "secrets.enc", size: secretBytes.byteLength, sha256: hash(secretBytes) },
      { path: "files/assets/000001-sample.txt", size: fileBytes.byteLength, sha256: hash(fileBytes) },
    ],
    files: [{
      path: "files/assets/000001-sample.txt",
      key: "sample",
      workspaceKey: "default",
      sessionId: "session-1",
      assetId: "asset-1",
      kind: "asset",
      storedAt: 1,
      name: "sample.txt",
      type: "text/plain",
      lastModified: 1,
      size: fileBytes.byteLength,
    }],
  };
  const archive = zipSync({
    "manifest.json": new TextEncoder().encode(JSON.stringify(manifest)),
    "settings.json": settingsBytes,
    "workspace.json": workspaceBytes,
    "secrets.enc": secretBytes,
    "files/assets/000001-sample.txt": fileBytes,
  }, { level: 0 });
  const messages = [];
  const stagedChunks = new Map();
  const stagedEntries = new Map();
  let context;
  const sandbox = {
    ArrayBuffer,
    Blob,
    DOMException,
    Promise,
    TextDecoder,
    TextEncoder,
    Uint8Array,
    URL,
    atob: (value) => Buffer.from(value, "base64").toString("binary"),
    btoa: (value) => Buffer.from(value, "binary").toString("base64"),
    crypto: webcrypto,
    queueMicrotask,
    setTimeout,
    __NGR_IMPORT_STAGING_FACTORY__: async (sessionId) => ({
      createBatch() {
        const chunks = [];
        const entries = [];
        let aborted = false;
        return {
          putChunk(path, sequence, bytes) { chunks.push({ path, sequence, data: new Blob([bytes]) }); },
          putEntry(entry) { entries.push(entry); },
          done: new Promise((resolve) => queueMicrotask(() => {
            if (!aborted) {
              for (const chunk of chunks) stagedChunks.set(`${chunk.path}\0${chunk.sequence}`, chunk);
              for (const entry of entries) stagedEntries.set(entry.path, entry);
            }
            resolve();
          })),
          abort() { aborted = true; },
        };
      },
      async listEntries() { return [...stagedEntries.values()].map((entry) => ({ sessionId, ...entry })); },
      async readEntryParts(path) {
        return [...stagedChunks.values()]
          .filter((chunk) => chunk.path === path)
          .sort((left, right) => left.sequence - right.sequence)
          .map((chunk) => chunk.data);
      },
      async clear() { stagedChunks.clear(); stagedEntries.clear(); },
      close() {},
    }),
  };
  sandbox.self = sandbox;
  sandbox.postMessage = (message) => messages.push(message);
  sandbox.importScripts = (...paths) => {
    for (const scriptPath of paths) vm.runInContext(scriptPath.includes("fflate") ? fflateSource : backupCoreSource, context);
  };
  context = vm.createContext(sandbox);
  vm.runInContext(backupWorkerSource, context);
  const sessionId = "00000000-0000-4000-8000-000000000001";
  await context.self.onmessage({ data: { type: "import-start", requestId: "start", payload: { sessionId, hasPassword: true } } });
  assert.ok(messages.some((message) => message.type === "import-ready"));
  const exact = archive.buffer.slice(archive.byteOffset, archive.byteOffset + archive.byteLength);
  await context.self.onmessage({ data: { type: "import-chunk", requestId: "chunk", sessionId, data: exact, final: true } });
  const completed = messages.find((message) => message.type === "import-chunk-result" && message.complete);
  assert.ok(completed, messages.find((message) => message.type === "import-error")?.message);
  assert.equal(completed.parsed.manifest.formatVersion, 1);
  assert.equal(completed.parsed.files.length, 1);
  assert.equal(Object.hasOwn(completed.parsed.files[0], "data"), false);
  assert.equal(Object.hasOwn(completed.parsed, "secrets"), false);
  assert.equal(
    new TextDecoder().decode(completed.parsed.legacySecretBlock),
    '{"encrypted":"renderer-must-not-decrypt"}',
  );
  assert.equal(completed.parsed.files[0].stagingSessionId, sessionId);
  assert.equal(new TextDecoder().decode(await new Blob(
    [...stagedChunks.values()].filter((chunk) => chunk.path.endsWith("sample.txt")).map((chunk) => chunk.data),
  ).arrayBuffer()), "streamed import payload");
});

test("退出协调桥接转交 requestId，避免主进程等待超时", () => {
  const { bridge, calls } = createBridgeContext();
  let received = null;
  const unsubscribe = bridge.onBeforeQuit((payload) => { received = payload; });
  const registration = calls.find(([name]) => name === "app.onBeforeQuit");
  registration[1]({ requestId: "quit-request-1", deadlineMs: 5000 });
  assert.equal(received.requestId, "quit-request-1");
  assert.equal(bridge.readyToQuit(received.requestId), true);
  assert.equal(calls.find(([name]) => name === "app.readyToQuit")[1], "quit-request-1");
  unsubscribe();
  assert.ok(calls.some(([name]) => name === "app.unsubscribe"));
});

test("旧凭据 payload 的 Kimi 与百度字段能映射到现有设置模型", () => {
  const context = { window: {} };
  vm.createContext(context);
  vm.runInContext(migrationSource, context);
  const normalized = context.window.NgrWorkspaceMigration.normalizeCredentialPayload({
    kimi: {
      provider: "kimi",
      apiFormat: "chat",
      baseUrl: "https://api.moonshot.cn/v1",
      apiKey: "fake-kimi-key",
      model: "fake-vision-model",
    },
    translation: {
      provider: "baidu",
      appId: "fake-app-id",
      secret: "fake-baidu-secret",
      endpoint: "https://fanyi-api.baidu.com/api/trans/vip/translate",
    },
  });
  assert.equal(normalized.ai.provider, "kimi");
  assert.equal(normalized.ai.apiFormat, "chat");
  assert.equal(normalized.ai.baseUrl, "https://api.moonshot.cn/v1");
  assert.equal(normalized.ai.apiKey, "fake-kimi-key");
  assert.equal(normalized.ai.model, "fake-vision-model");
  assert.equal(normalized.translation.provider, "baidu");
  assert.equal(normalized.translation.baiduAppId, "fake-app-id");
  assert.equal(normalized.translation.baiduSecret, "fake-baidu-secret");
  assert.equal(normalized.translation.baiduEndpoint, "https://fanyi-api.baidu.com/api/trans/vip/translate");
});
