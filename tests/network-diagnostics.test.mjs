import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  NetworkDiagnosticsService,
  classifyAddress,
  normalizeCustomTarget,
  normalizeUrl,
  resultCodeForStatus,
  summarizeProxy,
} from "../desktop/services/network-diagnostics-service.mjs";

async function withTempDirectory(run) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ngr-network-diagnostics-"));
  try { return await run(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}

function createSession({ route = "system", responses = new Map(), resolvedAddress = "93.184.216.34" } = {}) {
  const calls = [];
  return {
    calls,
    proxyConfig: null,
    async setProxy(config) { this.proxyConfig = config; },
    async resolveProxy() { return route === "direct" ? "DIRECT" : "PROXY proxy.internal:8080; DIRECT"; },
    async resolveHost() { return { endpoints: [{ address: resolvedAddress, family: "ipv4" }] }; },
    async fetch(url, options) {
      calls.push({ url, method: options.method, body: options.body });
      if (options.signal.aborted) throw new DOMException("aborted", "AbortError");
      const key = new URL(url).pathname;
      return responses.get(key) || new Response(null, { status: 204, headers: { "content-type": "application/json" } });
    },
    async closeAllConnections() {},
    async clearStorageData() {},
  };
}

function createService(userDataPath, options = {}) {
  const systemSession = options.systemSession || createSession();
  const directSession = options.directSession || createSession({ route: "direct" });
  const netModule = {
    online: true,
    isOnline: () => true,
    resolveHost: async () => ({ endpoints: [{ address: "93.184.216.34", family: "ipv4" }] }),
  };
  return {
    systemSession,
    directSession,
    service: new NetworkDiagnosticsService({ userDataPath, netModule, defaultSession: systemSession, directSession, ...options }),
  };
}

test("诊断地址限制云元数据、保留网络、明文远程和密钥参数", () => {
  assert.equal(classifyAddress("127.0.0.1"), "loopback");
  assert.equal(classifyAddress("192.168.1.8"), "lan");
  assert.equal(classifyAddress("169.254.169.254"), "metadata");
  assert.equal(classifyAddress("8.8.8.8"), "public");
  assert.throws(() => normalizeUrl("http://example.com/api"), { code: "DIAGNOSTICS_PROTOCOL_BLOCKED" });
  assert.throws(() => normalizeUrl("https://169.254.169.254/latest"), { code: "DIAGNOSTICS_METADATA_BLOCKED" });
  assert.throws(() => normalizeUrl("https://192.168.1.8/health"), { code: "DIAGNOSTICS_LAN_CONFIRM_REQUIRED" });
  assert.equal(normalizeUrl("https://192.168.1.8/health", { allowLan: true }).hostname, "192.168.1.8");
  assert.equal(normalizeUrl("http://localhost:11434/health").port, "11434");
  assert.throws(() => normalizeUrl("https://api.example.com/health?api_key=secret"), { code: "DIAGNOSTICS_SECRET_BLOCKED" });
});

test("自定义目标限制方法、请求体、超时并要求高风险方法确认", async () => {
  const target = normalizeCustomTarget({
    name: "项目 CDN",
    category: "自定义",
    url: "https://cdn.example.com/health",
    method: "POST",
    timeoutMs: 5000,
    body: '{"ping":true}',
    expectedStatuses: [200, 204, 204, 999],
  });
  assert.equal(target.unsafe, true);
  assert.deepEqual(target.expectedStatuses, [200, 204]);
  assert.throws(() => normalizeCustomTarget({ ...target, body: '{"apiKey":"secret"}' }), { code: "DIAGNOSTICS_SECRET_BLOCKED" });

  await withTempDirectory(async (userDataPath) => {
    const { service } = createService(userDataPath);
    await service.initialize();
    const saved = await service.upsertCustomTarget({
      name: target.name,
      category: target.category,
      url: target.url,
      method: target.method,
      timeoutMs: target.timeoutMs,
      body: target.body,
      expectedStatuses: target.expectedStatuses,
    });
    await assert.rejects(() => service.run({ requestId: "unsafe_run_01", targetIds: [saved.id] }, 1), { code: "DIAGNOSTICS_UNSAFE_CONFIRM_REQUIRED" });
    const run = await service.run({ requestId: "unsafe_run_02", targetIds: [saved.id], confirmedUnsafeTargetIds: [saved.id] }, 1);
    assert.equal(run.results[0].resultCode, "REACHABLE");
    await service.dispose();
  });
});

test("内置目录覆盖设计、AI、百度、阿里、腾讯和软件依赖", async () => {
  await withTempDirectory(async (userDataPath) => {
    const { service, directSession } = createService(userDataPath, {
      managedProviderConfig: { baiduCfc: { enabled: true, endpoint: "https://example.cfc-execute.gz.baidubce.com/translate" } },
    });
    const catalog = await service.listCatalog();
    assert.equal(catalog.online, true);
    assert.equal(directSession.proxyConfig.mode, "direct");
    for (const expected of ["figma-rest", "openai-api", "baidu-translate", "ngr-managed-cfc", "aliyun-oss-hangzhou", "tencent-cos", "github-api", "huggingface-model"]) {
      assert.ok(catalog.targets.some((target) => target.id === expected), `missing ${expected}`);
    }
    assert.equal(JSON.stringify(catalog).match(/bearer|authorization|api.?key/i), null);
    await service.dispose();
  });
});

test("HTTP 状态、代理和直连对比均返回脱敏的可达结论", async () => {
  await withTempDirectory(async (userDataPath) => {
    const responses = new Map([["/health", new Response(null, { status: 403, headers: { "content-type": "application/json" } })]]);
    const systemSession = createSession({ responses });
    const directSession = createSession({ route: "direct", responses });
    const { service } = createService(userDataPath, { systemSession, directSession });
    const saved = await service.upsertCustomTarget({ name: "鉴权接口", url: "https://api.example.com/health", method: "GET" });
    const run = await service.run({ requestId: "compare_run_01", targetIds: [saved.id], routeMode: "compare" }, 12);
    assert.equal(run.results.length, 2);
    assert.ok(run.results.every((result) => result.reachable && result.resultCode === "REACHABLE_AUTH_REQUIRED"));
    assert.deepEqual(new Set(run.results.map((result) => result.route)), new Set(["system", "direct"]));
    assert.equal(run.results.find((result) => result.route === "system").proxy, "PROXY + DIRECT");
    assert.equal(run.results.find((result) => result.route === "direct").proxy, "DIRECT");
    assert.ok(run.results.every((result) => result.firstByteMs != null && result.totalMs >= result.firstByteMs));
    assert.ok(run.results.every((result) => result.failureStage === ""));
    assert.equal(resultCodeForStatus(405), "REACHABLE_METHOD_NOT_ALLOWED");
    assert.equal(resultCodeForStatus(429), "REACHABLE_RATE_LIMITED");
    assert.equal(resultCodeForStatus(503), "REACHABLE_SERVICE_ERROR");
    assert.equal(summarizeProxy("HTTPS proxy.example:443; SOCKS5 hidden:1080; DIRECT"), "HTTPS + SOCKS5 + DIRECT");
    await service.dispose();
  });
});

test("DNS Rebinding 在发出 HTTP 前被阻止", async () => {
  await withTempDirectory(async (userDataPath) => {
    const systemSession = createSession({ resolvedAddress: "10.0.0.5" });
    const { service } = createService(userDataPath, { systemSession });
    const saved = await service.upsertCustomTarget({ name: "重绑定目标", url: "https://public.example.com/health" });
    const run = await service.run({ requestId: "rebind_run_01", targetIds: [saved.id], routeMode: "system" }, 2);
    assert.equal(run.results[0].reachable, false);
    assert.equal(run.results[0].resultCode, "ADDRESS_BLOCKED");
    assert.equal(systemSession.calls.length, 0);
    await service.dispose();
  });
});

test("跨源跳转只记录目标源并标记疑似认证网关，不继续请求", async () => {
  await withTempDirectory(async (userDataPath) => {
    const responses = new Map([["/health", new Response(null, { status: 302, headers: { location: "https://login.example.net/sign-in" } })]]);
    const systemSession = createSession({ responses });
    const { service } = createService(userDataPath, { systemSession });
    const target = await service.upsertCustomTarget({ name: "跨域登录页", url: "https://api.example.com/health" });
    const run = await service.run({ requestId: "redirect_run_01", targetIds: [target.id] }, 6);
    assert.equal(run.results[0].resultCode, "REACHABLE_SUSPECTED_INTERCEPTION");
    assert.deepEqual(run.results[0].redirectOrigins, ["https://login.example.net"]);
    assert.equal(systemSession.calls.length, 1);
    await service.dispose();
  });
});

test("代理解析、DNS 和 HTTP 阶段都响应超时与整批取消", async () => {
  await withTempDirectory(async (userDataPath) => {
    const never = () => new Promise(() => {});
    const timeoutSession = createSession();
    timeoutSession.resolveProxy = never;
    const { service: timeoutService } = createService(userDataPath, { systemSession: timeoutSession });
    const timeoutTarget = await timeoutService.upsertCustomTarget({
      name: "代理超时",
      url: "https://api.example.com/health",
      timeoutMs: 1000,
    });
    const timeoutRun = await timeoutService.run({ requestId: "timeout_run_01", targetIds: [timeoutTarget.id] }, 7);
    assert.equal(timeoutRun.results[0].resultCode, "TIMEOUT");
    assert.ok(timeoutRun.results[0].latencyMs >= 900 && timeoutRun.results[0].latencyMs < 2500);
    await timeoutService.dispose();

    const cancelSession = createSession();
    cancelSession.resolveHost = never;
    const { service: cancelService } = createService(userDataPath, { systemSession: cancelSession });
    const cancelTarget = await cancelService.upsertCustomTarget({
      name: "DNS 取消",
      url: "https://api.example.com/cancel",
      timeoutMs: 10000,
    });
    const pending = cancelService.run({ requestId: "cancel_run_01", targetIds: [cancelTarget.id] }, 8);
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.deepEqual(cancelService.cancel({ requestId: "cancel_run_01" }, 8), { canceled: true, requestId: "cancel_run_01" });
    const canceledRun = await pending;
    assert.equal(canceledRun.canceled, true);
    assert.equal(canceledRun.results[0].resultCode, "CANCELED");
    await cancelService.dispose();
  });
});

test("历史仅保留最近 30 次并导出无查询参数、请求体或代理地址", async () => {
  await withTempDirectory(async (userDataPath) => {
    const exportPath = path.join(userDataPath, "diagnostics.json");
    const dialog = { async showSaveDialog() { return { canceled: false, filePath: exportPath }; } };
    const { service } = createService(userDataPath, { dialog });
    const saved = await service.upsertCustomTarget({
      name: "安全导出",
      url: "https://api.example.com/health?tenant=studio",
      method: "POST",
      body: '{"ping":true}',
    });
    for (let index = 0; index < 31; index += 1) {
      await service.run({
        requestId: `history_run_${String(index).padStart(2, "0")}`,
        targetIds: [saved.id],
        confirmedUnsafeTargetIds: [saved.id],
      }, 4);
    }
    const history = await service.listHistory({ limit: 99 });
    assert.equal(history.length, 30);
    assert.equal(history.at(-1).requestId, "history_run_01");
    const exported = await service.exportHistory({ format: "json" });
    assert.equal(exported.runCount, 30);
    const raw = await readFile(exportPath, "utf8");
    assert.doesNotMatch(raw, /tenant=studio|ping|proxy\.internal/);
    assert.match(raw, /https:\/\/api\.example\.com/);
    await service.clearHistory();
    assert.deepEqual(await service.listHistory(), []);
    await service.dispose();
  });
});
