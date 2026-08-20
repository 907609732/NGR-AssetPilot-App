/* NGR AssetPilot desktop streaming backup worker. */
"use strict";

importScripts("../vendor/fflate-0.8.3.min.js", "./workspace-backup.js");

const MAX_ARCHIVE_ENTRIES = 25000;
const MAX_ARCHIVE_UNCOMPRESSED_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_SINGLE_ENTRY_BYTES = 128 * 1024 * 1024;
const MAX_JSON_BYTES = 32 * 1024 * 1024;
const MAX_LEGACY_SECRET_BYTES = 8 * 1024 * 1024;
const ENTRY_CHUNK_BYTES = 1024 * 1024;
const IMPORT_STAGING_DB = "ngr-assetpilot-import-staging-v1";
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
let acknowledgmentSequence = 0;
const acknowledgments = new Map();
let activeImport = null;

function fail(message, code = "STREAM_BACKUP_FAILED") {
  const error = new Error(message);
  error.code = code;
  return error;
}

function toBytes(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  throw fail("备份条目不是有效的二进制数据", "INVALID_BYTES");
}

function encodeJson(value) {
  return encoder.encode(JSON.stringify(value, null, 2));
}

function sendChunk(bytes, final) {
  const view = toBytes(bytes);
  const copy = view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength);
  const acknowledgmentId = ++acknowledgmentSequence;
  return new Promise((resolve, reject) => {
    acknowledgments.set(acknowledgmentId, { resolve, reject });
    postMessage({ type: "chunk", acknowledgmentId, data: copy, final: Boolean(final) }, [copy]);
  });
}

function fileDescriptor(record, archivePath, size) {
  return {
    path: archivePath,
    key: String(record.key || ""),
    workspaceKey: String(record.workspaceKey || "default"),
    sessionId: String(record.sessionId || ""),
    assetId: record.assetId == null ? null : String(record.assetId),
    kind: record.kind === "reference" ? "reference" : "asset",
    storedAt: Number(record.storedAt || Date.now()),
    name: String(record.name || "file.bin"),
    type: String(record.mimeType || "application/octet-stream"),
    lastModified: Number(record.lastModified || 0),
    size,
  };
}

