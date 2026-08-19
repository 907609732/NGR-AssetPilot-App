import {
  MAX_NETWORK_REQUEST_BYTES,
  MAX_NETWORK_RESPONSE_BYTES,
} from "../shared/constants.mjs";
import { DesktopError, isPlainRecord, toBoundedBuffer } from "../shared/core.mjs";

const ALLOWED_HOSTS = Object.freeze({
  ai: new Set(["api.openai.com", "api.moonshot.cn"]),
  translation: new Set(["fanyi-api.baidu.com"]),
});
const ALLOWED_METHODS = new Set(["GET", "POST", "HEAD"]);
const ALLOWED_REQUEST_HEADERS = new Set([
  "accept",
  "authorization",
  "content-type",
  "openai-organization",
  "openai-project",
  "x-request-id",
]);
const EXPOSED_RESPONSE_HEADERS = [
  "content-type",
  "content-length",
  "request-id",
  "x-request-id",
  "openai-request-id",
];
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 5;

function isLoopbackHost(hostname) {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "::1";
}

export function validateNetworkUrl(rawUrl, service) {
  if (!Object.hasOwn(ALLOWED_HOSTS, service)) {
    throw new DesktopError("NETWORK_SERVICE_NOT_ALLOWED", "网络服务类型未获授权");
  }
  if (typeof rawUrl !== "string" || rawUrl.length > 4096) {
    throw new DesktopError("NETWORK_URL_INVALID", "网络地址无效");
  }

  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new DesktopError("NETWORK_URL_INVALID", "网络地址无效");
  }

  const hostname = parsed.hostname.toLowerCase();
  const loopback = isLoopbackHost(hostname);
  if (parsed.username || parsed.password || parsed.hash) {
    throw new DesktopError("NETWORK_URL_INVALID", "网络地址包含不允许的凭据或片段");
  }
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopback)) {
    throw new DesktopError("NETWORK_PROTOCOL_NOT_ALLOWED", "仅允许 HTTPS 或本机回环 HTTP");
  }
  if (!loopback && !ALLOWED_HOSTS[service].has(hostname)) {
    throw new DesktopError("NETWORK_HOST_NOT_ALLOWED", "网络目标未列入允许清单");
  }
  if (!loopback && parsed.port && parsed.port !== "443") {
    throw new DesktopError("NETWORK_PORT_NOT_ALLOWED", "网络端口未获授权");
  }
  return parsed;
}

function normalizeHeaders(input) {
  if (input === undefined) return Object.create(null);
  if (!isPlainRecord(input)) {
    throw new DesktopError("NETWORK_HEADERS_INVALID", "网络请求头格式无效");
  }
  const output = Object.create(null);
  const entries = Object.entries(input);
  if (entries.length > 24) {
    throw new DesktopError("NETWORK_HEADERS_INVALID", "网络请求头数量过多");
  }
  for (const [rawName, rawValue] of entries) {
    const name = rawName.toLowerCase();
    if (!ALLOWED_REQUEST_HEADERS.has(name) || typeof rawValue !== "string" || rawValue.length > 16 * 1024) {
      throw new DesktopError("NETWORK_HEADER_NOT_ALLOWED", "网络请求头未获授权");
    }
    if (/[\r\n]/.test(rawValue)) {
      throw new DesktopError("NETWORK_HEADERS_INVALID", "网络请求头格式无效");
    }
    output[name] = rawValue;
  }
  return output;
}

function normalizeBody(body, headers) {
  if (body === undefined || body === null) return undefined;
  if (typeof body === "string") {
    if (Buffer.byteLength(body, "utf8") > MAX_NETWORK_REQUEST_BYTES) {
      throw new DesktopError("NETWORK_REQUEST_TOO_LARGE", "网络请求数据超过大小限制");
    }
    return body;
  }
  if (body instanceof ArrayBuffer || ArrayBuffer.isView(body) || Buffer.isBuffer(body)) {
    return toBoundedBuffer(body, MAX_NETWORK_REQUEST_BYTES, "NETWORK_REQUEST_TOO_LARGE");
  }
  if (isPlainRecord(body) || Array.isArray(body)) {
    let json;
    try {
      json = JSON.stringify(body);
    } catch {
      throw new DesktopError("NETWORK_BODY_INVALID", "网络请求数据无法序列化");
    }
    if (Buffer.byteLength(json, "utf8") > MAX_NETWORK_REQUEST_BYTES) {
      throw new DesktopError("NETWORK_REQUEST_TOO_LARGE", "网络请求数据超过大小限制");
    }
    if (!headers["content-type"]) headers["content-type"] = "application/json";
    return json;
  }
  throw new DesktopError("NETWORK_BODY_INVALID", "网络请求数据格式无效");
}

