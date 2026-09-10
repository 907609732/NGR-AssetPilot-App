import { isIP } from "node:net";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { DesktopError, isPlainRecord } from "../shared/core.mjs";

const STORAGE_VERSION = 1;
const MAX_HISTORY_RUNS = 30;
const MAX_CUSTOM_TARGETS = 100;
const MAX_TARGETS_PER_RUN = 50;
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_TIMEOUT_MS = 30_000;
const MAX_REDIRECTS = 3;
const MAX_REQUEST_BODY_BYTES = 16 * 1024;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;
const CUSTOM_ID_PATTERN = /^custom-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAFE_METHODS = new Set(["HEAD", "GET"]);
const ALLOWED_METHODS = new Set(["HEAD", "GET", "POST", "PUT", "PATCH", "DELETE"]);
const ROUTE_MODES = new Set(["system", "direct", "compare"]);
const SECRET_HINT_PATTERN = /(?:api.?key|secret|token|password|authorization|credential|signature|access.?key)/i;
const CLOUD_METADATA_HOSTS = new Set([
  "169.254.169.254",
  "100.100.100.200",
  "metadata.google.internal",
]);

const BUILTIN_TARGETS = Object.freeze([
  { id: "figma-rest", name: "Figma REST API", category: "设计服务", url: "https://api.figma.com/v1/me", method: "GET", expectedContent: "json" },
  { id: "openai-api", name: "OpenAI API", category: "AI 服务", url: "https://api.openai.com/v1/models", method: "GET", expectedContent: "json" },
  { id: "moonshot-api", name: "Moonshot / Kimi API", category: "AI 服务", url: "https://api.moonshot.cn/v1/models", method: "GET", expectedContent: "json" },
  { id: "dashscope-api", name: "通义千问 DashScope", category: "AI 服务", url: "https://dashscope.aliyuncs.com/api/v1/services/aigc/text-generation/generation", method: "HEAD", expectedContent: "json" },
  { id: "tencent-hunyuan", name: "腾讯混元", category: "AI 服务", url: "https://hunyuan.tencentcloudapi.com/", method: "HEAD", expectedContent: "json" },
  { id: "baidu-translate", name: "百度通用翻译", category: "百度云", url: "https://fanyi-api.baidu.com/api/trans/vip/translate", method: "HEAD", expectedContent: "json" },
  { id: "baidu-ai-translate", name: "百度 AI 翻译", category: "百度云", url: "https://fanyi-api.baidu.com/ait/api/aiTextTranslate", method: "HEAD", expectedContent: "json" },
  { id: "baidu-cfc-bj", name: "百度 CFC（北京）", category: "百度云", url: "https://cfc.bj.baidubce.com/", method: "HEAD", expectedContent: "json" },
  { id: "baidu-bos-bj", name: "百度 BOS（北京）", category: "百度云", url: "https://bj.bcebos.com/", method: "HEAD" },
  { id: "aliyun-sts", name: "阿里云 OpenAPI / STS", category: "阿里云", url: "https://sts.aliyuncs.com/", method: "HEAD", expectedContent: "xml" },
  { id: "aliyun-oss-hangzhou", name: "阿里云 OSS（杭州）", category: "阿里云", url: "https://oss-cn-hangzhou.aliyuncs.com/", method: "HEAD", expectedContent: "xml" },
  { id: "aliyun-cdn", name: "阿里云 CDN API", category: "阿里云", url: "https://cdn.aliyuncs.com/", method: "HEAD", expectedContent: "xml" },
  { id: "tencent-sts", name: "腾讯云 OpenAPI / STS", category: "腾讯云", url: "https://sts.tencentcloudapi.com/", method: "HEAD", expectedContent: "json" },
  { id: "tencent-cos", name: "腾讯云 COS", category: "腾讯云", url: "https://service.cos.myqcloud.com/", method: "HEAD", expectedContent: "xml" },
  { id: "tencent-cdn", name: "腾讯云 CDN API", category: "腾讯云", url: "https://cdn.tencentcloudapi.com/", method: "HEAD", expectedContent: "json" },
  { id: "github-api", name: "GitHub API", category: "软件依赖", url: "https://api.github.com/", method: "HEAD", expectedContent: "json" },
  { id: "github-releases", name: "GitHub Releases", category: "软件依赖", url: "https://github.com/907609732/NGR-AssetPilot-App/releases", method: "HEAD" },
  { id: "huggingface", name: "Hugging Face", category: "软件依赖", url: "https://huggingface.co/", method: "HEAD" },
  { id: "huggingface-model", name: "Hugging Face 模型仓库", category: "软件依赖", url: "https://huggingface.co/Xenova/clip-vit-base-patch32", method: "HEAD" },
].map((target) => Object.freeze({ ...target, builtin: true, timeoutMs: DEFAULT_TIMEOUT_MS, unsafe: false })));

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function isLoopbackHostname(hostname) {
  const value = String(hostname || "").toLowerCase().replace(/^\[|\]$/g, "");
  return value === "localhost" || value === "127.0.0.1" || value === "::1";
}

