import { Worker } from "node:worker_threads";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { readFile, stat, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";

const PROBE_TIMEOUT_MS = 8_000;
const PROBE_TOTAL_TIMEOUT_MS = 8_000;
const FAILED_PROBE_CACHE_MS = 24 * 60 * 60 * 1_000;
const MAX_CAPTURE_BYTES = 64 * 1024;
const CONTROL_TIMEOUT_MS = 10_000;
const SEARCH_TIMEOUT_MS = 60_000;
const INDEX_NO_PROGRESS_TIMEOUT_MS = 180_000;
const PROCESS_STOP_TIMEOUT_MS = 1_000;
const UTILITY_WORKER_DATA_PREFIX = "--ngr-local-image-worker-data=";
const MAX_UTILITY_WORKER_ARGUMENT_CHARS = 24 * 1024;
const QUERY_ACTIONS = Object.freeze(new Set([
  "searchImage",
  "searchText",
  "listAssets",
  "listAssetFolders",
]));
let graphicsDriverPromise = null;
const VIRTUAL_DISPLAY_ADAPTER_PATTERN = /(parsec|gameviewer|virtual|remote|basic)/i;

function boundedDelay(milliseconds) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    timer.unref?.();
  });
}

class EngineProcessHost {
  constructor(processHandle, runtime) {
    this.processHandle = processHandle;
    this.runtime = runtime;
    this.exited = false;
    this.exitDetails = null;
    this.exitPromise = new Promise((resolve) => {
      processHandle.once("exit", (code, signal) => {
        this.exited = true;
        this.exitDetails = { code, signal };
        resolve(this.exitDetails);
      });
    });
  }

  on(eventName, listener) {
    this.processHandle.on(eventName, listener);
    return this;
  }

  off(eventName, listener) {
    this.processHandle.off(eventName, listener);
    return this;
  }

  postMessage(message) {
    if (this.exited) {
      const error = new Error(`LOCAL_SEARCH_WORKER_EXIT_${this.exitDetails?.code ?? "UNKNOWN"}`);
      error.code = "LOCAL_SEARCH_WORKER_EXIT";
      error.exitCode = this.exitDetails?.code;
      throw error;
    }
    this.processHandle.postMessage(message);
  }

  async terminate() {
    if (this.exited) return;
    if (this.runtime === "worker_threads") {
      await this.processHandle.terminate();
      return;
    }
    try {
      this.processHandle.kill();
    } catch {
      return;
    }
    await Promise.race([this.exitPromise, boundedDelay(PROCESS_STOP_TIMEOUT_MS)]);
  }
}

function encodeUtilityWorkerData(workerData) {
  const argument = `${UTILITY_WORKER_DATA_PREFIX}${Buffer.from(JSON.stringify(workerData), "utf8").toString("base64url")}`;
  if (argument.length > MAX_UTILITY_WORKER_ARGUMENT_CHARS) {
    const error = new Error("LOCAL_SEARCH_WORKER_DATA_TOO_LARGE");
    error.code = "LOCAL_SEARCH_WORKER_DATA_TOO_LARGE";
    throw error;
  }
  return argument;
}

function appendCapture(current, chunk) {
  if (current.length >= MAX_CAPTURE_BYTES) return current;
  return `${current}${String(chunk)}`.slice(0, MAX_CAPTURE_BYTES);
}

function runCaptured(command, args, { timeoutMs, env } = {}) {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timer;
    const child = spawn(command, args, {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: env || process.env,
    });
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout: stdout.trim(), stderr: stderr.trim(), ...result });
    };
    child.stdout?.on("data", (chunk) => { stdout = appendCapture(stdout, chunk); });
    child.stderr?.on("data", (chunk) => { stderr = appendCapture(stderr, chunk); });
    child.once("error", (error) => finish({ code: null, signal: null, error: error?.code || error?.message }));
    child.once("exit", (code, signal) => finish({ code, signal }));
    timer = setTimeout(() => {
      child.kill();
      finish({ code: null, signal: "TIMEOUT", timedOut: true });
    }, timeoutMs || PROBE_TIMEOUT_MS);
    timer.unref?.();
  });
}

