import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import vm from "node:vm";

const source = await fs.readFile(new URL("../app/js/finder-extension.js", import.meta.url), "utf8");
const settle = () => new Promise(resolve => setImmediate(resolve));
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }

function fixture() {
  class Element {
    constructor(id = "") { this.id = id; this.attrs = new Map(); this.events = new Map(); this.children = []; this.dataset = {}; this.textContent = ""; this.hidden = false; this.disabled = false; this.open = false; this.classes = new Set(); this.classList = { toggle: (name, value) => value ? this.classes.add(name) : this.classes.delete(name) }; }
    setAttribute(name, value) { this.attrs.set(name, String(value)); }
    removeAttribute(name) { this.attrs.delete(name); }
    hasAttribute(name) { return this.attrs.has(name); }
    getAttribute(name) { return this.attrs.get(name) ?? null; }
    set value(value) { this.setAttribute("value", value); }
    get value() { return Number(this.getAttribute("value") || 0); }
    addEventListener(name, fn) { this.events.set(name, [...this.events.get(name) || [], fn]); }
    fire(name) { for (const fn of this.events.get(name) || []) fn({}); }
    replaceChildren(...items) { this.children = items; }
    append(item) { this.children.push(item); }
    showModal() { this.open = true; }
    close() { this.open = false; this.fire("close"); }
    focus() { this.focused = true; }
    hidePopover() {}
  }
  const nodes = new Map(), clock = { now: 100000 }, timers = new Map(); let timerId = 0;
  const el = name => { const id = name.startsWith("more") ? name : "finderExtension" + name; if (!nodes.has(id)) nodes.set(id, new Element(id)); return nodes.get(id); };
  const counters = { status: 0, choose: 0, open: 0 };
  let backend = { state: "not-found", message: "尚未安装扩展", bound: null }, choose = deferred(), open = deferred();
  const api = { status: async () => { counters.status++; return backend; }, choose: async () => { counters.choose++; return choose.promise; }, open: async () => { counters.open++; return open.promise; } };
  const events = new Map();
  class ClockDate extends Date { constructor(...args) { super(...(args.length ? args : [clock.now])); } static now() { return clock.now; } }
  const document = { getElementById: id => { if (!nodes.has(id)) nodes.set(id, new Element(id)); return nodes.get(id); }, createElement: () => new Element() };
  vm.runInNewContext(source, { document, window: { ngrDesktop: { finderExtension: api }, addEventListener: (name, fn) => events.set(name, fn) }, Date: ClockDate, console, setTimeout: (fn, ms) => { timers.set(++timerId, { fn, ms }); return timerId; }, clearTimeout: id => timers.delete(id) });
  const progress = (phase, extras = {}) => ({ operation: "install", phase, stage: phase, state: "running", active: true, done: null, total: null, bytesDone: null, bytesTotal: null, percent: null, indeterminate: true, startedAt: 100000, updatedAt: clock.now, revision: 1, currentFile: "", ...extras });
  return {
    el, counters, clock, timers, progress,
    set backend(value) { backend = value; }, get backend() { return backend; },
    get choose() { return choose; }, resetChoose() { choose = deferred(); return choose; }, get open() { return open; },
    async drive() { const next = timers.entries().next().value; if (!next) return false; timers.delete(next[0]); clock.now += next[1].ms; await next[1].fn(); await settle(); return true; },
    async flush() { await settle(); await settle(); },
    stop() { events.get("beforeunload")?.(); },
  };
}

test("import shows indeterminate then measured progress; close and reopen does not duplicate import", async () => {
  const f = fixture(); f.el("Choose").fire("click"); await f.flush();
  assert.equal(f.el("Dialog").open, true); assert.equal(f.el("Progress").hidden, false); assert.equal(f.el("ProgressBar").hasAttribute("value"), false);
  assert.equal(f.el("Choose").disabled, true); assert.equal(f.el("Entry").disabled, false); assert.equal(f.el("Manage").disabled, false);
  f.backend = { message: "安装中", bound: null, progress: f.progress("extracting", { stage: "解压并校验", done: 2, total: 4, bytesDone: 6000000, bytesTotal: 12000000, percent: 50, indeterminate: false, currentFile: "resources/worker/运行环境.dll", revision: 2 }) };
  await f.drive();
  assert.equal(f.el("ProgressBar").value, 50); assert.match(f.el("ProgressCounts").textContent, /2 \/ 4 个文件.*6\.0 \/ 12\.0 MB/); assert.equal(f.el("ProgressFile").textContent, "resources/worker/运行环境.dll"); assert.match(f.el("ProgressPercent").textContent, /当前阶段 50%/);
  f.el("Close").fire("click"); assert.equal(f.el("Dialog").open, false);
  f.el("Entry").fire("click"); await f.flush(); assert.equal(f.el("Dialog").open, true); assert.equal(f.counters.choose, 1); assert.equal(f.counters.open, 0); assert.equal(f.el("ProgressBar").value, 50);
  f.clock.now += 11000; f.backend.progress.updatedAt = f.clock.now; await f.drive(); assert.match(f.el("ProgressHint").textContent, /仍在处理/); assert.match(f.el("ProgressElapsed").textContent, /11 秒/);
  f.backend = { installed: true, bound: { version: "0.7.0", root: "C:/fixture" }, message: "已安装", progress: f.progress("complete", { state: "complete", active: false, updatedAt: f.clock.now, revision: 3 }) }; f.choose.resolve(f.backend); await f.flush();
  assert.equal(f.el("ProgressBar").value, 100); assert.equal(f.el("Choose").disabled, false); assert.equal(f.el("Launch").disabled, false); assert.equal(f.el("Download").hidden, true); assert.equal(f.el("Download").disabled, true);
  const before = f.counters.status; await f.drive(); assert.equal(f.counters.status, before); assert.equal(f.timers.size, 0); f.stop();
});

