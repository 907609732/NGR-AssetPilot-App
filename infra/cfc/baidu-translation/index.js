"use strict";

const { createHash, randomBytes } = require("node:crypto");

const BAIDU_ENDPOINT = "https://fanyi-api.baidu.com/api/trans/vip/translate";
const MAX_QUERY_CHARACTERS = 200;
const MAX_BODY_BYTES = 16 * 1024;
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_RATE_LIMIT = 30;
const CACHE_TTL_MS = 30 * 60 * 1000;
const CACHE_LIMIT = 512;
const ALLOWED_LANGUAGES = new Set([
  "auto", "zh", "en", "jp", "kor", "fra", "spa", "th", "ara", "ru", "pt", "de", "it", "nl", "fin", "dan",
]);

const cache = new Map();
const rateBuckets = new Map();

function response(statusCode, payload, requestId = "") {
  const headers = {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  };
  if (requestId) headers["x-request-id"] = String(requestId).slice(0, 128);
  return {
    isBase64Encoded: false,
    statusCode,
    headers,
    body: JSON.stringify(payload),
  };
}

function parseBody(event) {
  let body = event?.body;
  if (event?.isBase64Encoded && typeof body === "string") {
    body = Buffer.from(body, "base64").toString("utf8");
  }
  if (typeof body === "string") {
    if (Buffer.byteLength(body, "utf8") > MAX_BODY_BYTES) throw Object.assign(new Error("请求数据过大"), { statusCode: 413 });
    try {
      body = JSON.parse(body);
    } catch {
      throw Object.assign(new Error("请求必须为 JSON"), { statusCode: 400 });
    }
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw Object.assign(new Error("请求数据无效"), { statusCode: 400 });
  }
  const q = String(body.q || "").trim();
  const from = String(body.from || "auto").trim().toLowerCase();
  const to = String(body.to || "en").trim().toLowerCase();
  if (!q || q.length > MAX_QUERY_CHARACTERS) {
    throw Object.assign(new Error(`翻译文字必须为 1-${MAX_QUERY_CHARACTERS} 个字符`), { statusCode: 400 });
  }
  if (!ALLOWED_LANGUAGES.has(from) || !ALLOWED_LANGUAGES.has(to) || to === "auto") {
    throw Object.assign(new Error("翻译语言不受支持"), { statusCode: 400 });
  }
  return { q, from, to };
}

function enforceRateLimit(event, now = Date.now()) {
  const sourceIp = String(event?.requestContext?.sourceIp || "unknown");
  const key = createHash("sha256").update(sourceIp).digest("hex");
  const minute = Math.floor(now / 60_000);
  const limit = Math.max(1, Math.min(300, Number.parseInt(process.env.RATE_LIMIT_PER_MINUTE || "", 10) || DEFAULT_RATE_LIMIT));
  const current = rateBuckets.get(key);
  const next = !current || current.minute !== minute ? { minute, count: 1 } : { minute, count: current.count + 1 };
  rateBuckets.set(key, next);
  if (rateBuckets.size > 2048) {
    for (const [bucketKey, bucket] of rateBuckets) {
      if (bucket.minute < minute - 1) rateBuckets.delete(bucketKey);
    }
  }
  if (next.count > limit) throw Object.assign(new Error("请求过于频繁，请稍后再试"), { statusCode: 429 });
}

function getCached(key, now = Date.now()) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= now) {
    cache.delete(key);
    return null;
  }
  cache.delete(key);
  cache.set(key, entry);
  return entry.value;
}

function setCached(key, value, now = Date.now()) {
  cache.set(key, { value, expiresAt: now + CACHE_TTL_MS });
  while (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchBaiduTranslation(input, attempt = 0) {
  const appId = String(process.env.BAIDU_TRANSLATE_APP_ID || "").trim();
  const secret = String(process.env.BAIDU_TRANSLATE_SECRET || "").trim();
  if (!appId || !secret) throw Object.assign(new Error("翻译服务尚未配置"), { statusCode: 503 });

  const salt = randomBytes(12).toString("hex");
  const sign = createHash("md5").update(`${appId}${input.q}${salt}${secret}`, "utf8").digest("hex");
  const body = new URLSearchParams({
    q: input.q,
    from: input.from,
    to: input.to,
    appid: appId,
    salt,
    sign,
  }).toString();
  const controller = new AbortController();
  const timeoutMs = Math.max(1_000, Math.min(30_000, Number.parseInt(process.env.UPSTREAM_TIMEOUT_MS || "", 10) || DEFAULT_TIMEOUT_MS));
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  let upstream;
  try {
    upstream = await fetch(BAIDU_ENDPOINT, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded",
      },
      body,
      signal: controller.signal,
    });
  } catch (error) {
    if (error?.name === "AbortError") throw Object.assign(new Error("翻译服务响应超时"), { statusCode: 504 });
    throw Object.assign(new Error("无法连接翻译服务"), { statusCode: 502 });
  } finally {
    clearTimeout(timer);
  }
  let data;
  try {
    data = await upstream.json();
  } catch {
    throw Object.assign(new Error("翻译服务返回无效结果"), { statusCode: 502 });
  }
  if (String(data?.error_code || "") === "54003" && attempt < 1) {
    await delay(1_100 + Math.floor(Math.random() * 300));
    return fetchBaiduTranslation(input, attempt + 1);
  }
  if (!upstream.ok || data?.error_code || !Array.isArray(data?.trans_result)) {
    const error = new Error("翻译服务暂时不可用");
    error.statusCode = 502;
    error.upstreamCode = String(data?.error_code || upstream.status || "unknown").slice(0, 32);
    throw error;
  }
  return data;
}

async function handle(event) {
  const requestId = String(event?.requestContext?.requestId || event?.headers?.["x-request-id"] || "").slice(0, 128);
  const method = String(event?.httpMethod || "POST").toUpperCase();
  if (method === "GET") {
    return response(200, {
      ok: true,
      service: "ngr-baidu-translation",
      configured: Boolean(process.env.BAIDU_TRANSLATE_APP_ID && process.env.BAIDU_TRANSLATE_SECRET),
    }, requestId);
  }
  if (method !== "POST") return response(405, { error: "仅支持 POST 请求" }, requestId);

  try {
    enforceRateLimit(event);
    const input = parseBody(event);
    const cacheKey = `${input.from}\u001f${input.to}\u001f${input.q}`.toLowerCase();
    const cached = getCached(cacheKey);
    if (cached) return response(200, cached, requestId);
    const translated = await fetchBaiduTranslation(input);
    setCached(cacheKey, translated);
    return response(200, translated, requestId);
  } catch (error) {
    const statusCode = Number.isInteger(error?.statusCode) ? error.statusCode : 500;
    const payload = {
      error: statusCode >= 500 ? "翻译服务暂时不可用" : String(error?.message || "请求无效"),
    };
    if (error?.upstreamCode) payload.error_code = error.upstreamCode;
    return response(statusCode, payload, requestId);
  }
}

exports.handler = (event, context, callback) => {
  handle(event)
    .then((result) => callback(null, result))
    .catch(() => callback(null, response(500, { error: "翻译服务暂时不可用" })));
};

exports.__test = {
  enforceRateLimit,
  fetchBaiduTranslation,
  getCached,
  handle,
  parseBody,
  response,
  setCached,
};