async function readBoundedBody(response, controller) {
  const lengthHeader = response.headers?.get?.("content-length");
  if (lengthHeader && /^\d+$/.test(lengthHeader) && Number(lengthHeader) > MAX_NETWORK_RESPONSE_BYTES) {
    controller.abort();
    throw new DesktopError("NETWORK_RESPONSE_TOO_LARGE", "网络响应超过 2 MiB 限制");
  }
  if (!response.body) return "";

  const chunks = [];
  let total = 0;
  const reader = response.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      total += chunk.byteLength;
      if (total > MAX_NETWORK_RESPONSE_BYTES) {
        controller.abort();
        await reader.cancel().catch(() => {});
        throw new DesktopError("NETWORK_RESPONSE_TOO_LARGE", "网络响应超过 2 MiB 限制");
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock?.();
  }
  return Buffer.concat(chunks, total).toString("utf8");
}

function exposedHeaders(headers) {
  const output = Object.create(null);
  for (const name of EXPOSED_RESPONSE_HEADERS) {
    const value = headers?.get?.(name);
    if (value) output[name] = value.slice(0, 1024);
  }
  return output;
}

export class NetworkClient {
  constructor({ fetchImpl }) {
    if (typeof fetchImpl !== "function") throw new TypeError("fetchImpl is required");
    this.fetchImpl = fetchImpl;
  }

  async request(input) {
    if (!isPlainRecord(input)) {
      throw new DesktopError("NETWORK_REQUEST_INVALID", "网络请求格式无效");
    }
    const service = input.service;
    let currentUrl = validateNetworkUrl(input.url, service);
    let method = String(input.method || "GET").toUpperCase();
    if (!ALLOWED_METHODS.has(method)) {
      throw new DesktopError("NETWORK_METHOD_NOT_ALLOWED", "网络请求方法未获授权");
    }

    const headers = normalizeHeaders(input.headers);
    let body = normalizeBody(input.body, headers);
    if ((method === "GET" || method === "HEAD") && body !== undefined) {
      throw new DesktopError("NETWORK_BODY_INVALID", "GET/HEAD 请求不能携带请求体");
    }

    const maximumTimeout = service === "translation" ? 30_000 : 120_000;
    const requestedTimeout = input.timeoutMs === undefined ? maximumTimeout : Number(input.timeoutMs);
    if (!Number.isFinite(requestedTimeout) || requestedTimeout < 1_000) {
      throw new DesktopError("NETWORK_TIMEOUT_INVALID", "网络超时设置无效");
    }
    const timeoutMs = Math.min(Math.trunc(requestedTimeout), maximumTimeout);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref?.();

    try {
      for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
        let response;
        try {
          response = await this.fetchImpl(currentUrl.href, {
            method,
            headers,
            body,
            redirect: "manual",
            signal: controller.signal,
          });
        } catch (error) {
          if (controller.signal.aborted) {
            throw new DesktopError("NETWORK_TIMEOUT", "网络请求超时");
          }
          throw new DesktopError("NETWORK_REQUEST_FAILED", "网络请求失败");
        }

        if (REDIRECT_STATUSES.has(response.status)) {
          if (redirectCount === MAX_REDIRECTS) {
            throw new DesktopError("NETWORK_TOO_MANY_REDIRECTS", "网络重定向次数过多");
          }
          const location = response.headers?.get?.("location");
          if (!location) {
            throw new DesktopError("NETWORK_REDIRECT_INVALID", "网络重定向缺少目标地址");
          }
          const nextUrl = validateNetworkUrl(new URL(location, currentUrl).href, service);
          if (nextUrl.origin !== currentUrl.origin) {
            throw new DesktopError("NETWORK_CROSS_ORIGIN_REDIRECT", "已阻止跨来源网络重定向");
          }
          if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === "POST")) {
            method = "GET";
            body = undefined;
            delete headers["content-type"];
          }
          currentUrl = nextUrl;
          continue;
        }

        const bodyText = method === "HEAD" ? "" : await readBoundedBody(response, controller);
        return {
          ok: Boolean(response.ok),
          status: Number(response.status),
          statusText: String(response.statusText || "").slice(0, 128),
          headers: exposedHeaders(response.headers),
          bodyText,
          url: `${currentUrl.origin}${currentUrl.pathname}`,
        };
      }
      throw new DesktopError("NETWORK_TOO_MANY_REDIRECTS", "网络重定向次数过多");
    } finally {
      clearTimeout(timer);
    }
  }
}
