import { createServer } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import Ajv from "ajv";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const SESSION_COOKIE = "ngr_local_web";
const MAX_REQUEST_BYTES = 32 * 1024 * 1024;
const SESSION_TTL = 12 * 60 * 60 * 1000;
const PAIR_TTL = 60 * 1000;
const TYPES = new Map(Object.entries({
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp", ".svg": "image/svg+xml",
  ".woff2": "font/woff2", ".ico": "image/x-icon", ".wasm": "application/wasm",
}));
const CSP = "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; worker-src 'self' blob:; style-src 'self' 'unsafe-inline'; frame-ancestors 'self'; form-action 'self'; base-uri 'none'; object-src 'none'";
const secret = () => randomBytes(32).toString("base64url");
function equal(a, b) {
  if (typeof b !== "string") return false;
  const expected = Buffer.from(a);
  const received = Buffer.from(b);
  return expected.length === received.length && timingSafeEqual(expected, received);
}
const fail = (status, message) => Object.assign(new Error(message), { status });

function json(response, status, value) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(value));
}

function errorMessage(error) {
  const message = error?.message;
  if (typeof message === "string" && (error.status || /^[\u3400-\u9fff]/.test(message))) {
    return message.slice(0, 300);
  }
  return "操作未完成，请重试";
}

async function jsonBody(request, maxBytes = MAX_REQUEST_BYTES) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers["content-type"] || "")) {
    throw fail(415, "需要 JSON 请求");
  }
  if (Number(request.headers["content-length"] || 0) > maxBytes) throw fail(413, "请求过大");
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    bytes += chunk.length;
    if (bytes > maxBytes) throw fail(413, "请求过大");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw fail(400, "JSON 格式无效");
  }
}

async function sendStatic(response, root, relative) {
  const pieces = relative.split("/");
  if (pieces.some(part => !part || part.startsWith(".") || /[\\:\u0000]/.test(part))) {
    throw fail(404, "页面不存在");
  }
  const file = path.join(root, ...pieces);
  const type = TYPES.get(path.extname(file).toLowerCase());
  if (!type) throw fail(404, "页面不存在");
  const contents = await fs.readFile(file).catch(error => {
    if (error.code === "ENOENT" || error.code === "EISDIR") throw fail(404, "页面不存在");
    throw error;
  });
  response.writeHead(200, { "Content-Type": type });
  response.end(contents);
}

export class LocalToolsServer {
  constructor({ port = 5199, webRoot, assets, getFinder, onAccessChanged }) {
    Object.assign(this, { port, webRoot, assets, getFinder, onAccessChanged });
    this.webEnabled = false;
    this.mcpEnabled = false;
    this.token = secret();
    this.tickets = new Map();
    this.sessions = new Map();
    this.calls = new Set();
    this.schemas = new WeakMap();
    this.validator = new Ajv({ strict: false, ownProperties: true });
    this.transition = Promise.resolve();
  }

  status() {
    const origin = "http://127.0.0.1:" + this.activePort();
    return { webEnabled: this.webEnabled, mcpEnabled: this.mcpEnabled, webUrl: origin + "/", mcpUrl: origin + "/mcp" };
  }

  activePort() {
    return this.listener?.address()?.port || this.port;
  }

  sessionCookieName() {
    return `${SESSION_COOKIE}_${this.activePort()}`;
  }

  setEnabled(feature, enabled) {
    if (!["web", "mcp"].includes(feature) || typeof enabled !== "boolean") {
      return Promise.reject(fail(400, "服务设置无效"));
    }
    const operation = this.transition.then(async () => {
      if (this.disposed) throw fail(409, "本机服务已关闭");
      if (enabled && !this.listener) await this.listen();
      this[feature + "Enabled"] = enabled;
      if (!enabled && feature === "web") {
        this.tickets.clear();
        this.sessions.clear();
      }
      if (!enabled && feature === "mcp") this.rotateToken();
      else if (!enabled) this.cancelCalls(feature);
      if (!this.webEnabled && !this.mcpEnabled) await this.stop();
      await this.onAccessChanged?.(this.status());
      return this.status();
    });
    this.transition = operation.catch(() => {});
    return operation;
  }

  async listen() {
    const listener = createServer((request, response) => {
      this.handle(request, response).catch(error => {
        if (!response.headersSent) {
          const status = Number.isInteger(error.status) && error.status >= 400 && error.status <= 599
            ? error.status : 500;
          json(response, status, { error: errorMessage(error) });
        } else response.destroy();
      });
    });
    listener.headersTimeout = 10_000;
    listener.requestTimeout = 60_000;
    listener.maxConnections = 48;
    const listenOn = port => {
      const ready = once(listener, "listening");
      listener.listen(port, "127.0.0.1");
      return ready;
    };
    try {
      await listenOn(this.port);
    } catch (error) {
      if (error.code !== "EADDRINUSE" || this.port === 0) throw error;
      await listenOn(0);
      this.port = listener.address().port;
    }
    this.listener = listener;
  }

