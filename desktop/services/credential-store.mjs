import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  cloneAndValidateCredentials,
  DesktopError,
  errorCodeOnly,
} from "../shared/core.mjs";

const STORE_VERSION = 2;
const LEGACY_STORE_VERSION = 1;
const MAX_STORE_FILE_BYTES = 512 * 1024;

function hasSecretValue(value) {
  if (typeof value === "string") return Boolean(value.trim());
  if (!value || typeof value !== "object") return false;
  return Object.values(value).some(hasSecretValue);
}

export class CredentialStore {
  constructor({
    safeStorage,
    userDataPath,
    fileName = "credentials.v2.json",
    legacyFileName = "credentials.v1.json",
  }) {
    if (!safeStorage || typeof safeStorage.encryptString !== "function") {
      throw new TypeError("safeStorage implementation is required");
    }
    if (!path.isAbsolute(userDataPath)) {
      throw new TypeError("userDataPath must be absolute");
    }
    this.safeStorage = safeStorage;
    this.filePath = path.join(userDataPath, fileName);
    this.legacyFilePath = path.join(userDataPath, legacyFileName);
  }

  isAvailable() {
    return Boolean(this.safeStorage.isEncryptionAvailable?.());
  }

  assertAvailable() {
    if (!this.isAvailable()) {
      throw new DesktopError(
        "CREDENTIAL_STORAGE_UNAVAILABLE",
        "Windows 凭据加密当前不可用，请重新登录系统后重试",
      );
    }
  }

  async exists() {
    try {
      await readFile(this.filePath, { encoding: null, flag: "r" });
      return true;
    } catch (error) {
      if (error?.code === "ENOENT") return false;
      throw new DesktopError("CREDENTIAL_STORE_READ_FAILED", "无法读取本机凭据状态");
    }
  }

  async #readEnvelope(filePath, expectedVersion) {
    this.assertAvailable();
    let raw;
    try {
      raw = await readFile(filePath);
    } catch (error) {
      if (error?.code === "ENOENT") return Object.create(null);
      throw new DesktopError("CREDENTIAL_STORE_READ_FAILED", "无法读取本机凭据");
    }
    if (raw.byteLength > MAX_STORE_FILE_BYTES) {
      throw new DesktopError("CREDENTIAL_STORE_CORRUPT", "本机凭据文件无效");
    }

