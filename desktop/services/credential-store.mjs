import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  cloneAndValidateCredentials,
  credentialStatus,
  DesktopError,
  errorCodeOnly,
} from "../shared/core.mjs";

const STORE_VERSION = 1;
const MAX_STORE_FILE_BYTES = 512 * 1024;

export class CredentialStore {
  constructor({ safeStorage, userDataPath, fileName = "credentials.v1.json" }) {
    if (!safeStorage || typeof safeStorage.encryptString !== "function") {
      throw new TypeError("safeStorage implementation is required");
    }
    if (!path.isAbsolute(userDataPath)) {
      throw new TypeError("userDataPath must be absolute");
    }
    this.safeStorage = safeStorage;
    this.filePath = path.join(userDataPath, fileName);
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

  async get() {
    this.assertAvailable();
    let raw;
    try {
      raw = await readFile(this.filePath);
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
        envelope?.version !== STORE_VERSION ||
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
      return {
        available: true,
        ...credentialStatus(credentials),
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
    const plaintext = JSON.stringify(sanitized);
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
