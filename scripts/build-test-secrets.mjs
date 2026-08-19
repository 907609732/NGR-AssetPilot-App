import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { projectPaths, projectRoot } from "./project-env.mjs";

const MAGIC = Buffer.from("NGRSEC1\0", "ascii");
const TEST_SECRET_AAD = Buffer.from("NGR AssetPilot test credentials v1", "utf8");
const PLACEHOLDER_PATTERN = /填入|your\s|example|changeme|replace.?me/i;

function asText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function readConfigInMemory(sourcePath) {
  if (!sourcePath || !fs.existsSync(sourcePath)) {
    return {};
  }

  const source = fs.readFileSync(sourcePath, "utf8");
  const sandbox = { window: Object.create(null) };
  const context = vm.createContext(sandbox, {
    codeGeneration: { strings: false, wasm: false },
  });
  new vm.Script(source, { filename: "local-config.js" }).runInContext(context, { timeout: 250 });
  return sandbox.window;
}

function validateSecret(name, value) {
  const text = asText(value);
  if (!text || PLACEHOLDER_PATTERN.test(text)) {
    throw new Error(`缺少有效的 ${name}；请通过环境变量或 NGR_TEST_SECRET_SOURCE 提供`);
  }
  return text;
}

function validateHttpsUrl(name, value, fallback) {
  const text = asText(value) || fallback;
  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    throw new Error(`${name} 不是有效 URL`);
  }
  if (parsed.protocol !== "https:") {
    throw new Error(`${name} 必须使用 HTTPS`);
  }
  return parsed.toString().replace(/\/$/, "");
}

export function resolveTestSecretPayload({ sourcePath, env = process.env } = {}) {
  const sourceConfig = readConfigInMemory(sourcePath);
  const kimi = sourceConfig.NGR_LOCAL_KIMI_CONFIG ?? sourceConfig.NGR_LOCAL_AI_CONFIG ?? {};
  const translation = sourceConfig.NGR_LOCAL_TRANSLATION_CONFIG ?? {};

  return {
    schemaVersion: 1,
    ai: {
      provider: "kimi",
      apiFormat: asText(env.NGR_TEST_KIMI_API_FORMAT) || asText(kimi.apiFormat) || "chat",
      baseUrl: validateHttpsUrl(
        "Kimi Base URL",
        env.NGR_TEST_KIMI_BASE_URL || kimi.baseUrl,
        "https://api.moonshot.cn/v1",
      ),
      apiKey: validateSecret("Kimi API Key", env.NGR_TEST_KIMI_API_KEY || kimi.apiKey),
      model: asText(env.NGR_TEST_KIMI_MODEL) || asText(kimi.model) || "moonshot-v1-8k-vision-preview",
    },
    translation: {
      provider: "baidu",
      baiduAppId: validateSecret("百度翻译 App ID", env.NGR_TEST_BAIDU_APP_ID || translation.baiduAppId),
      baiduSecret: validateSecret("百度翻译密钥", env.NGR_TEST_BAIDU_SECRET || translation.baiduSecret),
      baiduEndpoint: validateHttpsUrl(
        "百度翻译 Endpoint",
        env.NGR_TEST_BAIDU_ENDPOINT || translation.baiduEndpoint,
        "https://fanyi-api.baidu.com/api/trans/vip/translate",
      ),
    },
  };
}

function xorBuffers(left, right) {
  if (left.length !== right.length) {
    throw new Error("密钥份额长度不一致");
  }
  const result = Buffer.allocUnsafe(left.length);
  for (let index = 0; index < left.length; index += 1) {
    result[index] = left[index] ^ right[index];
  }
  return result;
}

export function encryptTestSecretPayload(payload) {
  const contentKey = crypto.randomBytes(32);
  const keyShareA = crypto.randomBytes(32);
  const keyShareB = xorBuffers(contentKey, keyShareA);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", contentKey, iv);
  cipher.setAAD(TEST_SECRET_AAD);
  const ciphertext = Buffer.concat([
    cipher.update(Buffer.from(JSON.stringify(payload), "utf8")),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  contentKey.fill(0);

  const blob = Buffer.concat([MAGIC, keyShareB, iv, authTag, ciphertext]);
  keyShareB.fill(0);
  return { blob, keyShareA };
}

export function decryptTestSecretBlob(blob, keyShareA) {
  if (!Buffer.isBuffer(blob) || blob.length <= 68 || !blob.subarray(0, 8).equals(MAGIC)) {
    throw new Error("测试密钥文件格式无效");
  }
  const keyShareB = blob.subarray(8, 40);
  const key = xorBuffers(keyShareA, keyShareB);
  const iv = blob.subarray(40, 52);
  const authTag = blob.subarray(52, 68);
  const ciphertext = blob.subarray(68);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAAD(TEST_SECRET_AAD);
  decipher.setAuthTag(authTag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  key.fill(0);
  return JSON.parse(plaintext.toString("utf8"));
}

export function buildTestSecrets({ sourcePath, outputDirectory = projectPaths.generated, env = process.env } = {}) {
  const payload = resolveTestSecretPayload({ sourcePath, env });
  const { blob, keyShareA } = encryptTestSecretPayload(payload);
  const blobSha256 = crypto.createHash("sha256").update(blob).digest("hex");
  const moduleSource = [
    "// 此文件由 scripts/build-test-secrets.mjs 生成；禁止提交。",
    "export default Object.freeze({",
    "  schemaVersion: 1,",
    "  algorithm: \"aes-256-gcm\",",
    `  keyShare: ${JSON.stringify(keyShareA.toString("base64"))},`,
    "  resourceName: \"test-secrets.bin\",",
    `  blobSha256: ${JSON.stringify(blobSha256)},`,
    "});",
    "",
  ].join("\n");
  keyShareA.fill(0);

  fs.mkdirSync(outputDirectory, { recursive: true });
  const blobPath = path.join(outputDirectory, "test-secrets.bin");
  const modulePath = path.join(outputDirectory, "test-secrets-key.mjs");
  fs.writeFileSync(blobPath, blob, { mode: 0o600 });
  fs.writeFileSync(modulePath, moduleSource, { encoding: "utf8", mode: 0o600 });
  return { blobPath, modulePath, blobSha256 };
}

function resolveCliSourcePath() {
  if (process.env.NGR_TEST_SECRET_SOURCE) {
    return path.resolve(process.env.NGR_TEST_SECRET_SOURCE);
  }
  const localConfig = path.join(projectRoot, "app", "API配置文件", "local-config.js");
  if (fs.existsSync(localConfig)) {
    return localConfig;
  }
  const originalWorkspaceConfig = process.env.USERPROFILE
    ? path.join(process.env.USERPROFILE, "Documents", "AI资源领航", "app", "API配置文件", "local-config.js")
    : undefined;
  return originalWorkspaceConfig && fs.existsSync(originalWorkspaceConfig)
    ? originalWorkspaceConfig
    : undefined;
}

const isCli = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isCli) {
  try {
    buildTestSecrets({ sourcePath: resolveCliSourcePath() });
    console.log("开发测试用密钥密文已生成；未输出任何凭据值。");
  } catch (error) {
    console.error(`测试密钥生成失败：${error instanceof Error ? error.message : "未知错误"}`);
    process.exitCode = 1;
  }
}
