import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createIndexExecutionProfile } from "../desktop/services/local-image-search/execution-profile.mjs";

const [engine, worker, probe, executionProfile] = await Promise.all([
  readFile(new URL("../desktop/services/local-image-search/engine.mjs", import.meta.url), "utf8"),
  readFile(new URL("../desktop/services/local-image-search/engine-worker.mjs", import.meta.url), "utf8"),
  readFile(new URL("../desktop/services/local-image-search/directml-probe.mjs", import.meta.url), "utf8"),
  readFile(new URL("../desktop/services/local-image-search/execution-profile.mjs", import.meta.url), "utf8"),
]);

test("DirectML 会话遵守顺序执行与禁用 memory pattern 的官方约束", () => {
  assert.match(worker, /function cpuSessionOptions[\s\S]*?graphOptimizationLevel:\s*"basic"/);
  assert.match(worker, /executionProviders:\s*\[\{ name: "dml", deviceId \}\]/);
  assert.match(worker, /graphOptimizationLevel:\s*"basic"/);
  assert.match(worker, /executionMode:\s*"sequential"/);
  assert.match(worker, /enableMemPattern:\s*false/);
  assert.match(probe, /graphOptimizationLevel:\s*"basic"/);
  assert.match(probe, /executionMode:\s*"sequential"/);
  assert.match(probe, /enableMemPattern:\s*false/);
});

