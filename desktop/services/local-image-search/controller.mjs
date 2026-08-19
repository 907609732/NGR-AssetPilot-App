import { randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, rm, stat } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { DesktopError, isPlainRecord, toBoundedBuffer } from "../../shared/core.mjs";
import {
  DEFAULT_RESULT_LIMIT,
  LOCAL_IMAGE_SEARCH_VERSION,
  MODEL_PACKAGE_EXTENSION,
  QUERY_MAX_BYTES,
  QUERY_MAX_PIXELS,
} from "./constants.mjs";
import { LocalImageSearchEngine } from "./engine.mjs";
import { LocalModelManager } from "./model-manager.mjs";
import { LocalImageSearchStorage } from "./storage.mjs";

const ID_PATTERN = /^[a-f0-9-]{16,64}$/i;

function requireRecord(value) {
  if (!isPlainRecord(value)) throw new DesktopError("LOCAL_SEARCH_INVALID_REQUEST", "本地搜图请求参数无效");
  return value;
}

function requireId(value, name = "ID") {
  if (typeof value !== "string" || !ID_PATTERN.test(value)) {
    throw new DesktopError("LOCAL_SEARCH_INVALID_ID", `${name} 无效`);
  }
  return value;
}

function isInside(rootPath, candidatePath) {
  const relative = path.relative(rootPath, candidatePath);
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative);
}

export class LocalImageSearchController {
  constructor({ userDataPath, dialog, shell, netFetch, getWindow }) {
    this.dialog = dialog;
    this.shell = shell;
    this.getWindow = getWindow;
    this.netFetch = netFetch;
    this.dataRoot = path.join(userDataPath, "local-image-search");
    this.modelRoot = path.join(this.dataRoot, "models");
    this.thumbnailRoot = path.join(this.dataRoot, "thumbnails");
    this.storage = new LocalImageSearchStorage({ dataRoot: this.dataRoot });
    this.jobs = new Map();
    this.models = new LocalModelManager({ modelRoot: this.modelRoot, fetchImpl: this.netFetch });
    this.connectEngine();
  }

  connectEngine() {
    this.engine = new LocalImageSearchEngine({ dbPath: this.storage.dbPath, modelRoot: this.modelRoot });
    this.unsubscribeProgress = this.engine.onProgress((jobId, progress) => {
      const job = this.jobs.get(jobId);
      if (job) Object.assign(job, progress, { updatedAt: new Date().toISOString() });
    });
  }

  async ensureModelReady() {
    const status = await this.models.inspect();
    if (!status.ready) throw new DesktopError("LOCAL_SEARCH_MODEL_REQUIRED", "请先下载并校验本地 AI 模型");
  }

  async getModelStatus() {
    return this.models.inspect();
  }

  async downloadModel() {
    this.models.startDownload();
    return this.models.inspect();
  }

  async cancelModelDownload() {
    return { canceled: this.models.cancelDownload() };
  }

  assertModelIdle() {
    if (["downloading", "importing", "exporting"].includes(this.models.job?.state)) {
      throw new DesktopError("LOCAL_SEARCH_MODEL_BUSY", "模型正在下载、导入或导出，请稍候");
    }
    if ([...this.jobs.values()].some((job) => job.state === "indexing")) {
      throw new DesktopError("LOCAL_SEARCH_MODEL_BUSY", "请先停止图库分析");
    }
  }

  async importModel() {
    this.assertModelIdle();
    const result = await this.dialog.showOpenDialog(this.getWindow(), {
      title: "导入本地 AI 离线模型包",
      buttonLabel: "导入并校验",
      properties: ["openFile"],
      filters: [
        { name: "NGR 本地 AI 模型包", extensions: [MODEL_PACKAGE_EXTENSION] },
        { name: "所有文件", extensions: ["*"] },
      ],
    });
    if (result.canceled || !result.filePaths?.[0]) return { canceled: true };
    this.unsubscribeProgress();
    await this.engine.dispose();
    this.models.startImport(result.filePaths[0]);
    try {
      await this.models.packagePromise;
      return { canceled: false, imported: true, ...(await this.models.inspect()) };
    } catch {
      throw new DesktopError("LOCAL_SEARCH_MODEL_IMPORT_FAILED", "离线模型包无效、版本不匹配或文件已损坏");
    } finally {
      this.connectEngine();
    }
  }

