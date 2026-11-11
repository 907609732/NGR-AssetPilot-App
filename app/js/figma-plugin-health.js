(() => {
  "use strict";

  const byId = (name) => document.getElementById(`figmaPluginHealth${name}`);
  const dialog = byId("Dialog");
  const targets = [
    { id: "arthub-public", name: "ArtHub 公网服务", host: "service.arthub.qq.com" },
    { id: "arthub-internal", name: "ArtHub 内网服务", host: "service.arthub.woa.com" },
    { id: "arthub-local", name: "ArtHub 本机服务", host: "localhost:31700" },
    { id: "figma-rest", name: "Figma API", host: "api.figma.com" },
    { id: "figma-web", name: "Figma 官网", host: "www.figma.com" },
  ];
  const labels = {
    REACHABLE: "已响应",
    REACHABLE_AUTH_REQUIRED: "已响应，需要登录或鉴权",
    REACHABLE_METHOD_NOT_ALLOWED: "已响应，方法受限",
    REACHABLE_RATE_LIMITED: "已响应，已限流",
    REACHABLE_SERVICE_ERROR: "服务异常",
    REACHABLE_REDIRECT: "已响应，发生跳转",
    REACHABLE_CROSS_ORIGIN_REDIRECT: "已响应，发生跳转",
    REACHABLE_SUSPECTED_INTERCEPTION: "已响应，发生跨域跳转",
    REACHABLE_TOO_MANY_REDIRECTS: "已响应，跳转过多",
    REACHABLE_UNEXPECTED_STATUS: "已响应，状态码不符",
    DNS_FAILED: "DNS 解析失败",
    TLS_FAILED: "TLS / 证书失败",
    PROXY_FAILED: "代理连接失败",
    CONNECTION_FAILED: "连接失败",
    NETWORK_FAILED: "网络请求失败",
    ADDRESS_BLOCKED: "地址访问被阻止",
    TIMEOUT: "请求超时",
    CANCELED: "已取消",
  };
  const stages = { proxy: "代理阶段", dns: "DNS 阶段", http: "HTTP / TLS 阶段" };
  let current = null;

  function failed(result) {
    return result.resultCode !== "CANCELED" && (result.reachable === false || result.status >= 500);
  }

  function render(state) {
    const list = byId("Results");
    list.replaceChildren();
    for (const target of targets) {
      const result = state.results.get(target.id);
      const row = document.createElement("li");
      row.dataset.targetId = target.id;
      const copy = document.createElement("div");
      const name = document.createElement("strong");
      name.textContent = target.name;
      const host = document.createElement("small");
      host.textContent = target.host;
      copy.append(name, host);
      const details = document.createElement("div");
      details.className = "figma-plugin-health-result";
      const status = document.createElement("span");
      let tone = "muted";
      if (result && result.resultCode !== "CANCELED") {
        tone = "warning";
        if (result.resultCode === "REACHABLE") tone = "success";
        if (failed(result)) tone = "danger";
      }
      status.className = `diagnostics-result-pill ${tone}`;
      status.textContent = result ? labels[result.resultCode] || "检测未完成" : state.pendingLabel;
      if (result?.status === 404) status.textContent = "已响应，当前路径不存在";
      details.append(status);
      if (result) {
        const metadata = document.createElement("small");
        const parts = [];
        if (result.status != null) parts.push(`HTTP ${result.status}`);
        if (result.totalMs != null) parts.push(`${result.totalMs} ms`);
        if (result.failureStage) parts.push(stages[result.failureStage] || result.failureStage);
        if (result.errorCode) parts.push(result.errorCode);
        metadata.textContent = parts.join(" · ");
        details.append(metadata);
      }
      row.append(copy, details);
      list.append(row);
    }
    byId("Warning").hidden = ![...state.results.values()].some(failed);
    byId("Run").disabled = !state.ready || state.running;
    byId("Run").textContent = state.started ? "重新检测" : "开始检测";
    byId("Cancel").hidden = !state.running;
    byId("Cancel").disabled = state.cancelRequested;
    byId("Progress").textContent = state.message || (state.running ? `检测中 · ${state.results.size} / ${targets.length}` : "等待开始检测");
  }

  async function show() {
    if (dialog.open) return;
    const state = {
      api: window.NgrDesktopBridge?.diagnostics,
      results: new Map(),
      requestId: "",
      unsubscribe: null,
      ready: false,
      running: false,
      started: false,
      cancelRequested: false,
      pendingLabel: "待检测",
      message: "正在准备检测…",
    };
    current = state;
    render(state);
    dialog.showModal();
    try {
      if (!state.api?.isAvailable()) throw new Error("请在 AI资源领航桌面版中使用健康检测");
      const catalog = await state.api.listCatalog();
      if (current !== state) return;
      if (targets.some((target) => !catalog.targets?.some((item) => item.id === target.id))) {
        throw new Error("检测服务未准备好，请重启最新开发版后重试");
      }
      state.unsubscribe = state.api.onProgress((payload) => {
        if (current !== state || !state.running || payload?.requestId !== state.requestId) return;
        if (payload.type === "result" && payload.result && targets.some((target) => target.id === payload.result.targetId)) {
          state.results.set(payload.result.targetId, payload.result);
          render(state);
        }
      });
      state.ready = true;
      state.message = "等待开始检测";
    } catch (error) {
      if (current !== state) return;
      state.message = error?.message || "检测服务准备失败";
    }
    if (current === state) render(state);
  }

  async function run() {
    const state = current;
    if (!state?.ready || state.running) return;
    state.requestId = crypto.randomUUID();
    state.running = true;
    state.started = true;
    state.cancelRequested = false;
    state.results.clear();
    state.pendingLabel = "检测中";
    state.message = "";
    render(state);
    const requestId = state.requestId;
    try {
      const result = await state.api.run({ requestId, targetIds: targets.map((target) => target.id), routeMode: "system" });
      if (current !== state || state.requestId !== requestId) return;
      for (const item of result.results || []) {
        if (targets.some((target) => target.id === item.targetId)) state.results.set(item.targetId, item);
      }
      state.pendingLabel = "未完成";
      state.message = `检测未完成 · ${state.results.size} / ${targets.length}`;
      if (state.results.size === targets.length) state.message = "五项地址均已收到响应";
      if ([...state.results.values()].some(failed)) state.message = `检测完成 · ${state.results.size} / ${targets.length} 项，存在异常`;
      if (result.canceled) {
        state.pendingLabel = "已取消";
        state.message = `检测已取消 · 已完成 ${state.results.size} / ${targets.length}`;
      }
    } catch (error) {
      if (current !== state || state.requestId !== requestId) return;
      state.pendingLabel = "未完成";
      state.message = `检测未完成：${error?.message || "检测服务执行失败，请重试"}`;
    } finally {
      if (current === state && state.requestId === requestId) {
        state.running = false;
        state.requestId = "";
        render(state);
      }
    }
  }

  async function cancel() {
    const state = current;
    if (!state?.running || state.cancelRequested) return;
    const requestId = state.requestId;
    state.cancelRequested = true;
    state.message = "正在取消检测…";
    render(state);
    try {
      await state.api.cancel({ requestId });
    } catch (error) {
      if (current !== state || state.requestId !== requestId) return;
      state.cancelRequested = false;
      state.message = `取消请求失败：${error?.message || "请稍后重试"}`;
      render(state);
    }
  }

  byId("Entry").addEventListener("click", show);
  byId("Run").addEventListener("click", run);
  byId("Cancel").addEventListener("click", cancel);
  byId("Close").addEventListener("click", () => dialog.close());
  dialog.addEventListener("close", () => {
    const state = current;
    current = null;
    state?.unsubscribe?.();
    if (state?.running && state.requestId) state.api.cancel({ requestId: state.requestId }).catch(() => {});
    if (state) state.requestId = "";
    document.getElementById("moreFeaturesEntry").focus({ preventScroll: true });
  });
  dialog.addEventListener("click", (event) => {
    const rect = dialog.getBoundingClientRect();
    if (event.target === dialog && (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom)) dialog.close();
  });
})();
