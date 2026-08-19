import assert from "node:assert/strict";
import { Blob } from "node:buffer";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = fs.readFileSync(new URL("../app/js/desktop-bridge.js", import.meta.url), "utf8");
const migrationSource = fs.readFileSync(new URL("../app/js/workspace-migration.js", import.meta.url), "utf8");

function createBridgeContext(overrides = {}) {
  const calls = [];
  const native = {
    environment: { getInfo: async () => ({ edition: "dev", distribution: "development" }) },
    credentials: {
      getStatus: async () => ({ configured: true }),
      get: async () => ({ ai: { apiKey: "test-only" } }),
      set: async (payload) => { calls.push(["credentials.set", payload]); return { configured: true }; },
      clear: async () => ({ configured: false }),
    },
    network: {
      request: async (payload) => {
        calls.push(["network.request", payload]);
        return { ok: true, status: 200, bodyText: JSON.stringify({ service: payload.service }), url: payload.url };
      },
    },
    files: {
      selectExportDirectory: async () => ({ canceled: false, token: "directory-token" }),
      writeFile: async (payload) => { calls.push(["files.writeFile", payload]); return { bytesWritten: payload.data.byteLength }; },
    },
    backup: {
      save: async (payload) => { calls.push(["backup.save", payload]); return { canceled: false }; },
      open: async () => ({ canceled: false, name: "test.ngrap", data: new ArrayBuffer(0) }),
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

test("桌面网络桥接标注服务类型并兼容 bodyText 响应", async () => {
  const { bridge, calls } = createBridgeContext();
  const baiduResponse = await bridge.request("https://fanyi-api.baidu.com/api/trans/vip/translate?q=test");
  assert.equal((await baiduResponse.json()).service, "translation");
  const aiResponse = await bridge.request("https://api.moonshot.cn/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  assert.equal((await aiResponse.json()).service, "ai");
  assert.equal(calls[0][1].service, "translation");
  assert.equal(calls[1][1].service, "ai");
  await bridge.request("http://127.0.0.1:3000/translate", { service: "translation" });
  assert.equal(calls[2][1].service, "translation", "显式 service 应优先于 URL 推断");
  await assert.rejects(
    () => bridge.request("https://api.moonshot.cn/v1", { service: "unknown" }),
    (error) => error?.name === "TypeError" && /服务类型/.test(error.message),
  );
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
  assert.deepEqual(await bridge.getCredentials(), { ai: { apiKey: "test-only" } });
  await bridge.setCredentials({ ai: { apiKey: "replacement" } });
  await bridge.saveBackup("workspace.ngrap", new Uint8Array([1, 2, 3]), { automatic: true });
  const saveCall = calls.find(([name]) => name === "backup.save")[1];
  assert.equal(saveCall.suggestedName, "workspace.ngrap");
  assert.equal(saveCall.automatic, true);
  assert.deepEqual([...new Uint8Array(saveCall.data)], [1, 2, 3]);
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
