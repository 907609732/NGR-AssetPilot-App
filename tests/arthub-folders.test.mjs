import test from "node:test";
import assert from "node:assert/strict";
import { ArtHubFolders } from "../desktop/services/arthub-folders.mjs";

function fixture(nodes, override = {}) {
  let saved = {};
  const calls = [];
  const store = { get: async () => structuredClone(saved), set: async (value) => { saved = structuredClone(value); } };
  const service = new ArtHubFolders({ store, fetchImpl: async (url, options) => {
    const method = url.split("/").pop(), payload = JSON.parse(options.body);
    calls.push({ method, payload });
    assert.equal(options.headers.publictoken, "test-token");
    assert.equal(options.redirect, "error");
    if (override[method]) return override[method](payload);
    let result;
    if (method === "get-depot-id") result = 1;
    if (method === "get-node-brief-by-path") result = [{ id: 2, type: "directory", name: "UI" }];
    if (method === "get-child-node-count") result = { count: nodes.length };
    if (method === "get-child-node-id-in-range") result = { nodes: nodes.slice(payload.offset, payload.offset + payload.count).map((n) => n.id) };
    if (method === "get-node-brief-by-id") result = { items: nodes.filter((n) => payload.ids.includes(n.id)) };
    return { ok: true, status: 200, json: async () => ({ code: 0, result }) };
  } });
  const configure = () => service.configure({ environment: "qq", assetHub: "trial", token: "test-token", rootPath: "UI" });
  return { service, calls, configure, store };
}
const node = (id, name, path = "UI") => ({ id, name, type: "directory", full_path_name: [path, name] });

test("ArtHub 完整分页、精确匹配优先、完整路径和秘密不回传", async () => {
  const nodes = Array.from({ length: 1002 }, (_, i) => node(i + 10, `Other${i}`));
  nodes[0] = node(10, "activityminiwinter");
  nodes[1001] = node(1011, "ActivityMiniWinter");
  const { service, configure, calls } = fixture(nodes);
  assert.equal((await service.status()).configured, false);
  const status = await configure();
  assert.equal(status.configured, true);
  assert.doesNotMatch(JSON.stringify(status), /test-token/);
  const result = await service.search({ projectName: "ActivityMiniWinter" });
  assert.equal(result.matches.length, 1);
  assert.equal(result.matches[0].path, "UI/ActivityMiniWinter");
  assert.deepEqual(calls.filter((c) => c.method === "get-child-node-id-in-range").map((c) => c.payload.offset), [0, 500, 1000]);
  await assert.rejects(service.open({ resultId: result.matches[0].resultId }), { code: "ARTHUB_CLIENT_UNVERIFIED" });
  await assert.rejects(service.open({ resultId: "arbitrary-command" }), { code: "ARTHUB_RESULT_EXPIRED" });
});

test("ArtHub 同名目录保留、大小写回退、无结果和空名称", async () => {
  const { service, configure } = fixture([node(10, "Home", "A"), node(11, "Home", "B")]);
  await configure();
  assert.equal((await service.search({ projectName: "home" })).matches.length, 2);
  assert.equal((await service.search({ projectName: "missing" })).matches.length, 0);
  await assert.rejects(service.search({ projectName: " " }), { code: "ARTHUB_NAME" });
});

test("ArtHub 授权失败、部分权限及中途分页变化不返回不完整结果", async () => {
  for (const status of [401, 403]) {
    const { configure, service } = fixture([], { "get-depot-id": () => ({ status, ok: false }) });
    await assert.rejects(configure(), { code: "ARTHUB_AUTH" });
    assert.equal((await service.status()).configured, false);
  }
  const partial = fixture([], { "get-depot-id": () => ({ ok: true, json: async () => ({ code: 1, result: 1 }) }) });
  await assert.rejects(partial.configure(), { code: "ARTHUB_QUERY" });
  const changed = fixture([node(10, "Home")], { "get-child-node-id-in-range": () => ({ ok: true, json: async () => ({ code: 0, result: { nodes: [] } }) }) });
  await changed.configure();
  await assert.rejects(changed.service.search({ projectName: "Home" }), { code: "ARTHUB_CHANGED" });
});

test("ArtHub 配置仅接受固定环境、合法资源库及根目录", async () => {
  const { service, configure } = fixture([]);
  await assert.rejects(service.search({ projectName: "Home" }), { code: "ARTHUB_NOT_CONFIGURED" });
  await configure();
  await assert.rejects(service.configure({ environment: "https://evil.test", assetHub: "trial" }), { code: "ARTHUB_CONFIG" });
  await assert.rejects(service.configure({ environment: "qq", assetHub: "../trial" }), { code: "ARTHUB_CONFIG" });
  await assert.rejects(service.configure({ environment: "qq", assetHub: "trial", rootPath: "../UI" }), { code: "ARTHUB_CONFIG" });
  assert.equal((await service.configure({ environment: "qq", assetHub: "trial" })).configured, true);
});