async function graphicsDriverDetails() {
  if (!graphicsDriverPromise) {
    graphicsDriverPromise = (async () => {
      if (process.platform !== "win32") return { fingerprint: process.platform, devices: [] };
      const powershell = path.join(
        process.env.SystemRoot || "C:\\Windows",
        "System32", "WindowsPowerShell", "v1.0", "powershell.exe",
      );
      const command = [
        "Get-CimInstance Win32_VideoController",
        "Select-Object Name,DriverVersion,PNPDeviceID,Status",
        "ConvertTo-Json -Compress",
      ].join(" | ");
      const result = await runCaptured(
        powershell,
        ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", command],
        { timeoutMs: 3_000 },
      );
      let devices = [];
      if (result.code === 0 && result.stdout) {
        try {
          const parsed = JSON.parse(result.stdout);
          devices = (Array.isArray(parsed) ? parsed : [parsed]).filter(Boolean);
        } catch {
          devices = [];
        }
      }
      const fingerprintSource = JSON.stringify(devices.map((device) => ({
        name: device.Name || "",
        driverVersion: device.DriverVersion || "",
        pnpDeviceId: device.PNPDeviceID || "",
      })).sort((left, right) => left.pnpDeviceId.localeCompare(right.pnpDeviceId)));
      return {
        fingerprint: createHash("sha256").update(fingerprintSource || "unknown").digest("hex"),
        devices,
      };
    })();
  }
  return graphicsDriverPromise;
}

function directmlDeviceLabel(devices, deviceId) {
  const physicalNames = [...new Set((Array.isArray(devices) ? devices : [])
    .map((device) => String(device?.Name || "").trim())
    .filter((name) => name && !VIRTUAL_DISPLAY_ADAPTER_PATTERN.test(name)))];
  if (physicalNames.length === 1) return `${physicalNames[0]} · DirectML设备${deviceId}`;
  if (physicalNames.length > 1) {
    // WMI enumeration order is not a documented mapping to DirectML/DXGI device ids.
    return `DirectML设备${deviceId}（检测到 ${physicalNames.join(" / ")}）`;
  }
  return `DirectML设备${deviceId}`;
}

function parseProbeOutput(stdout) {
  const lines = String(stdout || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      const parsed = JSON.parse(lines[index]);
      if (parsed && typeof parsed === "object") return parsed;
    } catch {
      // ONNX Runtime may write diagnostics before the final JSON line.
    }
  }
  return null;
}

