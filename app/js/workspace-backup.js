/* NGR AssetPilot V3.0.0 module: workspace-backup.js */
(function initializeWorkspaceBackup(globalScope) {
  "use strict";

  const FORMAT = "NGR_ASSETPILOT_BACKUP";
  const FORMAT_VERSION = 1;
  const SECRET_FORMAT = "NGR_ASSETPILOT_SECRETS";
  const PBKDF2_ITERATIONS = 600000;
  const MIN_PASSWORD_LENGTH = 12;
  const MAX_ARCHIVE_ENTRIES = 25000;
  const MAX_ARCHIVE_UNCOMPRESSED_BYTES = 2 * 1024 * 1024 * 1024;
  const MAX_JSON_BYTES = 32 * 1024 * 1024;
  const encoder = new TextEncoder();
  const decoder = new TextDecoder("utf-8", { fatal: true });

  function backupError(message, code) {
    const error = new Error(message);
    error.code = code;
    return error;
  }

  function getCrypto(provider) {
    const cryptoProvider = provider || globalScope.crypto;
    if (!cryptoProvider?.subtle || typeof cryptoProvider.getRandomValues !== "function") {
      throw backupError("当前环境不支持 WebCrypto，无法安全处理迁移凭据", "CRYPTO_UNAVAILABLE");
    }
    return cryptoProvider;
  }

  function getFflate(provider) {
    const fflate = provider || globalScope.fflate;
    if (!fflate?.zipSync || !fflate?.unzipSync) throw backupError("ZIP 组件未加载", "ZIP_UNAVAILABLE");
    return fflate;
  }

  function toBytes(value) {
    if (value instanceof Uint8Array) return value;
    if (value instanceof ArrayBuffer) return new Uint8Array(value);
    if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    throw backupError("备份条目不是有效的二进制数据", "INVALID_BYTES");
  }

  function bytesToBase64(value) {
    const bytes = toBytes(value);
    let binary = "";
    const chunkSize = 32768;
    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
    }
    return btoa(binary);
  }

  function base64ToBytes(value) {
    try {
      const binary = atob(String(value || ""));
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
      return bytes;
    } catch {
      throw backupError("加密凭据的数据格式无效", "INVALID_SECRET_BLOCK");
    }
  }

  function encodeJson(value) {
    return encoder.encode(JSON.stringify(value, null, 2));
  }

  function parseJson(bytes, label) {
    const value = toBytes(bytes);
    if (value.byteLength > MAX_JSON_BYTES) throw backupError(`${label} 过大`, "JSON_TOO_LARGE");
    try {
      return JSON.parse(decoder.decode(value));
    } catch {
      throw backupError(`${label} 不是有效的 JSON`, "INVALID_JSON");
    }
  }

  function validatePassword(password) {
    if (typeof password !== "string" || password.length < MIN_PASSWORD_LENGTH) {
      throw backupError(`迁移密码至少需要 ${MIN_PASSWORD_LENGTH} 个字符`, "PASSWORD_TOO_SHORT");
    }
  }

  async function deriveSecretKey(password, salt, usages, cryptoProvider) {
    const crypto = getCrypto(cryptoProvider);
    const baseKey = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveKey"]);
    return crypto.subtle.deriveKey(
      { name: "PBKDF2", hash: "SHA-256", salt, iterations: PBKDF2_ITERATIONS },
      baseKey,
      { name: "AES-GCM", length: 256 },
      false,
      usages,
    );
  }

  async function encryptSecrets(secrets, password, options = {}) {
    validatePassword(password);
    const crypto = getCrypto(options.crypto);
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await deriveSecretKey(password, salt, ["encrypt"], crypto);
    const plaintext = encodeJson({
      format: SECRET_FORMAT,
      version: 1,
      createdAt: options.createdAt || new Date().toISOString(),
      credentials: secrets || {},
    });
    const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext));
    plaintext.fill(0);
    return encodeJson({
      format: SECRET_FORMAT,
      version: 1,
      kdf: {
        algorithm: "PBKDF2",
        hash: "SHA-256",
        iterations: PBKDF2_ITERATIONS,
        salt: bytesToBase64(salt),
      },
      cipher: {
        algorithm: "AES-256-GCM",
        iv: bytesToBase64(iv),
        ciphertext: bytesToBase64(ciphertext),
      },
    });
  }

  async function decryptSecrets(encryptedBytes, password, options = {}) {
    validatePassword(password);
    const block = parseJson(encryptedBytes, "secrets.enc");
    if (block?.format !== SECRET_FORMAT || block?.version !== 1
      || block?.kdf?.algorithm !== "PBKDF2" || block?.kdf?.hash !== "SHA-256"
      || block?.kdf?.iterations !== PBKDF2_ITERATIONS || block?.cipher?.algorithm !== "AES-256-GCM") {
      throw backupError("加密凭据格式或算法不受支持", "INVALID_SECRET_BLOCK");
    }
    const salt = base64ToBytes(block.kdf.salt);
    const iv = base64ToBytes(block.cipher.iv);
    const ciphertext = base64ToBytes(block.cipher.ciphertext);
    if (salt.length !== 16 || iv.length !== 12 || ciphertext.length < 16) {
      throw backupError("加密凭据参数无效", "INVALID_SECRET_BLOCK");
    }
    try {
      const crypto = getCrypto(options.crypto);
      const key = await deriveSecretKey(password, salt, ["decrypt"], crypto);
      const plaintext = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext));
      const payload = parseJson(plaintext, "解密后的凭据");
      plaintext.fill(0);
      if (payload?.format !== SECRET_FORMAT || payload?.version !== 1 || !payload.credentials || typeof payload.credentials !== "object") {
        throw backupError("解密后的凭据格式无效", "INVALID_SECRET_PAYLOAD");
      }
      return payload.credentials;
    } catch (error) {
      if (error?.code) throw error;
      throw backupError("迁移密码错误或凭据数据已损坏", "DECRYPTION_FAILED");
    }
  }

  async function sha256Hex(value, cryptoProvider) {
    const crypto = getCrypto(cryptoProvider);
    const bytes = toBytes(value);
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
    return [...digest].map((part) => part.toString(16).padStart(2, "0")).join("");
  }

  function validateArchivePath(path) {
    const normalized = String(path || "");
    if (!normalized || normalized.length > 1024 || normalized.startsWith("/") || normalized.includes("\\") || /[:\u0000-\u001f]/.test(normalized)
      || normalized.split("/").some((part) => !part || part === "." || part === "..")) {
      throw backupError(`备份中包含不安全的路径：${normalized || "(空)"}`, "UNSAFE_ARCHIVE_PATH");
    }
    return normalized;
  }

  function createArchiveId(cryptoProvider) {
    const crypto = getCrypto(cryptoProvider);
    if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    return [...bytes].map((part) => part.toString(16).padStart(2, "0")).join("");
  }

  function sanitizeFileDescriptor(file) {
    const path = validateArchivePath(file?.path);
    if (!path.startsWith("files/")) throw backupError("二进制文件必须位于 files/ 目录", "INVALID_FILE_PATH");
    return {
      path,
      key: String(file.key || ""),
      workspaceKey: String(file.workspaceKey || "default"),
      sessionId: String(file.sessionId || ""),
      assetId: file.assetId == null ? null : String(file.assetId),
      kind: file.kind === "reference" ? "reference" : "asset",
      storedAt: Number(file.storedAt || Date.now()),
      name: String(file.name || "file.bin"),
      type: String(file.type || "application/octet-stream"),
      lastModified: Number(file.lastModified || 0),
      size: toBytes(file.data).byteLength,
    };
  }

  async function buildArchive(payload, options = {}) {
    const fflate = getFflate(options.fflate);
    const crypto = getCrypto(options.crypto);
    if (!payload?.settings || typeof payload.settings !== "object") throw backupError("缺少设置数据", "INVALID_SETTINGS");
    validateWorkspace(payload.workspace);
    if (!Array.isArray(payload.files)) throw backupError("文件清单格式无效", "INVALID_FILES");
    if (payload.files.length > MAX_ARCHIVE_ENTRIES - 4) throw backupError("备份文件数量过多", "TOO_MANY_ENTRIES");

    const createdAt = options.createdAt || new Date().toISOString();
    const zipEntries = Object.create(null);
    const entryDescriptors = [];
    const fileDescriptors = [];
    let uncompressedBytes = 0;
    const addEntry = async (path, value) => {
      const safePath = validateArchivePath(path);
      if (zipEntries[safePath]) throw backupError(`备份路径重复：${safePath}`, "DUPLICATE_ENTRY");
      const bytes = toBytes(value);
      uncompressedBytes += bytes.byteLength;
      if (uncompressedBytes > MAX_ARCHIVE_UNCOMPRESSED_BYTES) throw backupError("备份内容超过 2 GiB 限制", "ARCHIVE_TOO_LARGE");
      zipEntries[safePath] = bytes;
      entryDescriptors.push({ path: safePath, size: bytes.byteLength, sha256: await sha256Hex(bytes, crypto) });
    };

    const settingsBytes = encodeJson(payload.settings);
    const workspaceBytes = encodeJson(payload.workspace);
    if (settingsBytes.byteLength > MAX_JSON_BYTES || workspaceBytes.byteLength > MAX_JSON_BYTES) {
      throw backupError("设置或工作区元数据超过 32 MiB 限制", "JSON_TOO_LARGE");
    }
    await addEntry("settings.json", settingsBytes);
    await addEntry("workspace.json", workspaceBytes);
    for (const file of payload.files) {
      const descriptor = sanitizeFileDescriptor(file);
      fileDescriptors.push(descriptor);
      await addEntry(descriptor.path, file.data);
    }

    let includesSecrets = false;
    if (payload.secrets && Object.keys(payload.secrets).length) {
      if (!options.password) throw backupError("包含凭据时必须设置迁移密码", "PASSWORD_REQUIRED");
      await addEntry("secrets.enc", await encryptSecrets(payload.secrets, options.password, { crypto, createdAt }));
      includesSecrets = true;
    }

    const manifest = {
      format: FORMAT,
      formatVersion: FORMAT_VERSION,
      archiveId: createArchiveId(crypto),
      appVersion: String(options.appVersion || "unknown"),
      createdAt,
      includesSecrets,
      encryption: includesSecrets ? {
        kdf: "PBKDF2-HMAC-SHA256",
        iterations: PBKDF2_ITERATIONS,
        cipher: "AES-256-GCM",
      } : null,
      settingsSchemaVersion: Number(payload.settings.schemaVersion || 1),
      workspaceSchemaVersion: Number(payload.workspace.schemaVersion || 1),
      entries: entryDescriptors,
      files: fileDescriptors,
    };
    zipEntries["manifest.json"] = encodeJson(manifest);
    return { bytes: fflate.zipSync(zipEntries, { level: 0 }), manifest };
  }

  function validateWorkspace(workspace) {
    if (!workspace || typeof workspace !== "object" || !Array.isArray(workspace.sessions)) {
      throw backupError("工作区数据格式无效", "INVALID_WORKSPACE");
    }
    const ids = new Set();
    workspace.sessions.forEach((session) => {
      if (!session || typeof session.id !== "string" || !session.id || !Array.isArray(session.assets) || ids.has(session.id)) {
        throw backupError("工作区包含无效或重复的命名记录", "INVALID_WORKSPACE");
      }
      ids.add(session.id);
      const assetIds = new Set();
      session.assets.forEach((asset) => {
        if (!asset || typeof asset.id !== "string" || !asset.id || assetIds.has(asset.id)) {
          throw backupError("工作区包含无效或重复的图片记录", "INVALID_WORKSPACE");
        }
        assetIds.add(asset.id);
      });
    });
    return workspace;
  }

  function validateSettings(settings) {
    if (!settings || typeof settings !== "object" || !settings.entries || typeof settings.entries !== "object" || Array.isArray(settings.entries)) {
      throw backupError("设置数据格式无效", "INVALID_SETTINGS");
    }
    Object.values(settings.entries).forEach((value) => {
      if (value !== null && typeof value !== "string") throw backupError("设置条目格式无效", "INVALID_SETTINGS");
    });
    return settings;
  }

  async function parseArchive(value, options = {}) {
    const bytes = toBytes(value);
    const fflate = getFflate(options.fflate);
    const crypto = getCrypto(options.crypto);
    let uncompressedBytes = 0;
    let entryCount = 0;
    let entries;
    try {
      entries = fflate.unzipSync(bytes, {
        filter(entry) {
          entryCount += 1;
          uncompressedBytes += Number(entry.originalSize || 0);
          if (entryCount > MAX_ARCHIVE_ENTRIES) throw backupError("备份文件数量过多", "TOO_MANY_ENTRIES");
          if (uncompressedBytes > MAX_ARCHIVE_UNCOMPRESSED_BYTES) throw backupError("备份解压后的大小超过 2 GiB 限制", "ARCHIVE_TOO_LARGE");
          return true;
        },
      });
    } catch (error) {
      if (error?.code) throw error;
      throw backupError("无法解压 .ngrap 文件，文件可能已损坏", "INVALID_ARCHIVE");
    }
    const paths = Object.keys(entries);
    paths.forEach(validateArchivePath);
    if (!entries["manifest.json"] || !entries["settings.json"] || !entries["workspace.json"]) {
      throw backupError("备份缺少 manifest、settings 或 workspace", "MISSING_REQUIRED_ENTRY");
    }
    const manifest = parseJson(entries["manifest.json"], "manifest.json");
    if (manifest?.format !== FORMAT || manifest?.formatVersion !== FORMAT_VERSION || !Array.isArray(manifest.entries) || !Array.isArray(manifest.files)) {
      throw backupError("这不是受支持的 NGR AssetPilot 迁移包", "UNSUPPORTED_ARCHIVE");
    }

    const expectedPaths = new Set(["manifest.json"]);
    for (const descriptor of manifest.entries) {
      const path = validateArchivePath(descriptor?.path);
      if (expectedPaths.has(path) || !entries[path]) throw backupError(`备份条目缺失或重复：${path}`, "INVALID_MANIFEST");
      expectedPaths.add(path);
      const entryBytes = entries[path];
      if (Number(descriptor.size) !== entryBytes.byteLength || String(descriptor.sha256 || "").toLowerCase() !== await sha256Hex(entryBytes, crypto)) {
        throw backupError(`备份条目校验失败：${path}`, "INTEGRITY_CHECK_FAILED");
      }
    }
    paths.forEach((path) => {
      if (!expectedPaths.has(path)) throw backupError(`备份包含未登记的条目：${path}`, "UNEXPECTED_ENTRY");
    });

    const settings = validateSettings(parseJson(entries["settings.json"], "settings.json"));
    const workspace = validateWorkspace(parseJson(entries["workspace.json"], "workspace.json"));
    const filePaths = new Set();
    const files = manifest.files.map((descriptor) => {
      const path = validateArchivePath(descriptor?.path);
      if (!path.startsWith("files/") || filePaths.has(path) || !entries[path]) throw backupError("文件清单与备份内容不一致", "INVALID_FILE_MANIFEST");
      filePaths.add(path);
      const data = entries[path];
      if (Number(descriptor.size) !== data.byteLength) throw backupError(`文件大小校验失败：${path}`, "INTEGRITY_CHECK_FAILED");
      return { ...descriptor, path, data };
    });
    const listedBinaryPaths = new Set(manifest.entries.map((entry) => entry.path).filter((path) => path.startsWith("files/")));
    if (listedBinaryPaths.size !== filePaths.size || [...listedBinaryPaths].some((path) => !filePaths.has(path))) {
      throw backupError("文件清单不完整", "INVALID_FILE_MANIFEST");
    }

    let secrets = null;
    if (manifest.includesSecrets) {
      if (!entries["secrets.enc"]) throw backupError("备份声明包含凭据，但 secrets.enc 缺失", "MISSING_SECRET_BLOCK");
      if (!options.password) throw backupError("该迁移包包含加密凭据，请输入迁移密码", "PASSWORD_REQUIRED");
      secrets = await decryptSecrets(entries["secrets.enc"], options.password, { crypto });
    } else if (entries["secrets.enc"]) {
      throw backupError("备份凭据声明与内容不一致", "INVALID_MANIFEST");
    }
    return { manifest, settings, workspace, files, secrets };
  }

  globalScope.NgrWorkspaceBackup = Object.freeze({
    FORMAT,
    FORMAT_VERSION,
    PBKDF2_ITERATIONS,
    MIN_PASSWORD_LENGTH,
    encryptSecrets,
    decryptSecrets,
    sha256Hex,
    buildArchive,
    parseArchive,
    validateArchivePath,
    validateWorkspace,
    validateSettings,
  });
})(typeof window === "undefined" ? globalThis : window);
