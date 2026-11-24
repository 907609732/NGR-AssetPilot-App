const REPOSITORY = "907609732/NGR-AssetPilot-App";
const REPOSITORY_URL = `https://github.com/${REPOSITORY}`;

export const LATEST_RELEASE_API = `https://api.github.com/repos/${REPOSITORY}/releases/latest`;
export const RELEASE_TIMEOUT_MS = 3_000;
export const RELEASE_CACHE_TTL_MS = 5 * 60_000;
export const RELEASE_RETRY_TTL_MS = 30_000;

/**
 * @typedef {object} DesktopRelease
 * @property {string} version
 * @property {string} tag
 * @property {string} publishedAt
 * @property {string} url
 * @property {string} filename
 * @property {string} releaseUrl
 * @property {string} checksumUrl
 * @property {string} sha256
 * @property {number} sizeBytes
 * @property {boolean} isFallback True when using the verified fallback or stale metadata.
 */

/** @type {Readonly<DesktopRelease>} */
export const FALLBACK_RELEASE = Object.freeze({
  version: "3.0.24",
  tag: "v3.0.24",
  publishedAt: "2026-11-04T08:10:32Z",
  url: `${REPOSITORY_URL}/releases/download/v3.0.24/NGR-AssetPilot-3.0.24-Setup-x64.exe`,
  filename: "NGR-AssetPilot-3.0.24-Setup-x64.exe",
  releaseUrl: `${REPOSITORY_URL}/releases/tag/v3.0.24`,
  checksumUrl: `${REPOSITORY_URL}/releases/download/v3.0.24/NGR-AssetPilot-3.0.24-SHA256SUMS.txt`,
  sha256: "c46c0395d849444d993b37b3d24965453c083544e62a4805bf8b9eb9332d1642",
  sizeBytes: 210_937_882,
  isFallback: true,
});

function invalidRelease(detail) {
  return new TypeError(`Invalid GitHub desktop release: ${detail}`);
}

/** Validate API metadata before allowing any of its download links onto the page. */
export function parseDesktopRelease(release) {
  if (!release || release.draft !== false || release.prerelease !== false) {
    throw invalidRelease("a published stable release is required");
  }

  const tag = release.tag_name;
  // This project's production tags and installer names use canonical vMAJOR.MINOR.PATCH.
  const versionMatch = typeof tag === "string" && tag.length <= 64
    ? /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(tag)
    : null;
  if (!versionMatch || versionMatch.slice(1).some((part) => !Number.isSafeInteger(Number(part)))) {
    throw invalidRelease("the production tag is not a stable semantic version");
  }
  const version = tag.slice(1);
  const releaseUrl = `${REPOSITORY_URL}/releases/tag/${tag}`;
  if (release.html_url !== releaseUrl) {
    throw invalidRelease("the release is not from the official repository and tag");
  }
  if (typeof release.published_at !== "string"
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(release.published_at)
    || !Number.isFinite(Date.parse(release.published_at))) {
    throw invalidRelease("a publication time is required");
  }
  if (!Array.isArray(release.assets)) throw invalidRelease("release assets are missing");

  function officialAsset(filename) {
    const matches = release.assets.filter((asset) => asset?.name === filename);
    const asset = matches[0];
    const url = `${REPOSITORY_URL}/releases/download/${tag}/${filename}`;
    if (matches.length !== 1 || asset.state !== "uploaded"
      || asset.browser_download_url !== url
      || !Number.isSafeInteger(asset.size) || asset.size <= 0) {
      throw invalidRelease(`the official asset ${filename} is missing or invalid`);
    }
    return asset;
  }

  const filename = `NGR-AssetPilot-${version}-Setup-x64.exe`;
  const installer = officialAsset(filename);
  const checksum = officialAsset(`NGR-AssetPilot-${version}-SHA256SUMS.txt`);
  const digest = typeof installer.digest === "string"
    ? /^sha256:([a-fA-F0-9]{64})$/.exec(installer.digest)
    : null;
  if (!digest) throw invalidRelease("the installer has no valid GitHub SHA-256 digest");

  return Object.freeze({
    version,
    tag,
    publishedAt: release.published_at,
    url: installer.browser_download_url,
    filename,
    releaseUrl,
    checksumUrl: checksum.browser_download_url,
    sha256: digest[1].toLowerCase(),
    sizeBytes: installer.size,
    isFallback: false,
  });
}

/**
 * A loader owns its cache, allowing deterministic tests without network access.
 * The default loader below shares one cache per server/Worker instance.
 */
export function createDesktopReleaseLoader({
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
  setTimer = (callback, delay) => setTimeout(callback, delay),
  clearTimer = (timer) => clearTimeout(timer),
} = {}) {
  let cachedRelease = null;
  let lastValidRelease = null;
  let expiresAt = 0;
  let inFlight = null;

  async function requestRelease() {
    const controller = new AbortController();
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimer(() => {
        controller.abort();
        reject(new Error("GitHub release request timed out"));
      }, RELEASE_TIMEOUT_MS);
    });
    const request = (async () => {
      const response = await fetchImpl(LATEST_RELEASE_API, {
        headers: {
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "NGR-AssetPilot-Official-Site",
        },
        signal: controller.signal,
        redirect: "error",
        cache: "no-store",
      });
      if (!response.ok || (response.url && response.url !== LATEST_RELEASE_API)) {
        throw new Error("GitHub release metadata is unavailable");
      }
      return parseDesktopRelease(await response.json());
    })();

    try {
      // Bound the whole request, including JSON reading, even if a fetch ignores abort.
      return await Promise.race([request, timeout]);
    } finally {
      clearTimer(timer);
    }
  }

  return async function loadDesktopRelease() {
    if (cachedRelease && now() < expiresAt) return cachedRelease;
    if (inFlight) return inFlight;

    inFlight = (async () => {
      try {
        lastValidRelease = await requestRelease();
        cachedRelease = lastValidRelease;
        expiresAt = now() + RELEASE_CACHE_TTL_MS;
      } catch {
        cachedRelease = Object.freeze({ ...(lastValidRelease || FALLBACK_RELEASE), isFallback: true });
        expiresAt = now() + RELEASE_RETRY_TTL_MS;
      }
      return cachedRelease;
    })();

    try {
      return await inFlight;
    } finally {
      inFlight = null;
    }
  };
}

const loadDesktopRelease = createDesktopReleaseLoader();

/** @returns {Promise<Readonly<DesktopRelease>>} */
export async function getDesktopRelease() {
  return loadDesktopRelease();
}
