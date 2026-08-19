import { constants as fsConstants } from "node:fs";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { MAX_EXPORT_CHUNK_BYTES } from "../shared/constants.mjs";
import { DesktopError, isPlainRecord, toBoundedBuffer } from "../shared/core.mjs";

const TOKEN_TTL_MS = 8 * 60 * 60 * 1000;
const MAX_EXPORT_FILE_BYTES = 2 * 1024 * 1024 * 1024 * 1024;
const WINDOWS_RESERVED_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;

function isWithin(root, candidate) {
  const normalizedRoot = path.resolve(root).toLocaleLowerCase("en-US");
  const normalizedCandidate = path.resolve(candidate).toLocaleLowerCase("en-US");
  return normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(`${normalizedRoot}${path.sep}`);
}

export function validateRelativeExportPath(relativePath) {
  if (typeof relativePath !== "string" || !relativePath || relativePath.length > 1024) {
    throw new DesktopError("EXPORT_PATH_INVALID", "导出相对路径无效");
  }
  if (relativePath.includes("\\") || relativePath.includes("\0") || path.isAbsolute(relativePath)) {
    throw new DesktopError("EXPORT_PATH_INVALID", "导出路径必须使用安全的相对路径");
  }
  const components = relativePath.split("/");
  if (components.some((part) => !part || part === "." || part === "..")) {
    throw new DesktopError("EXPORT_PATH_INVALID", "导出路径包含非法目录段");
  }
  for (const component of components) {
    if (
      component.length > 240 ||
      /[<>:"|?*\u0000-\u001f]/.test(component) ||
      /[. ]$/.test(component) ||
      WINDOWS_RESERVED_NAME.test(component)
    ) {
      throw new DesktopError("EXPORT_PATH_INVALID", "导出路径包含 Windows 不支持的名称");
    }
  }
  return components;
}

async function optionalLstat(target) {
  try {
    return await lstat(target);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function prepareSafeParent(rootPath, components) {
  let current = rootPath;
  for (const component of components.slice(0, -1)) {
    current = path.join(current, component);
    let stats = await optionalLstat(current);
    if (!stats) {
      await mkdir(current, { recursive: false, mode: 0o700 });
      stats = await lstat(current);
    }
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw new DesktopError("EXPORT_PATH_UNSAFE", "导出目录包含链接或非目录对象");
    }
  }

  const parentRealPath = await realpath(current);
  if (!isWithin(rootPath, parentRealPath)) {
    throw new DesktopError("EXPORT_PATH_UNSAFE", "导出路径越过已选择目录");
  }
  return current;
}

export class DirectoryTokenStore {
  constructor({ now = () => Date.now() } = {}) {
    this.now = now;
    this.tokens = new Map();
    this.writeQueues = new Map();
  }

  async grant(rootPath, ownerId) {
    if (!Number.isInteger(ownerId) || ownerId < 0 || !path.isAbsolute(rootPath)) {
      throw new DesktopError("EXPORT_DIRECTORY_INVALID", "导出目录无效");
    }
    const rootRealPath = await realpath(rootPath);
    const stats = await lstat(rootRealPath);
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw new DesktopError("EXPORT_DIRECTORY_INVALID", "导出目录无效");
    }
    const token = randomUUID();
    this.tokens.set(token, {
      ownerId,
      rootPath: rootRealPath,
      lastUsedAt: this.now(),
    });
    return { token, name: path.basename(rootRealPath) };
  }

  requireToken(token, ownerId) {
    if (typeof token !== "string" || token.length > 80) {
      throw new DesktopError("EXPORT_TOKEN_INVALID", "导出目录授权无效");
    }
    const record = this.tokens.get(token);
    if (!record || record.ownerId !== ownerId) {
      throw new DesktopError("EXPORT_TOKEN_INVALID", "导出目录授权无效");
    }
    if (this.now() - record.lastUsedAt > TOKEN_TTL_MS) {
      this.tokens.delete(token);
      throw new DesktopError("EXPORT_TOKEN_EXPIRED", "导出目录授权已过期，请重新选择目录");
    }
    record.lastUsedAt = this.now();
    return record;
  }

  async writeFile(input, ownerId) {
    if (!isPlainRecord(input)) {
      throw new DesktopError("EXPORT_WRITE_INVALID", "导出写入请求无效");
    }
    const token = input.directoryToken ?? input.token;
    const record = this.requireToken(token, ownerId);
    const components = validateRelativeExportPath(input.relativePath);
    const data = toBoundedBuffer(input.data, MAX_EXPORT_CHUNK_BYTES, "EXPORT_CHUNK_TOO_LARGE");
    const offset = input.offset === undefined ? 0 : Number(input.offset);
    if (!Number.isSafeInteger(offset) || offset < 0 || offset + data.byteLength > MAX_EXPORT_FILE_BYTES) {
      throw new DesktopError("EXPORT_OFFSET_INVALID", "导出文件偏移无效");
    }
    const truncate = Boolean(input.truncate);
    const final = Boolean(input.final);
    if (truncate && offset !== 0) {
      throw new DesktopError("EXPORT_OFFSET_INVALID", "截断写入必须从文件开头开始");
    }

    const candidate = path.resolve(record.rootPath, ...components);
    if (!isWithin(record.rootPath, candidate)) {
      throw new DesktopError("EXPORT_PATH_UNSAFE", "导出路径越过已选择目录");
    }
    const queueKey = `${token}\0${components.join("/")}`;
    const previous = this.writeQueues.get(queueKey) ?? Promise.resolve();
    const operation = previous.catch(() => {}).then(() =>
      this.#writeChunk({
        rootPath: record.rootPath,
        candidate,
        components,
        data,
        offset,
        truncate,
        final,
      }),
    );
    this.writeQueues.set(queueKey, operation);
    try {
      return await operation;
    } finally {
      if (this.writeQueues.get(queueKey) === operation) this.writeQueues.delete(queueKey);
    }
  }

  async #writeChunk({ rootPath, candidate, components, data, offset, truncate, final }) {
    await prepareSafeParent(rootPath, components);
    const existing = await optionalLstat(candidate);
    if (existing?.isSymbolicLink() || existing?.isDirectory()) {
      throw new DesktopError("EXPORT_PATH_UNSAFE", "导出目标是链接或目录");
    }
    if (existing) {
      const existingRealPath = await realpath(candidate);
      if (!isWithin(rootPath, existingRealPath)) {
        throw new DesktopError("EXPORT_PATH_UNSAFE", "导出路径越过已选择目录");
      }
    }

    let flags = fsConstants.O_WRONLY | fsConstants.O_CREAT;
    if (truncate) flags |= fsConstants.O_TRUNC;
    if (typeof fsConstants.O_NOFOLLOW === "number") flags |= fsConstants.O_NOFOLLOW;
    let handle;
    try {
      handle = await open(candidate, flags, 0o600);
      let written = 0;
      while (written < data.byteLength) {
        const result = await handle.write(data, written, data.byteLength - written, offset + written);
        if (!result.bytesWritten) {
          throw new DesktopError("EXPORT_WRITE_FAILED", "导出文件写入失败");
        }
        written += result.bytesWritten;
      }
      const nextOffset = offset + written;
      if (final) await handle.truncate(nextOffset);
      await handle.sync();
      return { bytesWritten: written, nextOffset, final };
    } catch (error) {
      if (error instanceof DesktopError) throw error;
      if (error?.code === "ELOOP") {
        throw new DesktopError("EXPORT_PATH_UNSAFE", "导出目标不允许使用链接");
      }
      throw new DesktopError("EXPORT_WRITE_FAILED", "导出文件写入失败");
    } finally {
      await handle?.close().catch(() => {});
    }
  }

  revokeOwner(ownerId) {
    for (const [token, record] of this.tokens) {
      if (record.ownerId === ownerId) this.tokens.delete(token);
    }
  }
}
