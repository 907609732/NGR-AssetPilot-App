import { Worker } from "node:worker_threads";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

function probeDirectML(modelRoot) {
  if (process.platform !== "win32") return Promise.resolve("cpu");
  const probePath = fileURLToPath(new URL("./directml-probe.mjs", import.meta.url));
  const visionPath = path.join(modelRoot, "vision", "onnx", "vision_model_quantized.onnx");
  const textPath = path.join(modelRoot, "text", "onnx", "model_quantized.onnx");
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [probePath, visionPath, textPath], {
      windowsHide: true,
      stdio: "ignore",
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    });
    child.once("error", () => resolve("cpu"));
    child.once("exit", (code) => resolve(code === 0 ? "dml" : "cpu"));
  });
}

export class LocalImageSearchEngine {
  constructor({ dbPath, modelRoot }) {
    this.dbPath = dbPath;
    this.modelRoot = modelRoot;
    this.pending = new Map();
    this.progressListeners = new Set();
    this.worker = null;
    this.workerPromise = null;
  }

  async ensureWorker() {
    if (this.worker) return this.worker;
    if (!this.workerPromise) this.workerPromise = this.startWorker();
    return this.workerPromise;
  }

  async startWorker() {
    const preferredProvider = await probeDirectML(this.modelRoot);
    const worker = new Worker(new URL("./engine-worker.mjs", import.meta.url), {
      workerData: { dbPath: this.dbPath, modelRoot: this.modelRoot, preferredProvider },
    });
    this.worker = worker;
    worker.on("message", (message) => this.onMessage(message));
    worker.on("error", (error) => this.rejectAll(error));
    worker.on("exit", (code) => {
      if (code !== 0) this.rejectAll(new Error(`LOCAL_SEARCH_WORKER_EXIT_${code}`));
    });
    return worker;
  }

  onMessage(message) {
    if (message.type === "progress") {
      for (const listener of this.progressListeners) listener(message.jobId, message.progress);
      return;
    }
    const pending = this.pending.get(message.requestId);
    if (!pending) return;
    this.pending.delete(message.requestId);
    if (message.type === "error") {
      const error = new Error(message.error?.code || "LOCAL_SEARCH_WORKER_FAILED");
      error.code = message.error?.code;
      pending.reject(error);
    } else pending.resolve(message.result);
  }

  rejectAll(error) {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  async request(action, payload) {
    if (action === "invalidate" && !this.worker && !this.workerPromise) return { invalidated: true };
    const worker = await this.ensureWorker();
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      this.pending.set(requestId, { resolve, reject });
      worker.postMessage({ requestId, action, payload });
    });
  }

  onProgress(listener) {
    this.progressListeners.add(listener);
    return () => this.progressListeners.delete(listener);
  }

  async dispose() {
    if (!this.worker && !this.workerPromise) return;
    await this.ensureWorker().catch(() => null);
    if (!this.worker) return;
    await this.request("dispose", {}).catch(() => {});
    await this.worker.terminate();
  }
}