async function probeDirectML({
  modelRoot,
  dbPath,
  visionPath: requestedVisionPath,
  modelConfig,
  deadlineAt = Date.now() + PROBE_TOTAL_TIMEOUT_MS,
}) {
  if (process.platform !== "win32") {
    return {
      preferredProvider: "cpu", deviceId: null, deviceName: null, batchSize: 1,
      fallbackReason: "DIRECTML_WINDOWS_ONLY", probeDiagnostics: [], driverFingerprint: "non-windows",
    };
  }
  const visionPath = requestedVisionPath
    || path.join(modelRoot, "vision", "onnx", "vision_model_q4f16.onnx");
  const modelInfo = await stat(visionPath).catch(() => null);
  if (!modelInfo?.isFile()) {
    return {
      preferredProvider: "cpu", deviceId: null, deviceName: null, batchSize: 1,
      fallbackReason: "MODEL_NOT_READY", probeDiagnostics: [], driverFingerprint: "unknown",
    };
  }

  const driver = await graphicsDriverDetails();
  const vision = modelConfig?.vision || {};
  const probeSpec = {
    fingerprint: modelConfig?.fingerprint || null,
    inputName: vision.inputName || null,
    pixelType: ["float32", "uint8", "int8"].includes(vision.pixelType) ? vision.pixelType : "float32",
    layout: vision.layout === "NHWC" ? "NHWC" : "NCHW",
    width: Number.isInteger(Number(vision.width)) ? Number(vision.width) : 224,
    height: Number.isInteger(Number(vision.height)) ? Number(vision.height) : 224,
    externalData: Array.isArray(vision.externalData) ? vision.externalData : [],
  };
  const cachePath = path.join(path.dirname(dbPath), "directml-probe-cache.json");
  const cacheKey = createHash("sha256").update(JSON.stringify({
    probeVersion: 3,
    visionPath: path.resolve(visionPath),
    modelSize: modelInfo.size,
    modelMtimeMs: modelInfo.mtimeMs,
    modelFingerprint: probeSpec.fingerprint,
    input: probeSpec,
    driver: driver.fingerprint,
    platform: process.platform,
    arch: process.arch,
    osRelease: os.release(),
    nodeModules: process.versions.modules,
  })).digest("hex");
  const cacheDocument = await readFile(cachePath, "utf8").then(JSON.parse).catch(() => null);
  const cacheEntries = cacheDocument?.version === 1 && cacheDocument.entries && typeof cacheDocument.entries === "object"
    ? cacheDocument.entries
    : {};
  const cached = cacheEntries[cacheKey];
  const cacheAge = Date.now() - Number(cached?.createdAt || 0);
  if (cached?.result && (cached.result.preferredProvider === "dml" || cacheAge < FAILED_PROBE_CACHE_MS)) {
    return {
      ...cached.result,
      deviceName: cached.result.preferredProvider === "dml"
        ? directmlDeviceLabel(driver.devices, cached.result.deviceId)
        : null,
      probeCacheHit: true,
      driverFingerprint: cached.result.driverFingerprint || driver.fingerprint,
    };
  }

  const probePath = fileURLToPath(new URL("./directml-probe.mjs", import.meta.url));
  const remainingProbeMs = Math.max(1, Math.min(PROBE_TIMEOUT_MS, deadlineAt - Date.now()));
  const diagnostics = await Promise.all(Array.from({ length: 4 }, async (_, deviceId) => {
    const result = await runCaptured(
      process.execPath,
      [probePath, visionPath, String(deviceId), Buffer.from(JSON.stringify(probeSpec)).toString("base64url")],
      {
        timeoutMs: remainingProbeMs,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      },
    );
    const output = parseProbeOutput(result.stdout);
    const diagnostic = {
      deviceId,
      ok: result.code === 0 && output?.ok === true,
      code: result.code,
      signal: result.signal,
      timedOut: Boolean(result.timedOut),
      batchSize: Number(output?.batchSize || 0),
      millisecondsPerImage: Number(output?.millisecondsPerImage || 0),
      error: result.code === 0 && output?.ok === true
        ? null
        : output?.error || result.error || (result.stderr ? "DIRECTML_PROBE_STDERR" : null),
    };
    return diagnostic;
  }));
  const successes = diagnostics.filter((diagnostic) => diagnostic.ok);

  successes.sort((left, right) => left.millisecondsPerImage - right.millisecondsPerImage);
  const best = successes[0];
  const deviceName = best ? directmlDeviceLabel(driver.devices, best.deviceId) : null;
  const result = best ? {
    preferredProvider: "dml",
    deviceId: best.deviceId,
    deviceName,
    batchSize: best.batchSize || 16,
    fallbackReason: null,
    probeDiagnostics: diagnostics,
    driverFingerprint: driver.fingerprint,
  } : {
    preferredProvider: "cpu",
    deviceId: null,
    deviceName: null,
    batchSize: 1,
    fallbackReason: diagnostics.some((item) => item.timedOut)
      ? "DIRECTML_PROBE_TIMEOUT"
      : "DIRECTML_PROBE_FAILED",
    probeDiagnostics: diagnostics,
    driverFingerprint: driver.fingerprint,
  };
  cacheEntries[cacheKey] = { createdAt: Date.now(), result };
  const trimmedEntries = Object.fromEntries(Object.entries(cacheEntries)
    .sort((left, right) => Number(right[1]?.createdAt || 0) - Number(left[1]?.createdAt || 0))
    .slice(0, 16));
  void writeFile(cachePath, JSON.stringify({ version: 1, entries: trimmedEntries }), "utf8").catch(() => {});
  return result;
}

function missingModelStatus() {
  return {
    visionProvider: "cpu",
    textProvider: "cpu",
    executionProvider: "cpu",
    deviceId: null,
    deviceName: null,
    batchSize: 1,
    fallbackReason: "MODEL_NOT_READY",
    probeDiagnostics: [],
  };
}

function cpuControlProbe() {
  return {
    preferredProvider: "cpu",
    deviceId: null,
    deviceName: null,
    batchSize: 1,
    fallbackReason: "CONTROL_REQUEST_CPU",
    probeDiagnostics: [],
    driverFingerprint: "control-cpu",
  };
}

