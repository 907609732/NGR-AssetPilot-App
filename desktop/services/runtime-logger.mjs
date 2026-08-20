import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { errorCodeOnly, isPlainRecord } from "../shared/core.mjs";

const STATE_VERSION = 1;
const ALLOWED_DETAIL_KEYS = new Set([
  "version",
  "edition",
  "operationId",
  "errorCode",
  "stage",
  "jobId",
  "workerExitCode",
  "providerId",
  "reason",
  "previousCleanShutdown",
  "reloadAttempt",
]);

function safeDetails(input) {
  if (!isPlainRecord(input)) return {};
  const output = {};
  for (const [key, value] of Object.entries(input)) {
    if (!ALLOWED_DETAIL_KEYS.has(key)) continue;
    if (typeof value === "number" && Number.isFinite(value)) output[key] = value;
    else if (typeof value === "boolean") output[key] = value;
    else if (typeof value === "string") {
      const bounded = value.slice(0, 160);
      output[key] = /(?:[A-Za-z]:[\\/]|\\\\|\/Users\/|\/home\/|file:|https?:\/\/)/i.test(bounded)
        ? "[redacted]"
        : bounded;
    }
  }
  return output;
}

function safeStage(value) {
  const stage = String(value || "").slice(0, 80);
  return /^[a-z0-9][a-z0-9:._-]{0,79}$/i.test(stage) ? stage : "runtime-event";
}

export class RuntimeLogger {
  constructor({ app, logger, edition }) {
    if (!app || typeof app.getPath !== "function") throw new TypeError("app is required");
    if (!logger) throw new TypeError("logger is required");
    this.app = app;
    this.logger = logger;
    this.edition = String(edition || "dev");
    this.statePath = path.join(app.getPath("userData"), "runtime-state.json");
    this.started = false;
  }

  async initialize() {
    if (this.logger.transports?.file) {
      this.logger.transports.file.maxSize = 5 * 1024 * 1024;
      this.logger.transports.file.fileName = "desktop-runtime.log";
      this.logger.transports.file.format = "{y}-{m}-{d}T{h}:{i}:{s}.{ms} [{level}] {text}";
    }
    if (this.logger.transports?.remote) this.logger.transports.remote.level = false;
    this.logger.initialize?.();
    let previousCleanShutdown = true;
    try {
      const raw = await readFile(this.statePath, "utf8");
      if (Buffer.byteLength(raw, "utf8") <= 64 * 1024) {
        const state = JSON.parse(raw);
        previousCleanShutdown = state?.version === STATE_VERSION && state.cleanShutdown !== false;
      }
    } catch {
      previousCleanShutdown = true;
    }
    await this.#writeState(false);
    this.started = true;
    this.info("runtime-start", { previousCleanShutdown });
    return { previousCleanShutdown };
  }

  info(stage, details = {}) {
    this.logger.info?.(JSON.stringify({ ...safeDetails(details), stage: safeStage(stage) }));
  }

  warn(stage, error, details = {}) {
    this.logger.warn?.(JSON.stringify({
      ...safeDetails(details),
      stage: safeStage(stage),
      errorCode: errorCodeOnly(error),
    }));
  }

  error(stage, error, details = {}) {
    this.logger.error?.(JSON.stringify({
      ...safeDetails(details),
      stage: safeStage(stage),
      errorCode: errorCodeOnly(error),
    }));
  }

  async markCleanShutdown() {
    if (!this.started) return;
    await this.#writeState(true);
    this.info("runtime-clean-shutdown");
  }

  async #writeState(cleanShutdown) {
    const directory = path.dirname(this.statePath);
    const temporary = `${this.statePath}.tmp`;
    await mkdir(directory, { recursive: true });
    const payload = JSON.stringify({
      version: STATE_VERSION,
      cleanShutdown: Boolean(cleanShutdown),
      updatedAt: new Date().toISOString(),
    });
    try {
      await writeFile(temporary, payload, { encoding: "utf8", mode: 0o600, flag: "w" });
      await rename(temporary, this.statePath);
    } catch (error) {
      await unlink(temporary).catch(() => {});
      throw error;
    }
  }
}

export { safeDetails as redactLogDetails };
