import { createDecipheriv, createHash, timingSafeEqual } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { cloneAndValidateCredentials, DesktopError, isPlainRecord } from "../shared/core.mjs";

const MAGIC = Buffer.from([0x4e, 0x47, 0x52, 0x53, 0x45, 0x43, 0x31, 0x00]);
const KEY_SHARE_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const HEADER_BYTES = MAGIC.byteLength + KEY_SHARE_BYTES + IV_BYTES + TAG_BYTES;
const MAX_TEST_SECRETS_BYTES = 256 * 1024;
export const TEST_SECRETS_AAD = "NGR AssetPilot test credentials v1";

function decodeKeyShare(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    throw new DesktopError("TEST_SECRETS_CONFIG_INVALID", "测试凭据配置无效");
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.byteLength !== KEY_SHARE_BYTES) {
    throw new DesktopError("TEST_SECRETS_CONFIG_INVALID", "测试凭据配置无效");
  }
  return decoded;
}

function assertConfig(config) {
  if (
    !isPlainRecord(config) ||
    config.schemaVersion !== 1 ||
    config.algorithm !== "aes-256-gcm" ||
    typeof config.resourceName !== "string" ||
    path.basename(config.resourceName) !== config.resourceName ||
    typeof config.blobSha256 !== "string" ||
    !/^[a-f0-9]{64}$/i.test(config.blobSha256)
  ) {
    throw new DesktopError("TEST_SECRETS_CONFIG_INVALID", "测试凭据配置无效");
  }
}

export function decryptTestSecretsBlob(blobValue, config) {
  assertConfig(config);
  const blob = Buffer.from(blobValue);
  if (blob.byteLength <= HEADER_BYTES || blob.byteLength > MAX_TEST_SECRETS_BYTES) {
    throw new DesktopError("TEST_SECRETS_BLOB_INVALID", "测试凭据包无效");
  }

  const expectedHash = Buffer.from(config.blobSha256, "hex");
  const actualHash = createHash("sha256").update(blob).digest();
  if (expectedHash.byteLength !== actualHash.byteLength || !timingSafeEqual(expectedHash, actualHash)) {
    throw new DesktopError("TEST_SECRETS_HASH_MISMATCH", "测试凭据包完整性校验失败");
  }
  if (!timingSafeEqual(blob.subarray(0, MAGIC.byteLength), MAGIC)) {
    throw new DesktopError("TEST_SECRETS_BLOB_INVALID", "测试凭据包格式无效");
  }

  const keyShareA = decodeKeyShare(config.keyShare);
  const keyShareB = Buffer.from(blob.subarray(MAGIC.byteLength, MAGIC.byteLength + KEY_SHARE_BYTES));
  const ivStart = MAGIC.byteLength + KEY_SHARE_BYTES;
  const tagStart = ivStart + IV_BYTES;
  const ciphertextStart = tagStart + TAG_BYTES;
  const iv = blob.subarray(ivStart, tagStart);
  const authTag = blob.subarray(tagStart, ciphertextStart);
  const ciphertext = blob.subarray(ciphertextStart);
  const key = Buffer.allocUnsafe(KEY_SHARE_BYTES);
  for (let index = 0; index < KEY_SHARE_BYTES; index += 1) key[index] = keyShareA[index] ^ keyShareB[index];

  let plaintext;
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAAD(Buffer.from(TEST_SECRETS_AAD, "utf8"));
    decipher.setAuthTag(authTag);
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    if (plaintext.byteLength > 128 * 1024) {
      throw new DesktopError("TEST_SECRETS_BLOB_INVALID", "测试凭据内容超过大小限制");
    }
    return cloneAndValidateCredentials(JSON.parse(plaintext.toString("utf8")));
  } catch (error) {
    if (error instanceof DesktopError) throw error;
    throw new DesktopError("TEST_SECRETS_DECRYPT_FAILED", "测试凭据包无法解密");
  } finally {
    key.fill(0);
    keyShareA.fill(0);
    keyShareB.fill(0);
    plaintext?.fill(0);
  }
}

export async function loadTestSecrets({ config, resourcesPath }) {
  assertConfig(config);
  if (typeof resourcesPath !== "string" || !path.isAbsolute(resourcesPath)) {
    throw new DesktopError("TEST_SECRETS_CONFIG_INVALID", "测试凭据资源目录无效");
  }
  const blobPath = path.join(resourcesPath, config.resourceName);
  let fileStats;
  try {
    fileStats = await stat(blobPath);
  } catch {
    throw new DesktopError("TEST_SECRETS_NOT_FOUND", "未找到测试凭据包");
  }
  if (!fileStats.isFile() || fileStats.size <= HEADER_BYTES || fileStats.size > MAX_TEST_SECRETS_BYTES) {
    throw new DesktopError("TEST_SECRETS_BLOB_INVALID", "测试凭据包无效");
  }
  const blob = await readFile(blobPath);
  try {
    return decryptTestSecretsBlob(blob, config);
  } finally {
    blob.fill(0);
  }
}
