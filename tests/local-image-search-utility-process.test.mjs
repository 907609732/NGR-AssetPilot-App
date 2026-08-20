import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { LocalImageSearchEngine } from "../desktop/services/local-image-search/engine.mjs";

const WORKER_DATA_PREFIX = "--ngr-local-image-worker-data=";
const PROJECT_ROOT = fileURLToPath(new URL("..", import.meta.url));

class FakeUtilityChild extends EventEmitter {
  constructor({ exitWithoutReply = false, activity }) {
    super();
    this.exitWithoutReply = exitWithoutReply;
    this.activity = activity;
    this.exited = false;
  }

  postMessage(message) {
    if (this.exitWithoutReply) {
      queueMicrotask(() => this.finish(0));
      return;
    }
    this.activity.active += 1;
    this.activity.maximum = Math.max(this.activity.maximum, this.activity.active);
    setTimeout(() => {
      this.activity.active -= 1;
      this.emit("message", {
        type: "result",
        requestId: message.requestId,
        result: { action: message.action },
      });
    }, 15).unref?.();
  }

  kill() {
    queueMicrotask(() => this.finish(0));
    return true;
  }

  finish(code) {
    if (this.exited) return;
    this.exited = true;
    this.emit("exit", code, null);
  }
}

function fakeUtilityProcess({ exitWithoutReply = false } = {}) {
  const forks = [];
  const activity = { active: 0, maximum: 0 };
  return {
    forks,
    activity,
    fork(modulePath, args, options) {
      const child = new FakeUtilityChild({ exitWithoutReply, activity });
      forks.push({ modulePath, args, options, child });
      return child;
    },
  };
}

