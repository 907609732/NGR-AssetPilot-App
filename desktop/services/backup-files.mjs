import { createDecipheriv, pbkdf2Sync, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { MAX_BACKUP_BYTES } from "../shared/constants.mjs";
import { DesktopError, isPlainRecord, toBoundedBuffer } from "../shared/core.mjs";

const BACKUP_CHUNK_BYTES = 1024 * 1024;
const MAX_LEGACY_SECRET_BYTES = 8 * 1024 * 1024;
const SECRET_FORMAT = "NGR_ASSETPILOT_SECRETS";
const SECRET_KDF_ITERATIONS = 600_000;
const MIN_SECRET_PASSWORD_LENGTH = 12;
const SESSION_TTL_MS = 30 * 60 * 1000;
const JOURNAL_VERSION = 2;

function suggestedBackupName(value) {
  const fallback = `NGR-AssetPilot-backup-${new Date().toISOString().slice(0, 10)}.ngrap`;
  if (typeof value !== "string") return fallback;
  let name = path.basename(value.trim()).replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-");
  name = name.replace(/[. ]+$/g, "").slice(0, 128);
  if (!name) return fallback;
  if (!name.toLowerCase().endsWith(".ngrap")) name += ".ngrap";
  return name;
}

function asArrayBuffer(buffer) {
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
}

function validSessionId(value) {
  return typeof value === "string" && /^[0-9a-f-]{36}$/i.test(value);
}

function strictBase64(value, expectedBytes = null) {
  if (typeof value !== "string" || !value || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    throw new DesktopError("INVALID_SECRET_BLOCK", "加密凭据参数无效");
  }
  const buffer = Buffer.from(value, "base64");
  if (!buffer.length || (expectedBytes !== null && buffer.byteLength !== expectedBytes)) {
    throw new DesktopError("INVALID_SECRET_BLOCK", "加密凭据参数无效");
  }
  return buffer;
}

function decryptLegacySecretBlock(value, password) {
  if (typeof password !== "string" || password.length < MIN_SECRET_PASSWORD_LENGTH || password.length > 4096) {
    throw new DesktopError("PASSWORD_TOO_SHORT", `迁移密码至少需要 ${MIN_SECRET_PASSWORD_LENGTH} 个字符`);
  }
  const encrypted = toBoundedBuffer(value, MAX_LEGACY_SECRET_BYTES, "SECRET_BLOCK_TOO_LARGE");
  let envelope;
  try {
    envelope = JSON.parse(encrypted.toString("utf8"));
  } catch {
    throw new DesktopError("INVALID_SECRET_BLOCK", "加密凭据格式无效");
  }
  if (
    envelope?.format !== SECRET_FORMAT ||
    envelope?.version !== 1 ||
    envelope?.kdf?.algorithm !== "PBKDF2" ||
    envelope?.kdf?.hash !== "SHA-256" ||
    envelope?.kdf?.iterations !== SECRET_KDF_ITERATIONS ||
    envelope?.cipher?.algorithm !== "AES-256-GCM"
  ) {
    throw new DesktopError("INVALID_SECRET_BLOCK", "加密凭据格式或算法不受支持");
  }
  const salt = strictBase64(envelope.kdf.salt, 16);
  const iv = strictBase64(envelope.cipher.iv, 12);
  const ciphertextWithTag = strictBase64(envelope.cipher.ciphertext);
  if (ciphertextWithTag.byteLength < 17 || ciphertextWithTag.byteLength > MAX_LEGACY_SECRET_BYTES) {
    throw new DesktopError("INVALID_SECRET_BLOCK", "加密凭据参数无效");
  }
  const tag = ciphertextWithTag.subarray(ciphertextWithTag.byteLength - 16);
  const ciphertext = ciphertextWithTag.subarray(0, ciphertextWithTag.byteLength - 16);
  const key = pbkdf2Sync(password, salt, SECRET_KDF_ITERATIONS, 32, "sha256");
  let plaintext = null;
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    const payload = JSON.parse(plaintext.toString("utf8"));
    if (
      payload?.format !== SECRET_FORMAT ||
      payload?.version !== 1 ||
      !isPlainRecord(payload.credentials)
    ) {
      throw new DesktopError("INVALID_SECRET_PAYLOAD", "解密后的凭据格式无效");
    }
    return payload.credentials;
  } catch (error) {
    if (error instanceof DesktopError) throw error;
    throw new DesktopError("DECRYPTION_FAILED", "迁移密码错误或凭据数据已损坏");
  } finally {
    key.fill(0);
    plaintext?.fill(0);
  }
}

