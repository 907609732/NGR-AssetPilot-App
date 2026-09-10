/* NGR AssetPilot V3.0.11 module: network-diagnostics.js */
(function initializeNetworkDiagnostics(globalScope) {
  "use strict";

  const RESULT_LABELS = Object.freeze({
    REACHABLE: "可达",
    REACHABLE_AUTH_REQUIRED: "可达，需要鉴权",
    REACHABLE_METHOD_NOT_ALLOWED: "可达，方法受限",
    REACHABLE_RATE_LIMITED: "可达，已限流",
    REACHABLE_SERVICE_ERROR: "可达，服务异常",
    REACHABLE_REDIRECT: "可达，发生跳转",
    REACHABLE_CROSS_ORIGIN_REDIRECT: "可达，跨域跳转",
    REACHABLE_TOO_MANY_REDIRECTS: "可达，跳转过多",
    REACHABLE_SUSPECTED_INTERCEPTION: "可达，疑似认证网关",
    REACHABLE_UNEXPECTED_STATUS: "可达，状态码不符",
    DNS_FAILED: "DNS 解析失败",
    TLS_FAILED: "TLS / 证书失败",
    PROXY_FAILED: "代理连接失败",
    CONNECTION_FAILED: "连接失败",
    NETWORK_FAILED: "网络请求失败",
    ADDRESS_BLOCKED: "已阻止危险地址",
    TIMEOUT: "请求超时",
    CANCELED: "已取消",
  });
  const STAGE_LABELS = Object.freeze({ proxy: "代理阶段", dns: "DNS 阶段", http: "HTTP / TLS 阶段" });

  const state = {
    initialized: false,
    targets: [],
    selected: new Set(),
    results: new Map(),
    history: [],
    currentRequestId: "",
    running: false,
    unsubscribe: null,
  };

  const byId = (id) => document.getElementById(id);
  const escapeHtml = (value) => String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

  function toast(message) {
    if (typeof globalScope.showToast === "function") globalScope.showToast(message);
  }

  function api() {
    return globalScope.NgrDesktopBridge?.diagnostics;
  }

  function targetById(targetId) {
    return state.targets.find((target) => target.id === targetId) || null;
  }

  function visibleTargets() {
    const category = byId("diagnosticsCategoryFilter")?.value || "all";
    return category === "all" ? state.targets : state.targets.filter((target) => target.category === category);
  }

  function renderCategories() {
    const select = byId("diagnosticsCategoryFilter");
    if (!select) return;
    const previous = select.value || "all";
    const categories = [...new Set(state.targets.map((target) => target.category))];
    select.innerHTML = '<option value="all">全部服务</option>' + categories
      .map((category) => `<option value="${escapeHtml(category)}">${escapeHtml(category)}</option>`)
      .join("");
    select.value = categories.includes(previous) ? previous : "all";
  }

  function renderTargets() {
    const list = byId("diagnosticsTargetList");
    const empty = byId("diagnosticsTargetsEmpty");
    if (!list) return;
    const targets = visibleTargets();
    list.innerHTML = targets.map((target) => {
      const selected = state.selected.has(target.id);
      return `
        <label class="network-diagnostics-target ${selected ? "selected" : ""}">
          <input type="checkbox" data-diagnostics-target="${escapeHtml(target.id)}" ${selected ? "checked" : ""} />
          <span class="network-diagnostics-target-copy">
            <strong>${escapeHtml(target.name)}</strong>
            <small>${escapeHtml(target.category)} · ${escapeHtml(target.method)} · ${escapeHtml(target.displayUrl)}</small>
          </span>
          ${target.unsafe ? '<em class="diagnostics-risk-label">高级方法</em>' : ""}
        </label>`;
    }).join("");
    empty?.classList.toggle("hidden", targets.length > 0);
    list.querySelectorAll("[data-diagnostics-target]").forEach((checkbox) => {
      checkbox.addEventListener("change", () => {
        if (checkbox.checked) state.selected.add(checkbox.dataset.diagnosticsTarget);
        else state.selected.delete(checkbox.dataset.diagnosticsTarget);
        checkbox.closest(".network-diagnostics-target")?.classList.toggle("selected", checkbox.checked);
      });
    });
  }

  function resultTone(code) {
    if (code === "REACHABLE") return "success";
    if (String(code || "").startsWith("REACHABLE")) return "warning";
    if (code === "CANCELED") return "muted";
    return "danger";
  }

  function renderResults() {
    const body = byId("diagnosticsResultsBody");
    if (!body) return;
    const results = [...state.results.values()];
    if (!results.length) {
      body.innerHTML = '<tr><td colspan="8" class="network-diagnostics-empty">选择服务后运行测试，结果会实时显示在这里。</td></tr>';
      return;
    }
    body.innerHTML = results.map((result) => `
      <tr>
        <td><strong>${escapeHtml(result.targetName)}</strong><small>${escapeHtml(result.category || "")}</small></td>
        <td>${result.route === "direct" ? "直连" : "软件路线"}</td>
        <td><span class="diagnostics-result-pill ${resultTone(result.resultCode)}">${escapeHtml(RESULT_LABELS[result.resultCode] || result.resultCode)}</span>${result.failureStage ? `<small>${escapeHtml(STAGE_LABELS[result.failureStage] || result.failureStage)}</small>` : ""}</td>
        <td>${result.status ?? "-"}</td>
        <td>${result.dnsMs == null ? "-" : `${result.dnsMs} ms`}</td>
        <td>${result.firstByteMs == null ? "-" : `${result.firstByteMs} / ${result.totalMs ?? result.latencyMs} ms`}</td>
        <td>${escapeHtml(result.proxy || "-")}</td>
        <td class="diagnostics-result-actions">
          <button type="button" class="ghost-action" data-diagnostics-rerun="${escapeHtml(result.targetId)}">重测</button>
          <button type="button" class="ghost-action" data-diagnostics-copy="${escapeHtml(result.targetId)}:${escapeHtml(result.route)}">复制</button>
        </td>
      </tr>`).join("");
    body.querySelectorAll("[data-diagnostics-rerun]").forEach((button) => {
      button.addEventListener("click", () => runTargets([button.dataset.diagnosticsRerun]));
    });
    body.querySelectorAll("[data-diagnostics-copy]").forEach((button) => {
      button.addEventListener("click", async () => {
        const [targetId, route] = button.dataset.diagnosticsCopy.split(":");
        const result = state.results.get(`${targetId}:${route}`);
        if (!result) return;
        const summary = `${result.targetName} | ${route === "direct" ? "直连" : "软件路线"} | ${RESULT_LABELS[result.resultCode] || result.resultCode} | HTTP ${result.status ?? "-"} | 首包 ${result.firstByteMs ?? "-"} ms | 总耗时 ${result.totalMs ?? result.latencyMs ?? "-"} ms${result.failureStage ? ` | ${STAGE_LABELS[result.failureStage] || result.failureStage}` : ""}`;
        await navigator.clipboard.writeText(summary);
        toast("诊断摘要已复制");
      });
    });
  }

  function renderCustomTargets() {
    const list = byId("diagnosticsCustomList");
    if (!list) return;
    const custom = state.targets.filter((target) => !target.builtin);
    list.innerHTML = custom.length ? custom.map((target) => `
      <div class="network-diagnostics-custom-item">
        <div><strong>${escapeHtml(target.name)}</strong><small>${escapeHtml(target.method)} · ${escapeHtml(target.displayUrl)}</small></div>
        <div class="action-row compact-actions">
          <button class="ghost-action" type="button" data-diagnostics-edit="${escapeHtml(target.id)}">编辑</button>
          <button class="danger-action" type="button" data-diagnostics-remove="${escapeHtml(target.id)}">删除</button>
        </div>
      </div>`).join("") : '<p class="network-diagnostics-empty">尚未添加自定义 API 或 CDN 资源。</p>';
    list.querySelectorAll("[data-diagnostics-edit]").forEach((button) => button.addEventListener("click", () => editCustomTarget(button.dataset.diagnosticsEdit)));
    list.querySelectorAll("[data-diagnostics-remove]").forEach((button) => button.addEventListener("click", async () => {
      const target = targetById(button.dataset.diagnosticsRemove);
      if (!target || !confirm(`确定删除自定义诊断目标“${target.name}”吗？`)) return;
      try {
        await api().removeCustomTarget({ targetId: target.id });
        state.selected.delete(target.id);
        await refreshData();
        toast("自定义诊断目标已删除");
      } catch (error) {
        toast(`删除失败：${error?.message || "未知错误"}`);
      }
    }));
  }

  function renderHistory() {
    const list = byId("diagnosticsHistoryList");
    if (!list) return;
    list.innerHTML = state.history.length ? state.history.map((run) => {
      const reachable = (run.results || []).filter((result) => result.reachable).length;
      return `<article class="network-diagnostics-history-item">
        <div><strong>${escapeHtml(new Date(run.startedAt).toLocaleString())}</strong><small>${run.routeMode === "compare" ? "软件路线 + 直连" : run.routeMode === "direct" ? "仅直连" : "软件路线"}</small></div>
        <span>${reachable}/${(run.results || []).length} 项收到 HTTP 响应${run.canceled ? " · 已取消" : ""}</span>
      </article>`;
    }).join("") : '<p class="network-diagnostics-empty">尚无诊断历史。</p>';
  }

  function resetCustomForm() {
    byId("diagnosticsCustomForm")?.reset();
    byId("diagnosticsCustomId").value = "";
    byId("diagnosticsCustomCategory").value = "自定义";
    byId("diagnosticsCustomTimeout").value = "10";
    byId("diagnosticsCustomMethod").value = "HEAD";
    syncAdvancedMethodFields();
  }

  function editCustomTarget(targetId) {
    const target = targetById(targetId);
    if (!target || target.builtin) return;
    byId("diagnosticsCustomDetails").open = true;
    byId("diagnosticsCustomId").value = target.id;
    byId("diagnosticsCustomName").value = target.name;
    byId("diagnosticsCustomCategory").value = target.category;
    byId("diagnosticsCustomUrl").value = target.url || target.displayUrl;
    byId("diagnosticsCustomMethod").value = target.method;
    byId("diagnosticsCustomTimeout").value = String((target.timeoutMs || 10000) / 1000);
    byId("diagnosticsCustomExpected").value = (target.expectedStatuses || []).join(", ");
    byId("diagnosticsCustomAllowLan").checked = Boolean(target.allowLan);
    byId("diagnosticsCustomBody").value = target.body || "";
    syncAdvancedMethodFields();
    byId("diagnosticsCustomName").focus();
  }

  function syncAdvancedMethodFields() {
    const method = byId("diagnosticsCustomMethod")?.value || "HEAD";
    const unsafe = !["HEAD", "GET"].includes(method);
    byId("diagnosticsBodyField")?.classList.toggle("hidden", !unsafe);
    byId("diagnosticsUnsafeWarning")?.classList.toggle("hidden", !unsafe);
  }

  async function saveCustomTarget(event) {
    event.preventDefault();
    const allowLan = byId("diagnosticsCustomAllowLan").checked;
    if (allowLan && !confirm("局域网高级模式会允许软件访问你明确登记的内网 HTTPS 地址。仍要保存吗？")) return;
    const expectedStatuses = byId("diagnosticsCustomExpected").value
      .split(/[,，\s]+/)
      .map(Number)
      .filter((value) => Number.isInteger(value));
    const payload = {
      id: byId("diagnosticsCustomId").value || undefined,
      name: byId("diagnosticsCustomName").value,
      category: byId("diagnosticsCustomCategory").value,
      url: byId("diagnosticsCustomUrl").value,
      method: byId("diagnosticsCustomMethod").value,
      timeoutMs: Number(byId("diagnosticsCustomTimeout").value) * 1000,
      expectedStatuses,
      allowLan,
      body: byId("diagnosticsCustomBody").value,
    };
    try {
      const saved = await api().upsertCustomTarget(payload);
      state.selected.add(saved.id);
      resetCustomForm();
      await refreshData();
      toast("自定义诊断目标已保存");
    } catch (error) {
      toast(`保存失败：${error?.message || "请检查 URL 和参数"}`);
    }
  }

  function updateRunningUi() {
    byId("diagnosticsRunSelected").disabled = state.running;
    byId("diagnosticsSelectVisible").disabled = state.running;
    byId("diagnosticsCancelRun").classList.toggle("hidden", !state.running);
  }

  async function runTargets(targetIds) {
    if (state.running) return;
    const ids = [...new Set((targetIds?.length ? targetIds : [...state.selected]).filter((id) => targetById(id)))];
    if (!ids.length) {
      toast("请先选择至少一个诊断服务");
      return;
    }
    const unsafeTargets = ids.map(targetById).filter((target) => target?.unsafe);
    if (unsafeTargets.length && !confirm(`以下目标使用可能改变数据的 HTTP 方法：${unsafeTargets.map((target) => target.name).join("、")}。仅本次确认执行吗？`)) return;
    state.running = true;
    state.currentRequestId = globalScope.crypto?.randomUUID?.() || `diag_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
    state.results.clear();
    renderResults();
    updateRunningUi();
    byId("diagnosticsProgressBadge").textContent = "正在准备测试";
    try {
      const run = await api().run({
        requestId: state.currentRequestId,
        targetIds: ids,
        routeMode: byId("diagnosticsRouteMode").value,
        confirmedUnsafeTargetIds: unsafeTargets.map((target) => target.id),
      });
      for (const result of run.results || []) state.results.set(`${result.targetId}:${result.route}`, result);
      state.history = await api().listHistory({ limit: 30 });
      renderResults();
      renderHistory();
      byId("diagnosticsProgressBadge").textContent = run.canceled ? "测试已取消" : `测试完成 · ${run.results.length} 项`;
      toast(run.canceled ? "网络诊断已取消" : "网络诊断完成");
    } catch (error) {
      byId("diagnosticsProgressBadge").textContent = "测试失败";
      toast(`网络诊断失败：${error?.message || "未知错误"}`);
    } finally {
      state.running = false;
      state.currentRequestId = "";
      updateRunningUi();
    }
  }

  function onProgress(payload) {
    if (!payload || payload.requestId !== state.currentRequestId) return;
    if (payload.type === "start") {
      byId("diagnosticsProgressBadge").textContent = `测试中 · 0/${payload.total}`;
    } else if (payload.type === "result" && payload.result) {
      state.results.set(`${payload.result.targetId}:${payload.result.route}`, payload.result);
      renderResults();
      byId("diagnosticsProgressBadge").textContent = `测试中 · ${payload.completed}/${payload.total}`;
    }
  }

  async function refreshData() {
    const [catalog, customTargets, history] = await Promise.all([
      api().listCatalog(),
      api().listCustomTargets(),
      api().listHistory({ limit: 30 }),
    ]);
    state.targets = [...(catalog.targets || []), ...(customTargets || [])];
    state.history = history || [];
    if (!state.selected.size) catalog.targets?.forEach((target) => state.selected.add(target.id));
    const valid = new Set(state.targets.map((target) => target.id));
    state.selected = new Set([...state.selected].filter((id) => valid.has(id)));
    byId("diagnosticsOnlineBadge").textContent = catalog.online ? "系统网络在线" : "系统网络离线";
    byId("diagnosticsOnlineBadge").classList.toggle("offline", !catalog.online);
    byId("diagnosticsProxyBadge").textContent = `当前代理：${catalog.proxy || "UNKNOWN"}`;
    renderCategories();
    renderTargets();
    renderCustomTargets();
    renderHistory();
  }

  function bindEvents() {
    byId("diagnosticsCategoryFilter")?.addEventListener("change", renderTargets);
    byId("diagnosticsSelectVisible")?.addEventListener("click", () => {
      const targets = visibleTargets();
      const allSelected = targets.length && targets.every((target) => state.selected.has(target.id));
      targets.forEach((target) => allSelected ? state.selected.delete(target.id) : state.selected.add(target.id));
      renderTargets();
    });
    byId("diagnosticsRunSelected")?.addEventListener("click", () => runTargets());
    byId("diagnosticsCancelRun")?.addEventListener("click", async () => {
      if (!state.currentRequestId) return;
      await api().cancel({ requestId: state.currentRequestId });
      byId("diagnosticsProgressBadge").textContent = "正在取消";
    });
    byId("diagnosticsCustomMethod")?.addEventListener("change", syncAdvancedMethodFields);
    byId("diagnosticsCustomForm")?.addEventListener("submit", saveCustomTarget);
    byId("diagnosticsResetCustom")?.addEventListener("click", resetCustomForm);
    byId("diagnosticsExportMarkdown")?.addEventListener("click", async () => {
      const result = await api().exportHistory({ format: "markdown" });
      if (!result.canceled) toast(`已导出 ${result.runCount} 次诊断记录`);
    });
    byId("diagnosticsExportJson")?.addEventListener("click", async () => {
      const result = await api().exportHistory({ format: "json" });
      if (!result.canceled) toast(`已导出 ${result.runCount} 次诊断记录`);
    });
    byId("diagnosticsClearHistory")?.addEventListener("click", async () => {
      if (!state.history.length || !confirm("确定清空本机保存的网络诊断历史吗？")) return;
      await api().clearHistory();
      state.history = [];
      renderHistory();
      toast("诊断历史已清空");
    });
  }

  async function init() {
    if (state.initialized) return;
    state.initialized = true;
    const panel = byId("networkDiagnosticsPanel");
    if (!panel) return;
    if (!api()?.isAvailable?.()) {
      panel.innerHTML = '<div class="network-diagnostics-empty">网络与 API 诊断仅支持 NGR AssetPilot 桌面版。</div>';
      return;
    }
    bindEvents();
    state.unsubscribe = api().onProgress(onProgress);
    try {
      await refreshData();
    } catch (error) {
      byId("diagnosticsProgressBadge").textContent = "初始化失败";
      toast(`网络诊断初始化失败：${error?.message || "未知错误"}`);
    }
  }

  globalScope.NgrNetworkDiagnostics = Object.freeze({ init });
})(window);