test("Electron 注入时 index/query/status 使用三个 utility process，查询动作保持串行", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ngr-utility-host-"));
  const utilityProcess = fakeUtilityProcess();
  const engine = new LocalImageSearchEngine({
    dbPath: path.join(root, "index.sqlite"),
    modelRoot: path.join(root, "models"),
    utilityProcess,
  });
  try {
    assert.deepEqual(await engine.request("cancel", { jobId: "job-1" }), { action: "cancel" });
    assert.deepEqual(await engine.request("getEngineStatus", {}), { action: "getEngineStatus" });
    assert.deepEqual(await engine.request("listAssetFolders", {}), { action: "listAssetFolders" });
    await Promise.all([
      engine.request("listAssets", { page: 1 }),
      engine.request("searchImage", { libraryId: "library-1", modelId: "model-1" }),
    ]);

    assert.equal(utilityProcess.forks.length, 3);
    assert.deepEqual(
      utilityProcess.forks.map((item) => item.options.serviceName).sort(),
      [
        "NGR AssetPilot Local AI index",
        "NGR AssetPilot Local AI query",
        "NGR AssetPilot Local AI status",
      ],
    );
    for (const fork of utilityProcess.forks) {
      assert.ok(path.isAbsolute(fork.modulePath));
      assert.equal(fork.args.length, 1);
      assert.match(fork.args[0], /^--ngr-local-image-worker-data=[A-Za-z0-9_-]+$/);
      const data = JSON.parse(Buffer.from(fork.args[0].slice(WORKER_DATA_PREFIX.length), "base64url"));
      assert.equal(data.dbPath, path.join(root, "index.sqlite"));
      assert.equal(data.modelRoot, path.join(root, "models"));
    }
    assert.equal(utilityProcess.activity.maximum, 1);
  } finally {
    await engine.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("utility process 即使以 code 0 无完成消息退出也会拒绝 pending 请求", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ngr-utility-exit-"));
  const events = [];
  const engine = new LocalImageSearchEngine({
    dbPath: path.join(root, "index.sqlite"),
    modelRoot: path.join(root, "models"),
    utilityProcess: fakeUtilityProcess({ exitWithoutReply: true }),
    onEvent: (event) => events.push(event),
  });
  try {
    await assert.rejects(
      engine.request("cancel", { jobId: "job-exit" }),
      (error) => error?.code === "LOCAL_SEARCH_WORKER_EXIT" && error?.exitCode === 0,
    );
    assert.equal(events.length, 1);
    assert.deepEqual({
      stage: events[0].stage,
      role: events[0].role,
      jobId: events[0].jobId,
      exitCode: events[0].exitCode,
      errorCode: events[0].errorCode,
    }, {
      stage: "worker-exit",
      role: "index",
      jobId: "job-exit",
      exitCode: 0,
      errorCode: "LOCAL_SEARCH_WORKER_EXIT",
    });
    assert.match(events[0].requestId, /^[a-f0-9-]{16,64}$/i);
    assert.deepEqual(Object.keys(events[0]).sort(), [
      "errorCode", "exitCode", "jobId", "requestId", "role", "stage",
    ]);
  } finally {
    await engine.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("Electron 43 可通过 process.parentPort 驱动真实 utility process", { timeout: 30_000 }, async () => {
  const temporaryRoot = path.join(PROJECT_ROOT, ".tmp");
  await mkdir(temporaryRoot, { recursive: true });
  const root = await mkdtemp(path.join(temporaryRoot, "ngr-utility-electron-"));
  const mainPath = path.join(root, "main.mjs");
  const logPath = path.join(root, "markers.log");
  const engineUrl = pathToFileURL(path.join(PROJECT_ROOT, "desktop/services/local-image-search/engine.mjs")).href;
  await writeFile(mainPath, `
    import electron from "electron";
    import { appendFileSync } from "node:fs";
    import path from "node:path";
    const { app, utilityProcess } = electron;
    const mark = (value) => appendFileSync(${JSON.stringify(logPath)}, value + "\\n", "utf8");
    mark("script-start");
    app.setPath("userData", path.join(${JSON.stringify(root)}, "userdata"));
    void (async () => {
      await app.whenReady();
      mark("app-ready");
      const { LocalImageSearchEngine } = await import(${JSON.stringify(engineUrl)});
      mark("engine-imported");
      const engine = new LocalImageSearchEngine({
        dbPath: path.join(${JSON.stringify(root)}, "index.sqlite"),
        modelRoot: path.join(${JSON.stringify(root)}, "models"),
        utilityProcess,
      });
      try {
        mark("request-start");
        const result = await engine.request("cancel", { jobId: "real-utility" });
        mark("request-complete");
        process.stdout.write("NGR_UTILITY_RESULT:" + JSON.stringify(result) + "\\n");
      } catch (error) {
        process.stdout.write("NGR_UTILITY_ERROR:" + String(error?.code || error?.message) + "\\n");
        process.exitCode = 1;
      } finally {
        await engine.dispose();
        app.quit();
      }
    })();
  `, "utf8");

  try {
    const require = createRequire(import.meta.url);
    const electronExecutable = require("electron");
    const result = await new Promise((resolve, reject) => {
      const child = spawn(electronExecutable, [mainPath, "--disable-gpu"], {
        cwd: PROJECT_ROOT,
        windowsHide: true,
        env: Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== "ELECTRON_RUN_AS_NODE")),
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(async () => {
        child.kill();
        const markers = await readFile(logPath, "utf8").catch(() => "<missing>");
        reject(new Error(`real utility process smoke timed out\nmarkers: ${markers}\nstdout: ${stdout}\nstderr: ${stderr}`));
      }, 25_000);
      child.stdout.on("data", (chunk) => { stdout += chunk; });
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      child.once("error", reject);
      child.once("exit", (code, signal) => {
        clearTimeout(timer);
        resolve({ code, signal, stdout, stderr });
      });
    });
    assert.equal(result.signal, null, result.stderr);
    assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /NGR_UTILITY_RESULT:\{"canceled":true\}/);
    assert.doesNotMatch(result.stdout, /NGR_UTILITY_ERROR:/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
