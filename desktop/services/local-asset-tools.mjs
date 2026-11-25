import { createHash, randomUUID } from "node:crypto";

import { DesktopError, isPlainRecord } from "../shared/core.mjs";
import {
  createLocalAssetOutputFolder,
  isLocalNamingImage,
  readLocalAsset,
  requireExportComponent,
  requireExportFilename,
  scanLocalAssetDirectory,
  scanLocalAssetFiles,
  writeLocalAssetCopy,
} from "./local-asset-files.mjs";

const MAX_SOURCES = 20;
const MAX_JOBS = 30;
const MAX_JOB_FILES = 200;
const MAX_PAGE_SIZE = 200;
const SOURCE_TTL_MS = 8 * 60 * 60 * 1000;
const FINISHED_JOB_TTL_MS = 60 * 60 * 1000;
const JOB_RUNNING = new Set(["queued", "running"]);
const ID_SCHEMA = { type: "string", minLength: 1, maxLength: 80 };
const RELATIVE_PATH_SCHEMA = { type: "string", minLength: 1, maxLength: 1024 };
const EMPTY_OBJECT_SCHEMA = { type: "object", additionalProperties: false, properties: {} };

function schema(properties, required = []) {
  return { ...EMPTY_OBJECT_SCHEMA, properties, required };
}

const startProperties = {
  sourceId: ID_SCHEMA,
  relativePaths: { type: "array", minItems: 1, maxItems: MAX_JOB_FILES, uniqueItems: true, items: RELATIVE_PATH_SCHEMA },
};
const startNamingSchema = schema({ ...startProperties, mode: { enum: ["ai", "local"] } }, ["sourceId"]);
const startSliceSchema = schema(startProperties, ["sourceId"]);
const jobSchema = schema({ jobId: ID_SCHEMA }, ["jobId"]);
const editSchema = schema({ relativePath: RELATIVE_PATH_SCHEMA, name: { type: "string", minLength: 1, maxLength: 240 } }, ["relativePath", "name"]);

function recordWithKeys(value, allowed) {
  if (!isPlainRecord(value) || Object.keys(value).some((key) => !Object.hasOwn(allowed, key))) {
    throw new DesktopError("LOCAL_ASSET_ARGUMENTS_INVALID", "请求参数不正确");
  }
}

function safeText(value, max = 240) {
  return typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, max) : "";
}

function safeList(values) {
  return Array.isArray(values) ? values.slice(0, MAX_JOB_FILES).map((item) => safeText(item, 1024)).filter(Boolean) : [];
}

function sourceSummary(source) {
  return { sourceId: source.id, name: source.name, fileCount: source.files.size };
}

function jobSnapshot(job) {
  return {
    jobId: job.id,
    type: job.type,
    mode: job.mode,
    status: job.status,
    processed: job.processed,
    total: job.files.length,
    results: [...job.results],
    ...(job.profileName ? { profileName: job.profileName } : {}),
    ...(job.error ? { error: job.error } : {}),
  };
}

function assetFailure(type, relativePath, message) {
  if (type === "naming") return { relativePath, status: "failed", recommendations: [], proposedName: "", message };
  return { relativePath, width: 0, height: 0, format: "", issues: [message], warnings: [], similarNames: [] };
}

function rendererResult(type, file, result) {
  if (!isPlainRecord(result)) return assetFailure(type, file.relativePath, "未收到处理结果");
  if (type === "slice_check") {
    return {
      relativePath: file.relativePath,
      width: Number.isSafeInteger(result.width) && result.width > 0 ? result.width : 0,
      height: Number.isSafeInteger(result.height) && result.height > 0 ? result.height : 0,
      format: safeText(result.format),
      issues: safeList(result.issues),
      warnings: safeList(result.warnings),
      similarNames: safeList(result.similarNames),
    };
  }
  if (!["done", "fallback"].includes(result.status)) {
    return assetFailure(type, file.relativePath, safeText(result.message) || "未生成可用的推荐名称");
  }
  try {
    return {
      relativePath: file.relativePath,
      status: result.status,
      recommendations: safeList(result.recommendations).slice(0, 5),
      proposedName: requireExportFilename(result.proposedName, file.name),
      projectFolder: requireExportComponent(result.projectFolder),
      ...(result.message ? { message: safeText(result.message) } : {}),
    };
  } catch {
    return assetFailure(type, file.relativePath, "当前工程或推荐名称不能作为导出文件名");
  }
}

