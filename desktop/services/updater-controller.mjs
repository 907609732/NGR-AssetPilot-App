import { DesktopError, errorCodeOnly } from "../shared/core.mjs";

function cloneState(state) {
  return {
    ...state,
    progress: state.progress ? { ...state.progress } : null,
  };
}

function stripMarkup(value) {
  return String(value || "")
    .replace(/<br\s*\/?\s*>/gi, "\n")
    .replace(/<\/p\s*>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, 20_000);
}

function normalizeReleaseNotes(releaseNotes) {
  if (Array.isArray(releaseNotes)) {
    return releaseNotes.map((entry) => stripMarkup(entry?.note)).filter(Boolean).join("\n\n");
  }
  return stripMarkup(releaseNotes);
}

function getDownloadSize(info) {
  const files = Array.isArray(info?.files) ? info.files : [];
  const installer = files.find((file) => String(file?.url || "").toLowerCase().endsWith(".exe")) || files[0];
  return Number.isFinite(installer?.size) && installer.size > 0 ? installer.size : null;
}

export class UpdaterController {
  constructor({
    autoUpdater = null,
    enabled = false,
    currentVersion = "0.0.0",
    channel = "latest",
    feed = null,
    websiteUrl = "https://ngr.lttlt.top/",
    historyUrl = "https://github.com/907609732/NGR-AssetPilot-App/releases",
  } = {}) {
    this.autoUpdater = autoUpdater;
    this.enabled = Boolean(enabled && autoUpdater);
    this.channel = String(channel || "latest").trim() || "latest";
    this.feed = feed && typeof feed === "object"
      ? { ...feed, channel: this.channel }
      : null;
    this.listeners = [];
    this.stateListeners = new Set();
    this.inFlight = null;
    this.state = {
      enabled: this.enabled,
      phase: this.enabled ? "idle" : "disabled",
      currentVersion,
      channel: this.channel,
      availableVersion: null,
      releaseName: null,
      releaseNotes: "",
      releaseDate: null,
      downloadSize: null,
      websiteUrl,
      historyUrl,
      progress: null,
      errorCode: null,
    };

    if (this.enabled) this.#configure();
  }

  #configure() {
    if (this.feed && typeof this.autoUpdater.setFeedURL === "function") {
      this.autoUpdater.setFeedURL(this.feed);
    }
    this.autoUpdater.autoDownload = false;
    this.autoUpdater.autoInstallOnAppQuit = false;
    this.autoUpdater.allowPrerelease = false;
    this.autoUpdater.channel = this.channel;
    this.autoUpdater.allowDowngrade = false;

    this.#on("checking-for-update", () => this.#patch({ phase: "checking", errorCode: null }));
    this.#on("update-available", (info) => this.#applyUpdateInfo(info, "available"));
    this.#on("update-not-available", () =>
      this.#patch({
        phase: "not-available",
        availableVersion: null,
        releaseName: null,
        releaseNotes: "",
        releaseDate: null,
        downloadSize: null,
        progress: null,
      }),
    );
    this.#on("download-progress", (progress) =>
      this.#patch({
        phase: "downloading",
        progress: {
          percent: Number.isFinite(progress?.percent) ? Math.max(0, Math.min(100, progress.percent)) : 0,
          bytesPerSecond: Number.isFinite(progress?.bytesPerSecond) ? Math.max(0, progress.bytesPerSecond) : 0,
          transferred: Number.isFinite(progress?.transferred) ? Math.max(0, progress.transferred) : 0,
          total: Number.isFinite(progress?.total) ? Math.max(0, progress.total) : 0,
        },
      }),
    );
    this.#on("update-downloaded", (info) => {
      this.#applyUpdateInfo(info, "downloaded");
      this.#patch({ progress: { ...(this.state.progress || {}), percent: 100 } });
    });
    this.#on("error", (error) =>
      this.#patch({ phase: "error", errorCode: errorCodeOnly(error, "UPDATER_ERROR"), progress: null }),
    );
  }

  #on(eventName, listener) {
    this.autoUpdater.on(eventName, listener);
    this.listeners.push([eventName, listener]);
  }

  #patch(change) {
    this.state = { ...this.state, ...change };
    const snapshot = this.getState();
    this.stateListeners.forEach((listener) => {
      try { listener(snapshot); } catch {}
    });
  }

  #applyUpdateInfo(info, phase) {
    this.#patch({
      phase,
      availableVersion: String(info?.version || this.state.availableVersion || "") || null,
      releaseName: String(info?.releaseName || "") || null,
      releaseNotes: normalizeReleaseNotes(info?.releaseNotes),
      releaseDate: String(info?.releaseDate || "") || null,
      downloadSize: getDownloadSize(info),
    });
  }

  #assertEnabled() {
    if (!this.enabled) {
      throw new DesktopError("UPDATER_DISABLED", "当前版本不支持应用内更新");
    }
  }

  getState() {
    return cloneState(this.state);
  }

  subscribe(listener) {
    if (typeof listener !== "function") throw new TypeError("Updater listener must be a function");
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  async check() {
    this.#assertEnabled();
    if (this.inFlight) return this.inFlight;
    this.#patch({ phase: "checking", errorCode: null, progress: null });
    this.inFlight = (async () => {
      try {
        const result = await this.autoUpdater.checkForUpdates();
        const info = result?.updateInfo;
        const version = info?.version;
        if (version && version !== this.state.currentVersion && this.state.phase === "checking") {
          this.#applyUpdateInfo(info, "available");
        }
        return this.getState();
      } catch (error) {
        this.#patch({ phase: "error", errorCode: errorCodeOnly(error, "UPDATE_CHECK_FAILED") });
        throw new DesktopError("UPDATE_CHECK_FAILED", "检查更新失败");
      } finally {
        this.inFlight = null;
      }
    })();
    return this.inFlight;
  }

  async download() {
    this.#assertEnabled();
    if (this.state.phase !== "available" && this.state.phase !== "error") {
      throw new DesktopError("UPDATE_NOT_AVAILABLE", "当前没有可下载的更新");
    }
    if (this.inFlight) return this.inFlight;
    this.#patch({ phase: "downloading", errorCode: null, progress: null });
    this.inFlight = (async () => {
      try {
        await this.autoUpdater.downloadUpdate();
        return this.getState();
      } catch (error) {
        this.#patch({ phase: "error", errorCode: errorCodeOnly(error, "UPDATE_DOWNLOAD_FAILED") });
        throw new DesktopError("UPDATE_DOWNLOAD_FAILED", "更新下载失败");
      } finally {
        this.inFlight = null;
      }
    })();
    return this.inFlight;
  }

  install() {
    this.#assertEnabled();
    if (this.state.phase !== "downloaded") {
      throw new DesktopError("UPDATE_NOT_DOWNLOADED", "更新尚未下载完成");
    }
    this.#patch({ phase: "installing" });
    setImmediate(() => this.autoUpdater.quitAndInstall(false, true));
    return { accepted: true };
  }

  dispose() {
    if (!this.autoUpdater) return;
    for (const [eventName, listener] of this.listeners) {
      this.autoUpdater.removeListener(eventName, listener);
    }
    this.listeners = [];
    this.stateListeners.clear();
  }
}

export const updaterMetadata = Object.freeze({ normalizeReleaseNotes, getDownloadSize });