export class BackupFileService {
  constructor({ dialog, getWindow, userDataPath, providerRegistry = null }) {
    if (!dialog || typeof dialog.showOpenDialog !== "function" || typeof dialog.showSaveDialog !== "function") {
      throw new TypeError("dialog implementation is required");
    }
    if (!path.isAbsolute(userDataPath)) throw new TypeError("userDataPath must be absolute");
    this.dialog = dialog;
    this.getWindow = getWindow;
    this.userDataPath = userDataPath;
    this.providerRegistry = providerRegistry;
    this.journalPath = path.join(userDataPath, "backup-sessions.v2.json");
    this.sessions = new Map();
    this.applyTransactions = new Map();
    this.initialized = false;
  }

  async initialize() {
    if (this.initialized) return;
    this.initialized = true;
    let journal;
    try {
      const raw = await readFile(this.journalPath, "utf8");
      if (Buffer.byteLength(raw, "utf8") > 256 * 1024) throw new Error("journal too large");
      journal = JSON.parse(raw);
    } catch {
      journal = null;
    }
    if (journal?.version === JOURNAL_VERSION && Array.isArray(journal.sessions)) {
      for (const session of journal.sessions) {
        const sessionId = session?.sessionId;
        const type = session?.type || "export";
        if (!validSessionId(sessionId) || !["export", "import"].includes(type)) continue;
        // Import sessions never own the selected source file and need no deletion.
        // Dropping their journal row is the complete crash recovery action.
        if (type === "import") continue;
        const finalPath = session?.finalPath;
        const partPath = session?.partPath;
        if (typeof finalPath !== "string" || typeof partPath !== "string") continue;
        if (!path.isAbsolute(finalPath) || !path.isAbsolute(partPath) || path.extname(finalPath).toLowerCase() !== ".ngrap") continue;
        if (path.resolve(partPath) !== path.resolve(`${finalPath}.ngr-backup-${sessionId}.part`)) continue;
        await unlink(partPath).catch(() => {});
      }
    }
    await this.#persistJournal();
  }

  async beginExport(input, ownerId) {
    await this.initialize();
    if (!isPlainRecord(input)) throw new DesktopError("BACKUP_SAVE_INVALID", "备份保存请求无效");
    const hasExpectedSize = input.expectedSize !== undefined && input.expectedSize !== null;
    const expectedSize = hasExpectedSize ? Number(input.expectedSize) : null;
    if (hasExpectedSize && (!Number.isSafeInteger(expectedSize) || expectedSize < 0 || expectedSize > MAX_BACKUP_BYTES)) {
      throw new DesktopError("BACKUP_TOO_LARGE", "备份文件大小无效或超过限制");
    }
    this.#assertOwner(ownerId);
    this.#assertNoOwnerSession(ownerId);
    const options = {
      title: "保存 NGR AssetPilot 备份",
      defaultPath: suggestedBackupName(input.suggestedName),
      buttonLabel: "保存备份",
      filters: [{ name: "NGR AssetPilot 备份", extensions: ["ngrap"] }],
      properties: ["showOverwriteConfirmation", "createDirectory"],
    };
    const owner = this.getWindow?.();
    const result = owner ? await this.dialog.showSaveDialog(owner, options) : await this.dialog.showSaveDialog(options);
    if (result.canceled || !result.filePath) return { canceled: true };
    const finalPath = result.filePath.toLowerCase().endsWith(".ngrap") ? result.filePath : `${result.filePath}.ngrap`;
    const sessionId = randomUUID();
    const partPath = `${finalPath}.ngr-backup-${sessionId}.part`;
    let handle;
    try {
      handle = await open(partPath, "wx", 0o600);
    } catch {
      throw new DesktopError("BACKUP_SAVE_FAILED", "无法创建备份临时文件");
    }
    this.sessions.set(sessionId, {
      type: "export",
      ownerId,
      handle,
      partPath,
      finalPath,
      expectedSize,
      offset: 0,
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
    });
    try {
      await this.#persistJournal();
    } catch (error) {
      const session = this.sessions.get(sessionId);
      this.sessions.delete(sessionId);
      await session?.handle?.close().catch(() => {});
      await unlink(partPath).catch(() => {});
      throw error;
    }
    return { canceled: false, sessionId, chunkSize: BACKUP_CHUNK_BYTES };
  }