function parseIpv4(value) {
  const parts = String(value).split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return null;
  return parts;
}

function classifyAddress(address) {
  const normalized = String(address || "").toLowerCase().replace(/^\[|\]$/g, "");
  const kind = isIP(normalized);
  if (kind === 4) {
    const [a, b, c] = parseIpv4(normalized);
    if (normalized === "169.254.169.254" || normalized === "100.100.100.200") return "metadata";
    if (a === 127) return "loopback";
    if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127)) return "lan";
    if (a === 169 && b === 254) return "link-local";
    if (a === 0 || a >= 224 || (a === 192 && b === 0 && c === 2) || (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113)) return "reserved";
    return "public";
  }
  if (kind === 6) {
    if (normalized === "::1") return "loopback";
    if (normalized === "::") return "reserved";
    if (normalized.startsWith("fe8") || normalized.startsWith("fe9") || normalized.startsWith("fea") || normalized.startsWith("feb")) return "link-local";
    if (normalized.startsWith("fc") || normalized.startsWith("fd")) return "lan";
    if (normalized.startsWith("ff") || normalized.startsWith("2001:db8")) return "reserved";
    return "public";
  }
  return "hostname";
}

function normalizeUrl(rawValue, { allowLan = false } = {}) {
  if (typeof rawValue !== "string" || !rawValue.trim() || rawValue.length > 4096 || /[\u0000-\u001f]/.test(rawValue)) {
    throw new DesktopError("DIAGNOSTICS_URL_INVALID", "诊断地址无效");
  }
  let parsed;
  try {
    parsed = new URL(rawValue.trim());
  } catch {
    throw new DesktopError("DIAGNOSTICS_URL_INVALID", "诊断地址无效");
  }
  const hostname = parsed.hostname.toLowerCase();
  if (parsed.username || parsed.password || parsed.hash) {
    throw new DesktopError("DIAGNOSTICS_URL_INVALID", "诊断地址不能包含凭据或片段");
  }
  if (CLOUD_METADATA_HOSTS.has(hostname)) {
    throw new DesktopError("DIAGNOSTICS_METADATA_BLOCKED", "禁止访问云主机元数据地址");
  }
  const loopback = isLoopbackHostname(hostname);
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopback)) {
    throw new DesktopError("DIAGNOSTICS_PROTOCOL_BLOCKED", "远程诊断仅允许 HTTPS，本机 localhost 可使用 HTTP");
  }
  if (parsed.protocol === "http:" && loopback && !parsed.port) {
    throw new DesktopError("DIAGNOSTICS_PORT_REQUIRED", "本机 HTTP 服务必须明确填写端口");
  }
  const addressClass = classifyAddress(hostname);
  if (["metadata", "link-local", "reserved"].includes(addressClass)) {
    throw new DesktopError("DIAGNOSTICS_ADDRESS_BLOCKED", "诊断地址属于禁止访问的保留网络");
  }
  if (addressClass === "lan" && !allowLan) {
    throw new DesktopError("DIAGNOSTICS_LAN_CONFIRM_REQUIRED", "局域网目标需要先启用并确认局域网高级模式");
  }
  for (const [name] of parsed.searchParams) {
    if (SECRET_HINT_PATTERN.test(name)) {
      throw new DesktopError("DIAGNOSTICS_SECRET_BLOCKED", "诊断地址不能包含密钥类查询参数");
    }
  }
  let decodedPath;
  try {
    decodedPath = decodeURIComponent(parsed.pathname);
  } catch {
    throw new DesktopError("DIAGNOSTICS_URL_INVALID", "诊断地址路径编码无效");
  }
  if (decodedPath.split("/").some((part) => part === "." || part === "..") || decodedPath.includes("\\")) {
    throw new DesktopError("DIAGNOSTICS_URL_INVALID", "诊断地址路径无效");
  }
  return parsed;
}

