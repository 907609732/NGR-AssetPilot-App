import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import generatedConfig from "../build/generated/test-secrets-key.mjs";
import { loadTestSecrets } from "../desktop/services/test-secrets.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const generatedDirectory = path.join(projectRoot, "build", "generated");
const payload = await loadTestSecrets({ config: generatedConfig, resourcesPath: generatedDirectory });
const plaintextNeedles = [
  payload?.ai?.apiKey,
  payload?.translation?.baiduAppId,
  payload?.translation?.baiduSecret,
].filter((value) => typeof value === "string" && value.length >= 8).map((value) => Buffer.from(value, "utf8"));

if (plaintextNeedles.length !== 3) throw new Error("测试凭据校验字段不完整");

function walk(directory) {
  const output = [];
  const pending = [directory];
  while (pending.length) {
    const current = pending.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(target);
      else if (entry.isFile()) output.push(target);
    }
  }
  return output;
}

function containsAny(filePath, needles) {
  const handle = fs.openSync(filePath, "r");
  const block = Buffer.allocUnsafe(1024 * 1024);
  const overlapSize = Math.max(...needles.map((needle) => needle.length)) - 1;
  let overlap = Buffer.alloc(0);
  try {
    for (;;) {
      const count = fs.readSync(handle, block, 0, block.length, null);
      if (!count) return false;
      const current = overlap.length
        ? Buffer.concat([overlap, block.subarray(0, count)])
        : block.subarray(0, count);
      if (needles.some((needle) => current.indexOf(needle) !== -1)) return true;
      overlap = Buffer.from(current.subarray(Math.max(0, current.length - overlapSize)));
    }
  } finally {
    fs.closeSync(handle);
  }
}

const results = [];
const sourceFiles = [
  "app",
  "desktop",
  "scripts",
  "tests",
  "build",
  "assets",
  ".github",
  path.join("website", "app"),
  path.join("website", "tests"),
].flatMap((relativePath) => {
  const target = path.join(projectRoot, relativePath);
  return fs.existsSync(target) ? walk(target) : [];
}).filter((filePath) => !filePath.startsWith(`${generatedDirectory}${path.sep}`));
for (const name of ["package.json", "package-lock.json", "README-DESKTOP.md", "LICENSE"]) {
  const target = path.join(projectRoot, name);
  if (fs.existsSync(target)) sourceFiles.push(target);
}
const sourcePlaintextHits = sourceFiles.filter((filePath) => containsAny(filePath, plaintextNeedles));
if (sourcePlaintextHits.length) {
  throw new Error(`桌面源码发现 ${sourcePlaintextHits.length} 个明文凭据命中`);
}

for (const channel of ["test", "release"]) {
  const root = path.join(projectRoot, "artifacts", channel);
  const files = walk(root);
  const plaintextHits = files.filter((filePath) => containsAny(filePath, plaintextNeedles));
  if (plaintextHits.length) {
    throw new Error(`${channel} 产物发现 ${plaintextHits.length} 个明文凭据命中`);
  }
  results.push({ channel, scannedFiles: files.length, plaintextHits: 0 });
}

process.stdout.write(`${JSON.stringify({ sourceScannedFiles: sourceFiles.length, sourcePlaintextHits: 0, artifacts: results })}\n`);
process.stdout.write("FINAL_SECRET_SCAN_OK\n");
