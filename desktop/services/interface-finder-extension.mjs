import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { Worker } from "node:worker_threads";
import path from "node:path";
import { FINDER_ID, FINDER_DOWNLOAD, FINDER_ENTRY, FINDER_SCHEME, inspectFinderExtension, readFinderExtensionMetadata } from "./finder-extension-files.mjs";
export { FINDER_ID, FINDER_DOWNLOAD, FINDER_ENTRY, FINDER_SCHEME, inspectFinderExtension };
const require = createRequire(import.meta.url);
const physicalFs = process.versions.electron ? require("original-fs") : require("node:fs");
const { readFile, mkdir, writeFile, rename, rm } = physicalFs.promises;
const json = async file => JSON.parse(await readFile(file, "utf8"));
const childOf = (root, file) => file === root || file.startsWith(`${root}${path.sep}`);
const cancelled = () => Object.assign(new Error("扩展处理已停止"), { code: "FINDER_CANCELLED" });

export class InterfaceFinderExtension {
  constructor({ appDataPath, userDataPath = appDataPath, dialog, getWindow, sessionFactory, loadRuntime = entry => require(entry), platform = process.platform, arch = process.arch }) {
    Object.assign(this, { appDataPath, userDataPath, dialog, getWindow, sessionFactory, loadRuntime, platform, arch });
    this.installRoot = path.join(appDataPath, "NGR", "extensions", FINDER_ID);
    this.bindingFile = path.join(this.installRoot, "current.json");
    this.runtime = null;
    this.pendingInstall = null;
    this.pendingOpen = null;
    this.disposed = false;
    this.worker = null;
    this.progress = null;
    this.progressRevision = 0;
    this.cachedBound = null;
    this.cachedError = "";
  }

  updateProgress(value) {
    const previous = this.progress;
    const state = value.state || (value.phase === "complete" ? "complete" : value.phase === "error" ? "error" : value.phase === "cancelled" ? "cancelled" : "running");
    const indeterminate = value.indeterminate ?? true;
    const done = Number.isFinite(value.done) ? value.done : null, total = Number.isFinite(value.total) ? value.total : null;
    const bytesDone = Number.isFinite(value.bytesDone) ? value.bytesDone : null, bytesTotal = Number.isFinite(value.bytesTotal) ? value.bytesTotal : null;
    let percent = null;
    if (!indeterminate) {
      if (bytesTotal > 0 && bytesDone !== null) percent = Math.min(100, Math.max(0, bytesDone / bytesTotal * 100));
      else if (total > 0 && done !== null) percent = Math.min(100, Math.max(0, done / total * 100));
    }
    const now = new Date().toISOString();
    this.progress = { operation: value.operation || previous?.operation || "install", phase: value.phase, stage: value.stage || "正在处理", state, active: state === "running", done, total, bytesDone, bytesTotal, indeterminate, percent, currentFile: value.currentFile || "", error: value.error || "", revision: ++this.progressRevision, startedAt: value.startedAt || previous?.startedAt || now, updatedAt: now };
  }

  startProgress(operation, phase, stage) {
    this.updateProgress({ operation, phase, stage, startedAt: new Date().toISOString(), indeterminate: true });
  }

  checkActive() { if (this.disposed) throw cancelled(); }

  async current({ verifyHashes = false } = {}) {
    const binding = await json(this.bindingFile).catch(() => null);
    if (!binding) return null;
    if (binding.format !== 1 || binding.id !== FINDER_ID || !/^v\d+\.\d+\.\d+(?:-[\w.-]+)?-[a-f0-9]{16}$/.test(binding.directory || "") || !/^[a-f0-9]{64}$/.test(binding.manifestHash || "")) throw new Error("扩展安装记录损坏，请重新导入");
    const payload = { root: path.join(this.installRoot, binding.directory), options: { manifestHash: binding.manifestHash, verifyHashes } };
    return verifyHashes ? this.runWorker("inspect", payload) : (await readFinderExtensionMetadata(payload.root, payload.options)).entry;
  }

  async refreshBound() {
    try { this.cachedBound = await this.current(); this.cachedError = ""; }
    catch (failure) { this.cachedBound = null; this.cachedError = failure.message; }
  }

