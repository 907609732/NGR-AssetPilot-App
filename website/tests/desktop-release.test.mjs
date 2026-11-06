import assert from "node:assert/strict";
import test from "node:test";
import {
  createDesktopReleaseLoader,
  FALLBACK_RELEASE,
  LATEST_RELEASE_API,
  parseDesktopRelease,
  RELEASE_CACHE_TTL_MS,
  RELEASE_RETRY_TTL_MS,
  RELEASE_TIMEOUT_MS,
} from "../lib/desktop-release.mjs";

const repositoryUrl = "https://github.com/907609732/NGR-AssetPilot-App";

function releaseFixture(version = "3.0.25") {
  const tag = `v${version}`;
  const asset = (name, digest, size) => ({
    name,
    state: "uploaded",
    size,
    digest,
    browser_download_url: `${repositoryUrl}/releases/download/${tag}/${name}`,
  });
  return {
    draft: false,
    prerelease: false,
    tag_name: tag,
    html_url: `${repositoryUrl}/releases/tag/${tag}`,
    published_at: "2026-11-06T08:00:00Z",
    assets: [
      asset(`NGR-AssetPilot-${version}-Setup-x64.exe`, `sha256:${"ab".repeat(32)}`, 211_000_000),
      asset(`NGR-AssetPilot-${version}-SHA256SUMS.txt`, `sha256:${"cd".repeat(32)}`, 573),
    ],
  };
}

function responseFor(release = releaseFixture()) {
  return new Response(JSON.stringify(release), { headers: { "content-type": "application/json" } });
}

test("uses an actual same-version official Setup asset and its SHA-256 digest", () => {
  const fixture = releaseFixture();
  fixture.assets[0].digest = `sha256:${"AB".repeat(32)}`;
  const result = parseDesktopRelease(fixture);
  assert.equal(result.version, "3.0.25");
  assert.equal(result.tag, "v3.0.25");
  assert.equal(result.filename, "NGR-AssetPilot-3.0.25-Setup-x64.exe");
  assert.equal(result.url, fixture.assets[0].browser_download_url);
  assert.equal(result.checksumUrl, fixture.assets[1].browser_download_url);
  assert.equal(result.releaseUrl, fixture.html_url);
  assert.equal(result.publishedAt, fixture.published_at);
  assert.equal(result.sha256, "ab".repeat(32));
  assert.equal(result.sizeBytes, 211_000_000);
  assert.equal(result.isFallback, false);
  assert.ok(Object.isFrozen(result));
});

test("rejects untrusted, incomplete or non-production release metadata", async (t) => {
  const cases = [
    ["draft release", (r) => { r.draft = true; }],
    ["prerelease", (r) => { r.prerelease = true; }],
    ["prerelease disguised as stable", (r) => { r.tag_name = "v3.0.25-rc.1"; }],
    ["invalid semantic version", (r) => { r.tag_name = "v03.0.25"; }],
    ["wrong release repository", (r) => { r.html_url = r.html_url.replace("907609732", "someone-else"); }],
    ["mismatched release tag", (r) => { r.html_url = r.html_url.replace("v3.0.25", "v3.0.24"); }],
    ["foreign asset host", (r) => { r.assets[0].browser_download_url = r.assets[0].browser_download_url.replace("github.com", "github.com.example.org"); }],
    ["wrong asset repository", (r) => { r.assets[0].browser_download_url = r.assets[0].browser_download_url.replace("907609732", "someone-else"); }],
    ["asset from another version", (r) => { r.assets[0].browser_download_url = r.assets[0].browser_download_url.replace("v3.0.25", "v3.0.24"); }],
    ["portable file instead of installer", (r) => { r.assets[0].name = "NGR-AssetPilot-3.0.25-portable-x64.exe"; }],
    ["missing checksum asset", (r) => { r.assets.pop(); }],
    ["checksum from another repository", (r) => { r.assets[1].browser_download_url = r.assets[1].browser_download_url.replace("907609732", "someone-else"); }],
    ["missing installer digest", (r) => { r.assets[0].digest = null; }],
    ["malformed installer digest", (r) => { r.assets[0].digest = "sha256:not-a-hash"; }],
    ["incomplete upload", (r) => { r.assets[0].state = "new"; }],
    ["empty installer", (r) => { r.assets[0].size = 0; }],
    ["missing publication time", (r) => { r.published_at = null; }],
  ];
  for (const [name, mutate] of cases) {
    await t.test(name, () => {
      const fixture = releaseFixture();
      mutate(fixture);
      assert.throws(() => parseDesktopRelease(fixture), TypeError);
    });
  }
});