test("GPU 探测按模型与驱动缓存，并限制超时和缓存条目", () => {
  assert.match(engine, /const PROBE_TIMEOUT_MS = 8_000/);
  assert.match(engine, /const PROBE_TOTAL_TIMEOUT_MS = 8_000/);
  assert.match(engine, /modelFingerprint:\s*probeSpec\.fingerprint/);
  assert.match(engine, /driver:\s*driver\.fingerprint/);
  assert.match(engine, /Promise\.all\(Array\.from\(\{ length: 4 \}/);
  assert.match(engine, /deadlineAt - Date\.now\(\)/);
  assert.match(engine, /CONTROL_REQUEST_CPU/);
  assert.match(engine, /\.slice\(0, 16\)/);
  assert.match(engine, /probeDirectML\(\{[\s\S]*?modelConfig[\s\S]*?\}\)/);
  assert.match(engine, /driverFingerprint: driver\.fingerprint/);
});

test("索引、查询和状态使用隔离 Worker，切换查询范围会终止旧查询进程释放缓存", () => {
  assert.match(engine, /return "query"/);
  assert.match(engine, /return "status"/);
  assert.match(engine, /return "index"/);
  assert.match(engine, /this\.workers = new Map\(\)/);
  assert.match(engine, /LOCAL_SEARCH_CACHE_INVALIDATED/);
  assert.match(engine, /await worker\.terminate\(\)/);
  assert.match(engine, /this\.queryScope !== scope/);
  assert.match(engine, /this\.queryRequestTail/);
  assert.match(worker, /if \(action === "cancel"\)[\s\S]*?void run\(\)/);
  assert.doesNotMatch(worker, /\["cancel", "invalidate", "dispose"\]\.includes/);
});

test("执行配置对驱动、设备、批量和模型指纹变化敏感", () => {
  const base = {
    modelFingerprint: "model-a",
    preprocessingVersion: "prep-1",
    preprocessing: { width: 224, height: 224, layout: "NCHW" },
    provider: "dml",
    batchSize: 16,
    deviceId: 0,
    driverFingerprint: "driver-a",
    onnxRuntimeVersion: "1.24.3",
    architecture: "x64",
  };
  const profile = createIndexExecutionProfile(base);
  assert.match(profile, /^execution-v2:[a-f0-9]{64}$/);
  for (const change of [
    { modelFingerprint: "model-b" },
    { driverFingerprint: "driver-b" },
    { deviceId: 1 },
    { batchSize: 8 },
    { preprocessingVersion: "prep-2" },
  ]) {
    assert.notEqual(createIndexExecutionProfile({ ...base, ...change }), profile);
  }
});

test("索引采用批量降级、有界预处理、批事务和单活动模型会话", () => {
  assert.match(worker, /GPU_BATCH_SIZES = Object\.freeze\(\[16, 8, 4, 1\]\)/);
  assert.match(worker, /TRANSACTION_SIZE = 256/);
  assert.match(worker, /PREPROCESS_CONCURRENCY = Math\.max\(2, Math\.min\(8,/);
  assert.match(worker, /SHARP_CONCURRENCY = Math\.max\(2, Math\.min\(4,/);
  assert.match(worker, /FROM images i INDEXED BY images_content_idx\s+CROSS JOIN image_embeddings e/);
  assert.match(worker, /CPU_INTRA_OP_THREADS = Math\.max\(1, Math\.min\(6,/);
  assert.match(worker, /await releaseState\(state\);[\s\S]*?sessionStates\.delete\(existingKey\)/);
  assert.match(worker, /state\.gpuDisabled = true;[\s\S]*?state\.visionProvider = "cpu"/);
  assert.match(worker, /MODEL_TEXT_INPUT_MISSING/);
  assert.match(executionProfile, /INDEX_EXECUTION_PROFILE_VERSION = "execution-v2"/);
  assert.match(worker, /modelFingerprint: state\.model\.fingerprint/);
  assert.match(worker, /driverFingerprint:/);
  assert.match(worker, /onnxRuntimeVersion: ORT_VERSION/);
  assert.match(worker, /architecture: process\.arch/);
  assert.match(worker, /execution_profile/);
  assert.match(worker, /INDEX_EXECUTION_PROFILE_CHANGED/);
  assert.match(worker, /MAX_EXECUTION_PROFILE_RESTARTS = 1/);
  assert.match(worker, /INSERT INTO index_staging_images/);
  assert.match(worker, /DELETE FROM image_embeddings[\s\S]*?model_fingerprint=\?/);
});

test("扫描只有完整完成令牌才能清理旧图片，目录读取失败会暂停而不剪枝", () => {
  assert.match(worker, /throw scanIncomplete\(error\)/);
  assert.match(worker, /error\.code = "INDEX_SCAN_INCOMPLETE"/);
  assert.match(worker, /scanCompleteToken !== SCAN_COMPLETE_TOKEN/);
  assert.match(worker, /finishIndex\(\{[\s\S]*?scanCompleteToken/);
  assert.match(worker, /SELECT \* FROM index_staging_jobs WHERE job_id=\?/);
  assert.match(worker, /DELETE FROM index_staging_jobs WHERE job_id=\?/);
  assert.match(worker, /catalog_status='paused'/);
  const scanStart = worker.indexOf("for await (const scannedFile of walkImages(library.root_path))");
  const beginState = worker.indexOf("generations = beginIndexState", scanStart);
  assert.ok(scanStart >= 0 && beginState > scanStart, "必须在完整枚举目录后才改变代次或重建 profile");
});

test("向量缓存使用 iterate 流式复制并在 300 MiB 后切换分块精确搜索", () => {
  assert.match(worker, /MAX_VECTOR_CACHE_BYTES = 300 \* 1024 \* 1024/);
  assert.match(worker, /new Float64Array\(count\)/);
  assert.match(worker, /statement\.iterate\(\.\.\.argumentsList\)/);
  assert.match(worker, /mode: "chunked"/);
  assert.match(worker, /chunkedTopK/);
});

test("新图库的 SHA 去重查询固定先走内容索引，避免随向量数量线性退化", () => {
  const match = worker.match(/duplicate:\s*db\.prepare\(`(\s*SELECT e\.embedding[\s\S]*?INDEXED BY images_content_idx[\s\S]*?)`\),/);
  assert.ok(match?.[1], "未找到现代多模型 SHA 去重 SQL");
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(`
      CREATE TABLE images (
        id INTEGER PRIMARY KEY, library_id TEXT NOT NULL, relative_path TEXT NOT NULL,
        mtime_ms REAL NOT NULL, size_bytes INTEGER NOT NULL, sha256 TEXT,
        format TEXT, width INTEGER, height INTEGER, scan_generation INTEGER NOT NULL DEFAULT 0,
        UNIQUE(library_id, relative_path)
      );
      CREATE INDEX images_content_idx ON images(library_id, sha256);
      CREATE TABLE image_embeddings (
        library_id TEXT NOT NULL, image_id INTEGER NOT NULL, model_id TEXT NOT NULL,
        model_fingerprint TEXT NOT NULL, dimensions INTEGER NOT NULL, embedding BLOB,
        scan_generation INTEGER NOT NULL DEFAULT 0, error_code TEXT,
        PRIMARY KEY(library_id, image_id, model_id, model_fingerprint)
      );
      CREATE INDEX image_embeddings_generation_idx
        ON image_embeddings(library_id, model_id, model_fingerprint, scan_generation);
    `);
    const plan = db.prepare(`EXPLAIN QUERY PLAN ${match[1]}`).all("library", "digest", "model", "fingerprint");
    assert.match(plan[0]?.detail || "", /images_content_idx \(library_id=\? AND sha256=\?\)/);
    assert.match(plan[1]?.detail || "", /sqlite_autoindex_image_embeddings_1/);
  } finally {
    db.close();
  }
});

test("索引管线用单请求双缓冲、内置 NCHW LUT 和节流进度", () => {
  assert.match(worker, /INDEX_INFERENCE_BATCH_SIZE = 16/);
  assert.match(worker, /let inferenceInFlight = null/);
  assert.match(worker, /const task = processInferenceGroups\(groups\)[\s\S]*?task\.then\([\s\S]*?\(error\) => \(\{ error \}\)/);
  assert.match(worker, /await awaitInferenceBarrier\(\)[\s\S]*?startInference\(groups\)/);
  assert.match(worker, /if \(force\) await awaitInferenceBarrier\(\)/);
  assert.match(worker, /else await awaitInferenceBarrier\(\)/);
  assert.match(worker, /model\.builtin[\s\S]*?pixelType !== "float32"[\s\S]*?layout !== "NCHW"/);
  assert.match(worker, /new Float32Array\(256\)/);
  assert.match(worker, /input\[pixel\] = lut0[\s\S]*?input\[plane1 \+ pixel\] = lut1[\s\S]*?input\[plane2 \+ pixel\] = lut2/);
  assert.match(worker, /PROGRESS_EMIT_INTERVAL_MS = 250/);
  assert.match(worker, /progressEmissionTimes\.delete\(jobId\)/);
});

test("损坏或缺失 ONNX 的 DirectML 探测在隔离子进程中返回结构化失败", async () => {
  const probePath = fileURLToPath(new URL("../desktop/services/local-image-search/directml-probe.mjs", import.meta.url));
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [probePath, "Z:\\definitely-missing\\model.onnx", "0", "e30"], {
      windowsHide: true,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("isolated probe did not exit"));
    }, 15_000);
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
  });
  assert.equal(result.signal, null);
  assert.notEqual(result.code, 0);
  const message = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1));
  assert.equal(message.ok, false);
  assert.equal(Number(message.deviceId), 0);
  assert.ok(message.error);
});