async function buildStreamingArchive(payload) {
  const backup = self.NgrWorkspaceBackup;
  if (!backup || !self.fflate?.Zip || !self.fflate?.ZipPassThrough) {
    throw fail("流式 ZIP 组件未加载", "ZIP_UNAVAILABLE");
  }
  backup.validateSettings(payload?.settings);
  backup.validateWorkspace(payload?.workspace);
  if (!Array.isArray(payload.files) || payload.files.length > MAX_ARCHIVE_ENTRIES - 3) {
    throw fail("备份文件数量过多", "TOO_MANY_ENTRIES");
  }

  const entryDescriptors = [];
  const fileDescriptors = [];
  const seenPaths = new Set();
  let uncompressedBytes = 0;
  let outputChain = Promise.resolve();
  let outputFailure = null;
  const zip = new self.fflate.Zip((error, data, final) => {
    if (error) {
      outputFailure = error;
      return;
    }
    const bytes = toBytes(data);
    if (!bytes.byteLength) {
      outputChain = outputChain.then(() => sendChunk(bytes, final));
      return;
    }
    for (let offset = 0; offset < bytes.byteLength; offset += ENTRY_CHUNK_BYTES) {
      const end = Math.min(bytes.byteLength, offset + ENTRY_CHUNK_BYTES);
      outputChain = outputChain.then(() => sendChunk(bytes.subarray(offset, end), final && end === bytes.byteLength));
    }
  });

  const addEntry = async (archivePath, input) => {
    const safePath = backup.validateArchivePath(archivePath);
    if (seenPaths.has(safePath)) throw fail(`备份路径重复：${safePath}`, "DUPLICATE_ENTRY");
    seenPaths.add(safePath);
    const bytes = toBytes(input);
    if (bytes.byteLength > MAX_SINGLE_ENTRY_BYTES) {
      throw fail(`单个备份条目超过 128 MiB：${safePath}`, "ENTRY_TOO_LARGE");
    }
    uncompressedBytes += bytes.byteLength;
    if (uncompressedBytes > MAX_ARCHIVE_UNCOMPRESSED_BYTES) throw fail("备份内容超过 2 GiB 限制", "ARCHIVE_TOO_LARGE");
    entryDescriptors.push({
      path: safePath,
      size: bytes.byteLength,
      sha256: await backup.sha256Hex(bytes),
    });
    const zipEntry = new self.fflate.ZipPassThrough(safePath);
    zip.add(zipEntry);
    if (!bytes.byteLength) {
      zipEntry.push(new Uint8Array(0), true);
      await outputChain;
      return;
    }
    for (let offset = 0; offset < bytes.byteLength; offset += ENTRY_CHUNK_BYTES) {
      const end = Math.min(bytes.byteLength, offset + ENTRY_CHUNK_BYTES);
      zipEntry.push(bytes.subarray(offset, end), end === bytes.byteLength);
      await outputChain;
      if (outputFailure) throw outputFailure;
    }
  };

  const settingsBytes = encodeJson(payload.settings);
  const workspaceBytes = encodeJson(payload.workspace);
  if (settingsBytes.byteLength > MAX_JSON_BYTES || workspaceBytes.byteLength > MAX_JSON_BYTES) {
    throw fail("设置或工作区元数据超过 32 MiB 限制", "JSON_TOO_LARGE");
  }
  await addEntry("settings.json", settingsBytes);
  await addEntry("workspace.json", workspaceBytes);
  for (const record of payload.files) {
    const archivePath = backup.validateArchivePath(record.path);
    if (!archivePath.startsWith("files/")) throw fail("二进制文件必须位于 files/ 目录", "INVALID_FILE_PATH");
    if (!(record.file instanceof Blob)) throw fail("备份文件数据无效", "INVALID_FILES");
    if (record.file.size > MAX_SINGLE_ENTRY_BYTES) throw fail(`单个备份文件超过 128 MiB：${archivePath}`, "ENTRY_TOO_LARGE");
    const bytes = new Uint8Array(await record.file.arrayBuffer());
    fileDescriptors.push(fileDescriptor(record, archivePath, bytes.byteLength));
    await addEntry(archivePath, bytes);
  }

  const createdAt = String(payload.createdAt || new Date().toISOString());
  const manifest = {
    format: backup.FORMAT,
    formatVersion: backup.FORMAT_VERSION,
    archiveId: typeof self.crypto.randomUUID === "function"
      ? self.crypto.randomUUID()
      : [...self.crypto.getRandomValues(new Uint8Array(16))].map((value) => value.toString(16).padStart(2, "0")).join(""),
    appVersion: String(payload.appVersion || "unknown"),
    createdAt,
    includesSecrets: false,
    encryption: null,
    settingsSchemaVersion: Number(payload.settings.schemaVersion || 1),
    workspaceSchemaVersion: Number(payload.workspace.schemaVersion || 1),
    entries: entryDescriptors,
    files: fileDescriptors,
  };
  const manifestBytes = encodeJson(manifest);
  const manifestEntry = new self.fflate.ZipPassThrough("manifest.json");
  zip.add(manifestEntry);
  for (let offset = 0; offset < manifestBytes.byteLength; offset += ENTRY_CHUNK_BYTES) {
    const end = Math.min(manifestBytes.byteLength, offset + ENTRY_CHUNK_BYTES);
    manifestEntry.push(manifestBytes.subarray(offset, end), end === manifestBytes.byteLength);
    await outputChain;
  }
  zip.end();
  await outputChain;
  if (outputFailure) throw outputFailure;
  return manifest;
}

function idbRequest(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || fail("IndexedDB 请求失败", "IMPORT_STAGING_FAILED"));
  });
}

function idbTransactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error || fail("IndexedDB 事务已取消", "IMPORT_STAGING_FAILED"));
    transaction.onerror = () => reject(transaction.error || fail("IndexedDB 事务失败", "IMPORT_STAGING_FAILED"));
  });
}