export class LocalImageSearchEngine {
  constructor({
    dbPath,
    modelRoot,
    testScanFailurePrefix = null,
    testPauseAfterStagedRows = null,
    testPauseAfterIndexBegin = false,
    utilityProcess = null,
    onEvent = null,
  }) {
    this.dbPath = dbPath;
    this.modelRoot = modelRoot;
    this.utilityProcess = utilityProcess && typeof utilityProcess.fork === "function"
      ? utilityProcess
      : null;
    this.pending = new Map();
    this.progressListeners = new Set();
    this.workers = new Map();
    this.workerPromises = new Map();
    this.expectedExits = new WeakSet();
    this.failedWorkers = new WeakSet();
    this.disposing = false;
    this.disposed = false;
    this.queryScope = null;
    this.queryRequestTail = Promise.resolve();
    // Dependency-injection seam used only by the filesystem failure regression tests. It is
    // never populated by the controller or renderer-facing API.
    this.testScanFailurePrefix = typeof testScanFailurePrefix === "string" ? testScanFailurePrefix : null;
    this.testPauseAfterStagedRows = Number.isInteger(testPauseAfterStagedRows)
      ? Math.max(1, Math.min(10_000, testPauseAfterStagedRows))
      : null;
    this.testPauseAfterIndexBegin = testPauseAfterIndexBegin === true;
    this.eventListener = typeof onEvent === "function" ? onEvent : null;
  }

  emitEvent(event) {
    if (!this.eventListener || !event || typeof event !== "object") return;
    const safe = {};
    for (const key of ["stage", "role", "requestId", "jobId", "exitCode", "errorCode"]) {
      const value = event[key];
      if (typeof value === "string") safe[key] = value.slice(0, 160);
      else if (key === "exitCode" && Number.isInteger(value)) safe[key] = value;
    }
    try {
      this.eventListener(Object.freeze(safe));
    } catch {
      // Observability must never change engine behavior.
    }
  }

  workerKind(action) {
    if (QUERY_ACTIONS.has(action) || action === "invalidate") return "query";
    if (["status", "getEngineStatus"].includes(action)) return "status";
    return "index";
  }

  createProcessHost(kind, workerData) {
    const workerEntry = new URL("./engine-worker.mjs", import.meta.url);
    if (this.utilityProcess) {
      const child = this.utilityProcess.fork(
        fileURLToPath(workerEntry),
        [encodeUtilityWorkerData(workerData)],
        { serviceName: `NGR AssetPilot Local AI ${kind}` },
      );
      return new EngineProcessHost(child, "utilityProcess");
    }
    return new EngineProcessHost(new Worker(workerEntry, { workerData }), "worker_threads");
  }

  async ensureWorker(kind, visionPath, modelConfig, precomputedProbe) {
    if (this.workers.has(kind)) return this.workers.get(kind);
    if (!this.workerPromises.has(kind)) {
      const promise = this.startWorker(kind, visionPath, modelConfig, precomputedProbe);
      this.workerPromises.set(kind, promise);
      promise.then(() => {
        if (this.workerPromises.get(kind) === promise) this.workerPromises.delete(kind);
      }, () => {});
      promise.catch(() => {
        if (this.workerPromises.get(kind) === promise) this.workerPromises.delete(kind);
      });
    }
    return this.workerPromises.get(kind);
  }

  async startWorker(kind, visionPath, modelConfig, precomputedProbe) {
    const probe = kind === "query" ? {
      preferredProvider: "cpu",
      deviceId: null,
      deviceName: null,
      batchSize: 1,
      fallbackReason: "QUERY_CPU_PREFERRED",
      probeDiagnostics: [],
      driverFingerprint: "query-cpu",
    } : precomputedProbe || await probeDirectML({
      modelRoot: this.modelRoot,
      dbPath: this.dbPath,
      visionPath,
      modelConfig,
    });
    const worker = this.createProcessHost(kind, {
      dbPath: this.dbPath,
      modelRoot: this.modelRoot,
      preferredProvider: probe.preferredProvider,
      directmlProbe: probe,
      testScanFailurePrefix: this.testScanFailurePrefix,
      testPauseAfterStagedRows: this.testPauseAfterStagedRows,
      testPauseAfterIndexBegin: this.testPauseAfterIndexBegin,
    });
    this.workers.set(kind, worker);
    worker.on("message", (message) => this.onMessage(kind, message));
    worker.on("error", (cause, location) => {
      const error = cause instanceof Error ? cause : new Error(String(cause || "LOCAL_SEARCH_UTILITY_PROCESS_FATAL"));
      if (!(cause instanceof Error)) error.code = "LOCAL_SEARCH_UTILITY_PROCESS_FATAL";
      if (location) error.location = String(location).slice(0, 240);
      this.handleUnexpectedExit(kind, worker, error);
    });
    worker.on("exit", (code, signal) => {
      if (this.expectedExits.has(worker) || this.disposing) return;
      const error = new Error(`LOCAL_SEARCH_WORKER_EXIT_${code ?? "UNKNOWN"}`);
      error.code = "LOCAL_SEARCH_WORKER_EXIT";
      error.exitCode = code;
      error.signal = signal;
      this.handleUnexpectedExit(kind, worker, error);
    });
    return worker;
  }

