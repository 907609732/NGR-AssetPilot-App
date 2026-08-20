import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { LocalImageSearchEngine } from "../desktop/services/local-image-search/engine.mjs";
import {
  BUILTIN_MODEL_ID,
  createBuiltinModelManifest,
} from "../desktop/services/local-image-search/model-manager.mjs";
import { LocalImageSearchStorage } from "../desktop/services/local-image-search/storage.mjs";

function readOption(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function modelConfig(modelRoot) {
  const manifest = createBuiltinModelManifest();
  return {
    id: manifest.id,
    fingerprint: manifest.fingerprint,
    dimensions: manifest.dimensions,
    kind: manifest.kind,
    supportsText: manifest.supportsText,
    builtin: true,
    vision: {
      ...manifest.vision,
      modelPath: path.join(modelRoot, ...manifest.vision.modelPath.split("/")),
      modelRoot: path.join(modelRoot, manifest.vision.modelRoot),
      externalData: [],
    },
    text: {
      ...manifest.text,
      modelPath: path.join(modelRoot, ...manifest.text.modelPath.split("/")),
      modelRoot: path.join(modelRoot, manifest.text.modelRoot),
      tokenizerRoot: path.join(modelRoot, manifest.text.tokenizerRoot),
      externalData: [],
    },
  };
}

const sourceArgument = readOption("--source");
assert.ok(sourceArgument, "用法：node scripts/benchmark-local-image-index.mjs --source <图库> [--model-root <models>] [--keep]");
const sourceRoot = await realpath(path.resolve(sourceArgument));
assert.ok((await stat(sourceRoot)).isDirectory(), "--source 必须是存在的目录");
const defaultModelRoot = path.join(process.env.APPDATA || "", "NGR AssetPilot", "local-image-search", "models");
const modelRoot = await realpath(path.resolve(readOption("--model-root", defaultModelRoot)));
assert.ok((await stat(modelRoot)).isDirectory(), "--model-root 必须是存在的模型目录");
const keep = process.argv.includes("--keep");
const maxSeconds = Number(readOption("--max-seconds", "480"));
const minRate = Number(readOption("--min-rate", "60"));
const tempParent = readOption("--temp-root", os.tmpdir());
const benchmarkRoot = await mkdtemp(path.join(path.resolve(tempParent), "ngr-index-benchmark-"));
const dataRoot = path.join(benchmarkRoot, "local-image-search");
const storage = new LocalImageSearchStorage({ dataRoot });
const library = storage.createLibrary({ id: randomUUID(), rootPath: sourceRoot, name: path.basename(sourceRoot) });
const engine = new LocalImageSearchEngine({ dbPath: storage.dbPath, modelRoot });
const config = modelConfig(modelRoot);
let lastProgressAt = 0;
const unsubscribe = engine.onProgress((_jobId, progress) => {
  const now = Date.now();
  if (now - lastProgressAt < 5_000) return;
  lastProgressAt = now;
  process.stderr.write(`${JSON.stringify({
    stage: progress.stage,
    scanned: progress.scanned,
    analyzed: progress.analyzed,
    reused: progress.reused,
    errors: progress.errors,
    provider: progress.executionProvider,
    batch: progress.batchSize,
    imagesPerSecond: progress.imagesPerSecond,
    etaSeconds: progress.etaSeconds,
  })}\n`);
});

async function run(label) {
  const startedAt = performance.now();
  const result = await engine.request("index", {
    jobId: randomUUID(),
    libraryId: library.id,
    modelId: BUILTIN_MODEL_ID,
    modelConfig: config,
  });
  const elapsedSeconds = (performance.now() - startedAt) / 1000;
  return {
    label,
    elapsedSeconds: Number(elapsedSeconds.toFixed(2)),
    overallImagesPerSecond: Number((Number(result.total || result.scanned || 0) / Math.max(elapsedSeconds, 0.001)).toFixed(2)),
    ...result,
  };
}

try {
  const initial = await run("initial");
  assert.equal(initial.state, "completed", "首次分析未完成");
  assert.ok(initial.elapsedSeconds <= maxSeconds, `首次分析 ${initial.elapsedSeconds}s 超过 ${maxSeconds}s`);
  assert.ok(initial.overallImagesPerSecond >= minRate, `首次分析 ${initial.overallImagesPerSecond} 张/秒低于 ${minRate}`);
  const rescan = await run("unchanged-rescan");
  assert.equal(rescan.state, "completed", "无变化重扫未完成");
  assert.ok(rescan.elapsedSeconds <= 20, `无变化重扫 ${rescan.elapsedSeconds}s 超过 20s`);
  const stored = storage.getLibrary(library.id, { modelId: BUILTIN_MODEL_ID });
  const summary = {
    sourceRoot,
    temporaryDataRoot: dataRoot,
    modelRoot,
    indexedImages: stored.itemCount,
    errors: stored.errorCount,
    initial,
    rescan,
  };
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
} finally {
  unsubscribe();
  await engine.dispose();
  storage.close();
  if (!keep) await rm(benchmarkRoot, { recursive: true, force: true });
  else process.stderr.write(`保留基准临时目录：${benchmarkRoot}\n`);
}
