import { Worker } from "node:worker_threads";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { readFile, stat, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";

const PROBE_TIMEOUT_MS = 8_000;
const FAILED_PROBE_CACHE_MS = 24 * 60 * 60 * 1_000;
const MAX_CAPTURE_BYTES = 64 * 1024;
let graphicsDriverPromise = null;
const VIRTUAL_DISPLAY_ADAPTER_PATTERN = /(parsec|gameviewer|virtual|remote|basic)/i;

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

async function probeDirectML({ modelRoot, dbPath, visionPath: requestedVisionPath, modelConfig }) {
  if (process.platform !== "win32") {
    return {
      preferredProvider: "cpu", deviceId: null, deviceName: null, batchSize: 1,
      fallbackReason: "DIRECTML_WINDOWS_ONLY", probeDiagnostics: [],
    };
  }
  const visionPath = requestedVisionPath
    || path.join(modelRoot, "vision", "onnx", "vision_model_quantized.onnx");
  const modelInfo = await stat(visionPath).catch(() => null);
  if (!modelInfo?.isFile()) {
    return {
      preferredProvider: "cpu", deviceId: null, deviceName: null, batchSize: 1,
      fallbackReason: "MODEL_NOT_READY", probeDiagnostics: [],
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
    };
  }

  const probePath = fileURLToPath(new URL("./directml-probe.mjs", import.meta.url));
  const diagnostics = [];
  const successes = [];
  for (let deviceId = 0; deviceId < 4; deviceId += 1) {
    const result = await runCaptured(
      process.execPath,
      [probePath, visionPath, String(deviceId), Buffer.from(JSON.stringify(probeSpec)).toString("base64url")],
      {
        timeoutMs: PROBE_TIMEOUT_MS,
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
    diagnostics.push(diagnostic);
    if (diagnostic.ok) successes.push(diagnostic);
  }

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
  } : {
    preferredProvider: "cpu",
    deviceId: null,
    deviceName: null,
    batchSize: 1,
    fallbackReason: diagnostics.some((item) => item.timedOut)
      ? "DIRECTML_PROBE_TIMEOUT"
      : "DIRECTML_PROBE_FAILED",
    probeDiagnostics: diagnostics,
  };
  cacheEntries[cacheKey] = { createdAt: Date.now(), result };
  const trimmedEntries = Object.fromEntries(Object.entries(cacheEntries)
    .sort((left, right) => Number(right[1]?.createdAt || 0) - Number(left[1]?.createdAt || 0))
    .slice(0, 16));
  await writeFile(cachePath, JSON.stringify({ version: 1, entries: trimmedEntries }), "utf8").catch(() => {});
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

export class LocalImageSearchEngine {
  constructor({ dbPath, modelRoot }) {
    this.dbPath = dbPath;
    this.modelRoot = modelRoot;
    this.pending = new Map();
    this.progressListeners = new Set();
    this.worker = null;
    this.workerPromise = null;
  }

  async ensureWorker(visionPath, modelConfig, precomputedProbe) {
    if (this.worker) return this.worker;
    if (!this.workerPromise) this.workerPromise = this.startWorker(visionPath, modelConfig, precomputedProbe);
    return this.workerPromise;
  }

  async startWorker(visionPath, modelConfig, precomputedProbe) {
    const probe = precomputedProbe || await probeDirectML({
      modelRoot: this.modelRoot,
      dbPath: this.dbPath,
      visionPath,
      modelConfig,
    });
    const worker = new Worker(new URL("./engine-worker.mjs", import.meta.url), {
      workerData: {
        dbPath: this.dbPath,
        modelRoot: this.modelRoot,
        preferredProvider: probe.preferredProvider,
        directmlProbe: probe,
      },
    });
    this.worker = worker;
    worker.on("message", (message) => this.onMessage(message));
    worker.on("error", (error) => this.rejectAll(error));
    worker.on("exit", (code) => {
      this.worker = null;
      this.workerPromise = null;
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
    const visionPath = payload?.modelConfig?.vision?.modelPath;
    const modelConfig = payload?.modelConfig;
    const defaultVisionPath = path.join(this.modelRoot, "vision", "onnx", "vision_model_quantized.onnx");
    if (action === "status" && !this.worker && !this.workerPromise) {
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
      });
    }
    const requestPayload = engineProbe ? { ...(payload || {}), engineProbe } : payload;
    const worker = await this.ensureWorker(visionPath, modelConfig, engineProbe);
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      this.pending.set(requestId, { resolve, reject });
      worker.postMessage({ requestId, action, payload: requestPayload });
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
    this.worker = null;
    this.workerPromise = null;
  }
}
