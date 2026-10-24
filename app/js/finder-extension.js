(() => {
  const el = (id) => document.getElementById(`finderExtension${id}`);
  const dialog = el("Dialog"), entry = el("Entry"), api = window.ngrDesktop?.finderExtension;
  const labels = { selecting: "等待选择扩展包", reading: "正在读取扩展包", manifest: "正在检查扩展清单", extracting: "正在解压并校验文件", verifying: "正在校验已安装扩展", publishing: "正在完成安装", activating: "正在完成安装", loading: "正在加载工作台", complete: "处理完成", error: "处理未完成", cancelled: "已取消选择" };
  let actionBusy = false, checking = false, state, fallback, fallbackRevision, pollTimer, pollInFlight = false, destroyed = false, refreshError = "", previousStep = 0, previousOperation;
  const terminal = (p) => ["complete", "error", "cancelled"].includes(p?.state || p?.phase);
  const active = (p) => Boolean(p && (p.active === true || p.state === "running" || (!terminal(p) && p.phase)));
  const timestamp = (value) => typeof value === "number" ? value : Date.parse(value || "");
  const visibleProgress = () => {
    const p = state?.progress;
    const updated = timestamp(p?.updatedAt);
    const oldRevision = Number.isFinite(fallbackRevision) && Number.isFinite(p?.revision) && p.revision <= fallbackRevision;
    if (fallback && (!p || (!active(p) && (oldRevision || !Number.isFinite(updated) || updated <= timestamp(fallback.startedAt))))) return fallback;
    return p || fallback;
  };
  const busy = () => actionBusy || active(visibleProgress());
  function syncButtons() {
    const locked = busy() || checking;
    el("Choose").disabled = locked; el("Detect").disabled = locked; el("Launch").disabled = locked || !state?.bound;
    // Keep these available to reopen the modal without starting a second operation.
    entry.disabled = false; el("Manage").disabled = false; el("Close").disabled = false;
    el("Download").hidden = true; el("Download").disabled = true;
    el("Choose").textContent = visibleProgress()?.state === "error" ? "重新导入扩展 ZIP" : state?.bound ? "导入新版扩展 ZIP" : "导入扩展 ZIP";
  }
  function renderProgress(p) {
    const panel = el("Progress"); panel.hidden = !p;
    if (!p) return;
    const running = active(p), resultState = running ? "running" : p.state || p.phase;
    panel.dataset.state = resultState; panel.dataset.phase = p.phase || "";
    const isOpen = p.operation === "open";
    const steps = isOpen ? ["校验已有扩展", "加载工作台", "准备完成"] : ["读取扩展包", "检查清单", "解压并校验", "完成安装"];
    const position = isOpen ? { verifying: 0, reading: 0, manifest: 0, loading: 1, complete: 2 } : { selecting: 0, reading: 0, manifest: 1, extracting: 2, verifying: 2, publishing: 3, activating: 3, loading: 3, complete: 3 };
    if (p.operation !== previousOperation) { previousStep = 0; previousOperation = p.operation; }
    const step = position[p.phase] ?? previousStep; previousStep = step;
    el("ProgressSteps").replaceChildren();
    steps.forEach((title, index) => {
      const item = document.createElement("li"); item.textContent = title; item.dataset.number = String(index + 1);
      item.classList.toggle("is-done", resultState === "complete" || index < step);
      item.classList.toggle("is-current", index === step && resultState !== "complete");
      if (index === step && running) item.setAttribute("aria-current", "step");
      el("ProgressSteps").append(item);
    });
    const counts = [], valid = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0;
    if (valid(p.total) && valid(p.done)) counts.push(`${Math.min(p.done, p.total).toLocaleString("zh-CN")} / ${p.total.toLocaleString("zh-CN")} 个文件`);
    if (valid(p.bytesTotal) && valid(p.bytesDone)) counts.push(`${(Math.min(p.bytesDone, p.bytesTotal) / 1000000).toFixed(1)} / ${(p.bytesTotal / 1000000).toFixed(1)} MB`);
    const stage = p.stage || labels[p.phase] || "正在处理扩展";
    el("ProgressStage").textContent = stage;
    el("ProgressCounts").textContent = counts.join(" · ") || (running ? "正在准备任务…" : "");
    let percent = null;
    if (resultState === "complete") percent = 100;
    else if (!p.indeterminate) {
      if (valid(p.percent)) percent = Math.max(0, Math.min(100, p.percent));
      else if (p.bytesTotal > 0 && valid(p.bytesDone)) percent = Math.min(100, p.bytesDone / p.bytesTotal * 100);
      else if (p.total > 0 && valid(p.done)) percent = Math.min(100, p.done / p.total * 100);
    }
    const bar = el("ProgressBar");
    bar.hidden = percent === null && !running;
    if (percent === null) { bar.removeAttribute("value"); bar.removeAttribute("aria-valuenow"); }
    else { bar.value = percent; bar.setAttribute("aria-valuenow", String(Math.round(percent))); }
    bar.setAttribute("aria-valuetext", `${stage}${percent === null ? "，进度暂无法确定" : `，当前阶段 ${Math.round(percent)}%`}${counts.length ? "，" + counts.join("，") : ""}`);
    el("ProgressPercent").textContent = resultState === "complete" ? "已完成" : resultState === "error" ? "需重试" : resultState === "cancelled" ? "未开始安装" : percent === null ? "处理中" : `当前阶段 ${Math.round(percent)}%`;
    el("ProgressFile").textContent = p.currentFile || ""; el("ProgressFile").title = p.currentFile || "";
    const started = timestamp(p.startedAt), ended = running ? Date.now() : timestamp(p.updatedAt);
    const seconds = Number.isFinite(started) ? Math.max(0, Math.floor(((Number.isFinite(ended) ? ended : Date.now()) - started) / 1000)) : 0;
    el("ProgressElapsed").textContent = seconds < 60 ? `用时 ${seconds} 秒` : `用时 ${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
    el("ProgressHint").textContent = resultState === "error" ? (p.error || "操作未完成，可重新导入扩展 ZIP。") : resultState === "complete" ? (isOpen ? "工作台已准备好。" : "扩展安装完成，可以打开工作台。") : resultState === "cancelled" ? "未修改现有扩展。" : refreshError || (seconds >= 10 ? "仍在处理，大文件解压和校验需要一些时间。关闭此窗口不会取消导入。" : "正在处理，可关闭此窗口，稍后从扩展入口回来查看。关闭不会取消导入。");
  }
  function render(next) {
    if (next) {
      const oldRevision = state?.progress?.revision, revision = next.progress?.revision;
      if (!(Number.isFinite(oldRevision) && Number.isFinite(revision) && revision < oldRevision)) state = next;
    }
    const p = visibleProgress();
    el("Status").textContent = active(p) ? "扩展正在后台处理，进度会自动更新。" : p?.state === "error" ? (p.error || state?.message || "扩展处理未完成") : [state?.message, state?.discoveryWarning].filter(Boolean).join("；");
    el("Version").textContent = state?.bound?.version || "—"; el("Path").textContent = state?.bound?.root || "—";
    el("Candidates").replaceChildren(); renderProgress(p); syncButtons();
  }
  function show() {
    document.getElementById("moreFeaturesPopover").hidePopover();
    if (!dialog.open) dialog.showModal();
  }
  function schedulePoll() {
    if (destroyed || pollTimer || !busy()) return;
    pollTimer = setTimeout(poll, 400);
  }
  async function poll() {
    pollTimer = null;
    if (destroyed || pollInFlight || !busy()) return;
    pollInFlight = true;
    try { const next = await api.status(); refreshError = ""; render(next); }
    catch { refreshError = "暂时无法刷新进度，请稍候。"; render(); }
    finally { pollInFlight = false; schedulePoll(); }
  }
  async function refresh() {
    if (checking) return;
    checking = true; syncButtons();
    try { if (!api) throw new Error("请在 AI资源领航桌面版中使用扩展工作台"); render(await api.status()); schedulePoll(); }
    catch (error) { el("Status").textContent = error?.message || String(error); }
    finally { checking = false; syncButtons(); }
  }
  async function run(operation, action) {
    if (busy()) { show(); render(); schedulePoll(); return; }
    actionBusy = true; refreshError = ""; previousStep = 0; previousOperation = operation;
    fallbackRevision = state?.progress?.revision;
    fallback = { operation, phase: operation === "install" ? "selecting" : "verifying", stage: operation === "install" ? "等待选择扩展包" : "正在准备工作台", state: "running", active: true, indeterminate: true, startedAt: Date.now(), updatedAt: Date.now() };
    show(); render(); schedulePoll();
    try {
      if (!api) throw new Error("请在 AI资源领航桌面版中使用扩展工作台");
      const next = await action();
      if (next.progress) fallback = null;
      else fallback = next.installed || next.launched ? { ...fallback, phase: "complete", stage: next.launched ? "工作台已准备好" : "扩展安装完成", state: "complete", active: false, updatedAt: Date.now() } : operation === "install" ? { ...fallback, phase: "cancelled", stage: "已取消选择", state: "cancelled", active: false, updatedAt: Date.now() } : null;
      render(next); return next;
    } catch (error) {
      try { const next = await api?.status(); if (next) render(next); } catch {}
      if (!active(state?.progress) && visibleProgress()?.state !== "error") fallback = { ...fallback, operation, phase: "error", stage: "处理未完成", state: "error", active: false, error: error?.message || String(error), updatedAt: Date.now() };
      show(); render();
    } finally { actionBusy = false; render(); schedulePoll(); }
  }
  async function open() {
    if (busy()) { show(); render(); schedulePoll(); return; }
    const next = await run("open", () => api.open());
    if (next?.launched && dialog.open) dialog.close();
  }
  entry.addEventListener("click", open);
  el("Manage").addEventListener("click", () => { show(); render(); if (busy()) schedulePoll(); else void refresh(); });
  el("Close").addEventListener("click", () => dialog.close());
  dialog.addEventListener("close", () => document.getElementById("moreFeaturesEntry").focus({ preventScroll: true }));
  el("Launch").addEventListener("click", open);
  el("Detect").addEventListener("click", () => { void refresh(); });
  el("Choose").addEventListener("click", () => { void run("install", () => api.choose()); });
  window.addEventListener("beforeunload", () => { destroyed = true; clearTimeout(pollTimer); });
})();