    try {
      const envelope = JSON.parse(raw.toString("utf8"));
      if (
        envelope?.version !== expectedVersion ||
        envelope?.protection !== "electron-safe-storage" ||
        typeof envelope?.ciphertext !== "string" ||
        !/^[A-Za-z0-9+/]+={0,2}$/.test(envelope.ciphertext)
      ) {
        throw new Error("invalid envelope");
      }
      const encrypted = Buffer.from(envelope.ciphertext, "base64");
      if (!encrypted.length || encrypted.byteLength > MAX_STORE_FILE_BYTES) {
        throw new Error("invalid ciphertext");
      }
      const plaintext = this.safeStorage.decryptString(encrypted);
      return cloneAndValidateCredentials(JSON.parse(plaintext));
    } catch (error) {
      if (error instanceof DesktopError && error.code === "INVALID_CREDENTIALS") {
        throw new DesktopError("CREDENTIAL_STORE_CORRUPT", "本机凭据文件无效");
      }
      throw new DesktopError("CREDENTIAL_STORE_CORRUPT", "本机凭据无法解密");
    }
  }

  async get() {
    const payload = await this.#readEnvelope(this.filePath, STORE_VERSION);
    if (!Object.keys(payload).length) return Object.create(null);
    if (payload.version !== STORE_VERSION || !payload.secrets || typeof payload.secrets !== "object") {
      throw new DesktopError("CREDENTIAL_STORE_CORRUPT", "本机凭据文件无效");
    }
    return cloneAndValidateCredentials(payload.secrets);
  }

  async readLegacy() {
    return this.#readEnvelope(this.legacyFilePath, LEGACY_STORE_VERSION);
  }

  async archiveLegacy() {
    const backupPath = `${this.legacyFilePath}.migrated-backup`;
    try {
      await readFile(backupPath, { encoding: null, flag: "r" });
      return { archived: false, reason: "backup-exists", backupPath };
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw new DesktopError("CREDENTIAL_STORE_READ_FAILED", "无法检查旧版凭据备份");
      }
    }
    try {
      await rename(this.legacyFilePath, backupPath);
    } catch (error) {
      if (error?.code === "ENOENT") return { archived: false, reason: "not-found", backupPath };
      throw new DesktopError("CREDENTIAL_STORE_WRITE_FAILED", "无法归档旧版凭据文件");
    }
    return { archived: true, backupPath };
  }

  async getStatus() {
    if (!this.isAvailable()) {
      return {
        available: false,
        configured: false,
        configuredFieldCount: 0,
        providers: Object.create(null),
        protection: "unavailable",
      };
    }
    try {
      const credentials = await this.get();
      const providers = Object.fromEntries(
        Object.entries(credentials).map(([providerId, value]) => [providerId, hasSecretValue(value)]),
      );
      return {
        available: true,
        configured: Object.values(providers).some(Boolean),
        configuredFieldCount: Object.values(providers).filter(Boolean).length,
        providers,
        protection: "windows-dpapi",
      };
    } catch (error) {
      if (error?.code === "CREDENTIAL_STORE_READ_FAILED" || error?.code === "CREDENTIAL_STORE_CORRUPT") {
        return {
          available: true,
          configured: false,
          configuredFieldCount: 0,
          providers: Object.create(null),
          protection: "windows-dpapi",
          errorCode: errorCodeOnly(error),
        };
      }
      throw error;
    }
  }

  async set(credentials) {
    this.assertAvailable();
    const sanitized = cloneAndValidateCredentials(credentials);
    const plaintext = JSON.stringify({ version: STORE_VERSION, secrets: sanitized });
    if (Buffer.byteLength(plaintext, "utf8") > 128 * 1024) {
      throw new DesktopError("INVALID_CREDENTIALS", "凭据配置超过大小限制");
    }
    const encrypted = this.safeStorage.encryptString(plaintext);
    const envelope = JSON.stringify({
      version: STORE_VERSION,
      protection: "electron-safe-storage",
      ciphertext: Buffer.from(encrypted).toString("base64"),
    });

    const directory = path.dirname(this.filePath);
    const temporaryPath = `${this.filePath}.${randomUUID()}.tmp`;
    await mkdir(directory, { recursive: true });
    try {
      await writeFile(temporaryPath, envelope, { encoding: "utf8", mode: 0o600, flag: "wx" });
      await rename(temporaryPath, this.filePath);
    } catch (error) {
      await unlink(temporaryPath).catch(() => {});
      throw new DesktopError("CREDENTIAL_STORE_WRITE_FAILED", "无法保存本机凭据");
    }
    return this.getStatus();
  }

  async getProviderSecret(providerId) {
    const id = String(providerId || "");
    if (!/^[a-z0-9][a-z0-9-]{1,63}$/.test(id)) {
      throw new DesktopError("PROVIDER_ID_INVALID", "模型服务标识无效");
    }
    const credentials = await this.get();
    const value = credentials[id];
    return value && typeof value === "object" ? cloneAndValidateCredentials({ value }).value : null;
  }

  async updateProviderSecret(providerId, action, value) {
    const id = String(providerId || "");
    if (!/^[a-z0-9][a-z0-9-]{1,63}$/.test(id)) {
      throw new DesktopError("PROVIDER_ID_INVALID", "模型服务标识无效");
    }
    if (!["keep", "replace", "clear"].includes(action)) {
      throw new DesktopError("PROVIDER_SECRET_ACTION_INVALID", "凭据保存方式无效");
    }
    if (action === "keep") return this.getStatus();
    const credentials = await this.get();
    if (action === "clear") delete credentials[id];
    else credentials[id] = cloneAndValidateCredentials({ value }).value;
    await this.set(credentials);
    return this.getStatus();
  }

  async seedIfEmpty(credentials) {
    if (await this.exists()) return { seeded: false, reason: "already-configured" };
    await this.set(credentials);
    return { seeded: true };
  }

  async clear() {
    try {
      await unlink(this.filePath);
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw new DesktopError("CREDENTIAL_STORE_CLEAR_FAILED", "无法清除本机凭据");
      }
    }
    return {
      available: this.isAvailable(),
      configured: false,
      configuredFieldCount: 0,
      providers: Object.create(null),
      protection: this.isAvailable() ? "windows-dpapi" : "unavailable",
    };
  }
}