  async stop() {
    const listener = this.listener;
    this.listener = null;
    if (!listener) return;
    await new Promise(resolve => {
      listener.close(resolve);
      listener.closeAllConnections();
    });
  }

  browserLink() {
    if (!this.webEnabled) throw fail(409, "请先开启网页服务");
    const now = Date.now();
    for (const [ticket, expires] of this.tickets) if (expires <= now) this.tickets.delete(ticket);
    if (this.tickets.size >= 12) this.tickets.delete(this.tickets.keys().next().value);
    const ticket = secret();
    this.tickets.set(ticket, now + PAIR_TTL);
    return this.status().webUrl + "#ticket=" + ticket;
  }

  getToken() {
    if (!this.mcpEnabled) throw fail(409, "请先开启 MCP");
    return this.token;
  }

  rotateToken() {
    this.token = secret();
    this.cancelCalls("mcp");
  }

  cancelCalls(feature) {
    for (const operation of this.calls) {
      if (!feature || operation.feature === feature) operation.controller.abort();
    }
  }

  async withCall(feature, response, run) {
    const controller = new AbortController();
    const operation = { feature, controller };
    const abort = () => controller.abort();
    response.once("close", abort);
    this.calls.add(operation);
    try {
      return await run(controller.signal);
    } finally {
      response.off("close", abort);
      this.calls.delete(operation);
    }
  }

  paired(request) {
    const prefix = this.sessionCookieName() + "=";
    const cookie = (request.headers.cookie || "").split(";").map(value => value.trim())
      .find(value => value.startsWith(prefix))?.slice(prefix.length);
    return this.sessions.get(cookie) > Date.now();
  }

  async pair(request, response) {
    const { ticket } = await jsonBody(request, 4096) || {};
    const now = Date.now();
    if (typeof ticket !== "string" || !(this.tickets.get(ticket) > now)) {
      throw fail(401, "连接已失效，请从桌面重新打开网页");
    }
    this.tickets.delete(ticket);
    for (const [id, expiry] of this.sessions) if (expiry <= now) this.sessions.delete(id);
    if (this.sessions.size >= 12) this.sessions.delete(this.sessions.keys().next().value);
    const id = secret();
    this.sessions.set(id, now + SESSION_TTL);
    response.setHeader("Set-Cookie", `${this.sessionCookieName()}=${id}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_TTL / 1000}`);
    json(response, 200, { paired: true });
  }

  async finder() {
    const runtime = await this.getFinder();
    if (!runtime?.invokeLocal || !runtime?.getWebRoot) throw fail(503, "快速找界面组件尚未就绪");
    return runtime;
  }

  async finderTools() {
    const finder = await this.getFinder().catch(() => null);
    return finder?.getLocalTools?.() || [];
  }

  async listMcpTools() {
    return [...this.assets.tools, ...await this.finderTools()].map(({ run, ...tool }) => tool);
  }

  async mcpGuide() {
    if (!this.mcpEnabled) throw fail(409, "请先开启 MCP");
    const tools = await this.listMcpTools();
    const finderGuide = tools.some(tool => tool.name === "finder_search")
      ? ["资料查询：用 finder_search 查找记录，用 finder_get 查看详情。写入时等待我在桌面确认。"]
      : [];
    return [
      "请通过 AI资源领航的本机 MCP 完成任务。",
      `地址：${this.status().mcpUrl}`,
      "传输方式：Streamable HTTP。身份验证在 AI 客户端的 MCP 配置中填入 Authorization: Bearer <令牌>。用软件的「复制令牌」获取，重启软件后按需更新。",
      "连接后先执行 tools/list，以当前清单为准，再用 tools/call 调用。若客户端已经加载 MCP 工具，可直接调用同名工具。",
      "图片任务：调用 grant_sources，等待我在桌面选择图片文件或文件夹。取消时停止。用返回的 sourceId 调用 start_naming 或 start_slice_check，再用 get_asset_job 查看结果。需导出命名副本时调用 export_named_copies，等待我选择导出位置。",
      ...finderGuide,
      "",
      "当前可用工具与参数（JSON Schema）",
      ...tools.map(tool => `- ${tool.name}：${tool.description}\n  ${JSON.stringify(tool.inputSchema)}`),
    ].join("\n");
  }

  checkMcpAccess(request, response) {
    if (!this.mcpEnabled) throw fail(404, "MCP 尚未启用");
    if (!equal("Bearer " + this.token, request.headers.authorization)) {
      response.setHeader("WWW-Authenticate", "Bearer");
      throw fail(401, "MCP 令牌无效");
    }
  }

