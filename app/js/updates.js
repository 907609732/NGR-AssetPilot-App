/* NGR AssetPilot updater UI */
(function initializeUpdateUiModule(globalScope) {
  "use strict";

  const WEBSITE_URL = "https://ngr.lttlt.top/";
  const HISTORY_URL = "https://github.com/907609732/NGR-AssetPilot-App/releases";
  const FEEDBACK_FORM_URL = "https://doc.weixin.qq.com/forms/ACwAeQeSAD0AawAWwZXAN0CNcmlvfsE1f?page=1";
  const UPDATE_INTERVAL_MS = 6 * 60 * 60 * 1000;
  let updateState = null;
  let desktopInfo = { isDesktop: false, version: APP_VERSION.replace(/^V/i, ""), isPortable: false };
  let updateTimer = null;
  let updateListenerCleanup = () => {};
  let controlsBound = false;
  let historyData = null, historyLoading = false, historyError = "";
  let historyObserver = null;

  function renderHistory() {
    document.querySelectorAll("[data-release-history]").forEach((host) => {
      // Preserve expanded entries and scroll position while a cached list refreshes.
      let heading = host.querySelector(".release-history-heading");
      if (!heading) {
        heading = document.createElement("div"); heading.className = "release-history-heading";
        const title = document.createElement("strong"); title.textContent = "所有历史版本";
        const retry = document.createElement("button"); retry.type = "button"; retry.className = "ghost-action"; retry.textContent = "刷新";
        retry.addEventListener("click", () => void loadHistory());
        heading.append(title, retry);
        const status = document.createElement("p"); status.className = "release-history-status"; status.setAttribute("role", "status");
        const list = document.createElement("div"); list.className = "release-history-list";
        host.append(heading, status, list);
      }
      heading.querySelector("button").disabled = historyLoading;
      host.querySelector(".release-history-status").textContent = historyLoading ? "正在加载全部历史版本…" : historyError || (historyData ? `${historyData.releases.length} 个已发布版本${historyData.stale ? ` · 暂无法联网刷新，显示 ${formatReleaseDate(historyData.fetchedAt)} 的记录` : " · 按发布时间倒序"}` : "打开设置或更新窗口时加载");
      if (!historyData || host.dataset.fetchedAt === historyData.fetchedAt) return;
      const list = host.querySelector(".release-history-list");
      const expanded = new Set([...list.querySelectorAll("details[open]")].map((entry) => entry.dataset.version));
      const scroll = list.scrollTop;
      list.replaceChildren();
      for (const release of historyData.releases) {
        const entry = document.createElement("details"); entry.dataset.version = release.version;
        entry.open = expanded.has(release.version);
        const summary = document.createElement("summary");
        const name = document.createElement("strong"); name.textContent = release.name || versionLabel(release.version);
        const meta = document.createElement("span");
        const current = String(release.version).replace(/^v/i, "") === String(updateState?.currentVersion || desktopInfo.version).replace(/^v/i, "");
        meta.textContent = `${versionLabel(release.version)} · ${formatReleaseDate(release.date)}${release.prerelease ? " · 预发布" : ""}${current ? " · 当前版本" : ""}`;
        const notes = document.createElement("pre"); notes.textContent = release.notes || "暂无更新说明";
        summary.append(name, meta); entry.append(summary, notes); list.append(entry);
      }
      if (!historyData.releases.length) list.textContent = "暂无已发布版本";
      list.scrollTop = scroll;
      host.dataset.fetchedAt = historyData.fetchedAt;
    });
  }

  async function loadHistory() {
    if (historyLoading) return;
    historyLoading = true; historyError = ""; renderHistory();
    try { historyData = await NgrDesktopBridge.getReleaseHistory(); }
    catch { historyError = "历史版本加载失败，请检查网络后点击刷新。"; }
    finally { historyLoading = false; renderHistory(); }
  }

  function formatBytes(bytes) {
    const value = Number(bytes);
    if (!Number.isFinite(value) || value <= 0) return "未知";
    if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
    return `${(value / (1024 * 1024)).toFixed(1)} MB`;
  }

  function formatReleaseDate(value) {
    if (!value) return "未知";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "未知";
    return new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
  }

  function versionLabel(value) {
    const clean = String(value || "").replace(/^v/i, "");
    return clean ? `V${clean}` : "—";
  }

  function formatRate(bytesPerSecond) {
    const value = Number(bytesPerSecond);
    return Number.isFinite(value) && value > 0 ? `${formatBytes(value)}/秒` : "正在测速…";
  }

  function getProgressViewModel(state = {}) {
    const phase = String(state.phase || "");
    const downloading = phase === "downloading";
    const downloaded = phase === "downloaded";
    const installing = phase === "installing";
    const visible = downloading || downloaded || installing;
    const rawPercent = Number(state.progress?.percent || 0);
    const percent = downloaded || installing ? 100 : Math.max(0, Math.min(100, rawPercent));
    const transferred = Number(state.progress?.transferred || 0);
    const total = Number(state.progress?.total || state.downloadSize || 0);
    if (installing) {
      return {
        visible,
        active: true,
        indeterminate: true,
        percent,
        percentLabel: "安装中",
        title: "正在自动安装更新",
        text: "安装包已验证，正在保存工作区",
        detail: "软件即将自动关闭，安装完成后会重新打开",
        speed: "请勿关闭软件",
        stages: { download: "complete", verify: "complete", install: "active" },
      };
    }
    if (downloaded) {
      return {
        visible,
        active: true,
        indeterminate: true,
        percent,
        percentLabel: "100%",
        title: "更新包准备完毕，正在自动安装",
        text: "下载与完整性检查已经完成",
        detail: "无需再次确认，软件即将自动关闭并完成安装",
        speed: "安全校验通过",
        stages: { download: "complete", verify: "complete", install: "active" },
      };
    }
    return {
      visible,
      active: downloading,
      indeterminate: false,
      percent,
      percentLabel: `${Math.round(percent)}%`,
      title: "正在安全下载更新",
      text: `新版本 ${versionLabel(state.availableVersion)} 正在传输`,
      detail: `${transferred > 0 ? formatBytes(transferred) : "0 B"} / ${formatBytes(total)}`,
      speed: formatRate(state.progress?.bytesPerSecond),
      stages: { download: "active", verify: "waiting", install: "waiting" },
    };
  }

  function isUpdateKnown() {
    return Boolean(updateState?.availableVersion && ["available", "downloading", "downloaded", "installing", "error"].includes(updateState.phase));
  }

  function syncUpdateButtonVisibility() {
    if (!els?.updateAvailableButton) return;
    const visible = currentViewName === "home" && isUpdateKnown();
    els.updateAvailableButton.classList.toggle("hidden", !visible);
    if (!visible) return;
    const labels = {
      available: `发现新版本 ${versionLabel(updateState.availableVersion)}`,
      downloading: `正在下载 ${Math.round(updateState.progress?.percent || 0)}%`,
      downloaded: `新版本 ${versionLabel(updateState.availableVersion)} 已就绪`,
      installing: "正在安装新版本",
      error: `新版 ${versionLabel(updateState.availableVersion)} 下载失败`,
    };
    els.updateAvailableButton.textContent = labels[updateState.phase] || "发现新版本";
  }

  function renderUpdateState() {
    if (!updateState) return;
    const currentVersion = updateState.currentVersion || desktopInfo.version;
    document.querySelectorAll("[data-app-version]").forEach((node) => {
      node.textContent = versionLabel(currentVersion);
    });
    if (els.manualUpdateStatus) {
      const status = {
        disabled: desktopInfo.isDesktop ? "当前运行方式不支持应用内更新，可前往官网下载。" : "网页版不支持应用内更新。",
        idle: "当前使用标准更新通道。",
        checking: "正在检查新版本…",
        "not-available": "当前已经是最新版本。",
        available: `发现新版本 ${versionLabel(updateState.availableVersion)}。`,
        downloading: `正在下载新版本：${Math.round(updateState.progress?.percent || 0)}%。`,
        downloaded: "新版本已下载，正在自动安装…",
        installing: "正在保存工作区并自动安装…",
        error: "更新操作失败，可重试或前往官网下载。",
      };
      els.manualUpdateStatus.textContent = status[updateState.phase] || "更新状态未知。";
    }
    if (els.manualUpdateCheck) {
      els.manualUpdateCheck.disabled = updateState.phase === "checking" || updateState.phase === "downloading";
      els.manualUpdateCheck.textContent = updateState.phase === "checking" ? "检查中…" : "检查更新";
    }
    if (els.updateCurrentVersion) els.updateCurrentVersion.textContent = versionLabel(currentVersion);
    if (els.updateLatestVersion) els.updateLatestVersion.textContent = versionLabel(updateState.availableVersion);
    if (els.updateDownloadSize) els.updateDownloadSize.textContent = formatBytes(updateState.downloadSize);
    if (els.updateReleaseDate) els.updateReleaseDate.textContent = formatReleaseDate(updateState.releaseDate);
    if (els.updateReleaseNotes) els.updateReleaseNotes.textContent = updateState.releaseNotes || "暂无更新说明";
    const progressView = getProgressViewModel(updateState);
    els.updateProgressWrap?.classList.toggle("hidden", !progressView.visible);
    els.updateProgressWrap?.classList.toggle("is-active", progressView.active);
    els.updateProgressWrap?.classList.toggle("is-indeterminate", progressView.indeterminate);
    if (els.updateProgressTitle) els.updateProgressTitle.textContent = progressView.title;
    if (els.updateProgressText) els.updateProgressText.textContent = progressView.text;
    if (els.updateProgressPercent) els.updateProgressPercent.textContent = progressView.percentLabel;
    if (els.updateProgressBar) els.updateProgressBar.style.setProperty("--update-progress", `${progressView.percent}%`);
    if (els.updateProgressTrack) {
      els.updateProgressTrack.setAttribute("aria-valuenow", String(Math.round(progressView.percent)));
      els.updateProgressTrack.setAttribute("aria-valuetext", progressView.text);
    }
    if (els.updateProgressDetail) els.updateProgressDetail.textContent = progressView.detail;
    if (els.updateProgressSpeed) els.updateProgressSpeed.textContent = progressView.speed;
    els.updateStageList?.querySelectorAll("[data-update-stage]").forEach((node) => {
      node.dataset.state = progressView.stages[node.dataset.updateStage] || "waiting";
    });
    const busy = ["downloading", "downloaded", "installing"].includes(updateState.phase);
    els.updateDialogOverlay?.querySelector(".update-dialog")?.setAttribute("data-update-busy", String(busy));
    if (els.updateDialogClose) els.updateDialogClose.disabled = busy;
    if (els.updatePrimaryAction) {
      const portable = Boolean(desktopInfo.isPortable);
      const actions = {
        available: portable ? "前往官网下载" : "下载更新",
        downloading: "正在下载…",
        downloaded: "正在自动安装…",
        installing: "正在自动安装…",
        error: portable ? "前往官网下载" : "重新下载",
      };
      els.updatePrimaryAction.textContent = actions[updateState.phase] || "检查更新";
      els.updatePrimaryAction.disabled = ["downloading", "downloaded", "installing"].includes(updateState.phase);
    }
    syncUpdateButtonVisibility();
  }

  function openUpdateDialog() {
    if (!isUpdateKnown()) return;
    renderUpdateState();
    els.updateDialogOverlay?.classList.remove("hidden");
    els.updateDialogOverlay?.setAttribute("aria-hidden", "false");
    void loadHistory();
  }

  function closeUpdateDialog() {
    if (["downloading", "downloaded", "installing"].includes(updateState?.phase)) return;
    els.updateDialogOverlay?.classList.add("hidden");
    els.updateDialogOverlay?.setAttribute("aria-hidden", "true");
  }

  async function openTrustedExternal(url) {
    await NgrDesktopBridge.openExternal(url);
  }

  async function checkForUpdates({ manual = false } = {}) {
    if (!NgrDesktopBridge.isDesktopRuntime()) {
      if (manual) showToast("网页版不支持应用内更新，请前往官网下载");
      return null;
    }
    if (!updateState?.enabled) {
      if (manual) showToast("当前版本不支持应用内更新，请前往官网下载");
      return updateState;
    }
    try {
      updateState = await NgrDesktopBridge.checkForUpdates();
      renderUpdateState();
      if (manual && updateState?.phase === "not-available") showToast("当前已经是最新版本");
      if (manual && updateState?.phase === "available") openUpdateDialog();
      return updateState;
    } catch {
      updateState = { ...(updateState || {}), phase: "error" };
      renderUpdateState();
      if (manual) showToast("检查更新失败，请稍后重试");
      return updateState;
    }
  }

  async function performPrimaryUpdateAction() {
    if (!updateState) return;
    if (desktopInfo.isPortable || !updateState.enabled) return openTrustedExternal(updateState.websiteUrl || WEBSITE_URL);
    try {
      if (updateState.phase === "available" || updateState.phase === "error") {
        updateState = await NgrDesktopBridge.downloadUpdate();
        renderUpdateState();
        return;
      }
      await checkForUpdates({ manual: true });
    } catch {
      updateState = { ...updateState, phase: "error" };
      renderUpdateState();
      showToast("更新下载失败，可重试或前往官网下载");
    }
  }

  function bindUpdateControls() {
    if (controlsBound) return;
    controlsBound = true;
    els.updateAvailableButton?.addEventListener("click", openUpdateDialog);
    els.feedbackFormLink?.addEventListener("click", () => void openTrustedExternal(FEEDBACK_FORM_URL));
    els.updateDialogClose?.addEventListener("click", closeUpdateDialog);
    els.updateDialogOverlay?.addEventListener("click", (event) => {
      if (event.target === els.updateDialogOverlay) closeUpdateDialog();
    });
    els.manualUpdateCheck?.addEventListener("click", () => void checkForUpdates({ manual: true }));
    els.updatePrimaryAction?.addEventListener("click", () => void performPrimaryUpdateAction());
    els.updateWebsiteAction?.addEventListener("click", () => void openTrustedExternal(updateState?.websiteUrl || WEBSITE_URL));
    els.websiteDownloadLink?.addEventListener("click", () => void openTrustedExternal(WEBSITE_URL));
    els.historyDownloadLink?.addEventListener("click", () => void openTrustedExternal(HISTORY_URL));
  }

  async function initializeUpdates() {
    bindUpdateControls();
    renderHistory();
    const settings = document.getElementById("generalSettingsView");
    if (settings) {
      historyObserver = new MutationObserver(() => { if (settings.classList.contains("active")) void loadHistory(); });
      historyObserver.observe(settings, { attributes: true, attributeFilter: ["class"] });
      if (settings.classList.contains("active")) void loadHistory();
    }
    desktopInfo = await NgrDesktopBridge.getInfo().catch(() => desktopInfo);
    updateState = await NgrDesktopBridge.getUpdateState().catch(() => null);
    if (!updateState) {
      updateState = {
        enabled: false,
        phase: "disabled",
        currentVersion: desktopInfo.version || APP_VERSION.replace(/^V/i, ""),
        channel: desktopInfo.updaterChannel || "latest",
        websiteUrl: WEBSITE_URL,
        historyUrl: HISTORY_URL,
      };
    }
    renderUpdateState();
    updateListenerCleanup();
    updateListenerCleanup = NgrDesktopBridge.onUpdateStateChanged((nextState) => {
      updateState = nextState;
      renderUpdateState();
    });
    if (updateState.enabled) {
      globalScope.setTimeout(() => void checkForUpdates(), 1200);
      updateTimer = globalScope.setInterval(() => void checkForUpdates(), UPDATE_INTERVAL_MS);
    }
  }

  globalScope.addEventListener?.("pagehide", () => {
    historyObserver?.disconnect();
    updateListenerCleanup();
    if (updateTimer) globalScope.clearInterval(updateTimer);
  });
  globalScope.syncUpdateButtonVisibility = syncUpdateButtonVisibility;
  globalScope.initializeUpdates = initializeUpdates;
  globalScope.NgrUpdateUi = Object.freeze({ formatBytes, formatRate, formatReleaseDate, getProgressViewModel, versionLabel });
})(window);