test("manager recovers a backend operation, error unlocks retry, and retry resets old progress", async () => {
  const f = fixture(); f.backend = { bound: { version: "0.7.0", root: "C:/old" }, message: "处理中", progress: f.progress("extracting", { done: 3, total: 10, percent: 30, indeterminate: false, revision: 5 }) };
  f.el("Manage").fire("click"); await f.flush(); assert.equal(f.el("ProgressBar").value, 30); assert.equal(f.el("Choose").disabled, true);
  f.clock.now += 1000; f.backend = { ...f.backend, progress: f.progress("error", { stage: "安装未完成", state: "error", active: false, error: "文件校验失败", revision: 6, updatedAt: f.clock.now }) }; await f.drive();
  assert.equal(f.el("Progress").dataset.state, "error"); assert.match(f.el("ProgressHint").textContent, /文件校验失败/); assert.equal(f.el("Choose").disabled, false); assert.equal(f.el("Version").textContent, "0.7.0");
  f.clock.now += 2000; f.el("Choose").fire("click"); await f.flush(); assert.equal(f.el("Progress").dataset.phase, "selecting"); assert.equal(f.el("ProgressBar").hasAttribute("value"), false); assert.equal(f.el("ProgressFile").textContent, ""); assert.match(f.el("ProgressElapsed").textContent, /0 秒/);
  // An early failure before the backend updates its old error must not stay busy forever.
  f.choose.reject(new Error("无法读取新的扩展包")); await f.flush(); assert.equal(f.el("Choose").disabled, false); assert.match(f.el("ProgressHint").textContent, /无法读取新的扩展包/); assert.equal(f.el("ProgressBar").hidden, true); f.stop();
});

test("open operation has a distinct verification/loading flow and closes modal only after launch", async () => {
  const f = fixture(); f.el("Entry").fire("click"); await f.flush();
  assert.equal(f.el("Dialog").open, true); assert.equal(f.counters.open, 1);
  f.backend = { bound: { version: "0.7.0", root: "C:/fixture" }, progress: f.progress("verifying", { operation: "open", percent: 60, indeterminate: false, done: 6, total: 10, revision: 2 }) }; await f.drive();
  assert.equal(f.el("ProgressSteps").children.length, 3); assert.equal(f.el("ProgressBar").value, 60);
  f.backend = { ...f.backend, progress: f.progress("loading", { operation: "open", revision: 3 }) }; await f.drive(); assert.equal(f.el("ProgressBar").hasAttribute("value"), false); assert.equal(f.el("ProgressSteps").children[1].getAttribute("aria-current"), "step");
  f.backend = { ...f.backend, launched: true, progress: f.progress("complete", { operation: "open", state: "complete", active: false, updatedAt: f.clock.now, revision: 4 }) }; f.open.resolve(f.backend); await f.flush(); assert.equal(f.el("Dialog").open, false); assert.equal(f.counters.open, 1); f.stop();
});

test("older status responses cannot move the visible phase backwards", async () => {
  const f = fixture(); f.el("Choose").fire("click"); await f.flush(); f.backend = { bound: { version: "0.7.0" }, progress: f.progress("extracting", { revision: 5, percent: 72, indeterminate: false }) }; await f.drive();
  f.backend = { bound: null, progress: f.progress("reading", { revision: 4 }) }; await f.drive(); assert.equal(f.el("Progress").dataset.phase, "extracting"); assert.equal(f.el("ProgressBar").value, 72); assert.equal(f.el("Version").textContent, "0.7.0");
  f.backend = { progress: f.progress("verifying", { revision: 6, percent: 20, indeterminate: false }) }; await f.drive(); assert.equal(f.el("ProgressSteps").children[2].getAttribute("aria-current"), "step");
  f.choose.resolve({ installed: true, bound: { version: "0.7.0" } }); await f.flush(); f.stop();
});

test("legacy status without progress shows no fabricated percent and handles picker cancellation", async () => {
  const f = fixture(); f.el("Choose").fire("click"); await f.flush(); await f.drive(); assert.equal(f.el("ProgressBar").hasAttribute("value"), false); assert.equal(f.el("ProgressBar").getAttribute("aria-valuenow"), null);
  f.choose.resolve({ message: "未选择文件", bound: null }); await f.flush(); assert.equal(f.el("Progress").dataset.state, "cancelled"); assert.equal(f.el("Choose").disabled, false); assert.equal(f.el("Launch").disabled, true); assert.equal(f.el("ProgressBar").hidden, true); f.stop();
});