  async writeExportChunk(input, ownerId) {
    if (!isPlainRecord(input) || !validSessionId(input.sessionId)) {
      throw new DesktopError("BACKUP_SESSION_INVALID", "备份写入会话无效");
    }
    const session = this.#getSession(input.sessionId, ownerId, "export");
    const offset = Number(input.offset);
    if (!Number.isSafeInteger(offset) || offset !== session.offset) {
      throw new DesktopError("BACKUP_CHUNK_ORDER_INVALID", "备份分块顺序无效");
    }
    const data = toBoundedBuffer(input.data, BACKUP_CHUNK_BYTES, "BACKUP_CHUNK_TOO_LARGE");
    if (
      (session.expectedSize !== null && session.offset + data.byteLength > session.expectedSize) ||
      session.offset + data.byteLength > MAX_BACKUP_BYTES
    ) {
      throw new DesktopError("BACKUP_TOO_LARGE", "备份内容超过声明大小");
    }
    try {
      const result = await session.handle.write(data, 0, data.byteLength, session.offset);
      if (result.bytesWritten !== data.byteLength) throw new Error("short write");
    } catch {
      await this.#dropSession(input.sessionId, true);
      throw new DesktopError("BACKUP_SAVE_FAILED", "备份分块写入失败");
    }
    session.offset += data.byteLength;
    session.lastActivityAt = Date.now();
    return { sessionId: input.sessionId, nextOffset: session.offset };
  }

  async finishExport(input, ownerId) {
    if (!isPlainRecord(input) || !validSessionId(input.sessionId)) {
      throw new DesktopError("BACKUP_SESSION_INVALID", "备份写入会话无效");
    }
    const session = this.#getSession(input.sessionId, ownerId, "export");
    if (session.expectedSize !== null && session.offset !== session.expectedSize) {
      throw new DesktopError("BACKUP_SIZE_MISMATCH", "备份写入大小与声明不一致");
    }
    try {
      await session.handle.sync();
      await session.handle.close();
      session.handle = null;
      await rename(session.partPath, session.finalPath);
    } catch {
      await this.#dropSession(input.sessionId, true);
      throw new DesktopError("BACKUP_SAVE_FAILED", "备份文件启用失败");
    }
    this.sessions.delete(input.sessionId);
    await this.#persistJournal();
    return { canceled: false, name: path.basename(session.finalPath), bytesWritten: session.offset };
  }

  async cancelExport(input, ownerId) {
    if (!isPlainRecord(input) || !validSessionId(input.sessionId)) {
      throw new DesktopError("BACKUP_SESSION_INVALID", "备份取消会话无效");
    }
    this.#getSession(input.sessionId, ownerId, "export");
    await this.#dropSession(input.sessionId, true);
    return { canceled: true, sessionId: input.sessionId };
  }