function digestAsset(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function createLocalAssetTools({ dialog, getWindow, runRenderer, now = Date.now }) {
  const sources = new Map();
  const jobs = new Map();
  const activeExports = new Set();
  let disposed = false;
  let dialogActive = false;
  let activeJob = null;
  let session = new AbortController();

  function ensureActive() {
    if (disposed) throw new DesktopError("LOCAL_ASSET_DISABLED", "本地资源服务已关闭");
  }

  async function showDialog(kind, options) {
    ensureActive();
    if (dialogActive) throw new DesktopError("LOCAL_ASSET_DIALOG_BUSY", "请先完成桌面上的选择或确认");
    const window = getWindow();
    if (!window || window.isDestroyed()) {
      throw new DesktopError("LOCAL_ASSET_WINDOW_UNAVAILABLE", "请打开 AI资源领航桌面窗口");
    }
    dialogActive = true;
    try {
      return await dialog[kind](window, options);
    } finally {
      dialogActive = false;
    }
  }

  function prune() {
    for (const [id, source] of sources) {
      if (source.createdAt + SOURCE_TTL_MS <= now()) sources.delete(id);
    }
    for (const [id, job] of jobs) {
      if (job.finishedAt && job.finishedAt + FINISHED_JOB_TTL_MS <= now() && !activeExports.has(id)) jobs.delete(id);
    }
  }

  async function grantSources(args, signal) {
    recordWithKeys(args, { kind: true });
    const kind = args.kind ?? "directory";
    if (!["files", "directory"].includes(kind)) {
      throw new DesktopError("LOCAL_ASSET_GRANT_INVALID", "请选择文件或目录");
    }
    if (sources.size >= MAX_SOURCES) {
      throw new DesktopError("LOCAL_ASSET_SOURCE_LIMIT", "已达到本次可授权的资源来源数量");
    }
    const picked = await showDialog("showOpenDialog", kind === "directory" ? {
      title: "选择要检查或命名的切图目录（含子目录）",
      properties: ["openDirectory", "dontAddToRecent"],
    } : {
      title: "选择要检查或命名的切图文件",
      properties: ["openFile", "multiSelections", "dontAddToRecent"],
    });
    signal.throwIfAborted();
    if (picked.canceled || !picked.filePaths.length) return { canceled: true, sources: [] };
    let source;
    try {
      source = kind === "directory"
        ? await scanLocalAssetDirectory(picked.filePaths[0], signal)
        : await scanLocalAssetFiles(picked.filePaths, signal);
    } catch (error) {
      signal.throwIfAborted();
      if (error instanceof DesktopError) throw error;
      throw new DesktopError("LOCAL_ASSET_SOURCE_UNREADABLE", "无法读取所选资源，请重新选择");
    }
    signal.throwIfAborted();
    if (sources.size >= MAX_SOURCES) {
      throw new DesktopError("LOCAL_ASSET_SOURCE_LIMIT", "已达到本次可授权的资源来源数量");
    }
    if (!source.files.length) throw new DesktopError("LOCAL_ASSET_SOURCE_EMPTY", "所选位置没有可用的文件");
    const grant = {
      id: randomUUID(),
      name: source.name,
      createdAt: now(),
      files: new Map(source.files.map((file) => [file.relativePath, file])),
    };
    sources.set(grant.id, grant);
    return { canceled: false, sources: [sourceSummary(grant)] };
  }

  function requireSource(id) {
    const source = typeof id === "string" && sources.get(id);
    if (!source) throw new DesktopError("LOCAL_ASSET_SOURCE_REQUIRED", "来源授权已失效，请在桌面重新选择资源");
    return source;
  }

  function listSources(args) {
    recordWithKeys(args, { sourceId: true, offset: true, limit: true });
    const summaries = [...sources.values()].map(sourceSummary);
    if (args.sourceId === undefined) return { sources: summaries };
    const source = requireSource(args.sourceId);
    const offset = args.offset ?? 0;
    const limit = args.limit ?? 50;
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) {
      throw new DesktopError("LOCAL_ASSET_PAGE_INVALID", "文件列表分页参数无效");
    }
    return {
      sources: summaries,
      total: source.files.size,
      files: [...source.files.values()].slice(offset, offset + limit)
        .map(({ relativePath, stats }) => ({ relativePath, size: Number(stats.size) })),
    };
  }

  function requireJob(id) {
    const job = typeof id === "string" && jobs.get(id);
    if (!job) throw new DesktopError("LOCAL_ASSET_JOB_NOT_FOUND", "任务不存在或已过期");
    return job;
  }

  function selectFiles(source, relativePaths, type) {
    let files;
    if (relativePaths === undefined) {
      files = [...source.files.values()];
      if (type === "naming") files = files.filter(({ name }) => isLocalNamingImage(name));
    } else {
      if (!Array.isArray(relativePaths) || new Set(relativePaths).size !== relativePaths.length || relativePaths.length > MAX_JOB_FILES) {
        throw new DesktopError("LOCAL_ASSET_SELECTION_INVALID", "请最多选择 " + MAX_JOB_FILES + " 个不同的文件");
      }
      files = relativePaths.map((relativePath) => {
        const file = typeof relativePath === "string" && source.files.get(relativePath);
        if (!file) throw new DesktopError("LOCAL_ASSET_FILE_NOT_GRANTED", "文件不在已授权来源内");
        return file;
      });
    }
    if (!files.length || files.length > MAX_JOB_FILES) {
      throw new DesktopError("LOCAL_ASSET_SELECTION_INVALID", "请为本次任务选择 1 至 " + MAX_JOB_FILES + " 个文件");
    }
    return files;
  }

  function cancelJob(job) {
    if (JOB_RUNNING.has(job.status)) {
      job.status = "cancelled";
      job.finishedAt = now();
      job.controller?.abort();
    }
    return jobSnapshot(job);
  }

  async function approveAi(source, files, provider, signal) {
    const endpoint = safeText(provider?.endpoint, 2048);
    if (!endpoint) throw new DesktopError("LOCAL_ASSET_PROVIDER_REQUIRED", "请先在桌面设置可用的 AI 命名服务");
    const response = await showDialog("showMessageBox", {
      type: "question",
      title: "确认 AI 命名",
      message: "允许将选中的图片发送给当前 AI 服务？",
      detail: [
        "来源：" + safeText(source.name) + " · " + files.length + " 个文件",
        "服务：" + safeText(provider.name) + " " + endpoint,
        "模型：" + safeText(provider.model),
        "请求会包含选中图片、原始文件名及当前命名方案中的词库、项目说明和提示词，可能产生模型服务费用。",
      ].join("\n"),
      buttons: ["取消", "允许本次发送"],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    signal.throwIfAborted();
    return response.response === 1;
  }

  async function runJob(job, source) {
    const signal = job.controller.signal;
    const callRenderer = (action, data) => runRenderer(action, { contextId: job.id, type: job.type, ...data }, { signal });
    let prepared = false;
    try {
      signal.throwIfAborted();
      job.status = "running";
      const settings = await callRenderer(job.type === "naming" ? "prepare_naming" : "prepare_slice_check", { mode: job.mode });
      prepared = true;
      signal.throwIfAborted();
      job.profileName = safeText(settings?.profileName);
      if (job.mode === "ai" && !(await approveAi(source, job.files, settings?.provider, signal))) {
        cancelJob(job);
        return;
      }
      for (const file of job.files) {
        signal.throwIfAborted();
        try {
          if (job.type === "naming" && !isLocalNamingImage(file.name)) {
            throw new DesktopError("LOCAL_ASSET_FORMAT_UNSUPPORTED", "命名支持 PNG、JPEG、WebP、GIF 和 SVG");
          }
          const bytes = await readLocalAsset(file, signal);
          await callRenderer("inspect_file", {
            relativePath: file.relativePath,
            name: file.name,
            bytes,
            size: bytes.length,
          });
          if (job.type === "naming") job.digests.set(file.relativePath, digestAsset(bytes));
          job.inspected.add(file.relativePath);
        } catch (error) {
          signal.throwIfAborted();
          if (!(error instanceof DesktopError) || error.code.startsWith("LOCAL_ASSET_RENDERER_")) throw error;
          job.results.push(assetFailure(job.type, file.relativePath, error.message));
        }
        job.processed += 1;
      }
      signal.throwIfAborted();
      const relativePaths = [...job.inspected];
      const finalized = relativePaths.length ? await callRenderer("finalize_job", { relativePaths }) : [];
      const byPath = new Map(Array.isArray(finalized) ? finalized.map((result) => [result?.relativePath, result]) : []);
      const failed = new Map(job.results.map((result) => [result.relativePath, result]));
      job.results = job.files.map((file) => failed.get(file.relativePath) || rendererResult(job.type, file, byPath.get(file.relativePath)));
      signal.throwIfAborted();
      job.status = "completed";
      job.finishedAt = now();
    } catch (error) {
      if (!signal.aborted) {
        job.status = "failed";
        job.error = error instanceof DesktopError ? error.message : "处理失败，请检查桌面设置后重试";
        job.finishedAt = now();
      }
    } finally {
      if (activeJob === job) activeJob = null;
      if (prepared) {
        void Promise.resolve().then(() => runRenderer("release_job", { contextId: job.id, type: job.type }))
          .catch(() => {});
      }
      job.controller = null;
    }
  }

  function startJob(type, args) {
    const spec = type === "naming" ? startNamingSchema : startSliceSchema;
    recordWithKeys(args, spec.properties);
    if (activeJob) throw new DesktopError("LOCAL_ASSET_JOB_BUSY", "请等当前任务结束后再启动");
    const source = requireSource(args.sourceId);
    const mode = type === "naming" ? args.mode ?? "local" : undefined;
    if (type === "naming" && !["local", "ai"].includes(mode)) {
      throw new DesktopError("LOCAL_ASSET_NAMING_MODE_INVALID", "请选择本地命名或 AI 命名");
    }
    const files = selectFiles(source, args.relativePaths, type);
    if (jobs.size >= MAX_JOBS) {
      const oldest = [...jobs.values()].find((job) => !JOB_RUNNING.has(job.status) && !activeExports.has(job.id));
      if (oldest) jobs.delete(oldest.id);
      else throw new DesktopError("LOCAL_ASSET_JOB_LIMIT", "已达到本次任务数量上限");
    }
    const job = {
      id: randomUUID(),
      type,
      mode,
      files,
      status: "queued",
      processed: 0,
      results: [],
      digests: new Map(),
      inspected: new Set(),
      controller: new AbortController(),
    };
    jobs.set(job.id, job);
    activeJob = job;
    void Promise.resolve().then(() => runJob(job, source));
    return jobSnapshot(job);
  }

  async function exportCopies(args, signal) {
    recordWithKeys(args, { jobId: true, edits: true });
    const job = requireJob(args.jobId);
    if (job.status !== "completed" || job.type !== "naming") {
      throw new DesktopError("LOCAL_ASSET_EXPORT_JOB_INVALID", "请先完成资源命名");
    }
    if (activeExports.has(job.id)) throw new DesktopError("LOCAL_ASSET_EXPORT_BUSY", "此任务正在导出");
    const inputEdits = args.edits ?? [];
    if (!Array.isArray(inputEdits) || inputEdits.length > MAX_JOB_FILES) {
      throw new DesktopError("LOCAL_ASSET_EXPORT_EDITS_INVALID", "导出名称修改无效");
    }
    const inputFiles = new Map(job.files.map((file) => [file.relativePath, file]));
    const edits = new Map();
    const exportableByPath = new Map(job.results.filter((result) => result.proposedName).map((result) => [result.relativePath, result]));
    for (const edit of inputEdits) {
      recordWithKeys(edit, editSchema.properties);
      const file = inputFiles.get(edit.relativePath);
      if (!file || !exportableByPath.has(edit.relativePath) || edits.has(edit.relativePath)) {
        throw new DesktopError("LOCAL_ASSET_EXPORT_EDITS_INVALID", "修改项须对应此任务中有命名结果的文件");
      }
      edits.set(edit.relativePath, requireExportFilename(edit.name, file.name));
    }
    const destinations = new Set();
    const candidates = job.results.map((result) => {
      if (!result.proposedName) return { relativePath: result.relativePath, status: "skipped", message: "此文件没有可导出的名称" };
      const name = edits.get(result.relativePath) || result.proposedName;
      const key = (result.projectFolder + "/" + name).toLowerCase();
      if (destinations.has(key)) throw new DesktopError("LOCAL_ASSET_EXPORT_DUPLICATE", "有多个文件使用相同的导出名称，请先修改");
      destinations.add(key);
      return { relativePath: result.relativePath, projectFolder: result.projectFolder, name };
    });
    if (!destinations.size) throw new DesktopError("LOCAL_ASSET_EXPORT_EMPTY", "此任务没有可导出的文件");
    activeExports.add(job.id);
    try {
      const picked = await showDialog("showOpenDialog", {
        title: "选择导出位置（将新建文件夹并写入 " + destinations.size + " 个副本）",
        properties: ["openDirectory", "createDirectory", "dontAddToRecent"],
      });
      signal.throwIfAborted();
      if (picked.canceled || !picked.filePaths.length) return { canceled: true, files: [] };
      const folder = await createLocalAssetOutputFolder(picked.filePaths[0], signal);
      const files = [];
      for (const candidate of candidates) {
        signal.throwIfAborted();
        if (candidate.status === "skipped") {
          files.push(candidate);
          continue;
        }
        const { relativePath, projectFolder, name } = candidate;
        try {
          const bytes = await readLocalAsset(inputFiles.get(relativePath), signal);
          signal.throwIfAborted();
          if (digestAsset(bytes) !== job.digests.get(relativePath)) {
            throw new DesktopError("LOCAL_ASSET_SOURCE_CHANGED", "源文件已修改，请重新命名");
          }
          const exportPath = await writeLocalAssetCopy(folder, projectFolder, name, bytes, signal);
          files.push({ relativePath, status: "copied", exportPath });
        } catch (error) {
          signal.throwIfAborted();
          files.push({
            relativePath,
            status: "failed",
            message: error instanceof DesktopError ? error.message : "写入副本失败",
          });
        }
      }
      return { canceled: false, files };
    } finally {
      activeExports.delete(job.id);
    }
  }

  const methods = new Map([
    ["list_sources", listSources],
    ["start_naming", (args) => startJob("naming", args)],
    ["start_slice_check", (args) => startJob("slice_check", args)],
    ["get_asset_job", (args) => {
      recordWithKeys(args, jobSchema.properties);
      return jobSnapshot(requireJob(args.jobId));
    }],
    ["cancel_asset_job", (args) => {
      recordWithKeys(args, jobSchema.properties);
      return cancelJob(requireJob(args.jobId));
    }],
    ["export_named_copies", exportCopies],
    ["grant_sources", grantSources],
  ]);

  async function invoke(method, args = {}, { signal: requestSignal } = {}) {
    ensureActive();
    const signal = requestSignal ? AbortSignal.any([session.signal, requestSignal]) : session.signal;
    signal.throwIfAborted();
    prune();
    const handler = methods.get(method);
    if (!handler) throw new DesktopError("LOCAL_ASSET_METHOD_INVALID", "资源操作不存在");
    return handler(args, signal);
  }

  const tools = [
    ["list_sources", "列出通过 AI资源领航本机页面选择的资源来源和相对路径。", schema({
      sourceId: ID_SCHEMA,
      offset: { type: "integer", minimum: 0 },
      limit: { type: "integer", minimum: 1, maximum: MAX_PAGE_SIZE },
    })],
    ["start_naming", "为已授权的切图启动命名任务。AI 模式需要在桌面确认发送。", startNamingSchema],
    ["start_slice_check", "用桌面当前规则检查已授权切图。", startSliceSchema],
    ["get_asset_job", "查看资源任务进度与处理结果。", jobSchema],
    ["cancel_asset_job", "终止尚未完成的资源任务。", jobSchema],
    ["export_named_copies", "打开桌面文件夹选择器，把命名结果导出为副本。", schema({
      jobId: ID_SCHEMA,
      edits: { type: "array", maxItems: MAX_JOB_FILES, items: editSchema },
    }, ["jobId"])],
  ].map(([name, description, inputSchema]) => ({
    name,
    description,
    inputSchema,
    run: (args, options) => invoke(name, args, options),
  }));

  function reset() {
    session.abort();
    session = new AbortController();
    if (activeJob) cancelJob(activeJob);
    sources.clear();
    jobs.clear();
  }

  function dispose() {
    disposed = true;
    reset();
  }

  return { tools, invoke, reset, dispose };
}

