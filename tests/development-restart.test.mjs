import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createDevelopmentRestartHandler } from "../desktop/main/development-restart.mjs";

test("源码开发重启只安排一次 relaunch，并通过正常 quit 保存", () => {
  const calls = [];
  const handler = createDevelopmentRestartHandler({
    app: { isPackaged: false, relaunch: () => calls.push("relaunch"), quit: () => calls.push("quit") },
    edition: "dev", sourceRoot: process.cwd(), showConflict: () => assert.fail("unexpected conflict"),
  });
  assert.equal(handler({ developmentRestartRoot: process.cwd() }), true);
  assert.equal(handler({ developmentRestartRoot: path.join(process.cwd(), ".") }), true);
  assert.deepEqual(calls, ["relaunch", "quit"]);
});

test("正式版、测试版、普通唤醒和无效请求不触发重启", () => {
  for (const [isPackaged, edition, data] of [
    [true, "dev", { developmentRestartRoot: process.cwd() }],
    [true, "prod", { developmentRestartRoot: process.cwd() }],
    [false, "test", { developmentRestartRoot: process.cwd() }],
    [false, "dev", {}], [false, "dev", undefined],
    [false, "dev", { developmentRestartRoot: 123 }],
  ]) {
    const handler = createDevelopmentRestartHandler({
      app: { isPackaged, relaunch: () => assert.fail("must not relaunch"), quit: () => assert.fail("must not quit") },
      edition, sourceRoot: process.cwd(), showConflict: () => assert.fail("must not show conflict"),
    });
    assert.equal(handler(data), false);
  }
});

test("其他工作树显示路径冲突，不能唤醒旧代码冒充最新源码", () => {
  const otherRoot = mkdtempSync(path.join(os.tmpdir(), "ngr-other-source-"));
  const conflicts = [];
  try {
    const handler = createDevelopmentRestartHandler({
      app: { isPackaged: false, relaunch: () => assert.fail("must not relaunch"), quit: () => assert.fail("must not quit") },
      edition: "dev", sourceRoot: process.cwd(), showConflict: (details) => conflicts.push(details),
    });
    assert.equal(handler({ developmentRestartRoot: otherRoot }), true);
    assert.equal(conflicts.length, 1);
    assert.equal(conflicts[0].runningRoot, process.cwd());
    assert.equal(conflicts[0].requestedRoot, otherRoot);
  } finally {
    rmSync(otherRoot, { recursive: true, force: true });
  }
});

test("Windows 源码路径大小写不影响同目录识别", { skip: process.platform !== "win32" }, () => {
  let restarts = 0;
  const handler = createDevelopmentRestartHandler({
    app: { isPackaged: false, relaunch: () => restarts++, quit: () => {} },
    edition: "dev", sourceRoot: process.cwd(), showConflict: () => assert.fail("same directory"),
  });
  assert.equal(handler({ developmentRestartRoot: process.cwd().toUpperCase() }), true);
  assert.equal(restarts, 1);
});
