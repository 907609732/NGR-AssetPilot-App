import { readFile } from "node:fs/promises";

import { DesktopError, isPlainRecord } from "../shared/core.mjs";

const MANAGED_PROVIDER_CONFIG_VERSION = 2;
const MAX_CONFIG_BYTES = 64 * 1024;
const CFC_HOST_PATTERN = /^[a-z0-9-]+\.cfc-execute\.[a-z0-9-]+\.baidubce\.com$/i;

function normalizeCfcEndpoint(value) {
  if (typeof value !== "string" || !value.trim() || value.length > 4096) {
    throw new DesktopError("MANAGED_PROVIDER_URL_INVALID", "托管翻译地址无效");
  }
  let parsed;
  try {
    parsed = new URL(value.trim());
  } catch {
    throw new DesktopError("MANAGED_PROVIDER_URL_INVALID", "托管翻译地址无效");
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.hash ||
    parsed.search ||
    parsed.port ||
    !CFC_HOST_PATTERN.test(parsed.hostname)
  ) {
    throw new DesktopError("MANAGED_PROVIDER_URL_INVALID", "托管翻译必须使用百度 CFC HTTPS 地址");
  }
  const decodedPath = (() => {
    try {
      return decodeURIComponent(parsed.pathname);
    } catch {
      throw new DesktopError("MANAGED_PROVIDER_URL_INVALID", "托管翻译路径编码无效");
    }
  })();
  if (
    decodedPath === "/" ||
    decodedPath.split("/").some((part) => part === "." || part === "..") ||
    /[\u0000-\u001f\\]/.test(decodedPath)
  ) {
    throw new DesktopError("MANAGED_PROVIDER_URL_INVALID", "托管翻译路径无效");
  }
  parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  return parsed.href;
}

export function parseManagedProviderConfig(input) {
  if (!isPlainRecord(input) || ![1, MANAGED_PROVIDER_CONFIG_VERSION].includes(input.version)) {
    throw new DesktopError("MANAGED_PROVIDER_CONFIG_INVALID", "托管服务配置版本无效");
  }
  const cfc = input.baiduCfc;
  if (!isPlainRecord(cfc) || cfc.enabled !== true) {
    throw new DesktopError("MANAGED_PROVIDER_CONFIG_INVALID", "托管翻译配置无效");
  }
  const endpoint = normalizeCfcEndpoint(cfc.endpoint);
  // Version 1 packages embedded a shared bearer token. A desktop package
  // cannot keep a shared secret, so v1 is read only for endpoint migration
  // and the token is deliberately discarded.
  return Object.freeze({
    version: MANAGED_PROVIDER_CONFIG_VERSION,
    baiduCfc: Object.freeze({
      enabled: true,
      endpoint,
    }),
  });
}

export async function loadManagedProviderConfig(filePath) {
  let raw;
  try {
    raw = await readFile(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw new DesktopError("MANAGED_PROVIDER_CONFIG_READ_FAILED", "无法读取托管服务配置");
  }
  if (raw.byteLength > MAX_CONFIG_BYTES) {
    throw new DesktopError("MANAGED_PROVIDER_CONFIG_INVALID", "托管服务配置超过大小限制");
  }
  try {
    return parseManagedProviderConfig(JSON.parse(raw.toString("utf8")));
  } catch (error) {
    if (error instanceof DesktopError) throw error;
    throw new DesktopError("MANAGED_PROVIDER_CONFIG_INVALID", "托管服务配置无法解析");
  }
}

export {
  CFC_HOST_PATTERN,
  MANAGED_PROVIDER_CONFIG_VERSION,
};