test("fetches the fixed public API without credentials and shares successful results for five minutes", async () => {
  let time = 0;
  const requests = [];
  const getRelease = createDesktopReleaseLoader({
    now: () => time,
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return responseFor(releaseFixture(requests.length === 1 ? "3.0.25" : "3.0.26"));
    },
  });
  const first = await getRelease();
  time = RELEASE_CACHE_TTL_MS - 1;
  assert.equal(await getRelease(), first);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, LATEST_RELEASE_API);
  const headers = new Headers(requests[0].options.headers);
  assert.equal(headers.has("authorization"), false);
  assert.equal(requests[0].options.redirect, "error");
  assert.equal(requests[0].options.cache, "no-store");

  time = RELEASE_CACHE_TTL_MS;
  assert.equal((await getRelease()).version, "3.0.26");
  assert.equal(requests.length, 2);
});

test("deduplicates simultaneous refreshes", async () => {
  let calls = 0;
  let resolveFetch;
  const getRelease = createDesktopReleaseLoader({
    fetchImpl: () => {
      calls += 1;
      return new Promise((resolve) => { resolveFetch = resolve; });
    },
  });
  const first = getRelease();
  const second = getRelease();
  const third = getRelease();
  assert.equal(calls, 1);
  resolveFetch(responseFor());
  const releases = await Promise.all([first, second, third]);
  assert.equal(releases[0], releases[1]);
  assert.equal(releases[1], releases[2]);
  assert.equal(releases[0].isFallback, false);
});

test("keeps a verified download available on network, rate-limit, JSON and validation failures", async (t) => {
  const failures = [
    ["network unavailable", async () => { throw new Error("offline"); }],
    ["GitHub rate limit", async () => new Response("rate limited", { status: 403 })],
    ["bad JSON", async () => new Response("<html>unavailable</html>")],
    ["invalid assets", async () => responseFor({ ...releaseFixture(), assets: [] })],
    ["unexpected response URL", async () => ({ ok: true, url: "https://example.org/release", json: async () => releaseFixture() })],
  ];
  for (const [name, fetchImpl] of failures) {
    await t.test(name, async () => {
      const result = await createDesktopReleaseLoader({ fetchImpl })();
      assert.deepEqual(result, FALLBACK_RELEASE);
      assert.ok(result.url.endsWith("/NGR-AssetPilot-3.0.24-Setup-x64.exe"));
      assert.equal(result.sha256.length, 64);
    });
  }
});

test("backs off briefly after failure, then retries instead of permanently disabling updates", async () => {
  let time = 0;
  let calls = 0;
  const getRelease = createDesktopReleaseLoader({
    now: () => time,
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) throw new Error("temporary failure");
      return responseFor();
    },
  });
  const fallback = await getRelease();
  time = RELEASE_RETRY_TTL_MS - 1;
  assert.equal(await getRelease(), fallback);
  assert.equal(calls, 1);
  time = RELEASE_RETRY_TTL_MS;
  assert.equal((await getRelease()).isFallback, false);
  assert.equal(calls, 2);
});

test("serves the last valid release when a later refresh fails", async () => {
  let time = 0;
  let calls = 0;
  const getRelease = createDesktopReleaseLoader({
    now: () => time,
    fetchImpl: async () => {
      calls += 1;
      if (calls > 1) throw new Error("offline after a successful refresh");
      return responseFor();
    },
  });
  const current = await getRelease();
  time = RELEASE_CACHE_TTL_MS;
  const stale = await getRelease();
  assert.equal(stale.version, current.version);
  assert.equal(stale.url, current.url);
  assert.equal(stale.sha256, current.sha256);
  assert.equal(stale.isFallback, true);
  assert.notEqual(stale.version, FALLBACK_RELEASE.version);
});

test("times out after three seconds even when fetch ignores abort; late data cannot overwrite the cache", async () => {
  let signal;
  let timeoutCallback;
  let timeoutDelay;
  let resolveFetch;
  let timerCleared = false;
  const getRelease = createDesktopReleaseLoader({
    fetchImpl: (_url, options) => {
      signal = options.signal;
      return new Promise((resolve) => { resolveFetch = resolve; });
    },
    setTimer: (callback, delay) => { timeoutCallback = callback; timeoutDelay = delay; return 1; },
    clearTimer: () => { timerCleared = true; },
  });
  const pending = getRelease();
  assert.equal(timeoutDelay, 3_000);
  assert.equal(timeoutDelay, RELEASE_TIMEOUT_MS);
  assert.equal(signal.aborted, false);
  timeoutCallback();
  assert.deepEqual(await pending, FALLBACK_RELEASE);
  assert.equal(signal.aborted, true);
  assert.equal(timerCleared, true);

  resolveFetch(responseFor());
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(await getRelease(), FALLBACK_RELEASE);
});

test("the timeout also covers a stalled response body", async () => {
  let timeoutCallback;
  const getRelease = createDesktopReleaseLoader({
    fetchImpl: async () => ({ ok: true, json: () => new Promise(() => {}) }),
    setTimer: (callback) => { timeoutCallback = callback; return 1; },
    clearTimer: () => {},
  });
  const pending = getRelease();
  await Promise.resolve();
  timeoutCallback();
  assert.deepEqual(await pending, FALLBACK_RELEASE);
});
