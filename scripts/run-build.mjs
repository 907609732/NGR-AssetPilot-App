import childProcess from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { generateReleaseMetadata } from "./generate-release-metadata.mjs";
import { createProjectEnvironment, projectPaths, projectRoot } from "./project-env.mjs";
import { scanArtifacts } from "./scan-package-secrets.mjs";

const edition = process.argv[2];
if (!['dev', 'test'].includes(edition) || process.argv.length !== 3) {
  throw new Error("请使用 npm run build:dev 或 npm run build:test");
}

const artifactDirectory = projectPaths[`${edition}Artifacts`];
const buildLockPath = path.join(projectPaths.temp, `build-${edition}.lock`);

function isProcessRunning(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function acquireBuildLock() {
  fs.mkdirSync(projectPaths.temp, { recursive: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = fs.openSync(buildLockPath, "wx");
      fs.writeFileSync(handle, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
      fs.closeSync(handle);
      return () => fs.rmSync(buildLockPath, { force: true });
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      let ownerPid = 0;
      try { ownerPid = JSON.parse(fs.readFileSync(buildLockPath, "utf8")).pid; } catch {}
      if (Number.isSafeInteger(ownerPid) && ownerPid > 0 && isProcessRunning(ownerPid)) {
        throw new Error(`已有 ${edition} 构建正在运行（PID ${ownerPid}）`);
      }
      fs.rmSync(buildLockPath, { force: true });
    }
  }
  throw new Error("无法取得构建锁");
}

function safelyResetOutput(directory) {
  const resolved = path.resolve(directory);
  const allowed = [projectPaths.devArtifacts, projectPaths.testArtifacts].map((value) => path.resolve(value));
  if (!allowed.includes(resolved)) throw new Error("拒绝清理开发版/测试版产物目录以外的位置");
  fs.rmSync(resolved, { recursive: true, force: true });
  fs.mkdirSync(resolved, { recursive: true });
}

function runBuilder(env) {
  const executable = path.join(projectRoot, "node_modules", "electron-builder", "out", "cli", "cli.js");
  if (!fs.existsSync(executable)) throw new Error("缺少 node_modules；请先执行 npm ci");
  const result = childProcess.spawnSync(process.execPath, [executable, "--config", "build/electron-builder.config.cjs", "--publish", "never"], {
    cwd: projectRoot,
    env,
    stdio: "inherit",
  });
  if (result.status !== 0) throw new Error(`electron-builder 失败，退出码 ${result.status ?? "unknown"}`);
}

const releaseBuildLock = acquireBuildLock();
try {
  safelyResetOutput(artifactDirectory);
  const env = createProjectEnvironment({ CSC_IDENTITY_AUTO_DISCOVERY: "false", NGR_BUILD_EDITION: edition });
  runBuilder(env);
  const manifest = generateReleaseMetadata(edition);
  const scan = scanArtifacts({ edition, env });
  console.log(`${edition === 'test' ? '测试版' : '开发版'}构建完成：${manifest.version}；凭据扫描 ${scan.fileCount} 个文件。`);
} finally {
  releaseBuildLock();
}