  snapshot() {
    const bound = this.cachedBound, error = this.cachedError;
    const running = Boolean(this.runtime?.getWindow() && !this.runtime.getWindow().isDestroyed());
    return { id: FINDER_ID, downloadUrl: FINDER_DOWNLOAD, state: bound ? "ready" : error ? "invalid" : "not-found", bound, candidates: [], running, progress: this.progress ? { ...this.progress } : null, message: error || (bound ? `已安装 ${bound.version}，复用 AI资源领航运行环境` : "尚未安装扩展。下载扩展 ZIP 后在这里导入，无需独立 EXE 或服务端。") };
  }

  async status() {
    // Polling a busy job must be a memory-only read, not 1,700 filesystem stats per tick.
    if (!this.pendingInstall && !this.pendingOpen) await this.refreshBound();
    return this.snapshot();
  }

  async detect() { return this.status(); }

  runWorker(kind, payload) {
    this.checkActive();
    if (this.worker) throw new Error("扩展已有处理任务，请等待完成");
    return new Promise((resolve, reject) => {
      const worker = new Worker(new URL("./finder-extension-worker.mjs", import.meta.url), { workerData: { kind, payload } });
      this.worker = worker;
      let settled = false;
      const finish = (error, result) => {
        if (settled) return; settled = true;
        if (this.worker === worker) this.worker = null;
        error ? reject(error) : resolve(result);
      };
      worker.on("message", message => {
        if (this.disposed) return;
        if (message.type === "progress") this.updateProgress(message.progress);
        else if (message.type === "result") finish(null, message.result);
        else if (message.type === "error") finish(Object.assign(new Error(message.error.message), { code: message.error.code }));
      });
      worker.once("error", error => finish(error));
      worker.once("exit", code => { if (!settled) finish(this.disposed ? cancelled() : new Error(`扩展处理进程提前结束（${code}）`)); });
    });
  }

  async choose(request) {
    if (request !== undefined && (request === null || typeof request !== "object" || Object.keys(request).length)) throw new Error("请通过原生文件选择器导入扩展 ZIP");
    if (this.disposed) throw new Error("扩展管理已关闭");
    if (this.pendingInstall) return this.pendingInstall;
    if (this.pendingOpen) throw new Error("扩展正在打开，请稍后再导入");
    this.startProgress("install", "selecting", "选择扩展包");
    this.pendingInstall = this.chooseAndInstall().catch(error => {
      this.updateProgress({ phase: error.code === "FINDER_CANCELLED" ? "cancelled" : "error", stage: error.code === "FINDER_CANCELLED" ? "扩展处理已停止" : "导入未完成", error: error.message });
      throw error;
    }).finally(() => { this.pendingInstall = null; });
    return this.pendingInstall;
  }

  async chooseAndInstall() {
    await this.refreshBound(); this.checkActive();
    const selected = await this.dialog.showOpenDialog(this.getWindow(), { title: "导入快速找界面扩展包（请使用受信任的官方 ZIP）", filters: [{ name: "快速找界面扩展包", extensions: ["zip"] }], properties: ["openFile"] });
    this.checkActive();
    if (selected.canceled || !selected.filePaths?.[0]) {
      this.updateProgress({ phase: "cancelled", stage: "已取消选择", state: "cancelled" });
      return this.snapshot();
    }
    if (this.runtime) throw new Error("请先关闭快速找界面工作台，再导入或升级扩展；项目与模型会保留");
    if (this.platform !== "win32" || this.arch !== "x64") throw new Error("此扩展仅支持 Windows x64");
    const staging = path.join(this.installRoot, `.install-${randomUUID()}`);
    let temporary;
    try {
      this.updateProgress({ phase: "reading", stage: "准备读取扩展包", currentFile: path.basename(selected.filePaths[0]), indeterminate: true });
      const installed = await this.runWorker("install", { archivePath: selected.filePaths[0], installRoot: this.installRoot, staging });
      this.checkActive();
      this.updateProgress({ phase: "publishing", stage: "完成校验，启用新版本", indeterminate: true });
      temporary = path.join(this.installRoot, `.current-${randomUUID()}.tmp`);
      await writeFile(temporary, JSON.stringify({ format: 1, id: FINDER_ID, directory: installed.directory, version: installed.entry.version, manifestHash: installed.entry.manifestHash }, null, 2), { flag: "wx" });
      this.checkActive();
      await rename(temporary, this.bindingFile);
      this.cachedBound = installed.entry; this.cachedError = "";
      this.updateProgress({ phase: "complete", stage: "扩展安装完成", state: "complete", done: installed.done, total: installed.total, bytesDone: installed.bytesDone, bytesTotal: installed.bytesTotal, indeterminate: false });
      return { ...this.snapshot(), installed: true };
    } finally {
      if (childOf(this.installRoot, staging) && path.basename(staging).startsWith(".install-")) await rm(staging, { recursive: true, force: true });
      if (temporary && childOf(this.installRoot, temporary) && path.basename(temporary).startsWith(".current-")) await rm(temporary, { force: true });
    }
  }