function openImportStagingDb() {
  if (!self.indexedDB) throw fail("当前环境不支持 IndexedDB 导入暂存", "IMPORT_STAGING_UNAVAILABLE");
  return new Promise((resolve, reject) => {
    const request = self.indexedDB.open(IMPORT_STAGING_DB, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      const chunks = db.createObjectStore("chunks", { keyPath: ["sessionId", "path", "sequence"] });
      chunks.createIndex("by-session", "sessionId", { unique: false });
      chunks.createIndex("by-entry", ["sessionId", "path"], { unique: false });
      const entries = db.createObjectStore("entries", { keyPath: ["sessionId", "path"] });
      entries.createIndex("by-session", "sessionId", { unique: false });
      db.createObjectStore("sessions", { keyPath: "sessionId" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || fail("无法打开导入暂存数据库", "IMPORT_STAGING_UNAVAILABLE"));
  });
}

function clearIndexedSession(db, sessionId) {
  const transaction = db.transaction(["chunks", "entries", "sessions"], "readwrite");
  const range = self.IDBKeyRange.only(sessionId);
  for (const storeName of ["chunks", "entries"]) {
    const request = transaction.objectStore(storeName).index("by-session").openKeyCursor(range);
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      transaction.objectStore(storeName).delete(cursor.primaryKey);
      cursor.continue();
    };
  }
  transaction.objectStore("sessions").delete(sessionId);
  return idbTransactionDone(transaction);
}

async function createIndexedImportStore(sessionId) {
  const db = await openImportStagingDb();
  const readTransaction = db.transaction("sessions", "readonly");
  const readDone = idbTransactionDone(readTransaction);
  const staleSessionIds = await idbRequest(readTransaction.objectStore("sessions").getAllKeys());
  await readDone;
  for (const staleSessionId of staleSessionIds) await clearIndexedSession(db, staleSessionId);
  {
    const transaction = db.transaction("sessions", "readwrite");
    const done = idbTransactionDone(transaction);
    transaction.objectStore("sessions").put({ sessionId, createdAt: Date.now() });
    await done;
  }
  return {
    createBatch() {
      const transaction = db.transaction(["chunks", "entries"], "readwrite");
      const chunkStore = transaction.objectStore("chunks");
      const entryStore = transaction.objectStore("entries");
      return {
        putChunk(path, sequence, bytes) {
          chunkStore.put({ sessionId, path, sequence, data: new Blob([bytes]) });
        },
        putEntry(entry) {
          entryStore.put({ sessionId, ...entry });
        },
        done: idbTransactionDone(transaction),
        abort() {
          try { transaction.abort(); } catch {}
        },
      };
    },
    async listEntries() {
      const transaction = db.transaction("entries", "readonly");
      const done = idbTransactionDone(transaction);
      const result = await idbRequest(transaction.objectStore("entries").index("by-session").getAll(self.IDBKeyRange.only(sessionId)));
      await done;
      return result;
    },
    async readEntryParts(path) {
      const transaction = db.transaction("chunks", "readonly");
      const done = idbTransactionDone(transaction);
      const result = await idbRequest(transaction.objectStore("chunks").index("by-entry").getAll(self.IDBKeyRange.only([sessionId, path])));
      await done;
      result.sort((left, right) => left.sequence - right.sequence);
      return result.map((record) => record.data);
    },
    async clear() {
      await clearIndexedSession(db, sessionId);
      db.close();
    },
    close() {
      db.close();
    },
  };
}

async function createImportStore(sessionId) {
  if (typeof self.__NGR_IMPORT_STAGING_FACTORY__ === "function") {
    return self.__NGR_IMPORT_STAGING_FACTORY__(sessionId);
  }
  return createIndexedImportStore(sessionId);
}

function parseImportJson(bytes, label) {
  if (bytes.byteLength > MAX_JSON_BYTES) throw fail(`${label} 过大`, "JSON_TOO_LARGE");
  try {
    return JSON.parse(decoder.decode(bytes));
  } catch {
    throw fail(`${label} 不是有效的 JSON`, "INVALID_JSON");
  }
}

async function readStagedBytes(state, entry) {
  const parts = await state.store.readEntryParts(entry.path);
  if (parts.length !== entry.chunkCount) throw fail(`暂存条目不完整：${entry.path}`, "IMPORT_STAGING_INCOMPLETE");
  const blob = new Blob(parts);
  if (blob.size !== entry.size) throw fail(`暂存条目大小错误：${entry.path}`, "IMPORT_STAGING_INCOMPLETE");
  return new Uint8Array(await blob.arrayBuffer());
}

function canonicalFileDescriptor(descriptor, entry, sessionId) {
  return {
    path: entry.path,
    key: String(descriptor?.key || ""),
    workspaceKey: String(descriptor?.workspaceKey || "default"),
    sessionId: String(descriptor?.sessionId || ""),
    assetId: descriptor?.assetId == null ? null : String(descriptor.assetId),
    kind: descriptor?.kind === "reference" ? "reference" : "asset",
    storedAt: Number(descriptor?.storedAt || Date.now()),
    name: String(descriptor?.name || "file.bin"),
    type: String(descriptor?.type || "application/octet-stream"),
    lastModified: Number(descriptor?.lastModified || 0),
    size: entry.size,
    stagingSessionId: sessionId,
    stagingChunkCount: entry.chunkCount,
  };
}

async function validateStagedImport(state) {
  const entries = await state.store.listEntries();
  const byPath = new Map(entries.map((entry) => [entry.path, entry]));
  for (const required of ["manifest.json", "settings.json", "workspace.json"]) {
    if (!byPath.has(required)) throw fail("备份缺少 manifest、settings 或 workspace", "MISSING_REQUIRED_ENTRY");
  }
  const manifestEntry = byPath.get("manifest.json");
  const manifest = parseImportJson(await readStagedBytes(state, manifestEntry), "manifest.json");
  const backup = self.NgrWorkspaceBackup;
  if (manifest?.format !== backup.FORMAT || manifest?.formatVersion !== backup.FORMAT_VERSION
    || !Array.isArray(manifest.entries) || !Array.isArray(manifest.files)) {
    throw fail("这不是受支持的 NGR AssetPilot 迁移包", "UNSUPPORTED_ARCHIVE");
  }
  if (manifest.entries.length > MAX_ARCHIVE_ENTRIES - 1 || manifest.files.length > MAX_ARCHIVE_ENTRIES - 3) {
    throw fail("备份文件数量过多", "TOO_MANY_ENTRIES");
  }

  const expectedPaths = new Set(["manifest.json"]);
  for (const descriptor of manifest.entries) {
    const path = backup.validateArchivePath(descriptor?.path);
    const entry = byPath.get(path);
    if (expectedPaths.has(path) || !entry) throw fail(`备份条目缺失或重复：${path}`, "INVALID_MANIFEST");
    expectedPaths.add(path);
    const expectedHash = String(descriptor?.sha256 || "").toLowerCase();
    if (Number(descriptor?.size) !== entry.size || !/^[a-f0-9]{64}$/.test(expectedHash)) {
      throw fail(`备份条目校验失败：${path}`, "INTEGRITY_CHECK_FAILED");
    }
    const bytes = await readStagedBytes(state, entry);
    if (await backup.sha256Hex(bytes) !== expectedHash) {
      throw fail(`备份条目校验失败：${path}`, "INTEGRITY_CHECK_FAILED");
    }
  }
  for (const path of byPath.keys()) {
    if (!expectedPaths.has(path)) throw fail(`备份包含未登记的条目：${path}`, "UNEXPECTED_ENTRY");
  }

  const settings = backup.validateSettings(parseImportJson(
    await readStagedBytes(state, byPath.get("settings.json")),
    "settings.json",
  ));
  const workspace = backup.validateWorkspace(parseImportJson(
    await readStagedBytes(state, byPath.get("workspace.json")),
    "workspace.json",
  ));
  const filePaths = new Set();
  const files = manifest.files.map((descriptor) => {
    const path = backup.validateArchivePath(descriptor?.path);
    const entry = byPath.get(path);
    if (!path.startsWith("files/") || filePaths.has(path) || !entry) {
      throw fail("文件清单与备份内容不一致", "INVALID_FILE_MANIFEST");
    }
    filePaths.add(path);
    if (Number(descriptor?.size) !== entry.size) throw fail(`文件大小校验失败：${path}`, "INTEGRITY_CHECK_FAILED");
    return canonicalFileDescriptor(descriptor, entry, state.sessionId);
  });
  const listedBinaryPaths = new Set([...expectedPaths].filter((path) => path.startsWith("files/")));
  if (listedBinaryPaths.size !== filePaths.size || [...listedBinaryPaths].some((path) => !filePaths.has(path))) {
    throw fail("文件清单不完整", "INVALID_FILE_MANIFEST");
  }

  let legacySecretBlock = null;
  const secretEntry = byPath.get("secrets.enc");
  if (manifest.includesSecrets) {
    if (!secretEntry) throw fail("备份声明包含凭据，但 secrets.enc 缺失", "MISSING_SECRET_BLOCK");
    if (!state.hasPassword) throw fail("该迁移包包含加密凭据，请输入迁移密码", "PASSWORD_REQUIRED");
    if (secretEntry.size > MAX_LEGACY_SECRET_BYTES) throw fail("旧版加密凭据块超过 8 MiB 安全限制", "SECRET_BLOCK_TOO_LARGE");
    const encrypted = await readStagedBytes(state, secretEntry);
    legacySecretBlock = encrypted.buffer.slice(encrypted.byteOffset, encrypted.byteOffset + encrypted.byteLength);
  } else if (secretEntry) {
    throw fail("备份凭据声明与内容不一致", "INVALID_MANIFEST");
  }
  return { manifest, settings, workspace, files, legacySecretBlock, stagingSessionId: state.sessionId };
}

async function startStreamingImport(payload) {
  if (activeImport) throw fail("已有导入任务正在运行", "IMPORT_BUSY");
  if (!self.fflate?.Unzip || !self.fflate?.UnzipInflate || !self.NgrWorkspaceBackup) {
    throw fail("流式 ZIP 组件未加载", "ZIP_UNAVAILABLE");
  }
  const sessionId = String(payload?.sessionId || "");
  if (!/^[0-9a-f-]{36}$/i.test(sessionId)) throw fail("导入会话无效", "BACKUP_SESSION_INVALID");
  const store = await createImportStore(sessionId);
  const state = {
    sessionId,
    hasPassword: Boolean(payload?.hasPassword),
    store,
    entryCount: 0,
    uncompressedBytes: 0,
    seenPaths: new Set(),
    entries: new Map(),
    batch: null,
    fatalError: null,
  };
  const unzip = new self.fflate.Unzip((file) => {
    try {
      const path = self.NgrWorkspaceBackup.validateArchivePath(file.name);
      if (state.seenPaths.has(path)) throw fail(`备份路径重复：${path}`, "DUPLICATE_ENTRY");
      state.seenPaths.add(path);
      state.entryCount += 1;
      if (state.entryCount > MAX_ARCHIVE_ENTRIES) throw fail("备份文件数量过多", "TOO_MANY_ENTRIES");
      const entry = { path, size: 0, chunkCount: 0, complete: false };
      state.entries.set(path, entry);
      file.ondata = (error, data, final) => {
        if (error && !state.fatalError) state.fatalError = fail("无法解压 .ngrap 文件，文件可能已损坏", "INVALID_ARCHIVE");
        if (state.fatalError) return;
        try {
          const bytes = toBytes(data);
          entry.size += bytes.byteLength;
          state.uncompressedBytes += bytes.byteLength;
          if (entry.size > MAX_SINGLE_ENTRY_BYTES) throw fail(`单个备份条目超过 128 MiB：${path}`, "ENTRY_TOO_LARGE");
          if (state.uncompressedBytes > MAX_ARCHIVE_UNCOMPRESSED_BYTES) throw fail("备份解压后的大小超过 2 GiB 限制", "ARCHIVE_TOO_LARGE");
          for (let offset = 0; offset < bytes.byteLength; offset += ENTRY_CHUNK_BYTES) {
            const end = Math.min(bytes.byteLength, offset + ENTRY_CHUNK_BYTES);
            state.batch.putChunk(path, entry.chunkCount, bytes.subarray(offset, end));
            entry.chunkCount += 1;
          }
          if (final) {
            entry.complete = true;
            state.batch.putEntry({ path, size: entry.size, chunkCount: entry.chunkCount });
          }
        } catch (candidate) {
          state.fatalError = candidate;
        }
      };
      file.start();
    } catch (error) {
      state.fatalError = error;
    }
  });
  unzip.register(self.fflate.UnzipInflate);
  state.unzip = unzip;
  activeImport = state;
}

async function pushStreamingImportChunk(message) {
  const state = activeImport;
  if (!state || state.sessionId !== message.sessionId) throw fail("导入会话无效", "BACKUP_SESSION_INVALID");
  const bytes = toBytes(message.data);
  if (bytes.byteLength > ENTRY_CHUNK_BYTES) throw fail("导入分块超过 1 MiB", "BACKUP_CHUNK_TOO_LARGE");
  const batch = state.store.createBatch();
  state.batch = batch;
  try {
    state.unzip.push(bytes, Boolean(message.final));
    if (state.fatalError) throw state.fatalError;
    await batch.done;
    state.batch = null;
    if (!message.final) return { complete: false, entries: state.entryCount, uncompressedBytes: state.uncompressedBytes };
    if ([...state.entries.values()].some((entry) => !entry.complete)) throw fail("备份条目未完整解压", "INVALID_ARCHIVE");
    const parsed = await validateStagedImport(state);
    state.store.close();
    activeImport = null;
    return { complete: true, parsed };
  } catch (error) {
    batch.abort();
    state.batch = null;
    await state.store.clear().catch(() => {});
    activeImport = null;
    throw error;
  }
}

self.onmessage = async (event) => {
  const message = event.data || {};
  if (message.type === "ack") {
    const pending = acknowledgments.get(message.acknowledgmentId);
    if (!pending) return;
    acknowledgments.delete(message.acknowledgmentId);
    if (message.error) pending.reject(fail(String(message.error), "BACKUP_WRITE_FAILED"));
    else pending.resolve();
    return;
  }
  if (message.type === "import-start") {
    try {
      await startStreamingImport(message.payload);
      postMessage({ type: "import-ready", requestId: message.requestId });
    } catch (error) {
      postMessage({ type: "import-error", requestId: message.requestId, code: String(error?.code || "STREAM_IMPORT_FAILED"), message: String(error?.message || "流式导入失败") });
    }
    return;
  }
  if (message.type === "import-chunk") {
    try {
      const result = await pushStreamingImportChunk(message);
      const transfer = result.parsed?.legacySecretBlock ? [result.parsed.legacySecretBlock] : [];
      postMessage({ type: "import-chunk-result", requestId: message.requestId, ...result }, transfer);
    } catch (error) {
      postMessage({ type: "import-error", requestId: message.requestId, code: String(error?.code || "STREAM_IMPORT_FAILED"), message: String(error?.message || "流式导入失败") });
    }
    return;
  }
  if (message.type === "import-cancel") {
    const state = activeImport;
    activeImport = null;
    await state?.store?.clear?.().catch(() => {});
    postMessage({ type: "import-canceled", requestId: message.requestId });
    return;
  }
  if (message.type !== "start") return;
  try {
    const manifest = await buildStreamingArchive(message.payload);
    postMessage({ type: "done", manifest });
  } catch (error) {
    postMessage({ type: "error", code: String(error?.code || "STREAM_BACKUP_FAILED"), message: String(error?.message || "流式备份失败") });
  }
};