  async beginImport(ownerId) {
    await this.initialize();
    this.#assertOwner(ownerId);
    this.#assertNoOwnerSession(ownerId);
    const options = {
      title: "打开 NGR AssetPilot 备份",
      buttonLabel: "打开备份",
      filters: [{ name: "NGR AssetPilot 备份", extensions: ["ngrap"] }],
      properties: ["openFile"],
    };
    const owner = this.getWindow?.();
    const result = owner ? await this.dialog.showOpenDialog(owner, options) : await this.dialog.showOpenDialog(options);
    if (result.canceled || !result.filePaths?.[0]) return { canceled: true };
    const filePath = result.filePaths[0];
    let fileStats;
    let handle;
    try {
      fileStats = await stat(filePath);
      if (!fileStats.isFile() || fileStats.size > MAX_BACKUP_BYTES || path.extname(filePath).toLowerCase() !== ".ngrap") {
        throw new Error("invalid file");
      }
      handle = await open(filePath, "r");
    } catch {
      await handle?.close().catch(() => {});
      throw new DesktopError("BACKUP_OPEN_FAILED", "无法读取备份文件");
    }
    const sessionId = randomUUID();
    this.sessions.set(sessionId, {
      type: "import",
      ownerId,
      handle,
      filePath,
      size: fileStats.size,
      mtimeMs: fileStats.mtimeMs,
      offset: 0,
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
    });
    try {
      await this.#persistJournal();
    } catch (error) {
      this.sessions.delete(sessionId);
      await handle.close().catch(() => {});
      throw error;
    }
    return { canceled: false, sessionId, name: path.basename(filePath), size: fileStats.size, chunkSize: BACKUP_CHUNK_BYTES };
  }

  async readImportChunk(input, ownerId) {
    if (!isPlainRecord(input) || !validSessionId(input.sessionId)) {
      throw new DesktopError("BACKUP_SESSION_INVALID", "备份读取会话无效");
    }
    const session = this.#getSession(input.sessionId, ownerId, "import");
    const offset = Number(input.offset);
    const length = Number(input.length || BACKUP_CHUNK_BYTES);
    if (!Number.isSafeInteger(offset) || offset !== session.offset || offset > session.size || !Number.isSafeInteger(length) || length < 1 || length > BACKUP_CHUNK_BYTES) {
      throw new DesktopError("BACKUP_CHUNK_INVALID", "备份读取分块无效");
    }
    const actualLength = Math.min(length, session.size - offset);
    const buffer = Buffer.allocUnsafe(actualLength);
    try {
      const result = await session.handle.read(buffer, 0, actualLength, offset);
      const data = buffer.subarray(0, result.bytesRead);
      session.offset = offset + result.bytesRead;
      session.lastActivityAt = Date.now();
      return { offset, nextOffset: offset + result.bytesRead, done: offset + result.bytesRead >= session.size, data: asArrayBuffer(data) };
    } catch {
      throw new DesktopError("BACKUP_OPEN_FAILED", "备份分块读取失败");
    }
  }

  async finishImport(input, ownerId) {
    if (!isPlainRecord(input) || !validSessionId(input.sessionId)) {
      throw new DesktopError("BACKUP_SESSION_INVALID", "备份读取会话无效");
    }
    const session = this.#getSession(input.sessionId, ownerId, "import");
    if (session.offset !== session.size) {
      throw new DesktopError("BACKUP_SIZE_MISMATCH", "备份文件尚未完整读取");
    }
    try {
      const current = await session.handle.stat();
      if (current.size !== session.size || current.mtimeMs !== session.mtimeMs) {
        throw new DesktopError("BACKUP_SOURCE_CHANGED", "备份文件在导入期间发生了变化");
      }
    } catch (error) {
      if (error instanceof DesktopError) throw error;
      throw new DesktopError("BACKUP_OPEN_FAILED", "无法确认备份文件完整性");
    }
    await this.#dropSession(input.sessionId, false);
    return { finished: true, sessionId: input.sessionId, bytesRead: session.size };
  }

