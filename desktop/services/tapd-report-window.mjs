import path from "node:path";
import { statSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { isTrustedAppUrl } from "../main/security.mjs";
import { bugMediaFileResponse } from "./tapd-media-response.mjs";

const CHILD_CHANNELS = Object.freeze([
  "tapd:load",
  "tapd:login",
  "tapd:collect",
  "tapd:cancel",
  "tapd:save",
  "tapd:restore",
  "tapd:clear-all-data",
  "tapd:extract-bug-images",
  "tapd:list-bug-images",
  "tapd:get-bug-image",
  "tapd:list-bug-media",
  "tapd:get-bug-media-url",
  "tapd:copy-bug-media-image",
  "tapd:reveal-bug-media",
  "tapd:export",
  "tapd:copy",
  "tapd:open-path",
  "tapd:open-item",
]);

function asMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

export class TapdReportWindowService {
  constructor({
    app,
    BrowserWindow,
    clipboard,
    nativeImage,
    dialog,
    ipcMain,
    shell,
    createWindowOptions,
    hardenWindow,
    getMainWindow,
    preloadPath,
    pageUrl,
    templatePath,
  }) {
    this.app = app;
    this.BrowserWindow = BrowserWindow;
    this.clipboard = clipboard;
    this.nativeImage = nativeImage;
    this.mediaLibrary = null;
    this.mediaTokens = new Map();
    this.dialog = dialog;
    this.ipcMain = ipcMain;
    this.shell = shell;
    this.createWindowOptions = createWindowOptions;
    this.hardenWindow = hardenWindow;
    this.getMainWindow = getMainWindow;
    this.preloadPath = preloadPath;
    this.pageUrl = pageUrl;
    this.templatePath = templatePath;
    this.window = null;
    this.store = null;
    this.collector = null;
    this.activeJob = null;
    this.runtime = null;
    this.disposed = false;
    this.registeredChannels = [];
    this.#registerHandlers();
  }

  #assertTrustedSender(event) {
    if (!this.window || this.window.isDestroyed() || event.sender !== this.window.webContents) {
      throw new Error("不受信任的 TAPD 月报请求");
    }
    const frame = event.senderFrame;
    const mainFrame = event.sender.mainFrame;
    if (!frame || !mainFrame || frame.routingId !== mainFrame.routingId || !isTrustedAppUrl(frame.url || event.sender.getURL())) {
      throw new Error("不受信任的 TAPD 月报请求");
    }
  }

  #handle(channel, handler) {
    this.ipcMain.handle(channel, async (event, payload) => {
      this.#assertTrustedSender(event);
      return handler(payload);
    });
    this.registeredChannels.push(channel);
  }

  async #runJob(handler) {
    if (this.activeJob) throw new Error("已有采集或图片提取正在进行");
    const job = Promise.resolve().then(handler);
    this.activeJob = job;
    try {
      return await job;
    } finally {
      if (this.activeJob === job) this.activeJob = null;
    }
  }

  #registerHandlers() {
    this.#handle("tapd:load", async () => (await this.#ensureReady()).store.load());
    this.#handle("tapd:login", async () => {
      if (this.activeJob) throw new Error("请等待当前任务完成或先停止");
      return (await this.#ensureReady()).collector.login();
    });
    this.#handle("tapd:collect", async (scope) => this.#runJob(async () => {
      const { collector, store } = await this.#ensureReady();
      return store.capture(await collector.collect(scope));
    }));
    this.#handle("tapd:cancel", async () => (await this.#ensureReady()).collector.cancel());
    this.#handle("tapd:save", async (input) => (await this.#ensureReady()).store.save(input));
    this.#handle("tapd:restore", async (id) => (await this.#ensureReady()).store.restore(String(id)));
    this.#handle("tapd:clear-all-data", async () => {
      if (this.activeJob) throw new Error("请先停止正在进行的采集或图片提取");
      const { response } = await this.dialog.showMessageBox(this.window, {
        type: "warning",
        title: "清除所有数据",
        message: "确定清除所有 TAPD 报表数据吗？",
        detail: "将删除采集记录、分类与等级调整、人天分配和导出历史。不会退出 TAPD，也不会删除已经导出的文件。此操作无法撤销。",
        buttons: ["取消", "清除所有数据"],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      });
      if (response !== 1) return null;
      const cleared = (await this.#ensureReady()).store.clearReportData();
      this.mediaLibrary?.clear();
      this.mediaTokens.clear();
      return cleared;
    });
    this.#handle("tapd:extract-bug-images", async (input) =>
      this.#runJob(() => this.#extractBugImages(input)));
    this.#handle("tapd:list-bug-images", async (input) => {
      if (!input || typeof input !== "object" || !input.period)
        throw new Error("请选择有效的图片日期");
      const { runtime, store } = await this.#ensureReady();
      runtime.dateRange(input.period.start, input.period.end);
      return runtime.listBugImagePreviews(store.load(), input.period);
    });
    this.#handle("tapd:get-bug-image", async (input) => {
      if (!input || typeof input !== "object" || !input.period)
        throw new Error("图片请求无效");
      const { runtime, store } = await this.#ensureReady();
      runtime.dateRange(input.period.start, input.period.end);
      return runtime.getBugImagePreview(store.load(), input);
    });
    this.#handle("tapd:list-bug-media", async (input) => {
      const { store } = await this.#ensureReady();
      return this.mediaLibrary.list(store.load(), input?.period, true);
    });
    this.#handle("tapd:get-bug-media-url", async (input) => {
      const { store } = await this.#ensureReady();
      await this.mediaLibrary.resolve(store.load(), input);
      if (input.variant !== undefined && !["thumbnail", "original"].includes(input.variant)) throw new Error("媒体预览格式无效");
      const token = randomBytes(24).toString("hex");
      this.mediaTokens.set(token, { period: { ...input.period }, bugId: input.bugId, mediaId: input.mediaId, variant: input.variant });
      if (this.mediaTokens.size > 4000) this.mediaTokens.delete(this.mediaTokens.keys().next().value);
      return new URL(`/tapd-media/${token}`, this.pageUrl).href;
    });
    this.#handle("tapd:copy-bug-media-image", async (input) => {
      const { store } = await this.#ensureReady();
      const buffer = await this.mediaLibrary.imageBuffer(store.load(), input);
      const image = this.nativeImage.createFromBuffer(buffer);
      if (image.isEmpty()) throw new Error("图片无法复制，可定位到本地文件");
      this.clipboard.writeImage(image);
    });
    this.#handle("tapd:reveal-bug-media", async (input) => {
      const { store } = await this.#ensureReady();
      const file = await this.mediaLibrary.resolve(store.load(), input);
      this.shell.showItemInFolder(file.absolutePath);
    });
    this.#handle("tapd:export", async (input) => this.#export(input));
    this.#handle("tapd:copy", async (input) => this.#copy(input));
    this.#handle("tapd:open-path", async (requestedPath) => {
      const { store } = await this.#ensureReady();
      if (!store.load().exports.some((entry) => entry.path === requestedPath)) throw new Error("找不到该导出记录");
      let directory = false;
      try {
        directory = statSync(requestedPath).isDirectory();
      } catch {
        throw new Error("导出文件或文件夹已被移动或删除");
      }
      if (directory) {
        const error = await this.shell.openPath(requestedPath);
        if (error) throw new Error(error);
      } else this.shell.showItemInFolder(requestedPath);
    });
    this.#handle("tapd:open-item", async (rawUrl) => {
      const parsed = new URL(rawUrl);
      if (parsed.protocol !== "https:" || parsed.hostname !== "tapd.tencent.com" || !/^\/tapd_fe\/\d+\//.test(parsed.pathname)) {
        throw new Error("仅支持打开原始 TAPD 单据链接");
      }
      return this.shell.openExternal(parsed.href, { activate: true });
    });
  }

  async #ensureReady() {
    if (this.disposed) throw new Error("TAPD 月报功能已关闭");
    if (!this.runtime) this.runtime = await import("./tapd-report-runtime.mjs");
    this.mediaLibrary ??= new this.runtime.BugMediaLibrary();
    if (!this.store) {
      const dataRoot = process.env.NGR_E2E_USER_DATA
        ? path.join(this.app.getPath("userData"), "tapd-report")
        : path.join(this.app.getPath("appData"), "TAPD月报工具");
      this.store = await this.runtime.LocalStore.open(dataRoot);
      this.collector = new this.runtime.TapdCollector(path.join(dataRoot, "tapd-browser"), (progress) => {
        if (this.window && !this.window.isDestroyed()) this.window.webContents.send("tapd:progress", progress);
      });
    }
    return { runtime: this.runtime, store: this.store, collector: this.collector };
  }

  async #export(input) {
    if (!input || !["xlsx", "txt", "md", "csv"].includes(input.kind)) throw new Error("不支持的格式");
    if (input.includeBugImages && input.kind !== "xlsx") throw new Error("只有月报 Excel 支持附带 Bug 图片");
    const { runtime, store } = await this.#ensureReady();
    const state = store.load();
    const request = input.kind === "csv"
      ? { ...input, draft: !state.capture?.complete || !runtime.captureCovers(state.capture, input.period) }
      : input;
    if (request.kind !== "csv" && !request.draft && runtime.exportProblems(state, request.period).length) {
      throw new Error("仍有待确认项，请先完成整理或导出草稿");
    }
    let images = [];
    if (request.includeBugImages) {
      const groups = await this.mediaLibrary.list(state, request.period);
      const selected = runtime.selectReportBugImages(state, request.period, groups);
      if (!selected.length) throw new Error("当前报告范围没有已提取的 Bug 图片，请先点击“提取 Bug 图片和视频”");
      images = await Promise.all(selected.map(async ({ mediaId, ...image }) => {
        const file = await this.mediaLibrary.resolve(state, { period: request.period, bugId: image.bugId, mediaId });
        return { ...image, absolutePath: file.absolutePath, mimeType: file.mimeType };
      }));
    }
    const result = await this.dialog.showSaveDialog(this.window, {
      title: "保存报表",
      defaultPath: path.join(this.app.getPath("documents"), runtime.suggestedName(request.kind, request.period, state, request.draft)),
      filters: [{ name: request.kind.toUpperCase(), extensions: [request.kind] }],
    });
    if (result.canceled || !result.filePath) return null;
    const filename = path.extname(result.filePath).toLowerCase() === `.${request.kind}`
      ? result.filePath
      : `${result.filePath}.${request.kind}`;
    const outputPath = runtime.unusedPath(filename);
    await runtime.writeExport(outputPath, request.kind, state, request.period, request.draft, this.templatePath, images);
    store.recordExport(outputPath, request.kind, request.draft);
    return outputPath;
  }

  async #extractBugImages(input) {
    if (!input || typeof input !== "object" || !input.period)
      throw new Error("请选择有效的提取日期");
    const { runtime, store, collector } = await this.#ensureReady();
    runtime.dateRange(input.period.start, input.period.end);
    const state = store.load();
    const tickets = runtime.selectBugImageTickets(state, input.period);
    await collector.prepareBugImageExtraction();
    const selection = await this.dialog.showOpenDialog(this.window, {
      title: "选择 Bug 图片和视频保存位置",
      defaultPath: this.app.getPath("documents"),
      buttonLabel: "保存到这里",
      properties: ["openDirectory", "createDirectory"],
    });
    if (selection.canceled || !selection.filePaths?.[0]) return null;
    const outputPath = runtime.unusedBugImageDirectory(selection.filePaths[0], input.period);
    const result = await collector.extractBugImages(tickets, outputPath);
    this.mediaLibrary.clear();
    store.recordExport(
      outputPath,
      "bug-images",
      result.canceled || result.failedCount > 0,
    );
    return result;
  }

  async #copy(input) {
    const { runtime, store } = await this.#ensureReady();
    const state = store.load();
    if (!input?.draft && runtime.exportProblems(state, input?.period).length) throw new Error("仍有待确认项，请先完成整理或勾选草稿");
    const report = runtime.buildReport(state, input.period);
    const text = runtime.weeklyText(report, input.draft, state.settings.weeklyContent);
    if (input.html) this.clipboard.write({ text, html: runtime.weeklyHtml(report, input.draft, state.settings.weeklyContent) });
    else this.clipboard.writeText(text);
  }

  async serveMedia(request) {
    const token = new URL(request.url).pathname.match(/^\/tapd-media\/([a-f0-9]{48})$/)?.[1];
    const input = token && this.mediaTokens.get(token);
    if (!input || !this.window || this.window.isDestroyed()) return new Response(null, { status: 404 });
    try {
      const { store } = await this.#ensureReady();
      const state = store.load();
      const file = await this.mediaLibrary.resolve(state, input);
      if (input.variant === "thumbnail" && file.kind === "image") {
        const image = await this.mediaLibrary.imageBuffer(state, input, true);
        return new Response(request.method === "HEAD" ? null : image, { headers: { "Content-Type": "image/webp", "Content-Length": String(image.length), "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
      }
      return bugMediaFileResponse(file, request);
    } catch { return new Response(null, { status: 404 }); }
  }

  async open() {
    await this.#ensureReady();
    if (this.window && !this.window.isDestroyed()) {
      if (this.window.isMinimized()) this.window.restore();
      this.window.show();
      this.window.focus();
      return { opened: true };
    }
    const parent = this.getMainWindow();
    this.window = new this.BrowserWindow({
      ...this.createWindowOptions(this.preloadPath),
      width: 1480,
      height: 960,
      minWidth: 1150,
      minHeight: 740,
      title: "TAPD 周报／月报",
      backgroundColor: "#f5f6f8",
      parent: parent && !parent.isDestroyed() ? parent : undefined,
    });
    this.hardenWindow(this.window);
    this.window.once("ready-to-show", () => this.window?.show());
    this.window.on("closed", () => {
      this.window = null;
      this.mediaTokens.clear();
    });
    await this.window.loadURL(this.pageUrl);
    return { opened: true };
  }

  async close() {
    this.collector?.cancel();
    await this.activeJob?.catch(() => {});
    await this.collector?.close().catch(() => {});
    this.collector = null;
    this.store?.close();
    this.store = null;
    this.mediaLibrary?.clear();
    this.mediaTokens.clear();
    if (this.window && !this.window.isDestroyed()) this.window.destroy();
    this.window = null;
  }

  async dispose() {
    if (this.disposed) return;
    this.disposed = true;
    await this.close().catch((error) => process.stderr.write(`[tapd-report] close failed: ${asMessage(error)}\n`));
    for (const channel of this.registeredChannels) this.ipcMain.removeHandler(channel);
    this.registeredChannels = [];
  }
}

export { CHILD_CHANNELS };
