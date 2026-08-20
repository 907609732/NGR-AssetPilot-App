import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { DesktopError, isPlainRecord } from "../../shared/core.mjs";
import { OFFLINE_TRANSLATION_MODEL, OFFLINE_TRANSLATION_TOTAL_BYTES } from "./manifest.mjs";

const REQUEST_TIMEOUT_MS = 60_000;
const MAX_TEXT_LENGTH = 200;

export class OfflineTranslationService {
  constructor({ modelLibraryRoot, workerFactory = (url, options) => new Worker(url, options) }) {
    this.modelLibraryRoot = path.resolve(modelLibraryRoot);
    this.modelRoot = path.join(this.modelLibraryRoot, ...OFFLINE_TRANSLATION_MODEL.id.split("/"));
    this.workerFactory = workerFactory;
    this.worker = null;
    this.pending = new Map();
    this.queue = Promise.resolve();
    this.disposed = false;
  }

  getStatus() {
    const missing = OFFLINE_TRANSLATION_MODEL.files.find((file) => {
      try {
        const stat = fs.statSync(path.join(this.modelRoot, ...file.path.split("/")));
        return !stat.isFile() || stat.size !== file.size;
      } catch {
        return true;
      }
    });
    return {
      ready: !missing,
      loaded: Boolean(this.worker),
      modelId: OFFLINE_TRANSLATION_MODEL.id,
      displayName: OFFLINE_TRANSLATION_MODEL.displayName,
      revision: OFFLINE_TRANSLATION_MODEL.revision,
      totalBytes: OFFLINE_TRANSLATION_TOTAL_BYTES,
      direction: "zh-en",
      offline: true,
      missingFile: missing?.path || null,
    };
  }

  async translate(payload) {
    if (this.disposed) {
      throw new DesktopError("OFFLINE_TRANSLATION_DISPOSED", "离线翻译服务已关闭");
    }
    if (!isPlainRecord(payload)) throw new DesktopError("OFFLINE_TRANSLATION_REQUEST_INVALID", "离线翻译请求无效");
    const text = String(payload.text || "").trim();
    const from = String(payload.from || "zh").toLowerCase();
    const to = String(payload.to || "en").toLowerCase();
    if (!text || text.length > MAX_TEXT_LENGTH) {
      throw new DesktopError("OFFLINE_TRANSLATION_TEXT_INVALID", "翻译文字不能为空且不能超过 200 字符");
    }
    if (from !== "zh" || to !== "en") {
      throw new DesktopError("OFFLINE_TRANSLATION_DIRECTION_UNSUPPORTED", "当前离线模型仅支持中文翻译为英文");
    }
    if (!this.getStatus().ready) {
      throw new DesktopError("OFFLINE_TRANSLATION_MODEL_MISSING", "内置离线翻译模型不完整，请重新安装软件");
    }
    const task = this.queue.then(() => {
      if (this.disposed) {
        throw new DesktopError("OFFLINE_TRANSLATION_DISPOSED", "离线翻译服务已关闭");
      }
      return this.#request("translate", { text });
    });
    this.queue = task.catch(() => {});
    return task;
  }

  #ensureWorker() {
    if (this.disposed) {
      throw new DesktopError("OFFLINE_TRANSLATION_DISPOSED", "离线翻译服务已关闭");
    }
    if (this.worker) return this.worker;
    const worker = this.workerFactory(new URL("./worker.mjs", import.meta.url), {
      type: "module",
      execArgv: process.execArgv.filter((argument) => !argument.startsWith("--input-type")),
      workerData: {
        modelLibraryRoot: this.modelLibraryRoot,
        modelId: OFFLINE_TRANSLATION_MODEL.id,
      },
    });
    worker.on("message", (message = {}) => {
      const entry = this.pending.get(message.requestId);
      if (!entry || entry.worker !== worker) return;
      this.pending.delete(message.requestId);
      clearTimeout(entry.timer);
      if (message.ok) entry.resolve(message.result);
      else entry.reject(new DesktopError(message.error?.code || "OFFLINE_TRANSLATION_FAILED", "离线翻译失败"));
    });
    const rejectAll = () => {
      this.#rejectWorkerRequests(worker);
    };
    worker.once("error", rejectAll);
    worker.once("exit", rejectAll);
    this.worker = worker;
    return worker;
  }

  #request(action, payload) {
    const worker = this.#ensureWorker();
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const entry = this.pending.get(requestId);
        if (!entry || entry.worker !== worker) return;
        this.pending.delete(requestId);
        reject(new DesktopError("OFFLINE_TRANSLATION_TIMEOUT", "离线翻译超时，请重试"));
        void this.#terminateWorker(worker);
      }, REQUEST_TIMEOUT_MS);
      timer.unref?.();
      this.pending.set(requestId, { resolve, reject, timer, worker });
      try {
        worker.postMessage({ requestId, action, ...payload });
      } catch {
        const entry = this.pending.get(requestId);
        if (entry?.worker === worker) {
          this.pending.delete(requestId);
          clearTimeout(entry.timer);
        }
        reject(new DesktopError("OFFLINE_TRANSLATION_WORKER_POST_FAILED", "离线翻译进程通信失败，请重试"));
        void this.#terminateWorker(worker);
      }
    });
  }

  #rejectWorkerRequests(worker) {
    if (this.worker === worker) this.worker = null;
    for (const [requestId, entry] of this.pending) {
      if (entry.worker !== worker) continue;
      this.pending.delete(requestId);
      clearTimeout(entry.timer);
      entry.reject(new DesktopError("OFFLINE_TRANSLATION_WORKER_EXITED", "离线翻译进程已退出，请重试"));
    }
  }

  async #terminateWorker(worker) {
    this.#rejectWorkerRequests(worker);
    await worker?.terminate?.().catch(() => {});
  }

  async dispose() {
    this.disposed = true;
    const worker = this.worker;
    if (worker) await this.#terminateWorker(worker);
    await this.queue.catch(() => {});
    const lateWorker = this.worker;
    if (lateWorker) await this.#terminateWorker(lateWorker);
  }
}