  async cancelImport(input, ownerId) {
    if (!isPlainRecord(input) || !validSessionId(input.sessionId)) {
      throw new DesktopError("BACKUP_SESSION_INVALID", "备份读取会话无效");
    }
    this.#getSession(input.sessionId, ownerId, "import");
    await this.#dropSession(input.sessionId, false);
    return { canceled: true, sessionId: input.sessionId };
  }

  async closeImport(input, ownerId) {
    const result = await this.cancelImport(input, ownerId);
    return { closed: true, sessionId: result.sessionId };
  }

  async beginApply(ownerId) {
    this.#assertOwner(ownerId);
    if (!this.providerRegistry) throw new DesktopError("BACKUP_APPLY_UNAVAILABLE", "迁移事务服务不可用");
    for (const transaction of this.applyTransactions.values()) {
      if (transaction.ownerId === ownerId) {
        throw new DesktopError("BACKUP_APPLY_BUSY", "当前窗口已有迁移应用事务");
      }
    }
    const result = await this.providerRegistry.beginImportTransaction();
    this.applyTransactions.set(result.transactionId, { ownerId, createdAt: Date.now() });
    return result;
  }

  async importLegacySecrets(input, ownerId) {
    if (!isPlainRecord(input) || !validSessionId(input.transactionId)) {
      throw new DesktopError("BACKUP_APPLY_INVALID", "迁移应用事务无效");
    }
    this.#getApplyTransaction(input.transactionId, ownerId);
    const encrypted = Buffer.from(toBoundedBuffer(input.data, MAX_LEGACY_SECRET_BYTES, "SECRET_BLOCK_TOO_LARGE"));
    const credentials = decryptLegacySecretBlock(encrypted, input.password);
    try {
      const result = await this.providerRegistry.importLegacyInTransaction(input.transactionId, {
        ...credentials,
        onlyIfEmpty: false,
      });
      return {
        transactionId: input.transactionId,
        imported: Boolean(result?.imported),
        reason: result?.reason || "",
        providers: Array.isArray(result?.providers) ? result.providers : [],
      };
    } finally {
      encrypted.fill(0);
    }
  }

  async commitApply(input, ownerId) {
    if (!isPlainRecord(input) || !validSessionId(input.transactionId)) {
      throw new DesktopError("BACKUP_APPLY_INVALID", "迁移应用事务无效");
    }
    this.#getApplyTransaction(input.transactionId, ownerId);
    const result = await this.providerRegistry.commitImportTransaction(input.transactionId);
    return result;
  }

  async getApplyState(input, ownerId) {
    this.#assertOwner(ownerId);
    if (!isPlainRecord(input) || !validSessionId(input.transactionId)) {
      throw new DesktopError("BACKUP_APPLY_INVALID", "迁移应用事务无效");
    }
    if (!this.providerRegistry) throw new DesktopError("BACKUP_APPLY_UNAVAILABLE", "迁移事务服务不可用");
    return this.providerRegistry.getImportTransactionState(input.transactionId);
  }

  async rollbackApply(input, ownerId) {
    this.#assertOwner(ownerId);
    if (!isPlainRecord(input) || !validSessionId(input.transactionId)) {
      throw new DesktopError("BACKUP_APPLY_INVALID", "迁移应用事务无效");
    }
    const binding = this.applyTransactions.get(input.transactionId);
    if (binding && binding.ownerId !== ownerId) {
      throw new DesktopError("BACKUP_APPLY_OWNER_MISMATCH", "迁移应用事务不属于当前窗口");
    }
    if (!binding) {
      const state = await this.providerRegistry.getImportTransactionState(input.transactionId);
      if (state.phase === "prepared") {
        throw new DesktopError("BACKUP_APPLY_OWNER_MISMATCH", "迁移应用事务所有者已失效，请重新启动恢复");
      }
      return state;
    }
    const result = await this.providerRegistry.rollbackImportTransaction(input.transactionId);
    return result;
  }

