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
import {
  BUILTIN_MODEL_ID,
  LocalModelManager,
} from "./model-manager.mjs";
import { LocalImageSearchStorage } from "./storage.mjs";

const ID_PATTERN = /^[a-f0-9-]{16,64}$/i;
const MODEL_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/i;
const VALIDATION_TTL_MS = 30 * 60 * 1000;
const ONNX_FILTER = Object.freeze([
  { name: "ONNX 模型与外部数据", extensions: ["onnx", "data", "onnx_data", "bin", "weights"] },
  { name: "ONNX 模型", extensions: ["onnx"] },
  { name: "所有外部数据文件", extensions: ["*"] },
]);

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

function requireModelId(value) {
  if (typeof value !== "string" || !MODEL_ID_PATTERN.test(value)) {
    throw new DesktopError("LOCAL_SEARCH_INVALID_MODEL_ID", "模型 ID 无效");
  }
  return value;
}

function isInside(rootPath, candidatePath, { allowRoot = false } = {}) {
  const relative = path.relative(rootPath, candidatePath);
  return (allowRoot && relative === "") || (relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

function publicModel(model) {
  if (!model) return null;
  const { manifest: _manifest, ...result } = model;
  return result;
}

function safeModelErrorCode(error) {
  const message = String(error?.message || "");
  if (/^[A-Z][A-Z0-9_]{2,80}$/.test(message)) return message;
  const code = String(error?.code || "");
  return /^[A-Z][A-Z0-9_]{1,40}$/.test(code) ? code : "MODEL_INVALID";
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
    this.validations = new Map();
    this.modelInspectionCache = new Map();
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

  activeModelId(requestedId) {
    return requestedId ? requireModelId(requestedId) : this.storage.getActiveModelId();
  }

  async inspectRegisteredModel(model, { force = false } = {}) {
    if (!model) throw new DesktopError("LOCAL_SEARCH_MODEL_NOT_FOUND", "模型不存在");
    if (!force && this.modelInspectionCache.has(model.id)) return this.modelInspectionCache.get(model.id);
    const inspection = model.builtin
      ? await this.models.inspect({ force })
      : await this.models.inspectManifest(model.manifest);
    if (!["downloading", "importing", "exporting"].includes(inspection.state)) {
      this.storage.updateModelStatus(model.id, inspection.ready ? "ready" : "missing");
    }
    if (force || inspection.ready || inspection.state === "missing") this.modelInspectionCache.set(model.id, inspection);
    return inspection;
  }

  async ensureModelReady(modelId = this.storage.getActiveModelId(), { force = false } = {}) {
    const model = this.storage.getModel(modelId);
    const status = await this.inspectRegisteredModel(model, { force });
    if (!status.ready) throw new DesktopError("LOCAL_SEARCH_MODEL_REQUIRED", "请先安装并校验所选本地 AI 模型");
    return model;
  }

  resolveManifestPath(root, relativePath, { allowRoot = false } = {}) {
    if (typeof relativePath !== "string" || !relativePath || relativePath.includes("\\")) {
      throw new DesktopError("LOCAL_SEARCH_MODEL_MANIFEST_INVALID", "模型清单路径无效");
    }
    const segments = relativePath === "." ? [] : relativePath.split("/");
    if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
      throw new DesktopError("LOCAL_SEARCH_MODEL_MANIFEST_INVALID", "模型清单路径越界");
    }
    const candidate = path.resolve(root, ...segments);
    if (!isInside(root, candidate, { allowRoot })) {
      throw new DesktopError("LOCAL_SEARCH_MODEL_MANIFEST_INVALID", "模型清单路径越界");
    }
    return candidate;
  }

  modelConfig(model) {
    const manifest = model?.manifest;
    if (!manifest || manifest.id !== model.id || manifest.fingerprint !== model.fingerprint) {
      throw new DesktopError("LOCAL_SEARCH_MODEL_MANIFEST_INVALID", "模型清单与注册信息不一致");
    }
    const root = manifest.relativeRoot === "."
      ? path.resolve(this.modelRoot)
      : this.resolveManifestPath(this.modelRoot, manifest.relativeRoot);
    const vision = manifest.vision;
    if (!vision?.modelPath) throw new DesktopError("LOCAL_SEARCH_MODEL_MANIFEST_INVALID", "图像模型清单不完整");
    const config = {
      id: model.id,
      fingerprint: model.fingerprint,
      dimensions: model.dimensions,
      kind: model.kind,
      supportsText: model.supportsText,
      builtin: model.builtin,
      vision: {
        ...vision,
        colorOrder: vision.colorOrder || vision.colorSpace || "RGB",
        modelPath: this.resolveManifestPath(root, vision.modelPath),
        modelRoot: this.resolveManifestPath(root, vision.modelRoot || path.posix.dirname(vision.modelPath)),
        externalData: (vision.externalData || []).map((filePath) => ({
          path: path.posix.basename(filePath),
          data: this.resolveManifestPath(root, filePath),
        })),
      },
      text: null,
    };
    if (manifest.text) {
      config.text = {
        ...manifest.text,
        modelPath: this.resolveManifestPath(root, manifest.text.modelPath),
        modelRoot: this.resolveManifestPath(root, manifest.text.modelRoot || path.posix.dirname(manifest.text.modelPath)),
        tokenizerRoot: this.resolveManifestPath(root, manifest.text.tokenizerRoot || manifest.text.modelRoot),
        externalData: (manifest.text.externalData || []).map((filePath) => ({
          path: path.posix.basename(filePath),
          data: this.resolveManifestPath(root, filePath),
        })),
      };
    }
    return config;
  }

  recordGpuCompatibility(modelId, status) {
    const model = this.storage.getModel(modelId);
    if (!model || !status) return;
    const provider = status.visionProvider || status.executionProvider || "cpu";
    this.storage.updateModelStatus(modelId, model.status === "missing" ? "missing" : "ready", {
      gpuCompatibility: {
        status: provider === "dml" ? "compatible" : "cpu-only",
        deviceId: Number.isInteger(status.deviceId) ? status.deviceId : null,
        deviceName: typeof status.deviceName === "string" ? status.deviceName : null,
        batchSize: Number.isInteger(status.batchSize) ? status.batchSize : 1,
        fallbackReason: status.fallbackReason || null,
        checkedAt: new Date().toISOString(),
      },
    });
  }

  async getModelStatus() {
    const status = await this.models.inspect();
    this.storage.updateModelStatus(BUILTIN_MODEL_ID, status.ready ? "ready" : status.state === "downloading" ? "downloading" : "missing");
    if (status.ready || status.state === "missing") this.modelInspectionCache.set(BUILTIN_MODEL_ID, status);
    return { ...status, activeModelId: this.storage.getActiveModelId() };
  }

  async listModels() {
    await this.getModelStatus();
    const activeModel = this.storage.getModel(this.storage.getActiveModelId());
    if (activeModel && !activeModel.builtin) {
      await this.inspectRegisteredModel(activeModel, { force: true });
    }
    return {
      models: this.storage.listModels().map(publicModel),
      activeModelId: this.storage.getActiveModelId(),
    };
  }

  async downloadModel() {
    this.assertModelIdle();
    this.models.startDownload();
    this.modelInspectionCache.delete(BUILTIN_MODEL_ID);
    return this.getModelStatus();
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

  async cleanupExpiredValidations({ all = false } = {}) {
    const now = Date.now();
    const removals = [];
    for (const [validationId, validation] of this.validations) {
      if (!all && now - validation.createdAt < VALIDATION_TTL_MS) continue;
      this.validations.delete(validationId);
      removals.push(rm(validation.stagingRoot, { recursive: true, force: true }));
    }
    await Promise.allSettled(removals);
  }

  async selectOnnxTower(title) {
    const result = await this.dialog.showOpenDialog(this.getWindow(), {
      title,
      buttonLabel: "选择并校验",
      properties: ["openFile", "multiSelections"],
      filters: ONNX_FILTER,
    });
    return result.canceled || !result.filePaths?.length ? null : result.filePaths;
  }

  async validateModel(payload) {
    const request = requireRecord(payload);
    if (request.modelId && request.source !== "dialog") {
      const modelId = requireModelId(request.modelId);
      const model = this.storage.getModel(modelId);
      if (!model) throw new DesktopError("LOCAL_SEARCH_MODEL_NOT_FOUND", "模型不存在");
      const inspection = await this.models.validateInstalledManifest(model.manifest);
      this.storage.updateModelStatus(modelId, inspection.ready ? "ready" : "missing");
      this.modelInspectionCache.set(modelId, inspection);
      return { valid: inspection.ready, inspection, model: publicModel(this.storage.getModel(modelId)) };
    }
    this.assertModelIdle();
    await this.cleanupExpiredValidations();
    const type = request.type === "image-text" ? "image-text" : request.type === "image" ? "image" : null;
    if (!type) throw new DesktopError("LOCAL_SEARCH_MODEL_TYPE_INVALID", "请选择图像模型或图文双塔模型");
    const visionFiles = await this.selectOnnxTower("选择图像 ONNX 模型；如有外部数据请一并多选");
    if (!visionFiles) return { canceled: true };
    let textFiles = [];
    let tokenizerRoot = null;
    if (type === "image-text") {
      textFiles = await this.selectOnnxTower("选择文字 ONNX 模型；如有外部数据请一并多选");
      if (!textFiles) return { canceled: true };
      const tokenizer = await this.dialog.showOpenDialog(this.getWindow(), {
        title: "选择 Transformers.js tokenizer 文件夹",
        buttonLabel: "使用此 tokenizer",
        properties: ["openDirectory"],
      });
      if (tokenizer.canceled || !tokenizer.filePaths?.[0]) return { canceled: true };
      tokenizerRoot = tokenizer.filePaths[0];
    }
    try {
      const validation = await this.models.prepareCustomValidation({
        type,
        preprocessing: request.preprocessing,
        visionFiles,
        textFiles,
        tokenizerRoot,
      });
      const validationId = randomUUID();
      this.validations.set(validationId, { ...validation, createdAt: Date.now() });
      return {
        canceled: false,
        valid: true,
        validationId,
        files: validation.files.map((file) => ({
          role: file.role,
          name: path.posix.basename(file.path),
          size: file.size,
          sha256: file.sha256,
        })),
        inspection: validation.inspection,
      };
    } catch (error) {
      throw new DesktopError(
        "LOCAL_SEARCH_MODEL_VALIDATION_FAILED",
        `ONNX 模型校验失败：${safeModelErrorCode(error)}`,
      );
    }
  }

  async importBuiltinPackage() {
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
      this.modelInspectionCache.delete(BUILTIN_MODEL_ID);
      this.storage.updateModelStatus(BUILTIN_MODEL_ID, "ready");
      return { canceled: false, imported: true, ...(await this.models.inspect()) };
    } catch {
      throw new DesktopError("LOCAL_SEARCH_MODEL_IMPORT_FAILED", "离线模型包无效、版本不匹配或文件已损坏");
    } finally {
      this.connectEngine();
    }
  }

  async importModel(payload) {
    this.assertModelIdle();
    if (payload === undefined || payload === null) return this.importBuiltinPackage();
    const request = requireRecord(payload);
    if (request.kind !== "custom") return this.importBuiltinPackage();
    const validationId = requireId(request.validationId, "模型校验 ID");
    await this.cleanupExpiredValidations();
    const validation = this.validations.get(validationId);
    if (!validation) throw new DesktopError("LOCAL_SEARCH_MODEL_VALIDATION_EXPIRED", "模型校验已过期，请重新选择文件");
    this.validations.delete(validationId);
    let installResult = null;
    try {
      installResult = await this.models.installValidated(validation, {
        name: request.name,
        license: request.license,
      });
      const { manifest } = installResult;
      const model = this.storage.upsertModel(manifest, { status: "ready" });
      await this.models.commitInstall(installResult).catch(() => {});
      this.modelInspectionCache.set(model.id, { ready: true, state: "ready", totalBytes: model.totalBytes, error: null });
      return { canceled: false, imported: true, model: publicModel(model) };
    } catch (error) {
      await this.models.rollbackInstall(installResult).catch(() => {});
      await rm(validation.stagingRoot, { recursive: true, force: true });
      throw new DesktopError(
        "LOCAL_SEARCH_MODEL_IMPORT_FAILED",
        `自定义模型安装失败：${safeModelErrorCode(error)}`,
      );
    }
  }

  async exportModel() {
    this.assertModelIdle();
    await this.ensureModelReady(BUILTIN_MODEL_ID);
    const result = await this.dialog.showSaveDialog(this.getWindow(), {
      title: "导出内置本地 AI 离线模型包",
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

  async removeModel(payload) {
    this.assertModelIdle();
    const modelId = payload === undefined || payload === null
      ? BUILTIN_MODEL_ID
      : requireModelId(requireRecord(payload).modelId);
    const model = this.storage.getModel(modelId);
    if (!model) return { removed: false, sourceFilesDeleted: false };
    this.unsubscribeProgress();
    await this.engine.dispose();
    let removal = null;
    try {
      removal = await this.models.stageRemoval(model.manifest);
      let removed;
      try {
        removed = this.storage.removeModelData(modelId);
      } catch (error) {
        await this.models.rollbackRemoval(removal);
        removal = null;
        throw error;
      }
      const committedRemoval = removal;
      removal = null;
      await this.models.commitRemoval(committedRemoval).catch(() => {});
      this.modelInspectionCache.delete(modelId);
      const legacyStatus = model.builtin ? await this.models.inspect() : {};
      return {
        removed: true,
        sourceFilesDeleted: false,
        modelId,
        ...removed,
        ...legacyStatus,
      };
    } finally {
      if (removal) await this.models.rollbackRemoval(removal).catch(() => {});
      this.connectEngine();
    }
  }

  async setActiveModel(payload) {
    this.assertModelIdle();
    const modelId = requireModelId(requireRecord(payload).modelId);
    const model = await this.ensureModelReady(modelId, { force: true });
    this.storage.setActiveModelId(modelId);
    return { activeModelId: modelId, model: publicModel(this.storage.getModel(model.id)) };
  }

  async getEngineStatus(payload) {
    const request = payload === undefined ? {} : requireRecord(payload);
    const modelId = this.activeModelId(request.modelId);
    const model = await this.ensureModelReady(modelId);
    try {
      const status = await this.engine.request("status", { modelId, modelConfig: this.modelConfig(model) });
      this.recordGpuCompatibility(modelId, status);
      return status;
    } catch {
      const status = {
        modelId,
        visionProvider: "cpu",
        textProvider: "cpu",
        deviceId: null,
        batchSize: 1,
        fallbackReason: "ENGINE_STATUS_UNAVAILABLE",
      };
      this.recordGpuCompatibility(modelId, status);
      return status;
    }
  }

  listLibraries() {
    return this.storage.listLibraries(this.storage.getActiveModelId());
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
    if ([...this.jobs.values()].some((job) => job.state === "indexing")) {
      throw new DesktopError("LOCAL_SEARCH_JOB_BUSY", "请等待图库分析完成或先停止任务，再删除图库索引");
    }
    await this.engine.request("invalidate", { libraryId });
    const removed = this.storage.removeLibrary(libraryId);
    await rm(path.join(this.thumbnailRoot, libraryId), { recursive: true, force: true });
    return { removed, sourceFilesDeleted: false };
  }

  async startIndex(payload) {
    const request = requireRecord(payload);
    const libraryId = requireId(request.libraryId, "图库 ID");
    const modelId = this.activeModelId(request.modelId);
    if (!this.storage.getLibrary(libraryId, { modelId })) throw new DesktopError("LOCAL_SEARCH_LIBRARY_NOT_FOUND", "图库不存在");
    const model = await this.ensureModelReady(modelId);
    this.storage.ensureLibraryModel(libraryId, modelId);
    for (const job of this.jobs.values()) {
      if (job.state !== "indexing") continue;
      if (job.libraryId === libraryId && job.modelId === modelId) return { jobId: job.jobId, reused: true };
      throw new DesktopError("LOCAL_SEARCH_JOB_BUSY", "当前已有图库分析任务，请等待完成或先停止任务");
    }
    const jobId = randomUUID();
    const job = {
      jobId,
      libraryId,
      modelId,
      modelFingerprint: model.fingerprint,
      state: "indexing",
      stage: "scanning",
      scanned: 0,
      analyzed: 0,
      reused: 0,
      skipped: 0,
      errors: 0,
      imagesPerSecond: 0,
      etaSeconds: null,
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    this.jobs.set(jobId, job);
    this.engine.request("index", { jobId, libraryId, modelId, modelConfig: this.modelConfig(model) }).then(
      (result) => {
        Object.assign(job, result, { updatedAt: new Date().toISOString() });
        this.recordGpuCompatibility(modelId, result);
      },
      (error) => {
        Object.assign(job, {
          state: "error",
          error: "分析失败，请检查模型或图片后重试",
          fallbackReason: job.fallbackReason || safeModelErrorCode(error),
          updatedAt: new Date().toISOString(),
        });
        this.recordGpuCompatibility(modelId, job);
      },
    );
    return { jobId, reused: false, modelId };
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
    const modelId = this.activeModelId(request.modelId);
    const text = typeof request.text === "string" ? request.text.trim() : "";
    if (!text || text.length > 200) throw new DesktopError("LOCAL_SEARCH_TEXT_INVALID", "请输入 1–200 个字符");
    const model = await this.assertSearchable(libraryId, modelId);
    if (!model.supportsText) throw new DesktopError("LOCAL_SEARCH_TEXT_MODEL_UNSUPPORTED", "当前模型仅支持图片相似搜索");
    return this.engine.request("searchText", {
      libraryId,
      modelId,
      modelConfig: this.modelConfig(model),
      text,
      limit: DEFAULT_RESULT_LIMIT,
    });
  }

  async searchByImage(payload) {
    const request = requireRecord(payload);
    const libraryId = requireId(request.libraryId, "图库 ID");
    const modelId = this.activeModelId(request.modelId);
    const bytes = toBoundedBuffer(request.data, QUERY_MAX_BYTES, "LOCAL_SEARCH_QUERY_TOO_LARGE");
    const metadata = await sharp(bytes, { pages: 1, limitInputPixels: QUERY_MAX_PIXELS }).metadata();
    if (!metadata.width || !metadata.height || metadata.width * metadata.height > QUERY_MAX_PIXELS) {
      throw new DesktopError("LOCAL_SEARCH_QUERY_PIXELS_EXCEEDED", "查询图片不得超过 5000 万像素");
    }
    const model = await this.assertSearchable(libraryId, modelId);
    return this.engine.request("searchImage", {
      libraryId,
      modelId,
      modelConfig: this.modelConfig(model),
      bytes,
      limit: DEFAULT_RESULT_LIMIT,
    });
  }

  async assertSearchable(libraryId, modelId) {
    const library = this.storage.getLibrary(libraryId, { modelId });
    if (!library || library.itemCount < 1) throw new DesktopError("LOCAL_SEARCH_LIBRARY_EMPTY", "请先用当前模型完成图库分析");
    return this.ensureModelReady(modelId);
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
    await this.cleanupExpiredValidations({ all: true });
    this.storage.close();
  }
}
