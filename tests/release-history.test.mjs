import test from "node:test";
import assert from "node:assert/strict";
import { ReleaseHistory } from "../desktop/services/release-history.mjs";

const entry = (id) => ({ id, tag_name: `v1.0.${id}`, name: `版本 ${id}`, body: `<script>untrusted</script>更新 ${id}`, published_at: new Date(1700000000000 + id * 1000).toISOString() });
test("发布历史读取全部分页，包含预发布、排除草稿并共享缓存", async () => {
  const calls = [];
  const service = new ReleaseHistory({ initialHistory: null, fetchImpl: async (url) => {
    calls.push(url); const page = new URL(url).searchParams.get("page");
    return { ok: true, json: async () => page === "1" ? Array.from({ length: 100 }, (_, i) => entry(i)) : [{ ...entry(100), prerelease: true }, { ...entry(101), draft: true }] };
  } });
  const [first, second] = await Promise.all([service.list(), service.list()]);
  assert.equal(first, second);
  assert.equal(first.releases.length, 101);
  assert.equal(first.releases[0].version, "v1.0.100");
  assert.equal(first.releases[0].prerelease, true);
  assert.equal(calls.length, 2);
  await service.list(); assert.equal(calls.length, 2);
});
test("限流和离线仍显示随包历史，不能把部分分页当成全部记录", async () => {
  const service = new ReleaseHistory({ fetchImpl: async () => ({ ok: false, status: 403 }) });
  const result = await service.list();
  assert.equal(result.stale, true); assert.ok(result.releases.length >= 13);
  const incomplete = new ReleaseHistory({ initialHistory: null, fetchImpl: async (url) => ({ ok: !url.endsWith("page=2"), json: async () => Array.from({ length: 100 }, (_, i) => entry(i)) }) });
  await assert.rejects(incomplete.list(), { code: "RELEASE_HISTORY_UNAVAILABLE" });
});
test("重复分页失败而非死循环", async () => {
  const service = new ReleaseHistory({ initialHistory: null, fetchImpl: async () => ({ ok: true, json: async () => Array.from({ length: 100 }, (_, i) => entry(i)) }) });
  await assert.rejects(service.list(), { code: "RELEASE_HISTORY_UNAVAILABLE" });
});