function assertBodyContainsNoSecret(body) {
  if (!body) return;
  if (Buffer.byteLength(body, "utf8") > MAX_REQUEST_BODY_BYTES) {
    throw new DesktopError("DIAGNOSTICS_BODY_TOO_LARGE", "自定义请求体超过 16 KiB 限制");
  }
  if (SECRET_HINT_PATTERN.test(body) || /(?:bearer\s+[a-z0-9._~-]{8,}|\bsk-[a-z0-9_-]{8,})/i.test(body)) {
    throw new DesktopError("DIAGNOSTICS_SECRET_BLOCKED", "连通性诊断请求体不能包含密钥类内容");
  }
}

function normalizeCustomTarget(input, existing = null) {
  if (!isPlainRecord(input)) throw new DesktopError("DIAGNOSTICS_TARGET_INVALID", "自定义诊断目标无效");
  const name = String(input.name || "").trim().slice(0, 80);
  if (!name) throw new DesktopError("DIAGNOSTICS_TARGET_NAME_REQUIRED", "请填写诊断目标名称");
  const category = String(input.category || "自定义").trim().slice(0, 40) || "自定义";
  const method = String(input.method || "HEAD").toUpperCase();
  if (!ALLOWED_METHODS.has(method)) throw new DesktopError("DIAGNOSTICS_METHOD_INVALID", "自定义诊断方法无效");
  const allowLan = input.allowLan === true;
  const parsed = normalizeUrl(input.url, { allowLan });
  const timeoutValue = Number(input.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  if (!Number.isFinite(timeoutValue) || timeoutValue < 1_000 || timeoutValue > MAX_TIMEOUT_MS) {
    throw new DesktopError("DIAGNOSTICS_TIMEOUT_INVALID", "诊断超时必须在 1 到 30 秒之间");
  }
  const body = SAFE_METHODS.has(method) ? "" : String(input.body || "");
  assertBodyContainsNoSecret(body);
  const expectedStatuses = Array.isArray(input.expectedStatuses)
    ? [...new Set(input.expectedStatuses.map(Number).filter((value) => Number.isInteger(value) && value >= 100 && value <= 599))].slice(0, 20)
    : [];
  if (existing && !CUSTOM_ID_PATTERN.test(String(existing.id || ""))) {
    throw new DesktopError("DIAGNOSTICS_TARGET_INVALID", "自定义诊断目标标识无效");
  }
  return {
    id: existing?.id || `custom-${randomUUID()}`,
    name,
    category,
    url: parsed.href,
    method,
    timeoutMs: Math.trunc(timeoutValue),
    expectedStatuses,
    allowLan,
    body,
    builtin: false,
    unsafe: !SAFE_METHODS.has(method),
    createdAt: existing?.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function publicTarget(target) {
  const parsed = new URL(target.url);
  parsed.search = "";
  return {
    id: target.id,
    name: target.name,
    category: target.category,
    displayUrl: parsed.href,
    url: target.builtin ? undefined : target.url,
    method: target.method,
    timeoutMs: target.timeoutMs,
    expectedStatuses: [...(target.expectedStatuses || [])],
    allowLan: Boolean(target.allowLan),
    body: target.builtin ? "" : String(target.body || ""),
    builtin: Boolean(target.builtin),
    unsafe: Boolean(target.unsafe),
  };
}

function managedTarget(config) {
  const endpoint = config?.baiduCfc?.enabled ? config.baiduCfc.endpoint : "";
  if (!endpoint) return null;
  try {
    const parsed = normalizeUrl(endpoint);
    return Object.freeze({
      id: "ngr-managed-cfc",
      name: "NGR 云翻译 CFC",
      category: "百度云",
      url: parsed.href,
      method: "GET",
      expectedContent: "json",
      timeoutMs: DEFAULT_TIMEOUT_MS,
      builtin: true,
      unsafe: false,
    });
  } catch {
    return null;
  }
}

function summarizeProxy(rawValue) {
  const tokens = String(rawValue || "DIRECT")
    .split(";")
    .map((item) => item.trim().split(/\s+/)[0].toUpperCase())
    .filter((item) => ["DIRECT", "PROXY", "HTTPS", "SOCKS", "SOCKS4", "SOCKS5", "QUIC"].includes(item));
  return [...new Set(tokens.length ? tokens : ["UNKNOWN"])].join(" + ");
}

function safeOrigin(rawValue) {
  try {
    return new URL(rawValue).origin;
  } catch {
    return "";
  }
}

function resultCodeForStatus(status) {
  if (status === 401 || status === 403) return "REACHABLE_AUTH_REQUIRED";
  if (status === 405) return "REACHABLE_METHOD_NOT_ALLOWED";
  if (status === 429) return "REACHABLE_RATE_LIMITED";
  if (status >= 500) return "REACHABLE_SERVICE_ERROR";
  if (status >= 300) return "REACHABLE_REDIRECT";
  return "REACHABLE";
}

function failureCode(error, timedOut, canceled) {
  if (canceled) return "CANCELED";
  if (timedOut) return "TIMEOUT";
  const raw = `${error?.code || ""} ${error?.message || ""}`.toUpperCase();
  if (/DNS_REBIND|ADDRESS_BLOCKED|METADATA_BLOCKED/.test(raw)) return "ADDRESS_BLOCKED";
  if (/NAME_NOT_RESOLVED|ENOTFOUND|EAI_AGAIN|DNS/.test(raw)) return "DNS_FAILED";
  if (/CERT|SSL|TLS/.test(raw)) return "TLS_FAILED";
  if (/PROXY|TUNNEL/.test(raw)) return "PROXY_FAILED";
  if (/TIMEDOUT|TIMEOUT/.test(raw)) return "TIMEOUT";
  if (/CONNECTION|ECONN|NETWORK|FAILED/.test(raw)) return "CONNECTION_FAILED";
  return "NETWORK_FAILED";
}

function safeResponseHeaders(response) {
  return {
    contentType: String(response?.headers?.get?.("content-type") || "").slice(0, 160),
    contentLength: String(response?.headers?.get?.("content-length") || "").slice(0, 32),
  };
}

function normalizeResolvedAddresses(value) {
  const candidates = Array.isArray(value?.endpoints) ? value.endpoints : Array.isArray(value?.addresses) ? value.addresses : [];
  return candidates
    .map((item) => typeof item === "string" ? item : item?.address)
    .filter((address) => typeof address === "string" && isIP(address))
    .slice(0, 16);
}

function assertResolvedAddresses(target, addresses) {
  if (target.builtin || isLoopbackHostname(new URL(target.url).hostname)) return;
  if (!addresses.length) return;
  for (const address of addresses) {
    const classification = classifyAddress(address);
    if (classification === "metadata" || classification === "link-local" || classification === "reserved") {
      throw new DesktopError("DIAGNOSTICS_DNS_REBIND_BLOCKED", "域名解析到了禁止访问的网络地址");
    }
    if (classification === "lan" && !target.allowLan) {
      throw new DesktopError("DIAGNOSTICS_DNS_REBIND_BLOCKED", "域名解析到了未授权的局域网地址");
    }
  }
}

function safeHistoryResult(target, route, result) {
  return {
    targetId: target.id,
    targetName: target.name,
    category: target.category,
    origin: safeOrigin(target.url),
    route,
    reachable: Boolean(result.reachable),
    resultCode: result.resultCode,
    status: result.status ?? null,
    latencyMs: result.latencyMs ?? null,
    firstByteMs: result.firstByteMs ?? null,
    totalMs: result.totalMs ?? result.latencyMs ?? null,
    dnsMs: result.dnsMs ?? null,
    failureStage: result.failureStage || "",
    proxy: result.proxy || "",
    contentType: result.contentType || "",
    redirectOrigins: Array.isArray(result.redirectOrigins) ? result.redirectOrigins.map(safeOrigin).filter(Boolean).slice(0, MAX_REDIRECTS) : [],
    finishedAt: result.finishedAt,
  };
}

function markdownHistory(runs) {
  const lines = ["# NGR AssetPilot 网络与 API 诊断", ""];
  for (const run of runs) {
    lines.push(`## ${run.startedAt}`, "", `- 模式：${run.routeMode}`, `- 在线状态：${run.online ? "在线" : "离线"}`, "", "| 服务 | 路线 | 结论 | HTTP | 延迟 |", "| --- | --- | --- | ---: | ---: |");
    for (const result of run.results || []) {
      lines.push(`| ${String(result.targetName || "").replace(/\|/g, "\\|")} | ${result.route} | ${result.resultCode} | ${result.status ?? "-"} | ${result.totalMs ?? result.latencyMs ?? "-"} ms |`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

function waitForAbortable(promise, signal) {
  if (signal.aborted) return Promise.reject(new DOMException("aborted", "AbortError"));
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(new DOMException("aborted", "AbortError"));
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve(promise).then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

export class NetworkDiagnosticsService {
  constructor({ userDataPath, netModule, defaultSession, directSession, dialog = null, getWindow = () => null, managedProviderConfig = null, onProgress = () => {} }) {
    if (!userDataPath || !netModule || !defaultSession || !directSession) throw new TypeError("network diagnostics dependencies are required");
    this.root = path.join(userDataPath, "network-diagnostics");
    this.targetsPath = path.join(this.root, "custom-targets.v1.json");
    this.historyPath = path.join(this.root, "history.v1.json");
    this.net = netModule;
    this.defaultSession = defaultSession;
    this.directSession = directSession;
    this.dialog = dialog;
    this.getWindow = getWindow;
    this.onProgress = onProgress;
    this.targets = [];
    this.history = [];
    this.active = new Map();
    this.initialized = false;
    this.builtinTargets = [...BUILTIN_TARGETS];
    const managed = managedTarget(managedProviderConfig);
    if (managed) this.builtinTargets.push(managed);
  }

  async initialize() {
    if (this.initialized) return;
    await mkdir(this.root, { recursive: true });
    this.targets = await this.#readStore(this.targetsPath, "targets");
    this.targets = this.targets.slice(0, MAX_CUSTOM_TARGETS).map((target) => {
      try { return normalizeCustomTarget(target, target); } catch { return null; }
    }).filter(Boolean);
    this.history = (await this.#readStore(this.historyPath, "runs")).slice(0, MAX_HISTORY_RUNS);
    await this.directSession.setProxy({ mode: "direct" });
    this.initialized = true;
  }

  async listCatalog() {
    await this.initialize();
    let proxy = "UNKNOWN";
    try {
      proxy = summarizeProxy(await this.defaultSession.resolveProxy(this.builtinTargets[0].url));
    } catch { /* A proxy summary failure must not hide the catalog. */ }
    return {
      online: Boolean(this.net.isOnline?.() ?? this.net.online),
      proxy,
      categories: [...new Set(this.builtinTargets.map((target) => target.category))],
      targets: this.builtinTargets.map(publicTarget),
    };
  }

  async listCustomTargets() {
    await this.initialize();
    return this.targets.map(publicTarget);
  }

  async upsertCustomTarget(input) {
    await this.initialize();
    const requestedId = String(input?.id || "");
    if (requestedId && !CUSTOM_ID_PATTERN.test(requestedId)) throw new DesktopError("DIAGNOSTICS_TARGET_INVALID", "自定义诊断目标标识无效");
    const existingIndex = requestedId ? this.targets.findIndex((target) => target.id === requestedId) : -1;
    if (requestedId && existingIndex < 0) throw new DesktopError("DIAGNOSTICS_TARGET_NOT_FOUND", "自定义诊断目标不存在");
    if (existingIndex < 0 && this.targets.length >= MAX_CUSTOM_TARGETS) throw new DesktopError("DIAGNOSTICS_TARGET_LIMIT", "自定义诊断目标数量已达上限");
    const target = normalizeCustomTarget(input, existingIndex >= 0 ? this.targets[existingIndex] : null);
    if (existingIndex >= 0) this.targets[existingIndex] = target;
    else this.targets.push(target);
    await this.#persistTargets();
    return publicTarget(target);
  }

  async removeCustomTarget(input) {
    await this.initialize();
    const id = String(input?.targetId || "");
    const index = this.targets.findIndex((target) => target.id === id);
    if (index < 0) throw new DesktopError("DIAGNOSTICS_TARGET_NOT_FOUND", "自定义诊断目标不存在");
    this.targets.splice(index, 1);
    await this.#persistTargets();
    return { removed: true, targetId: id };
  }

  async run(input, ownerId) {
    await this.initialize();
    if (!isPlainRecord(input) || !REQUEST_ID_PATTERN.test(String(input.requestId || ""))) throw new DesktopError("DIAGNOSTICS_REQUEST_INVALID", "诊断请求标识无效");
    const routeMode = ROUTE_MODES.has(input.routeMode) ? input.routeMode : "system";
    const ids = [...new Set(Array.isArray(input.targetIds) ? input.targetIds.map(String) : [])];
    if (!ids.length || ids.length > MAX_TARGETS_PER_RUN) throw new DesktopError("DIAGNOSTICS_TARGET_SELECTION_INVALID", "请选择 1 到 50 个诊断目标");
    const allTargets = new Map([...this.builtinTargets, ...this.targets].map((target) => [target.id, target]));
    const targets = ids.map((id) => allTargets.get(id));
    if (targets.some((target) => !target)) throw new DesktopError("DIAGNOSTICS_TARGET_NOT_FOUND", "诊断目标不存在或已被删除");
    const confirmedUnsafe = new Set(Array.isArray(input.confirmedUnsafeTargetIds) ? input.confirmedUnsafeTargetIds.map(String) : []);
    if (targets.some((target) => target.unsafe && !confirmedUnsafe.has(target.id))) {
      throw new DesktopError("DIAGNOSTICS_UNSAFE_CONFIRM_REQUIRED", "高风险 HTTP 方法需要在本次执行前确认");
    }
    const key = this.#requestKey(ownerId, input.requestId);
    if (this.active.has(key)) throw new DesktopError("DIAGNOSTICS_REQUEST_DUPLICATE", "诊断任务正在运行");
    const controller = new AbortController();
    this.active.set(key, { controller, requestId: input.requestId });
    const startedAt = new Date().toISOString();
    const runRecord = { id: randomUUID(), requestId: input.requestId, startedAt, routeMode, online: Boolean(this.net.isOnline?.() ?? this.net.online), results: [] };
    this.#emit({ requestId: input.requestId, type: "start", total: targets.length * (routeMode === "compare" ? 2 : 1), startedAt });
    try {
      const jobs = [];
      for (const target of targets) {
        if (routeMode === "compare") {
          jobs.push({ target, route: "system" }, { target, route: "direct" });
        } else jobs.push({ target, route: routeMode });
      }
      let cursor = 0;
      const worker = async () => {
        while (cursor < jobs.length) {
          const job = jobs[cursor++];
          if (controller.signal.aborted) break;
          const result = await this.#probe(job.target, job.route, controller.signal);
          const safeResult = safeHistoryResult(job.target, job.route, result);
          runRecord.results.push(safeResult);
          this.#emit({ requestId: input.requestId, type: "result", result: safeResult, completed: runRecord.results.length, total: jobs.length });
        }
      };
      await Promise.all(Array.from({ length: Math.min(4, jobs.length) }, worker));
      runRecord.finishedAt = new Date().toISOString();
      runRecord.canceled = controller.signal.aborted;
      this.history.unshift(runRecord);
      this.history = this.history.slice(0, MAX_HISTORY_RUNS);
      await this.#persistHistory();
      this.#emit({ requestId: input.requestId, type: "complete", run: clone(runRecord) });
      return clone(runRecord);
    } finally {
      this.active.delete(key);
    }
  }

  cancel(input, ownerId) {
    const key = this.#requestKey(ownerId, input?.requestId);
    const active = this.active.get(key);
    if (!active) return { canceled: false, requestId: input?.requestId };
    active.controller.abort();
    return { canceled: true, requestId: input.requestId };
  }

  cancelOwner(ownerId) {
    const prefix = `${Number(ownerId)}:`;
    let canceled = 0;
    for (const [key, active] of this.active) {
      if (!key.startsWith(prefix)) continue;
      active.controller.abort();
      canceled += 1;
    }
    return canceled;
  }

  async listHistory(input = {}) {
    await this.initialize();
    const limit = Math.min(MAX_HISTORY_RUNS, Math.max(1, Number(input?.limit) || MAX_HISTORY_RUNS));
    return clone(this.history.slice(0, limit));
  }

  async clearHistory() {
    await this.initialize();
    this.history = [];
    await this.#persistHistory();
    return { cleared: true };
  }

  async exportHistory(input = {}) {
    await this.initialize();
    if (!this.dialog) throw new DesktopError("DIAGNOSTICS_EXPORT_UNAVAILABLE", "当前环境不能导出诊断记录");
    const format = input.format === "json" ? "json" : "markdown";
    const selected = new Set(Array.isArray(input.runIds) ? input.runIds.map(String) : []);
    const runs = selected.size ? this.history.filter((run) => selected.has(run.id)) : this.history;
    const result = await this.dialog.showSaveDialog(this.getWindow(), {
      title: "导出网络诊断记录",
      defaultPath: `NGR-网络诊断-${new Date().toISOString().slice(0, 10)}.${format === "json" ? "json" : "md"}`,
      filters: format === "json" ? [{ name: "JSON", extensions: ["json"] }] : [{ name: "Markdown", extensions: ["md"] }],
    });
    if (result.canceled || !result.filePath) return { canceled: true };
    const content = format === "json" ? `${JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), runs }, null, 2)}\n` : `${markdownHistory(runs)}\n`;
    await writeFile(result.filePath, content, { encoding: "utf8", flag: "w" });
    return { canceled: false, format, runCount: runs.length };
  }

  async dispose() {
    for (const active of this.active.values()) active.controller.abort();
    this.active.clear();
    await this.directSession.closeAllConnections?.();
    await this.directSession.clearStorageData?.();
  }

  async #probe(target, route, runSignal) {
    const session = route === "direct" ? this.directSession : this.defaultSession;
    const parsed = new URL(target.url);
    const started = Date.now();
    let timedOut = false;
    let proxy = route === "direct" ? "DIRECT" : "UNKNOWN";
    let dnsMs = null;
    let firstByteMs = null;
    let failureStage = route === "system" ? "proxy" : "dns";
    const controller = new AbortController();
    const onRunAbort = () => controller.abort();
    runSignal.addEventListener("abort", onRunAbort, { once: true });
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, target.timeoutMs || DEFAULT_TIMEOUT_MS);
    timer.unref?.();
    try {
      if (route === "system") {
        proxy = summarizeProxy(await waitForAbortable(this.defaultSession.resolveProxy(parsed.href), controller.signal));
      }
      failureStage = "dns";
      const dnsStarted = Date.now();
      const resolved = await waitForAbortable(
        session.resolveHost
          ? session.resolveHost(parsed.hostname, { cacheUsage: "disallowed" })
          : this.net.resolveHost(parsed.hostname, { cacheUsage: "disallowed" }),
        controller.signal,
      );
      dnsMs = Date.now() - dnsStarted;
      assertResolvedAddresses(target, normalizeResolvedAddresses(resolved));
      let current = parsed;
      const redirectOrigins = [];
      for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
        failureStage = "http";
        const requestHeaders = target.method === "HEAD"
          ? { accept: "*/*" }
          : { accept: "application/json, text/plain, */*" };
        if (!SAFE_METHODS.has(target.method) && target.body) requestHeaders["content-type"] = "application/json";
        const response = await session.fetch(current.href, {
          method: target.method,
          headers: requestHeaders,
          body: SAFE_METHODS.has(target.method) ? undefined : target.body || undefined,
          redirect: "manual",
          cache: "no-store",
          credentials: "omit",
          referrerPolicy: "no-referrer",
          signal: controller.signal,
        });
        if (firstByteMs == null) firstByteMs = Date.now() - started;
        const responseHeaders = safeResponseHeaders(response);
        const location = response.headers?.get?.("location");
        const status = Number(response.status);
        await response.body?.cancel?.().catch(() => {});
        const totalMs = Date.now() - started;
        if (status >= 300 && status < 400 && location) {
          const next = new URL(location, current);
          redirectOrigins.push(next.origin);
          if (next.origin !== current.origin || redirects === MAX_REDIRECTS) {
            return {
              reachable: true,
              resultCode: next.origin !== current.origin ? "REACHABLE_SUSPECTED_INTERCEPTION" : "REACHABLE_TOO_MANY_REDIRECTS",
              status,
              latencyMs: totalMs,
              firstByteMs,
              totalMs,
              dnsMs,
              failureStage: "",
              proxy,
              ...responseHeaders,
              redirectOrigins,
              finishedAt: new Date().toISOString(),
            };
          }
          current = next;
          continue;
        }
        let resultCode = resultCodeForStatus(status);
        if (target.expectedContent === "json" && responseHeaders.contentType.includes("text/html") && status >= 200 && status < 300) resultCode = "REACHABLE_SUSPECTED_INTERCEPTION";
        if (target.expectedStatuses?.length && !target.expectedStatuses.includes(status)) resultCode = `REACHABLE_UNEXPECTED_STATUS`;
        return {
          reachable: true,
          resultCode,
          status,
          latencyMs: totalMs,
          firstByteMs,
          totalMs,
          dnsMs,
          failureStage: "",
          proxy,
          ...responseHeaders,
          redirectOrigins,
          finishedAt: new Date().toISOString(),
        };
      }
      throw new DesktopError("DIAGNOSTICS_REDIRECT_LIMIT", "诊断重定向次数过多");
    } catch (error) {
      return {
        reachable: false,
        resultCode: failureCode(error, timedOut, runSignal.aborted),
        status: null,
        latencyMs: Date.now() - started,
        firstByteMs,
        totalMs: Date.now() - started,
        dnsMs,
        failureStage,
        proxy,
        contentType: "",
        redirectOrigins: [],
        finishedAt: new Date().toISOString(),
      };
    } finally {
      clearTimeout(timer);
      runSignal.removeEventListener("abort", onRunAbort);
    }
  }

  #requestKey(ownerId, requestId) {
    const owner = Number(ownerId);
    const id = String(requestId || "");
    if (!Number.isSafeInteger(owner) || owner < 1 || !REQUEST_ID_PATTERN.test(id)) throw new DesktopError("DIAGNOSTICS_REQUEST_INVALID", "诊断请求标识无效");
    return `${owner}:${id}`;
  }

  #emit(payload) {
    try { this.onProgress(clone(payload)); } catch { /* UI progress must not interrupt diagnostics. */ }
  }

  async #readStore(filePath, key) {
    try {
      const raw = await readFile(filePath);
      if (raw.byteLength > 2 * 1024 * 1024) throw new Error("oversized");
      const parsed = JSON.parse(raw.toString("utf8"));
      return parsed?.version === STORAGE_VERSION && Array.isArray(parsed[key]) ? parsed[key] : [];
    } catch (error) {
      if (error?.code === "ENOENT") return [];
      return [];
    }
  }

  async #writeStore(filePath, key, value) {
    const temporary = `${filePath}.${randomUUID()}.tmp`;
    const payload = `${JSON.stringify({ version: STORAGE_VERSION, [key]: value }, null, 2)}\n`;
    try {
      await writeFile(temporary, payload, { encoding: "utf8", mode: 0o600, flag: "wx" });
      await rename(temporary, filePath);
    } catch (error) {
      await unlink(temporary).catch(() => {});
      throw new DesktopError("DIAGNOSTICS_STORAGE_FAILED", "网络诊断数据保存失败");
    }
  }

  #persistTargets() { return this.#writeStore(this.targetsPath, "targets", this.targets); }
  #persistHistory() { return this.#writeStore(this.historyPath, "runs", this.history); }
}

export {
  BUILTIN_TARGETS,
  classifyAddress,
  normalizeCustomTarget,
  normalizeUrl,
  resultCodeForStatus,
  summarizeProxy,
};