  async exportModel() {
    this.assertModelIdle();
    await this.ensureModelReady();
    const result = await this.dialog.showSaveDialog(this.getWindow(), {
      title: "导出本地 AI 离线模型包",
      buttonLabel: "导出模型包",
      defaultPath: `NGR-AssetPilot-${LOCAL_IMAGE_SEARCH_VERSION}.${MODEL_PACKAGE_EXTENSION}`,
      filters: [{ name: "NGR 本地 AI 模型包", extensions: [MODEL_PACKAGE_EXTENSION] }],
    });
    if (result.canceled || !result.filePath) return { canceled: true };
    const packagePath = path.extname(result.filePath).toLowerCase() === `.${MODEL_PACKAGE_EXTENSION}`
      ? result.filePath
      : `${result.filePath}.${MODEL_PACKAGE_EXTENSION}`;
    try {
      const exported = await this.models.exportPackage(packagePath);
      return { canceled: false, exported: true, ...exported };
    } catch {
      throw new DesktopError("LOCAL_SEARCH_MODEL_EXPORT_FAILED", "离线模型包导出失败，请检查目标位置剩余空间");
    }
  }

  async removeModel() {
    this.assertModelIdle();
    this.unsubscribeProgress();
    await this.engine.dispose();
    await rm(this.modelRoot, { recursive: true, force: true });
    this.models = new LocalModelManager({ modelRoot: this.modelRoot, fetchImpl: this.netFetch });
    this.connectEngine();
    return { removed: true, ...(await this.models.inspect()) };
  }

  listLibraries() {
    return this.storage.listLibraries();
  }

  async createLibrary() {
    const result = await this.dialog.showOpenDialog(this.getWindow(), {
      title: "创建或选择本地 AI 搜图库文件夹",
      buttonLabel: "使用此文件夹",
      properties: ["openDirectory", "createDirectory"],
    });
    if (result.canceled || !result.filePaths?.[0]) return { canceled: true };
    const rootPath = await realpath(result.filePaths[0]);
    const info = await stat(rootPath);
    if (!info.isDirectory()) throw new DesktopError("LOCAL_SEARCH_DIRECTORY_INVALID", "请选择有效文件夹");
    try {
      return { canceled: false, library: this.storage.createLibrary({ id: randomUUID(), rootPath, name: path.basename(rootPath) }) };
    } catch (error) {
      if (String(error?.message || "").includes("UNIQUE")) {
        throw new DesktopError("LOCAL_SEARCH_LIBRARY_EXISTS", "这个文件夹已经创建为图库");
      }
      throw error;
    }
  }

  async removeLibrary(payload) {
    const libraryId = requireId(requireRecord(payload).libraryId, "图库 ID");
    await this.engine.request("invalidate", { libraryId });
    const removed = this.storage.removeLibrary(libraryId);
    await rm(path.join(this.thumbnailRoot, libraryId), { recursive: true, force: true });
    return { removed, sourceFilesDeleted: false };
  }

  async startIndex(payload) {
    const libraryId = requireId(requireRecord(payload).libraryId, "图库 ID");
    if (!this.storage.getLibrary(libraryId)) throw new DesktopError("LOCAL_SEARCH_LIBRARY_NOT_FOUND", "图库不存在");
    await this.ensureModelReady();
    for (const job of this.jobs.values()) {
      if (job.libraryId === libraryId && job.state === "indexing") return { jobId: job.jobId, reused: true };
    }
    const jobId = randomUUID();
    const job = {
      jobId, libraryId, state: "indexing", scanned: 0, analyzed: 0, reused: 0, skipped: 0, errors: 0,
      startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    };
    this.jobs.set(jobId, job);
    this.engine.request("index", { jobId, libraryId }).then(
      (result) => Object.assign(job, result, { updatedAt: new Date().toISOString() }),
      () => Object.assign(job, { state: "error", error: "分析失败，请检查模型或图片后重试", updatedAt: new Date().toISOString() }),
    );
    return { jobId, reused: false };
  }

  getJobStatus(payload) {
    const jobId = requireId(requireRecord(payload).jobId, "任务 ID");
    const job = this.jobs.get(jobId);
    if (!job) throw new DesktopError("LOCAL_SEARCH_JOB_NOT_FOUND", "分析任务不存在或已结束");
    return { ...job };
  }

  async cancelJob(payload) {
    const jobId = requireId(requireRecord(payload).jobId, "任务 ID");
    const job = this.jobs.get(jobId);
    if (!job) return { canceled: false };
    await this.engine.request("cancel", { jobId });
    return { canceled: true };
  }

