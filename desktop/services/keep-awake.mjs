import { mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const modes = new Set(["system", "mouse", "combined"]);
export class KeepAwakeService {
  constructor({ userDataPath, powerSaveBlocker, powerMonitor, platform = process.platform, spawnImpl = spawn }) {
    Object.assign(this, { powerSaveBlocker, powerMonitor, platform, spawnImpl });
    this.file = path.join(userDataPath, "keep-awake.json");
    this.settings = { enabled: false, mode: "system" };
    this.blocker = null;
    this.worker = null;
    this.mouseState = "stopped";
    this.errors = {};
    this.pauses = new Set();
    this.listeners = [];
  }
  initialize() {
    try {
      const saved = JSON.parse(readFileSync(this.file, "utf8"));
      if (typeof saved.enabled === "boolean" && modes.has(saved.mode)) this.settings = { enabled: saved.enabled, mode: saved.mode };
    } catch (error) {
      if (error.code !== "ENOENT") this.errors.storage = "设置读取失败，请重新选择并保存。";
    }
    for (const [event, reason, paused] of [["lock-screen", "lock", true], ["unlock-screen", "lock", false], ["suspend", "sleep", true], ["resume", "sleep", false]]) {
      const listener = () => { paused ? this.pauses.add(reason) : this.pauses.delete(reason); this.reconcile(); };
      this.powerMonitor?.on(event, listener);
      this.listeners.push([event, listener]);
    }
    this.reconcile();
    this.timer = setInterval(() => this.reconcile(), 30_000);
    this.timer.unref?.();
  }
  setSettings(value) {
    if (!value || typeof value.enabled !== "boolean" || !modes.has(value.mode) || Object.keys(value).some((key) => !["enabled", "mode"].includes(key))) {
      throw new Error("防止息屏设置无效");
    }
    if (value.enabled && value.mode !== "system" && this.platform !== "win32") throw new Error("鼠标微动仅支持 Windows");
    const next = { enabled: value.enabled, mode: value.mode };
    mkdirSync(path.dirname(this.file), { recursive: true });
    writeFileSync(`${this.file}.tmp`, JSON.stringify(next), "utf8");
    renameSync(`${this.file}.tmp`, this.file);
    this.settings = next;
    delete this.errors.storage;
    this.reconcile();
    return this.getState();
  }
  getState() {
    return { ...this.settings, mouseSupported: this.platform === "win32", paused: this.pauses.size > 0,
      systemActive: this.blocker !== null && this.powerSaveBlocker.isStarted(this.blocker),
      mouseState: this.mouseState, errors: Object.values(this.errors) };
  }
  reconcile() {
    const active = this.settings.enabled && !this.pauses.size;
    const system = active && this.settings.mode !== "mouse";
    if (!system && this.blocker !== null) { this.powerSaveBlocker.stop(this.blocker); this.blocker = null; }
    if (system) {
      try {
        if (this.blocker === null || !this.powerSaveBlocker.isStarted(this.blocker)) this.blocker = this.powerSaveBlocker.start("prevent-display-sleep");
        delete this.errors.system;
      } catch { this.errors.system = "系统保活启动失败，可切换鼠标微动或双重模式。"; }
    } else delete this.errors.system;
    if (active && this.settings.mode !== "system") {
      if (this.platform !== "win32") this.errors.mouse = "鼠标微动仅支持 Windows。";
      else if (!this.worker) this.startMouse();
    } else { this.stopMouse(); delete this.errors.mouse; }
  }
  startMouse() {
    this.mouseState = "starting";
    let child;
    try {
      child = this.spawnImpl(path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
        ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(readFileSync(fileURLToPath(new URL("./keep-awake-mouse.ps1", import.meta.url)), "utf8"), "utf16le").toString("base64")],
        { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    } catch { this.mouseState = "failed"; this.errors.mouse = "鼠标微动启动失败，将自动重试；可切换系统保活。"; return; }
    this.worker = child;
    let output = "";
    const fail = () => {
      if (this.worker !== child) return;
      this.stopMouse();
      this.mouseState = "failed";
      this.errors.mouse = "鼠标微动已停止，将自动重试；可切换系统保活。";
    };
    this.startTimer = setTimeout(fail, 15_000);
    this.startTimer.unref?.();
    child.stdout.on("data", (data) => {
      output = (output + data.toString()).slice(-128);
      if (this.worker === child && output.includes("READY")) {
        clearTimeout(this.startTimer);
        this.mouseState = "running";
        delete this.errors.mouse;
      }
    });
    child.stderr.on("data", () => {});
    child.stdin.on("error", fail);
    child.on("error", fail);
    child.on("exit", fail);
  }
  stopMouse() {
    clearTimeout(this.startTimer);
    const child = this.worker;
    this.worker = null;
    this.mouseState = "stopped";
    if (child) { child.stdin.destroy(); child.kill(); }
  }
  dispose() {
    clearInterval(this.timer);
    for (const [event, listener] of this.listeners) this.powerMonitor?.removeListener(event, listener);
    this.stopMouse();
    if (this.blocker !== null) this.powerSaveBlocker.stop(this.blocker);
    this.blocker = null;
  }
}
