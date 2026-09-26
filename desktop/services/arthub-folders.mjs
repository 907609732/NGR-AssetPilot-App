import { randomUUID } from "node:crypto";
import { DesktopError } from "../shared/core.mjs";

const HOSTS = Object.freeze({ qq: "service.arthub.qq.com", woa: "service.arthub.woa.com", tencent: "service.arthub.tencent.com" });
const fail = (code, message) => { throw new DesktopError(code, message); };
const items = (value) => Array.isArray(value) ? value : Array.isArray(value?.items) ? value.items : [value];
const isFolder = (node) => ["directory", "project"].includes(node?.type);
const validId = (id) => Number.isSafeInteger(id) && id > 0;
const BLOCKED = "已找到文件夹，但当前 ArtHub 客户端的精确定位协议尚未验证，暂不能自动打开；不会跳转浏览器。";

export class ArtHubFolders {
  constructor({ store, fetchImpl = fetch }) {
    this.store = store;
    this.fetch = fetchImpl;
    this.results = new Map();
    this.busy = false;
    this.generation = 0;
  }
  async status() {
    const config = (await this.store.get()).connection;
    return { configured: Boolean(config?.token), environment: config?.environment || "qq", assetHub: config?.assetHub || "", rootPath: config?.rootPath || "", clientReady: false, clientReason: BLOCKED };
  }
  async request(config, method, payload, signal) {
    let response;
    try {
      response = await this.fetch(`https://${HOSTS[config.environment]}/${encodeURIComponent(config.assetHub)}/data/openapi/v2/core/${method}`, {
        method: "POST", redirect: "error", signal,
        headers: { "content-type": "application/json", publictoken: config.token, "Arthub-Client-Type": "sdk" },
        body: JSON.stringify(payload ?? null),
      });
    } catch { fail("ARTHUB_NETWORK", "ArtHub 查询超时或网络不可用，请检查服务环境和网络连接"); }
    if ([401, 403].includes(response.status)) fail("ARTHUB_AUTH", "ArtHub 授权失效或没有资源库访问权限，请检查连接设置");
    if (!response.ok) fail("ARTHUB_HTTP", `ArtHub 服务暂不可用（HTTP ${response.status}）`);
    let body;
    try { body = await response.json(); } catch { fail("ARTHUB_RESPONSE", "ArtHub 返回了无法识别的数据"); }
    if (body.code === -1) fail("ARTHUB_AUTH", "ArtHub 授权失效，请更新查询 Token");
    if (body.code !== 0) fail("ARTHUB_QUERY", "ArtHub 查询失败或部分目录无权限，未返回不完整的匹配结果");
    return items(body.result);
  }
  async root(config, signal) {
    const [id] = await this.request(config, "get-depot-id", null, signal);
    if (!validId(id)) fail("ARTHUB_RESPONSE", "ArtHub 资源库根节点无效");
    if (!config.rootPath) return id;
    const nodes = await this.request(config, "get-node-brief-by-path", { root_id: id, path: [config.rootPath], meta: ["id", "name", "type", "full_path_name"] }, signal);
    const node = nodes[0];
    if (!isFolder(node) || !validId(node.id)) fail("ARTHUB_ROOT", "搜索根目录不存在或不是文件夹");
    return node.id;
  }
  async configure(payload) {
    if (this.busy) fail("ARTHUB_BUSY", "正在查询，请稍后修改连接设置");
    const old = (await this.store.get()).connection;
    const config = {
      environment: String(payload?.environment || ""), assetHub: String(payload?.assetHub || "").trim(),
      rootPath: String(payload?.rootPath || "").trim().replaceAll("\\", "/").replace(/^\/+|\/+$/g, ""),
      token: String(payload?.token || "").trim() || old?.token || "",
    };
    if (!HOSTS[config.environment] || !/^[a-zA-Z0-9_-]{1,100}$/.test(config.assetHub)) fail("ARTHUB_CONFIG", "请选择服务环境并填写有效的资源库名称");
    if (!config.token || config.token.length > 8192 || /[\r\n]/.test(config.token)) fail("ARTHUB_CONFIG", "请输入有效的查询授权 Token");
    if (config.rootPath.length > 2048 || config.rootPath.split("/").includes("..")) fail("ARTHUB_CONFIG", "搜索根目录格式无效");
    this.busy = true;
    try {
      await this.root(config, AbortSignal.timeout(30_000));
      await this.store.set({ connection: config });
      this.results.clear();
      this.generation++;
      return this.status();
    } finally { this.busy = false; }
  }
  async search(payload) {
    if (this.busy) fail("ARTHUB_BUSY", "正在查询，请勿重复点击");
    const name = String(payload?.projectName || "").trim();
    if (!name || name.length > 200) fail("ARTHUB_NAME", "请填写有效的当前界面工程名");
    const config = (await this.store.get()).connection;
    if (!config?.token) fail("ARTHUB_NOT_CONFIGURED", "请先连接 ArtHub");
    this.busy = true;
    this.results.clear();
    const signal = AbortSignal.timeout(120_000);
    try {
      const root = await this.root(config, signal);
      const filter = [{ meta: "type", condition: "x != asset" }];
      const [counts] = await this.request(config, "get-child-node-count", { ids: [root], filter, is_recursive: true }, signal);
      const count = counts?.count;
      if (!Number.isSafeInteger(count) || count < 0) fail("ARTHUB_RESPONSE", "ArtHub 目录数量无效");
      const matches = [], seen = new Set();
      for (let offset = 0; offset < count; offset += 500) {
        const [range] = await this.request(config, "get-child-node-id-in-range", { parent_id: root, offset, count: Math.min(500, count - offset), filter, is_recursive: true, order: { meta: "id", type: "ascend" } }, signal);
        const ids = range?.nodes;
        if (!Array.isArray(ids) || ids.length !== Math.min(500, count - offset) || ids.some((id) => !validId(id) || seen.has(id))) fail("ARTHUB_CHANGED", "目录在查询期间发生变化，请重试");
        ids.forEach((id) => seen.add(id));
        const nodes = await this.request(config, "get-node-brief-by-id", { ids, meta: ["id", "name", "type", "full_path_name"] }, signal);
        if (nodes.length !== ids.length) fail("ARTHUB_RESPONSE", "ArtHub 返回了不完整的目录信息，请重试");
        for (const node of nodes) {
          if (!isFolder(node) || typeof node.name !== "string" || node.name.toLowerCase() !== name.toLowerCase()) continue;
          if (!validId(node.id) || !ids.includes(node.id) || !Array.isArray(node.full_path_name)) fail("ARTHUB_RESPONSE", "ArtHub 文件夹路径信息不完整");
          matches.push({ resultId: randomUUID(), name: node.name, path: node.full_path_name.join("/"), assetHub: config.assetHub, nodeId: node.id });
        }
      }
      const exact = matches.filter((entry) => entry.name === name);
      const selected = exact.length ? exact : matches;
      for (const entry of selected) this.results.set(entry.resultId, { ...entry, generation: this.generation });
      return { projectName: name, matches: selected, clientReady: false, clientReason: BLOCKED };
    } finally { this.busy = false; }
  }
  async open(payload) {
    const entry = this.results.get(payload?.resultId);
    if (!entry || entry.generation !== this.generation) fail("ARTHUB_RESULT_EXPIRED", "查询结果已失效，请重新查找");
    // No protocol URL is synthesized until its exact format and real client navigation are verified.
    fail("ARTHUB_CLIENT_UNVERIFIED", BLOCKED);
  }
}
