/* NGR AssetPilot V3.0.0 module: updates.js */
(function initializeUpdateUiModule(globalScope) {
  "use strict";

  const WEBSITE_URL = "https://ngr.lttlt.top/";
  const HISTORY_URL = "https://github.com/907609732/NGR-AssetPilot-App/releases";
  const UPDATE_INTERVAL_MS = 6 * 60 * 60 * 1000;
  let updateState = null;
  let desktopInfo = { isDesktop: false, version: APP_VERSION.replace(/^V/i, ""), isPortable: false };
  let updateTimer = null;
  let updateListenerCleanup = () => {};
  let controlsBound = false;

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
    if (els.currentAppVersion) els.currentAppVersion.textContent = versionLabel(currentVersion);
    if (els.manualUpdateStatus) {
      const status = {
        disabled: desktopInfo.isDesktop ? "当前运行方式不支持应用内更新，可前往官网下载。" : "网页版不支持应用内更新。",
        idle: "当前使用标准更新通道。",
        checking: "正在检查新版本…",
        "not-available": "当前已经是最新版本。",
        available: `发现新版本 ${versionLabel(updateState.availableVersion)}。`,
        downloading: `正在下载新版本：${Math.round(updateState.progress?.percent || 0)}%。`,
        downloaded: "新版本已下载，可以重启安装。",
        installing: "正在退出并安装新版本…",
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
    const percent = Math.max(0, Math.min(100, Number(updateState.progress?.percent || 0)));
    const showProgress = ["downloading", "downloaded"].includes(updateState.phase);
    els.updateProgressWrap?.classList.toggle("hidden", !showProgress);
    if (els.updateProgress) els.updateProgress.value = percent;
    if (els.updateProgressText) els.updateProgressText.textContent = updateState.phase === "downloaded" ? "下载完成" : `已下载 ${Math.round(percent)}%`;
    if (els.updatePrimaryAction) {
      const portable = Boolean(desktopInfo.isPortable);
      const actions = {
        available: portable ? "前往官网下载" : "下载更新",
        downloading: "正在下载…",
        downloaded: "重启并安装",
        installing: "正在安装…",
        error: portable ? "前往官网下载" : "重新下载",
      };
      els.updatePrimaryAction.textContent = actions[updateState.phase] || "检查更新";
      els.updatePrimaryAction.disabled = ["downloading", "installing"].includes(updateState.phase);
    }
    syncUpdateButtonVisibility();
  }

  function openUpdateDialog() {
    if (!isUpdateKnown()) return;
    renderUpdateState();
    els.updateDialogOverlay?.classList.remove("hidden");
    els.updateDialogOverlay?.setAttribute("aria-hidden", "false");
  }

  function closeUpdateDialog() {
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
      if (updateState.phase === "downloaded") {
        if (!globalScope.confirm("新版本已经下载完成，是否立即退出软件并安装？")) return;
        await NgrDesktopBridge.installUpdate();
        return;
      }
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
    updateListenerCleanup();
    if (updateTimer) globalScope.clearInterval(updateTimer);
  });
  globalScope.syncUpdateButtonVisibility = syncUpdateButtonVisibility;
  globalScope.initializeUpdates = initializeUpdates;
  globalScope.NgrUpdateUi = Object.freeze({ formatBytes, formatReleaseDate, versionLabel });
})(window);