  handleUnexpectedExit(kind, worker, error) {
    if (this.failedWorkers.has(worker) || this.expectedExits.has(worker)) return;
    this.failedWorkers.add(worker);
    if (this.workers.get(kind) !== worker) return;
    this.workers.delete(kind);
    this.workerPromises.delete(kind);
    const pendingRequest = [...this.pending.values()].find((pending) => pending.kind === kind);
    this.emitEvent({
      stage: "worker-exit",
      role: kind,
      requestId: pendingRequest?.requestId,
      jobId: pendingRequest?.jobId,
      exitCode: Number.isInteger(error?.exitCode) ? error.exitCode : undefined,
      errorCode: error?.code || "LOCAL_SEARCH_WORKER_EXIT",
    });
    this.rejectWorker(kind, error);
    void worker.terminate().catch(() => {});
  }

  async stopWorker(kind, worker) {
    if (!worker) return;
    this.expectedExits.add(worker);
    if (this.workers.get(kind) === worker) this.workers.delete(kind);
    this.workerPromises.delete(kind);
    await worker.terminate();
  }

  onMessage(kind, message) {
    if (message.type === "progress") {
      for (const listener of this.progressListeners) listener(message.jobId, message.progress);
      for (const pending of this.pending.values()) {
        if (pending.kind === kind && pending.action === "index" && pending.jobId === message.jobId) {
          this.armTimeout(pending, INDEX_NO_PROGRESS_TIMEOUT_MS, "LOCAL_SEARCH_INDEX_STALLED");
        }
      }
      return;
    }
    const pending = this.pending.get(message.requestId);
    if (!pending) return;
    this.pending.delete(message.requestId);
    clearTimeout(pending.timer);
    if (message.type === "error") {
      const error = new Error(message.error?.code || "LOCAL_SEARCH_WORKER_FAILED");
      error.code = message.error?.code;
      if (pending.action === "index") {
        this.emitEvent({
          stage: "index-failed",
          role: kind,
          requestId: pending.requestId,
          jobId: pending.jobId,
          errorCode: error.code || "LOCAL_SEARCH_WORKER_FAILED",
        });
      }
      pending.reject(error);
    } else {
      if (pending.action === "index") {
        this.emitEvent({
          stage: message.result?.state === "completed" ? "index-completed" : "index-finished",
          role: kind,
          requestId: pending.requestId,
          jobId: pending.jobId,
        });
      }
      pending.resolve(message.result);
    }
  }

  rejectWorker(kind, error) {
    for (const [requestId, pending] of this.pending) {
      if (pending.kind !== kind) continue;
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(requestId);
    }
  }

  armTimeout(pending, timeoutMs, code) {
    clearTimeout(pending.timer);
    pending.timer = setTimeout(() => {
      if (!this.pending.delete(pending.requestId)) return;
      const error = new Error(code);
      error.code = code;
      this.emitEvent({
        stage: "request-timeout",
        role: pending.kind,
        requestId: pending.requestId,
        jobId: pending.jobId,
        errorCode: code,
      });
      pending.reject(error);
      const worker = this.workers.get(pending.kind);
      if (worker) void this.stopWorker(pending.kind, worker).catch(() => {});
      this.rejectWorker(pending.kind, error);
    }, timeoutMs);
    pending.timer.unref?.();
  }

  async request(action, payload) {
    if (!QUERY_ACTIONS.has(action)) return this.requestInternal(action, payload);
    const task = this.queryRequestTail.then(
      () => this.requestInternal(action, payload),
      () => this.requestInternal(action, payload),
    );
    this.queryRequestTail = task.catch(() => {});
    return task;
  }