  async searchByText(payload) {
    const request = requireRecord(payload);
    const libraryId = requireId(request.libraryId, "图库 ID");
    const text = typeof request.text === "string" ? request.text.trim() : "";
    if (!text || text.length > 200) throw new DesktopError("LOCAL_SEARCH_TEXT_INVALID", "请输入 1–200 个字符");
    await this.assertSearchable(libraryId);
    return this.engine.request("searchText", { libraryId, text, limit: DEFAULT_RESULT_LIMIT });
  }

  async searchByImage(payload) {
    const request = requireRecord(payload);
    const libraryId = requireId(request.libraryId, "图库 ID");
    const bytes = toBoundedBuffer(request.data, QUERY_MAX_BYTES, "LOCAL_SEARCH_QUERY_TOO_LARGE");
    const metadata = await sharp(bytes, { pages: 1, limitInputPixels: QUERY_MAX_PIXELS }).metadata();
    if (!metadata.width || !metadata.height || metadata.width * metadata.height > QUERY_MAX_PIXELS) {
      throw new DesktopError("LOCAL_SEARCH_QUERY_PIXELS_EXCEEDED", "查询图片不得超过 5000 万像素");
    }
    await this.assertSearchable(libraryId);
    return this.engine.request("searchImage", { libraryId, bytes, limit: DEFAULT_RESULT_LIMIT });
  }

  async assertSearchable(libraryId) {
    const library = this.storage.getLibrary(libraryId);
    if (!library || library.itemCount < 1) throw new DesktopError("LOCAL_SEARCH_LIBRARY_EMPTY", "请先完成图库分析");
    await this.ensureModelReady();
  }

  async resolveImage(payload) {
    const request = requireRecord(payload);
    const libraryId = requireId(request.libraryId, "图库 ID");
    const imageId = Number(request.imageId);
    if (!Number.isSafeInteger(imageId) || imageId < 1) throw new DesktopError("LOCAL_SEARCH_INVALID_ID", "图片 ID 无效");
    const library = this.storage.getLibrary(libraryId, { includePath: true });
    const image = this.storage.getImage(libraryId, imageId);
    if (!library || !image) throw new DesktopError("LOCAL_SEARCH_RESULT_NOT_FOUND", "搜索结果不存在");
    const absolutePath = path.resolve(library.rootPath, image.relative_path);
    if (!isInside(library.rootPath, absolutePath)) throw new DesktopError("LOCAL_SEARCH_PATH_REJECTED", "结果路径越界");
    const [currentRoot, currentImage] = await Promise.all([realpath(library.rootPath), realpath(absolutePath)]).catch(() => []);
    if (!currentRoot || !currentImage || path.relative(library.rootPath, currentRoot) || !isInside(currentRoot, currentImage)) {
      throw new DesktopError("LOCAL_SEARCH_PATH_REJECTED", "结果路径已变化或越界，请重新分析图库");
    }
    return { library, image, absolutePath: currentImage };
  }

  async getThumbnail(payload) {
    const { library, image, absolutePath } = await this.resolveImage(payload);
    const outputPath = path.join(this.thumbnailRoot, library.id, `${image.id}.webp`);
    await mkdir(path.dirname(outputPath), { recursive: true });
    try {
      const sourceInfo = await stat(absolutePath);
      const cachedInfo = await stat(outputPath).catch(() => null);
      if (!cachedInfo || cachedInfo.mtimeMs < sourceInfo.mtimeMs) {
        await sharp(absolutePath, { pages: 1, limitInputPixels: QUERY_MAX_PIXELS })
          .rotate().resize(320, 240, { fit: "inside", withoutEnlargement: true }).webp({ quality: 80 }).toFile(outputPath);
      }
      const data = await readFile(outputPath);
      return { mimeType: "image/webp", data };
    } catch {
      throw new DesktopError("LOCAL_SEARCH_THUMBNAIL_FAILED", "缩略图生成失败");
    }
  }

  async openResult(payload) {
    const { absolutePath } = await this.resolveImage(payload);
    const error = await this.shell.openPath(absolutePath);
    if (error) throw new DesktopError("LOCAL_SEARCH_OPEN_FAILED", "无法打开这张图片");
    return { opened: true };
  }

  async revealResult(payload) {
    const { absolutePath } = await this.resolveImage(payload);
    this.shell.showItemInFolder(absolutePath);
    return { revealed: true };
  }

  async dispose() {
    this.unsubscribeProgress();
    await this.engine.dispose();
    this.storage.close();
  }
}
