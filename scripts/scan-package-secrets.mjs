import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { decryptTestSecretBlob, resolveTestSecretPayload } from "./build-test-secrets.mjs";
import { projectPaths, projectRoot } from "./project-env.mjs";

function getSourcePath(env = process.env) {
  const candidates = [
    env.NGR_TEST_SECRET_SOURCE,
    path.join(projectRoot, "app", "API配置文件", "local-config.js"),
    env.USERPROFILE
      ? path.join(env.USERPROFILE, "Documents", "AI资源领航", "app", "API配置文件", "local-config.js")
      : undefined,
  ];
  return candidates.filter(Boolean).map((candidate) => path.resolve(candidate)).find(fs.existsSync);
}

function collectKnownSecrets(env = process.env) {
  let payload;
  try {
    payload = resolveTestSecretPayload({ sourcePath: getSourcePath(env), env });
  } catch {
    try {
      const moduleSource = fs.readFileSync(path.join(projectPaths.generated, "test-secrets-key.mjs"), "utf8");
      const keyShareText = moduleSource.match(/keyShare:\s*"([^"]+)"/)?.[1];
      if (!keyShareText) return [];
      const blob = fs.readFileSync(path.join(projectPaths.generated, "test-secrets.bin"));
      payload = decryptTestSecretBlob(blob, Buffer.from(keyShareText, "base64"));
    } catch {
      return [];
    }
  }
  return [
    ["Kimi API Key", payload.ai.apiKey],
    ["百度翻译 App ID", payload.translation.baiduAppId],
    ["百度翻译密钥", payload.translation.baiduSecret],
  ].filter(([, value]) => typeof value === "string" && value.length >= 8);
}

function walkFiles(directory) {
  if (!fs.existsSync(directory)) {
    return [];
  }
  const files = [];
  const pending = [directory];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        pending.push(fullPath);
      } else if (entry.isFile()) {
        files.push(fullPath);
      }
    }
  }
  return files;
}

function containsBuffer(filePath, needle) {
  if (needle.length === 0) {
    return false;
  }
  const file = fs.openSync(filePath, "r");
  const chunk = Buffer.allocUnsafe(1024 * 1024);
  let overlap = Buffer.alloc(0);
  try {
    for (;;) {
      const count = fs.readSync(file, chunk, 0, chunk.length, null);
      if (count === 0) {
        return false;
      }
      const haystack = overlap.length
        ? Buffer.concat([overlap, chunk.subarray(0, count)])
        : chunk.subarray(0, count);
      if (haystack.indexOf(needle) !== -1) {
        return true;
      }
      const overlapLength = Math.min(needle.length - 1, haystack.length);
      overlap = overlapLength ? Buffer.from(haystack.subarray(haystack.length - overlapLength)) : Buffer.alloc(0);
    }
  } finally {
    fs.closeSync(file);
  }
}

function encodeKnownSecretNeedles(secretPairs) {
  const encoders = [
    ["UTF-8", (value) => Buffer.from(value, "utf8")],
    ["UTF-16LE", (value) => Buffer.from(value, "utf16le")],
    ["Base64", (value) => Buffer.from(Buffer.from(value, "utf8").toString("base64"), "ascii")],
    ["Hex", (value) => Buffer.from(Buffer.from(value, "utf8").toString("hex"), "ascii")],
  ];
  return secretPairs.flatMap(([label, value]) => encoders.map(([encoding, encode]) => [
    `${label} (${encoding})`,
    encode(value),
  ]));
}

export function scanArtifacts({ edition, env = process.env } = {}) {
  if (!['dev', 'test'].includes(edition)) throw new Error("版本必须是 dev 或 test");
  const artifactDirectory = projectPaths[`${edition}Artifacts`];
  const files = walkFiles(artifactDirectory);
  if (files.length === 0) {
    throw new Error("没有可扫描的构建产物");
  }

  const knownSecrets = collectKnownSecrets(env);
  const forbidden = encodeKnownSecretNeedles(knownSecrets);
  const forbiddenFileNames = new Set();
  forbiddenFileNames.add("test-secrets.bin");
  forbiddenFileNames.add("test-secrets-key.mjs");
  forbiddenFileNames.add("test-secrets.mjs");
  forbidden.push(
    ["测试密钥文件名", Buffer.from("test-secrets.bin", "utf8")],
    ["测试密钥模块名", Buffer.from("test-secrets-key.mjs", "utf8")],
    ["测试密钥加载器名", Buffer.from("test-secrets.mjs", "utf8")],
    ["测试密钥 magic", Buffer.from("NGRSEC1\0", "ascii")],
  );

  const findings = [];
  for (const filePath of files) {
    const relativeFile = path.relative(artifactDirectory, filePath);
    const isBuilderDebugMetadata = relativeFile === "builder-debug.yml";
    if (forbiddenFileNames.has(path.basename(filePath).toLowerCase())) {
      findings.push({ label: "测试密钥文件路径", file: relativeFile });
    }
    for (const [label, needle] of forbidden) {
      // electron-builder records the configured exclusion rules in this local
      // debug file. Keep scanning it for real credential values and the binary
      // magic, but do not treat the names inside explicit `!…` rules as a leak.
      if (
        isBuilderDebugMetadata
        && ["测试密钥文件名", "测试密钥模块名", "测试密钥加载器名"].includes(label)
      ) {
        continue;
      }
      if (containsBuffer(filePath, needle)) {
        findings.push({ label, file: relativeFile });
      }
    }
  }

  if (findings.length > 0) {
    const locations = findings.map(({ label, file }) => `${label} @ ${file}`).join("；");
    throw new Error(`凭据扫描未通过：${locations}`);
  }
  return { artifactDirectory, fileCount: files.length, knownSecretCount: knownSecrets.length };
}

const isCli = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isCli) {
  try {
    if (process.argv.length !== 3) throw new Error("请指定 dev 或 test");
    const result = scanArtifacts({ edition: process.argv[2] });
    console.log(`凭据扫描通过：检查 ${result.fileCount} 个文件，未输出任何凭据值。`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "凭据扫描失败");
    process.exitCode = 1;
  }
}
