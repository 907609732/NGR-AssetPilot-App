import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, realpath, rename, rm, stat } from "node:fs/promises";
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
  BUILTIN_MODEL_CATALOG,
  BUILTIN_MODEL_ID,
  LocalModelManager,
} from "./model-manager.mjs";
import { LocalImageSearchStorage } from "./storage.mjs";

const ID_PATTERN = /^[a-f0-9-]{16,64}$/i;
const MODEL_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/i;
const VALIDATION_TTL_MS = 30 * 60 * 1000;
const THUMBNAIL_CONCURRENCY = 4;
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
  constructor({
    userDataPath,
    dialog,
    shell,
    netFetch,
    getWindow,
    utilityProcess = null,
    onEngineEvent = null,
  }) {
    this.dialog = dialog;
    this.shell = shell;
    this.getWindow = getWindow;
    this.netFetch = netFetch;
    this.utilityProcess = utilityProcess;
    this.onEngineEvent = typeof onEngineEvent === "function" ? onEngineEvent : null;
    this.dataRoot = path.join(userDataPath, "local-image-search");
    this.modelRoot = path.join(this.dataRoot, "models");
    this.thumbnailRoot = path.join(this.dataRoot, "thumbnails");
    this.storage = new LocalImageSearchStorage({ dataRoot: this.dataRoot });
    this.jobs = new Map();
    this.validations = new Map();
    this.modelInspectionCache = new Map();
    this.thumbnailInflight = new Map();
    this.thumbnailActive = 0;
    this.thumbnailWaiters = [];
    this.thumbnailDisposed = false;
    this.builtinManagers = new Map(BUILTIN_MODEL_CATALOG.map((entry) => [
      entry.id,
      new LocalModelManager({
        modelRoot: this.modelRoot,
        fetchImpl: this.netFetch,
        files: entry.files,
        packageModel: entry.createManifest(),
      }),
    ]));
    this.models = this.builtinManagers.get(BUILTIN_MODEL_ID);
    this.connectEngine();
  }

  connectEngine() {
    this.engine = new LocalImageSearchEngine({
      dbPath: this.storage.dbPath,
      modelRoot: this.modelRoot,
      utilityProcess: this.utilityProcess,
      onEvent: this.onEngineEvent,
    });
    this.unsubscribeProgress = this.engine.onProgress((jobId, progress) => {
      const job = this.jobs.get(jobId);
      if (job) Object.assign(job, progress, { updatedAt: new Date().toISOString() });
    });
  }

  activeModelId(requestedId) {
    return requestedId ? requireModelId(requestedId) : this.storage.getActiveModelId();
  }

  managerForModel(modelId) {
    return this.builtinManagers.get(modelId) || this.models;
  }

  async inspectRegisteredModel(model, { force = false } = {}) {
    if (!model) throw new DesktopError("LOCAL_SEARCH_MODEL_NOT_FOUND", "模型不存在");
    if (!force && this.modelInspectionCache.has(model.id)) return this.modelInspectionCache.get(model.id);
    const inspection = model.builtin
      ? await this.managerForModel(model.id).inspect({ force })
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
      legacyCompatibility: manifest.legacyCompatibility === true,
      preprocessingVersion: manifest.indexProfile || manifest.version || "1",
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

  async getModelStatus(payload) {
    const request = payload === undefined ? {} : requireRecord(payload);
    const modelId = request.modelId === undefined ? BUILTIN_MODEL_ID : requireModelId(request.modelId);
    const model = this.storage.getModel(modelId);
    if (!model?.builtin) throw new DesktopError("LOCAL_SEARCH_MODEL_NOT_FOUND", "内置模型不存在");
    const status = await this.managerForModel(modelId).inspect();
    this.storage.updateModelStatus(modelId, status.ready ? "ready" : status.state === "downloading" ? "downloading" : "missing");
    if (status.ready || status.state === "missing") this.modelInspectionCache.set(modelId, status);
    return { ...status, activeModelId: this.storage.getActiveModelId() };
  }

  async listModels() {
    await Promise.all([...this.builtinManagers.keys()].map((modelId) => this.getModelStatus({ modelId })));
    const activeModel = this.storage.getModel(this.storage.getActiveModelId());
    if (activeModel && !activeModel.builtin) {
      await this.inspectRegisteredModel(activeModel, { force: true });
    }
    return {
      models: this.storage.listModels().map(publicModel),
      activeModelId: this.storage.getActiveModelId(),
    };
  }

  async downloadModel(payload) {
    this.assertModelIdle();
    const request = payload === undefined ? {} : requireRecord(payload);
    const modelId = request.modelId === undefined ? BUILTIN_MODEL_ID : requireModelId(request.modelId);
    const model = this.storage.getModel(modelId);
    if (!model?.builtin) throw new DesktopError("LOCAL_SEARCH_MODEL_NOT_FOUND", "内置模型不存在");
    this.managerForModel(modelId).startDownload();
    this.modelInspectionCache.delete(modelId);
    return this.getModelStatus({ modelId });
  }

  async cancelModelDownload(payload) {
    const request = payload === undefined ? {} : requireRecord(payload);
    const modelId = request.modelId === undefined ? BUILTIN_MODEL_ID : requireModelId(request.modelId);
    return { canceled: this.managerForModel(modelId).cancelDownload() };
  }

  assertModelIdle() {
    if ([...this.builtinManagers.values()].some((manager) => ["downloading", "importing", "exporting"].includes(manager.job?.state))) {
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
    try {
      for (const [modelId, manager] of this.builtinManagers) {
        manager.startImport(result.filePaths[0]);
        try {
          await manager.packagePromise;
          this.modelInspectionCache.delete(modelId);
          this.storage.updateModelStatus(modelId, "ready");
          return { canceled: false, imported: true, modelId, ...(await manager.inspect()) };
        } catch {
          // Version 1 packages are retried against the legacy built-in manifest.
        }
      }
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

  async exportModel(payload) {
    this.assertModelIdle();
    const request = payload === undefined ? {} : requireRecord(payload);
    const modelId = request.modelId === undefined ? BUILTIN_MODEL_ID : requireModelId(request.modelId);
    const model = this.storage.getModel(modelId);
    if (!model?.builtin) throw new DesktopError("LOCAL_SEARCH_MODEL_NOT_FOUND", "内置模型不存在");
    await this.ensureModelReady(modelId);
    const result = await this.dialog.showSaveDialog(this.getWindow(), {
      title: "导出内置本地 AI 离线模型包",
      buttonLabel: "导出模型包",
      defaultPath: `NGR-AssetPilot-${model.id}.${MODEL_PACKAGE_EXTENSION}`,
      filters: [{ name: "NGR 本地 AI 模型包", extensions: [MODEL_PACKAGE_EXTENSION] }],
    });
    if (result.canceled || !result.filePath) return { canceled: true };
    const packagePath = path.extname(result.filePath).toLowerCase() === `.${MODEL_PACKAGE_EXTENSION}`
      ? result.filePath
      : `${result.filePath}.${MODEL_PACKAGE_EXTENSION}`;
    try {
      const exported = await this.managerForModel(modelId).exportPackage(packagePath);
      return { canceled: false, exported: true, modelId, ...exported };
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
    const manager = model.builtin ? this.managerForModel(modelId) : this.models;
    const preservePaths = [];
    if (model.builtin) {
      for (const other of this.storage.listModels()) {
        if (!other.builtin || other.id === model.id) continue;
        const inspection = await this.managerForModel(other.id).inspect({ force: true });
        if (inspection.ready) preservePaths.push(...(other.manifest.files || []).map((file) => file.path));
      }
    }
    this.unsubscribeProgress();
    await this.engine.dispose();
    let removal = null;
    try {
      removal = await manager.stageRemoval(model.manifest, { preservePaths });
      let removed;
      try {
        removed = this.storage.removeModelData(modelId);
      } catch (error) {
        await manager.rollbackRemoval(removal);
        removal = null;
        throw error;
      }
      const committedRemoval = removal;
      removal = null;
      await manager.commitRemoval(committedRemoval).catch(() => {});
      this.modelInspectionCache.delete(modelId);
      const legacyStatus = model.builtin ? await manager.inspect({ force: true }) : {};
      return {
        removed: true,
        sourceFilesDeleted: false,
        modelId,
        ...removed,
        ...legacyStatus,
      };
    } finally {
      if (removal) await manager.rollbackRemoval(removal).catch(() => {});
      this.connectEngine();
    }
  }

  async setActiveModel(payload) {
    this.assertModelIdle();
    const modelId = requireModelId(requireRecord(payload).modelId);
    const model = await this.ensureModelReady(modelId, { force: true });
    await this.engine.request("invalidate", {});
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

  async listAssetFolders(payload) {
    const request = requireRecord(payload);
    const libraryId = requireId(request.libraryId, "图库 ID");
    try {
      return await this.engine.request("listAssetFolders", {
        libraryId,
        parentPrefix: request.parentPrefix,
      });
    } catch (error) {
      if (error?.code === "LOCAL_SEARCH_LIBRARY_NOT_FOUND" || error?.message === "LOCAL_SEARCH_LIBRARY_NOT_FOUND") {
        throw new DesktopError("LOCAL_SEARCH_LIBRARY_NOT_FOUND", "图库不存在");
      }
      throw new DesktopError("LOCAL_SEARCH_ASSET_REQUEST_INVALID", "素材文件夹参数无效");
    }
  }

  async listAssets(payload) {
    const request = requireRecord(payload);
    const libraryId = requireId(request.libraryId, "图库 ID");
    try {
      return await this.engine.request("listAssets", {
        libraryId,
        page: request.page,
        pageSize: request.pageSize,
        folderPrefix: request.folderPrefix,
        filter: request.filter,
        sort: request.sort,
      });
    } catch (error) {
      if (error?.code === "LOCAL_SEARCH_LIBRARY_NOT_FOUND" || error?.message === "LOCAL_SEARCH_LIBRARY_NOT_FOUND") {
        throw new DesktopError("LOCAL_SEARCH_LIBRARY_NOT_FOUND", "图库不存在");
      }
      throw new DesktopError("LOCAL_SEARCH_ASSET_REQUEST_INVALID", "素材分页参数无效");
    }
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
      async (result) => {
        await this.engine.request("invalidate", { libraryId }).catch(() => {});
        Object.assign(job, result, { updatedAt: new Date().toISOString() });
        this.recordGpuCompatibility(modelId, result);
      },
      (error) => {
        try {
          this.storage.markIndexPaused(libraryId, modelId, jobId);
        } catch {
          // Worker exits and database failures are reported through the job below.
        }
        Object.assign(job, {
          state: "paused",
          stage: "paused",
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
    if (!library) throw new DesktopError("LOCAL_SEARCH_LIBRARY_NOT_FOUND", "图库不存在");
    if (library.status === "stale") {
      throw new DesktopError("LOCAL_SEARCH_INDEX_STALE", "当前模型索引已过期，请重新分析图库");
    }
    if (library.status !== "ready") {
      throw new DesktopError("LOCAL_SEARCH_INDEX_NOT_READY", "当前模型索引未完成，请继续或重新分析图库");
    }
    if (library.itemCount < 1) throw new DesktopError("LOCAL_SEARCH_LIBRARY_EMPTY", "请先用当前模型完成图库分析");
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
    const thumbnailDirectory = path.join(this.thumbnailRoot, library.id);
    const contentKey = /^[a-f0-9]{64}$/i.test(String(image.sha256 || ""))
      ? String(image.sha256).toLowerCase()
      : `${Math.trunc(Number(image.mtime_ms) || 0)}-${Math.max(0, Number(image.size_bytes) || 0)}`;
    const outputPath = path.join(thumbnailDirectory, `${image.id}-${contentKey}.webp`);
    let task = this.thumbnailInflight.get(outputPath);
    if (!task) {
      task = this.createThumbnail({ absolutePath, imageId: image.id, outputPath, thumbnailDirectory })
        .finally(() => this.thumbnailInflight.delete(outputPath));
      this.thumbnailInflight.set(outputPath, task);
    }
    try {
      const data = await task;
      return { mimeType: "image/webp", data };
    } catch (error) {
      throw new DesktopError("LOCAL_SEARCH_THUMBNAIL_FAILED", "缩略图生成失败", { cause: error });
    }
  }

  async acquireThumbnailSlot() {
    if (this.thumbnailDisposed) throw new Error("LOCAL_SEARCH_DISPOSED");
    if (this.thumbnailActive < THUMBNAIL_CONCURRENCY) {
      this.thumbnailActive += 1;
      return;
    }
    await new Promise((resolve, reject) => this.thumbnailWaiters.push({ resolve, reject }));
  }

  releaseThumbnailSlot() {
    const waiter = this.thumbnailWaiters.shift();
    if (waiter) waiter.resolve();
    else this.thumbnailActive = Math.max(0, this.thumbnailActive - 1);
  }

  async createThumbnail({ absolutePath, imageId, outputPath, thumbnailDirectory }) {
    await mkdir(thumbnailDirectory, { recursive: true });
    const cached = await stat(outputPath).catch(() => null);
    if (!cached?.isFile()) {
      await this.acquireThumbnailSlot();
      // Keep the temporary basename short so deeply nested Windows CI/user-data
      // paths stay below legacy MAX_PATH while the final cache key remains stable.
      const temporaryPath = path.join(thumbnailDirectory, `.${imageId}-${randomUUID().slice(0, 8)}.tmp`);
      try {
        const racedCache = await stat(outputPath).catch(() => null);
        if (!racedCache?.isFile()) {
          await sharp(absolutePath, { pages: 1, limitInputPixels: QUERY_MAX_PIXELS })
            .rotate()
            .resize(320, 240, { fit: "inside", withoutEnlargement: true })
            .webp({ quality: 80 })
            .toFile(temporaryPath);
          await rename(temporaryPath, outputPath);
        }
      } finally {
        await rm(temporaryPath, { force: true }).catch(() => {});
        this.releaseThumbnailSlot();
      }
    }
    const data = await readFile(outputPath);
    const prefix = `${imageId}-`;
    const staleNames = await readdir(thumbnailDirectory).catch(() => []);
    await Promise.all(staleNames
      .filter((name) => name !== path.basename(outputPath) && (name === `${imageId}.webp` || (name.startsWith(prefix) && name.endsWith(".webp"))))
      .map((name) => rm(path.join(thumbnailDirectory, name), { force: true }).catch(() => {})));
    return data;
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
    this.thumbnailDisposed = true;
    for (const waiter of this.thumbnailWaiters.splice(0)) waiter.reject(new Error("LOCAL_SEARCH_DISPOSED"));
    this.unsubscribeProgress();
    await this.engine.dispose();
    await Promise.allSettled([...this.builtinManagers.values()].map((manager) => manager.dispose()));
    await this.cleanupExpiredValidations({ all: true });
    this.storage.close();
  }
}
