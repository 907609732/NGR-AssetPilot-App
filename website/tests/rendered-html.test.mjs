import assert from "node:assert/strict";
import test from "node:test";

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request("http://localhost/", { headers: { accept: "text/html" } }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

test("server-renders the NGR AssetPilot official website", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<html lang="zh-CN">/i);
  assert.match(html, /NGR AssetPilot/);
  assert.match(html, /AI资源领航/);
  assert.match(html, /让每一张 UI 资源/);
  assert.match(html, /核心能力/);
  assert.match(html, /本地优先/);
  assert.match(html, /V(?:<!-- -->)?3\.0\.0/);
  assert.match(html, /Windows 版准备中/);
  assert.match(html, /下载包不包含内置平台凭据/);
  assert.match(html, /https:\/\/ngr\.lttlt\.top/);
  assert.doesNotMatch(html, /<a\b[^>]*href=["'][^"']*\.exe(?:[?"'])/i);
  assert.doesNotMatch(html, /releases\/download\//i);
  assert.doesNotMatch(html, /浏览器本地|查看 GitHub Releases|安装版与便携版/);
  assert.match(html, /og\.png/);
  assert.doesNotMatch(html, /codex-preview|Your site is taking shape|react-loading-skeleton/i);
});
