import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseManagedProviderConfig } from "../desktop/services/managed-provider-config.mjs";

const REQUEST_TIMEOUT_MS = 20_000;

async function requestJson(fetchImpl, url, options) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  timer.unref?.();
  let response;
  try {
    response = await fetchImpl(url, { ...options, signal: controller.signal });
  } catch (error) {
    throw new Error(error?.name === "AbortError"
      ? "NGR 云翻译验证超时"
      : "无法连接 NGR 云翻译");
  } finally {
    clearTimeout(timer);
  }
  let data = null;
  try {
    data = await response.json();
  } catch {
    // Never include an upstream response body in release logs.
  }
  if (!response.ok) throw new Error(`NGR 云翻译验证失败（HTTP ${response.status}）`);
  if (!data || typeof data !== "object") throw new Error("NGR 云翻译返回格式无效");
  return data;
}

export async function verifyManagedProvider({ env = process.env, fetchImpl = globalThis.fetch } = {}) {
  if (typeof fetchImpl !== "function") throw new TypeError("fetch implementation is required");
  const config = parseManagedProviderConfig({
    version: 1,
    baiduCfc: {
      enabled: true,
      endpoint: String(env.NGR_BAIDU_CFC_ENDPOINT || "").trim(),
      bearerToken: String(env.NGR_BAIDU_CFC_BEARER_TOKEN || "").trim(),
    },
  });
  if (!config.baiduCfc.bearerToken) throw new Error("NGR 云翻译发布令牌未配置");
  const headers = {
    accept: "application/json",
    authorization: `Bearer ${config.baiduCfc.bearerToken}`,
  };
  const health = await requestJson(fetchImpl, config.baiduCfc.endpoint, {
    method: "GET",
    headers,
  });
  if (health.ok !== true || health.service !== "ngr-baidu-translation" || health.configured !== true) {
    throw new Error("NGR 云翻译健康检查未通过");
  }
  const translation = await requestJson(fetchImpl, config.baiduCfc.endpoint, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ q: "测试", from: "zh", to: "en" }),
  });
  const translatedText = Array.isArray(translation.trans_result)
    ? translation.trans_result.map((item) => String(item?.dst || "").trim()).filter(Boolean).join(" ")
    : "";
  if (!translatedText) throw new Error("NGR 云翻译测试未返回译文");
  return { ok: true, service: health.service };
}

const isCli = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isCli) {
  try {
    await verifyManagedProvider();
    console.log("NGR 云翻译在线验证通过；正式包将使用受管配置，用户无需填写 API。");
  } catch (error) {
    console.error(error instanceof Error ? error.message : "NGR 云翻译在线验证失败");
    process.exitCode = 1;
  }
}