  async open() {
    if (this.disposed) throw new Error("扩展管理已关闭");
    if (this.pendingInstall) throw new Error("扩展正在安装，请等待完成");
    if (this.pendingOpen) return this.pendingOpen;
    this.startProgress("open", "verifying", "准备检查已安装扩展");
    this.pendingOpen = this.openInstalled().catch(error => {
      this.updateProgress({ phase: error.code === "FINDER_CANCELLED" ? "cancelled" : "error", stage: "工作台未打开", error: error.message });
      throw error;
    }).finally(() => { this.pendingOpen = null; });
    return this.pendingOpen;
  }

  async openInstalled() {
    const previous = this.runtime;
    if (previous && (!previous.getWindow() || previous.getWindow().isDestroyed())) {
      await previous.dispose();
      if (this.runtime === previous) this.runtime = null;
    }
    if (this.runtime) {
      await this.runtime.show();
      this.updateProgress({ phase: "complete", stage: "已打开工作台", state: "complete" });
      return { ...this.snapshot(), launched: true };
    }
    await this.refreshBound(); this.checkActive();
    if (!this.cachedBound) { this.progress = null; return { ...this.snapshot(), launched: false }; }
    const entry = await this.current({ verifyHashes: true });
    this.checkActive();
    this.updateProgress({ phase: "loading", stage: "加载工作台", indeterminate: true });
    const module = await this.loadRuntime(path.join(entry.root, ...FINDER_ENTRY.split("/")));
    this.checkActive();
    if (typeof module?.createFinderRuntime !== "function") throw new Error("扩展未提供兼容的工作台接口，请重新导入正式扩展包");
    let runtime;
    runtime = await module.createFinderRuntime({ hosted: true, root: path.join(entry.root, "resources", "app.asar"), resourcesRoot: path.join(entry.root, "resources"), profileRoot: path.join(this.userDataPath, "extensions-data", FINDER_ID), cacheRoot: path.join(this.userDataPath, "extensions-cache", FINDER_ID), inheritSettingsFile: path.join(this.appDataPath, "QuickInterfaceFinder", "settings.json"), session: this.sessionFactory?.(), version: entry.version, parentWindow: this.getWindow(), onClosed: () => { if (this.runtime === runtime) this.runtime = null; } });
    if (!runtime || !["start", "show", "dispose", "getWindow"].every(key => typeof runtime[key] === "function")) throw new Error("扩展工作台接口不完整");
    this.runtime = runtime;
    try { this.checkActive(); await runtime.start(); this.checkActive(); }
    catch (failure) { await runtime.dispose().catch(() => {}); if (this.runtime === runtime) this.runtime = null; throw failure; }
    this.cachedBound = entry;
    this.updateProgress({ phase: "complete", stage: "工作台已打开", state: "complete" });
    return { ...this.snapshot(), launched: true };
  }

  async dispose() {
    if (this.disposal) return this.disposal;
    this.disposed = true;
    const worker = this.worker;
    const waitInstall = Boolean(worker || this.progress?.phase !== "selecting");
    if (this.progress?.active) this.updateProgress({ phase: "cancelled", stage: "扩展处理已停止", state: "cancelled" });
    this.disposal = (async () => {
      await worker?.terminate();
      if (waitInstall) await this.pendingInstall?.catch(() => {});
      await this.pendingOpen?.catch(() => {});
      const runtime = this.runtime; this.runtime = null;
      await runtime?.dispose();
    })();
    return this.disposal;
  }
}