  async finalizeApply(input, ownerId) {
    this.#assertOwner(ownerId);
    if (!isPlainRecord(input) || !validSessionId(input.transactionId)) {
      throw new DesktopError("BACKUP_APPLY_INVALID", "迁移应用事务无效");
    }
    const binding = this.applyTransactions.get(input.transactionId);
    if (binding && binding.ownerId !== ownerId) {
      throw new DesktopError("BACKUP_APPLY_OWNER_MISMATCH", "迁移应用事务不属于当前窗口");
    }
    const result = await this.providerRegistry.finalizeImportTransaction(input.transactionId);
    this.applyTransactions.delete(input.transactionId);
    return result;
  }

  async disposeOwner(ownerId) {
    for (const [sessionId, session] of [...this.sessions]) {
      if (session.ownerId === ownerId) await this.#dropSession(sessionId, session.type === "export");
    }
    for (const [transactionId, transaction] of [...this.applyTransactions]) {
      if (transaction.ownerId !== ownerId) continue;
      await this.providerRegistry?.rollbackImportTransaction(transactionId).catch(() => {});
      this.applyTransactions.delete(transactionId);
    }
  }

  async dispose() {
    for (const [sessionId, session] of [...this.sessions]) {
      await this.#dropSession(sessionId, session.type === "export");
    }
    for (const transactionId of [...this.applyTransactions.keys()]) {
      await this.providerRegistry?.rollbackImportTransaction(transactionId).catch(() => {});
      this.applyTransactions.delete(transactionId);
    }
  }

  #assertOwner(ownerId) {
    if (!Number.isSafeInteger(Number(ownerId)) || Number(ownerId) < 1) {
      throw new DesktopError("BACKUP_OWNER_INVALID", "备份请求来源无效");
    }
  }

  #assertNoOwnerSession(ownerId) {
    const now = Date.now();
    for (const session of this.sessions.values()) {
      if (now - session.createdAt > SESSION_TTL_MS) continue;
      if (session.ownerId === ownerId) throw new DesktopError("BACKUP_SESSION_BUSY", "当前窗口已有备份任务");
    }
  }

  #getSession(sessionId, ownerId, type) {
    const session = this.sessions.get(sessionId);
    const activityAt = session?.lastActivityAt || session?.createdAt || 0;
    if (!session || session.type !== type || session.ownerId !== ownerId || Date.now() - activityAt > SESSION_TTL_MS) {
      throw new DesktopError("BACKUP_SESSION_INVALID", "备份会话无效或已过期");
    }
    return session;
  }

  #getApplyTransaction(transactionId, ownerId) {
    this.#assertOwner(ownerId);
    const transaction = this.applyTransactions.get(transactionId);
    if (
      !transaction ||
      transaction.ownerId !== ownerId ||
      Date.now() - transaction.createdAt > SESSION_TTL_MS
    ) {
      throw new DesktopError("BACKUP_APPLY_INVALID", "迁移应用事务无效或已过期");
    }
    return transaction;
  }

  async #dropSession(sessionId, removePart) {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.sessions.delete(sessionId);
    await session.handle?.close().catch(() => {});
    if (removePart && session.partPath) await unlink(session.partPath).catch(() => {});
    await this.#persistJournal();
  }

  async #persistJournal() {
    await mkdir(this.userDataPath, { recursive: true });
    const temporary = `${this.journalPath}.tmp`;
    const sessions = [...this.sessions.entries()].map(([sessionId, session]) => session.type === "export"
      ? { sessionId, type: "export", partPath: session.partPath, finalPath: session.finalPath }
      : { sessionId, type: "import", sourceSize: session.size });
    const data = JSON.stringify({ version: JOURNAL_VERSION, sessions });
    try {
      await writeFile(temporary, data, { encoding: "utf8", mode: 0o600, flag: "w" });
      await rename(temporary, this.journalPath);
    } catch {
      await unlink(temporary).catch(() => {});
      throw new DesktopError("BACKUP_JOURNAL_FAILED", "无法保存备份恢复状态");
    }
  }
}

export { BACKUP_CHUNK_BYTES };