  async requestInternal(action, payload) {
    if (this.disposed) {
      const error = new Error("LOCAL_SEARCH_ENGINE_DISPOSED");
      error.code = "LOCAL_SEARCH_ENGINE_DISPOSED";
      throw error;
    }
    const kind = this.workerKind(action);
    const requestDeadline = Date.now() + (
      ["searchImage", "searchText"].includes(action) ? SEARCH_TIMEOUT_MS : CONTROL_TIMEOUT_MS
    );
    if (action === "invalidate") {
      await Promise.allSettled([...this.workerPromises.entries()]
        .filter(([workerKind]) => workerKind === "query")
        .map(([, promise]) => promise));
      const worker = this.workers.get("query");
      this.queryScope = null;
      if (!worker) return { invalidated: true, workerRecreated: false };
      const error = new Error("LOCAL_SEARCH_CACHE_INVALIDATED");
      error.code = "LOCAL_SEARCH_CACHE_INVALIDATED";
      this.rejectWorker("query", error);
      await this.stopWorker("query", worker);
      return { invalidated: true, workerRecreated: true };
    }
    if (["searchImage", "searchText"].includes(action)) {
      const scope = `${payload?.libraryId || ""}:${payload?.modelConfig?.fingerprint || payload?.modelId || ""}`;
      if (this.queryScope && this.queryScope !== scope) await this.requestInternal("invalidate", {});
      this.queryScope = scope;
    }
    const visionPath = payload?.modelConfig?.vision?.modelPath;
    const modelConfig = payload?.modelConfig;
    const defaultVisionPath = path.join(this.modelRoot, "vision", "onnx", "vision_model_q4f16.onnx");
    if (action === "status" && !this.workers.has(kind) && !this.workerPromises.has(kind)) {
      const candidate = visionPath || defaultVisionPath;
      if (!await stat(candidate).then((info) => info.isFile()).catch(() => false)) return missingModelStatus();
    }
    let engineProbe = null;
    if (["index", "status", "getEngineStatus"].includes(action)) {
      engineProbe = await probeDirectML({
        modelRoot: this.modelRoot,
        dbPath: this.dbPath,
        visionPath,
        modelConfig,
        deadlineAt: action === "index" ? Date.now() + PROBE_TOTAL_TIMEOUT_MS : requestDeadline,
      });
    } else if (kind === "index") {
      // Cancel/control actions must not be queued behind a multi-device GPU probe.
      engineProbe = cpuControlProbe();
    }
    const requestPayload = engineProbe ? { ...(payload || {}), engineProbe } : payload;
    const worker = await this.ensureWorker(kind, visionPath, modelConfig, engineProbe);
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const pending = {
        requestId,
        action,
        kind,
        jobId: payload?.jobId || null,
        resolve,
        reject,
        timer: null,
      };
      this.pending.set(requestId, pending);
      if (action === "index") this.armTimeout(pending, INDEX_NO_PROGRESS_TIMEOUT_MS, "LOCAL_SEARCH_INDEX_STALLED");
      else this.armTimeout(
        pending,
        Math.max(1, requestDeadline - Date.now()),
        ["searchImage", "searchText"].includes(action) ? "LOCAL_SEARCH_SEARCH_TIMEOUT" : "LOCAL_SEARCH_CONTROL_TIMEOUT",
      );
      try {
        worker.postMessage({ requestId, action, payload: requestPayload });
      } catch (cause) {
        clearTimeout(pending.timer);
        this.pending.delete(requestId);
        const error = cause instanceof Error ? cause : new Error("LOCAL_SEARCH_WORKER_SEND_FAILED");
        if (!error.code) error.code = "LOCAL_SEARCH_WORKER_SEND_FAILED";
        reject(error);
        this.handleUnexpectedExit(kind, worker, error);
      }
    });
  }

  onProgress(listener) {
    this.progressListeners.add(listener);
    return () => this.progressListeners.delete(listener);
  }

  async dispose() {
    this.disposing = true;
    this.disposed = true;
    try {
      await Promise.allSettled([...this.workerPromises.values()]);
      const workers = [...this.workers.entries()];
      await Promise.allSettled(workers.map(async ([kind, worker]) => {
        try {
          const requestId = randomUUID();
          await new Promise((resolve) => {
            let timer;
            const finish = () => {
              clearTimeout(timer);
              worker.off("message", listener);
              resolve();
            };
            const listener = (message) => {
              if (message?.requestId === requestId) finish();
            };
            timer = setTimeout(finish, CONTROL_TIMEOUT_MS);
            timer.unref?.();
            worker.on("message", listener);
            try {
              worker.postMessage({ requestId, action: "dispose", payload: {} });
            } catch {
              finish();
            }
          });
        } finally {
          await this.stopWorker(kind, worker);
        }
      }));
      const error = new Error("LOCAL_SEARCH_ENGINE_DISPOSED");
      error.code = "LOCAL_SEARCH_ENGINE_DISPOSED";
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(error);
      }
      this.pending.clear();
      this.workerPromises.clear();
    } finally {
      this.disposing = false;
    }
  }
}
