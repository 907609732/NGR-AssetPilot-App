import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Worker } from "node:worker_threads";
import { MODEL_FILES, MODEL_TOTAL_BYTES, LOCAL_IMAGE_SEARCH_VERSION } from "./constants.mjs";

async function fileMatches(filePath, expected) {
  try {
    const info = await stat(filePath);
    if (info.size !== expected.size) return false;
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(filePath)) hash.update(chunk);
    return hash.digest("hex") === expected.sha256;
  } catch {
    return false;
  }
}

export class LocalModelManager {
  constructor({ modelRoot, fetchImpl, files = MODEL_FILES }) {
    this.modelRoot = modelRoot;
    this.fetchImpl = fetchImpl;
    this.files = files;
    this.totalBytes = files.reduce((sum, file) => sum + file.size, 0);
    this.job = null;
    this.cachedInspection = null;
  }

  resolveFile(file) {
    return path.join(this.modelRoot, file.model, ...file.relativePath.split("/"));
  }

  async inspect() {
    if (["downloading", "importing"].includes(this.job?.state)) {
      return {
        version: LOCAL_IMAGE_SEARCH_VERSION,
        ready: false,
        state: this.job.state,
        downloadedBytes: this.job.downloadedBytes,
        totalBytes: this.totalBytes || MODEL_TOTAL_BYTES,
        error: null,
      };
    }
    if (this.job?.state === "ready") {
      return {
        version: LOCAL_IMAGE_SEARCH_VERSION,
        ready: true,
        state: "ready",
        downloadedBytes: this.totalBytes,
        totalBytes: this.totalBytes || MODEL_TOTAL_BYTES,
        error: null,
      };
    }
    if (this.cachedInspection && !this.job) return this.cachedInspection;
    let downloadedBytes = 0;
    let ready = true;
    for (const file of this.files) {
      const matches = await fileMatches(this.resolveFile(file), file);
      if (matches) downloadedBytes += file.size;
      else ready = false;
    }
    const result = {
      version: LOCAL_IMAGE_SEARCH_VERSION,
      ready,
      state: this.job?.state || (ready ? "ready" : "missing"),
      downloadedBytes: this.job?.downloadedBytes ?? downloadedBytes,
      totalBytes: this.totalBytes || MODEL_TOTAL_BYTES,
      error: this.job?.error || null,
    };
    if (!this.job) this.cachedInspection = result;
    return result;
  }

  startDownload() {
    if (this.job?.state === "downloading") return;
    const abortController = new AbortController();
    this.cachedInspection = null;
    this.job = { state: "downloading", downloadedBytes: 0, error: null, abortController };
    this.runDownload(abortController.signal).catch((error) => {
      if (error?.name === "AbortError") this.job.state = "canceled";
      else {
        this.job.state = "error";
        this.job.error = "模型下载或校验失败，请重试";
      }
    });
  }

  cancelDownload() {
    if (this.job?.state !== "downloading") return false;
    this.job.abortController.abort();
    return true;
  }

  runPackageWorker(workerData, onProgress = () => {}) {
    return new Promise((resolve, reject) => {
      const worker = new Worker(new URL("./model-package-worker.mjs", import.meta.url), { workerData });
      worker.on("message", (message) => {
        if (message?.type === "progress") onProgress(message.completedBytes);
        else if (message?.type === "complete") resolve(message.result);
        else if (message?.type === "error") reject(new Error(message.code));
      });
      worker.once("error", reject);
      worker.once("exit", (code) => {
        if (code !== 0) reject(new Error("MODEL_PACKAGE_WORKER_FAILED"));
      });
    });
  }

  startImport(packagePath) {
    if (["downloading", "importing", "exporting"].includes(this.job?.state)) return false;
    this.cachedInspection = null;
    this.job = { state: "importing", downloadedBytes: 0, error: null };
    this.packagePromise = this.runImport(packagePath).catch((error) => {
      this.job.state = "error";
      this.job.error = "离线模型包无效、版本不匹配或文件已损坏";
      throw error;
    });
    return true;
  }

  async runImport(packagePath) {
    const parentRoot = path.dirname(this.modelRoot);
    const stagingRoot = path.join(parentRoot, `.models-import-${randomUUID()}`);
    const backupRoot = path.join(parentRoot, `.models-backup-${randomUUID()}`);
    let backedUp = false;
    try {
      await this.runPackageWorker({
        action: "import",
        packagePath,
        stagingRoot,
        files: this.files,
      }, (completedBytes) => { this.job.downloadedBytes = completedBytes; });
      await mkdir(parentRoot, { recursive: true });
      try {
        await rename(this.modelRoot, backupRoot);
        backedUp = true;
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
      await rename(stagingRoot, this.modelRoot);
      await rm(backupRoot, { recursive: true, force: true });
      this.cachedInspection = null;
      this.job.state = "ready";
      this.job.downloadedBytes = this.totalBytes;
      this.job.error = null;
    } catch (error) {
      await rm(stagingRoot, { recursive: true, force: true });
      if (backedUp) {
        await rm(this.modelRoot, { recursive: true, force: true });
        await rename(backupRoot, this.modelRoot).catch(() => {});
      }
      throw error;
    }
  }

  async exportPackage(packagePath) {
    const inspection = await this.inspect();
    if (!inspection.ready) throw new Error("MODEL_NOT_READY");
    const previousJob = this.job;
    this.job = { state: "exporting", downloadedBytes: this.totalBytes, error: null };
    try {
      const result = await this.runPackageWorker({
        action: "export",
        packagePath,
        modelRoot: this.modelRoot,
        files: this.files,
      });
      this.job = { state: "ready", downloadedBytes: this.totalBytes, error: null };
      return result;
    } catch (error) {
      this.job = previousJob;
      throw error;
    }
  }

  async runDownload(signal) {
    await mkdir(this.modelRoot, { recursive: true });
    let completed = 0;
    for (const file of this.files) {
      const target = this.resolveFile(file);
      if (await fileMatches(target, file)) {
        completed += file.size;
        this.job.downloadedBytes = completed;
        continue;
      }
      await mkdir(path.dirname(target), { recursive: true });
      const partial = `${target}.part`;
      await rm(partial, { force: true });
      const response = await this.fetchImpl(file.url, { signal });
      if (!response.ok || !response.body) throw new Error(`MODEL_HTTP_${response.status}`);
      let received = 0;
      const manager = this;
      const progress = new TransformStream({
        transform(chunk, controller) {
          received += chunk.byteLength;
          manager.job.downloadedBytes = completed + received;
          controller.enqueue(chunk);
        },
      });
      await pipeline(response.body.pipeThrough(progress), createWriteStream(partial), { signal });
      this.job.downloadedBytes = completed + received;
      if (!(await fileMatches(partial, file))) {
        await rm(partial, { force: true });
        throw new Error("MODEL_HASH_MISMATCH");
      }
      await rm(target, { force: true });
      await rename(partial, target);
      completed += file.size;
      this.job.downloadedBytes = completed;
    }
    this.job.state = "ready";
    this.job.error = null;
  }
}
