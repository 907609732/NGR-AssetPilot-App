import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { KeepAwakeService } from "../desktop/services/keep-awake.mjs";

function setup(t, userDataPath = mkdtempSync(path.join(tmpdir(), "ngr-awake-"))) {
  const active = new Set();
  let id = 0;
  const workers = [];
  const powerMonitor = new EventEmitter();
  const service = new KeepAwakeService({ userDataPath, platform: "win32", powerMonitor,
    powerSaveBlocker: { start: () => { active.add(++id); return id; }, stop: (key) => active.delete(key), isStarted: (key) => active.has(key) },
    spawnImpl: () => {
      const child = new EventEmitter();
      child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
      child.kill = () => { child.killed = true; };
      workers.push(child); return child;
    },
  });
  service.initialize();
  t.after(() => service.dispose());
  return { service, active, workers, powerMonitor, userDataPath };
}
test("default off, validated settings persist across restarts, shutdown releases resources", (t) => {
  const a = setup(t);
  assert.equal(a.service.getState().enabled, false);
  assert.equal(a.workers.length, 0);
  assert.throws(() => a.service.setSettings({ enabled: "true", mode: "mouse" }));
  a.service.setSettings({ enabled: true, mode: "combined" });
  assert.equal(a.active.size, 1);
  a.service.dispose();
  assert.equal(a.active.size, 0);
  assert.equal(a.workers[0].killed, true);
  const b = setup(t, a.userDataPath);
  assert.equal(b.service.getState().enabled, true);
  assert.equal(b.service.getState().mode, "combined");
  b.service.setSettings({ enabled: false, mode: "combined" });
  assert.equal(b.active.size, 0);
  assert.equal(b.workers[0].killed, true);
  assert.equal(setup(t, a.userDataPath).service.getState().enabled, false);
});
test("mode switches stop previous mechanisms; lock and suspend pause until both clear", (t) => {
  const { service, active, workers, powerMonitor } = setup(t);
  service.setSettings({ enabled: true, mode: "mouse" });
  workers[0].stdout.write("READY\n");
  assert.equal(service.getState().mouseState, "running");
  assert.equal(active.size, 0);
  service.setSettings({ enabled: true, mode: "system" });
  assert.equal(workers[0].killed, true);
  assert.equal(active.size, 1);
  powerMonitor.emit("lock-screen"); powerMonitor.emit("suspend"); powerMonitor.emit("resume");
  assert.equal(active.size, 0);
  powerMonitor.emit("unlock-screen");
  assert.equal(active.size, 1);
  active.clear(); service.reconcile();
  assert.equal(active.size, 1);
});
test("mouse failure leaves combined system protection running and recovers", (t) => {
  const { service, active, workers } = setup(t);
  service.setSettings({ enabled: true, mode: "combined" });
  workers[0].emit("exit", 1);
  assert.equal(service.getState().mouseState, "failed");
  assert.equal(active.size, 1);
  assert.equal(service.getState().errors.length, 1);
  service.reconcile(); workers[1].stdout.write("READY\n");
  assert.equal(service.getState().errors.length, 0);
  service.setSettings({ enabled: false, mode: "combined" });
  workers[1].emit("exit", 0);
  assert.equal(service.getState().mouseState, "stopped");
});
test("corrupt preferences fail closed", (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "ngr-awake-"));
  writeFileSync(path.join(dir, "keep-awake.json"), "broken");
  const { service, workers } = setup(t, dir);
  assert.equal(service.getState().enabled, false);
  assert.equal(workers.length, 0);
  assert.equal(service.getState().errors.length, 1);
});