  async mcp(request, response) {
    this.checkMcpAccess(request, response);
    if (request.method !== "POST") {
      response.setHeader("Allow", "POST");
      throw fail(405, "此接口需要 POST 请求");
    }
    const body = await jsonBody(request, 1024 * 1024);
    this.checkMcpAccess(request, response);
    await this.withCall("mcp", response, async signal => {
      const server = new Server({ name: "ngr-assetpilot", version: "1" }, { capabilities: { tools: {} } });
      server.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: await this.listMcpTools(),
      }));
      server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
        try {
          const matches = candidate => candidate.name === params.name;
          const tool = this.assets.tools.find(matches) ??
            (params.name.startsWith("finder_") ? (await this.finderTools()).find(matches) : undefined);
          if (!tool) throw fail(404, "未知工具");
          let validate = this.schemas.get(tool.inputSchema);
          if (!validate) {
            validate = this.validator.compile(tool.inputSchema);
            this.schemas.set(tool.inputSchema, validate);
          }
          const args = params.arguments || {};
          if (!validate(args)) throw fail(400, "工具参数无效");
          signal.throwIfAborted();
          const result = await tool.run(args, { signal });
          const structuredContent = result && typeof result === "object" && !Array.isArray(result)
            ? result : { result: result ?? null };
          return { content: [{ type: "text", text: JSON.stringify(structuredContent) }], structuredContent };
        } catch (error) {
          return { isError: true, content: [{ type: "text", text: errorMessage(error) }] };
        }
      });
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      try {
        await server.connect(transport);
        await transport.handleRequest(request, response, body);
      } finally {
        await server.close();
      }
    });
  }

  async handle(request, response) {
    const origin = new URL(this.status().webUrl).origin;
    const host = new URL(origin).host;
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Content-Security-Policy", CSP);
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "no-referrer");
    if (request.headers.host !== host || !request.url?.startsWith("/") || request.url.startsWith("//")) {
      throw fail(403, "访问来源无效");
    }
    if (request.headers.origin && request.headers.origin !== origin) throw fail(403, "访问来源无效");
    const url = new URL(request.url, origin);
    if (url.pathname === "/mcp") return this.mcp(request, response);
    if (!this.webEnabled) throw fail(404, "网页服务未开启");
    if (request.method === "POST" && request.headers.origin !== origin) throw fail(403, "访问来源无效");
    if (request.headers["sec-fetch-site"] === "cross-site") throw fail(403, "访问来源无效");
    if (request.method === "GET" && ["/", "/index.html", "/local-web.js", "/local-web.css"].includes(url.pathname)) {
      return sendStatic(response, this.webRoot, url.pathname.slice(1) || "index.html");
    }
    if (request.method === "POST" && url.pathname === "/api/pair") return this.pair(request, response);
    if (!this.paired(request)) throw fail(401, "请从桌面打开本机网页");
    if (request.method === "GET" && url.pathname === "/api/session") return json(response, 200, { paired: true });
    if (request.method === "POST" && ["/api/assets", "/api/finder"].includes(url.pathname)) {
      const body = await jsonBody(request);
      if (typeof body?.method !== "string") throw fail(400, "请求缺少操作名称");
      return this.withCall("web", response, async signal => {
        const args = body.args ?? {};
        const result = url.pathname === "/api/assets"
          ? await this.assets.invoke(body.method, args, { signal })
          : await (await this.finder()).invokeLocal(body.method, args, { signal });
        json(response, 200, { result });
      });
    }
    if (["GET", "HEAD"].includes(request.method) && url.pathname === "/api/finder/media") {
      const result = await (await this.finder()).readLocalMedia(url.searchParams.get("url"), {
        method: request.method, headers: request.headers.range ? { Range: request.headers.range } : {},
      });
      response.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
      for (const header of ["content-type", "content-length", "content-range", "accept-ranges"]) {
        const value = result.headers.get(header);
        if (value) response.setHeader(header, value);
      }
      response.writeHead(result.status);
      if (result.body && request.method !== "HEAD") await pipeline(Readable.fromWeb(result.body), response);
      else response.end();
      return;
    }
    if (request.method === "GET" && url.pathname.startsWith("/finder/")) {
      return sendStatic(response, (await this.finder()).getWebRoot(),
        decodeURIComponent(url.pathname.slice(8)) || "index.html");
    }
    throw fail(404, "页面不存在");
  }

  async dispose() {
    this.disposed = true;
    await this.transition;
    this.webEnabled = false;
    this.mcpEnabled = false;
    this.tickets.clear();
    this.sessions.clear();
    this.cancelCalls();
    await this.stop();
  }
}
