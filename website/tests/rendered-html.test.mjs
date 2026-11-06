import assert from "node:assert/strict";
import test from "node:test";

const repository = "https://github.com/907609732/NGR-AssetPilot-App";
// A newer fixture proves that the page follows release metadata, not a pinned CTA.
const tag = "v3.0.25";
const filename = "NGR-AssetPilot-3.0.25-Setup-x64.exe";
const checksum = "NGR-AssetPilot-3.0.25-SHA256SUMS.txt";
const assetUrl = (name) => `${repository}/releases/download/${tag}/${name}`;
const release = {
  tag_name: tag,
  draft: false,
  prerelease: false,
  html_url: `${repository}/releases/tag/${tag}`,
  published_at: "2026-11-05T08:00:00Z",
  assets: [
    { name: filename, state: "uploaded", size: 210937882, browser_download_url: assetUrl(filename), digest: `sha256:${"a".repeat(64)}` },
    { name: checksum, state: "uploaded", size: 128, browser_download_url: assetUrl(checksum) },
  ],
};

test("renders desktop guidance with verified current installer links", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = input instanceof Request ? input.url : String(input);
    assert.equal(url, "https://api.github.com/repos/907609732/NGR-AssetPilot-App/releases/latest");
    return Response.json(release);
  };

  let html;
  try {
    const { default: worker } = await import(new URL("../dist/server/index.js", import.meta.url).href);
    const response = await worker.fetch(
      new Request("http://localhost/", { headers: { accept: "text/html" } }),
      { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
      { waitUntil() {}, passThroughOnException() {} },
    );
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);
    html = await response.text();
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.match(html, /<html lang="zh-CN">/i);
  assert.match(html, /Windows UI 资源与报表工作台/);
  assert.match(html, /rel="canonical" href="https:\/\/ngr\.lttlt\.top\/?"/);
  assert.match(html, /https:\/\/ngr\.lttlt\.top\/og\.png/);
  assert.equal(html.split(`href="${assetUrl(filename)}"`).length - 1, 3);
  assert.ok(html.includes(`href="${assetUrl(checksum)}"`));
  assert.ok(html.includes(`href="${repository}/releases/tag/${tag}"`));
  assert.match(html.replace(/<!--[\s\S]*?-->/g, ""), /v3\.0\.25 · WINDOWS 桌面工作台/);
  assert.match(html, /v3\.0\.24 更新重点/);
  assert.match(html, /查看使用教程/);
  assert.equal((html.match(/class="feature-card"/g) ?? []).length, 9);
  assert.equal((html.match(/<details class="faq-item"/g) ?? []).length, 9);
  for (const section of ["features", "workflow", "updates", "faq"]) {
    assert.ok(html.includes(`href="#${section}"`));
    assert.ok(html.includes(`id="${section}"`));
  }
  for (const expected of ["基地提单表", "本地 AI 搜图", "TAPD", "Google Chrome", "模型就绪后", "兼容扩展 ZIP 尚未公开下载", "桌面版 API Key 不会随包导出", "未知发布者", "命名流程示意 · 非软件截图"]) {
    assert.ok(html.includes(expected), `Missing product boundary: ${expected}`);
  }
  assert.doesNotMatch(html, /V2\.23|Windows 版准备中|codex-preview|Your site is taking shape|react-loading-skeleton/i);
});
