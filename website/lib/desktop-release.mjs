const FIELD_NAMES = Object.freeze({
  url: "NGR_RELEASE_EXE_URL",
  version: "NGR_RELEASE_VERSION",
  sha256: "NGR_RELEASE_SHA256",
  verified: "NGR_RELEASE_VERIFIED",
  credentialScanPassed: "NGR_RELEASE_CREDENTIAL_SCAN_PASSED",
});

const SHA256_PATTERN = /^[a-f\d]{64}$/i;
const VERSION_PATTERN = /^\d+\.\d+\.\d+$/;
const RELEASE_PATH_PATTERN =
  /^\/907609732\/NGR-AssetPilot-App\/releases\/download\/([^/]+)\/([^/]+\.exe)$/;

function readValue(environment, field) {
  const value = environment?.[FIELD_NAMES[field]];
  return typeof value === "string" ? value.trim() : "";
}

function configurationError(message) {
  return new Error(`软件下载配置无效：${message}`);
}

/**
 * Parse the server-only public release configuration.
 *
 * An entirely empty configuration is a valid "not published" state. Once any
 * field is supplied, every safety field becomes mandatory so a partial or
 * unreviewed release cannot accidentally turn into a public download button.
 */
export function parseDesktopRelease(environment = {}) {
  const values = {
    url: readValue(environment, "url"),
    version: readValue(environment, "version"),
    sha256: readValue(environment, "sha256"),
    verified: readValue(environment, "verified"),
    credentialScanPassed: readValue(environment, "credentialScanPassed"),
  };

  if (Object.values(values).every((value) => value === "")) {
    return null;
  }

  if (!values.url) {
    throw configurationError(`缺少 ${FIELD_NAMES.url}`);
  }
  if (!VERSION_PATTERN.test(values.version)) {
    throw configurationError(`${FIELD_NAMES.version} 必须采用 3.0.0 形式`);
  }
  if (!SHA256_PATTERN.test(values.sha256)) {
    throw configurationError(`${FIELD_NAMES.sha256} 必须是 64 位十六进制 SHA-256`);
  }
  if (values.verified !== "1") {
    throw configurationError(`只有 ${FIELD_NAMES.verified}=1 才能公开下载`);
  }
  if (values.credentialScanPassed !== "1") {
    throw configurationError(
      `只有确认公开包不含内置凭据并设置 ${FIELD_NAMES.credentialScanPassed}=1 才能公开下载`,
    );
  }

  let downloadUrl;
  try {
    downloadUrl = new URL(values.url);
  } catch {
    throw configurationError(`${FIELD_NAMES.url} 不是有效 URL`);
  }

  if (downloadUrl.protocol !== "https:") {
    throw configurationError(`${FIELD_NAMES.url} 必须使用 HTTPS`);
  }
  if (downloadUrl.hostname !== "github.com" || downloadUrl.port) {
    throw configurationError(`${FIELD_NAMES.url} 只允许 github.com 官方 Release 地址`);
  }
  if (downloadUrl.username || downloadUrl.password) {
    throw configurationError(`${FIELD_NAMES.url} 不得包含用户名或密码`);
  }
  if (downloadUrl.hash) {
    throw configurationError(`${FIELD_NAMES.url} 不得包含片段标识`);
  }
  if (downloadUrl.search) {
    throw configurationError(`${FIELD_NAMES.url} 不得包含查询参数`);
  }
  if (!downloadUrl.pathname.toLowerCase().endsWith(".exe")) {
    throw configurationError(`${FIELD_NAMES.url} 必须直接指向 .exe 文件`);
  }

  const releasePathMatch = downloadUrl.pathname.match(RELEASE_PATH_PATTERN);
  if (!releasePathMatch) {
    throw configurationError(
      `${FIELD_NAMES.url} 必须位于 907609732/NGR-AssetPilot-App 的 releases/download 路径`,
    );
  }
  const [, releaseTag, encodedFilename] = releasePathMatch;
  if (releaseTag !== `v${values.version}`) {
    throw configurationError(`GitHub Release 标签必须是 v${values.version}`);
  }

  let filename;
  try {
    filename = decodeURIComponent(encodedFilename);
  } catch {
    throw configurationError(`${FIELD_NAMES.url} 的文件名编码无效`);
  }
  if (!filename || filename.includes("/") || filename.includes("\\")) {
    throw configurationError(`${FIELD_NAMES.url} 缺少安全的 EXE 文件名`);
  }
  if (!filename.includes(values.version)) {
    throw configurationError(`EXE 文件名必须包含版本号 ${values.version}`);
  }

  return Object.freeze({
    url: downloadUrl.href,
    version: values.version,
    filename,
    sha256: values.sha256.toLowerCase(),
    credentialScanPassed: true,
  });
}

export function getDesktopRelease() {
  return parseDesktopRelease(process.env);
}
