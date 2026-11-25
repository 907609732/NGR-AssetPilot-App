import { constants as fsConstants } from "node:fs";
import { lstat, mkdir, mkdtemp, open, opendir, realpath } from "node:fs/promises";
import path from "node:path";

import { DesktopError } from "../shared/core.mjs";
import { validateRelativeExportPath } from "./directory-tokens.mjs";

const MAX_SOURCE_ENTRIES = 10_000;
const MAX_SOURCE_DEPTH = 20;
const MAX_IMAGE_BYTES = 32 * 1024 * 1024;

function samePath(left, right) {
  return process.platform === "win32"
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

function sameObject(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameFile(left, right) {
  return sameObject(left, right) && left.size === right.size && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

export function isLocalNamingImage(name) {
  return /\.(png|jpe?g|webp|gif|svg)$/i.test(name);
}

function sourceChanged() {
  return new DesktopError("LOCAL_ASSET_SOURCE_CHANGED", "源文件已移动或修改，请重新选择");
}

async function selectedDirectory(directory) {
  const selected = await lstat(directory, { bigint: true });
  if (!selected.isDirectory() || selected.isSymbolicLink()) throw sourceChanged();
  const canonical = await realpath(directory);
  const stats = await lstat(canonical, { bigint: true });
  if (!stats.isDirectory() || stats.isSymbolicLink() || !sameObject(selected, stats)) throw sourceChanged();
  return { canonical, stats };
}

function scanLimit() {
  return new DesktopError("LOCAL_ASSET_SCAN_LIMIT", "目录内容过多，请选择更小的切图目录");
}

function isSafeRelativePath(relativePath) {
  try {
    validateRelativeExportPath(relativePath);
    return true;
  } catch {
    return false;
  }
}

export async function scanLocalAssetDirectory(directory, signal) {
  const root = await selectedDirectory(directory);
  let entryCount = 0;
  const files = [];
  async function visit(components) {
    signal?.throwIfAborted();
    if (components.length > MAX_SOURCE_DEPTH) throw scanLimit();
    const folder = path.join(root.canonical, ...components);
    const canonical = await realpath(folder);
    if (!samePath(folder, canonical)) return;
    for await (const entry of await opendir(folder)) {
      signal?.throwIfAborted();
      entryCount += 1;
      if (entryCount > MAX_SOURCE_ENTRIES) throw scanLimit();
      if (entry.isSymbolicLink() || entry.name.startsWith(".")) continue;
      const next = [...components, entry.name];
      const relativePath = next.join("/");
      if (!isSafeRelativePath(relativePath)) continue;
      if (entry.isDirectory()) {
        await visit(next);
      } else if (entry.isFile()) {
        const stats = await lstat(path.join(root.canonical, ...next), { bigint: true });
        if (stats.isFile() && !stats.isSymbolicLink()) {
          files.push({ relativePath, name: entry.name, root, components: next, stats });
        }
      }
    }
  }
  await visit([]);
  files.sort((left, right) => left.relativePath.localeCompare(right.relativePath, "en"));
  return { name: path.basename(root.canonical) || "已选择的目录", files };
}

export async function scanLocalAssetFiles(selectedFiles, signal) {
  if (selectedFiles.length > MAX_SOURCE_ENTRIES) throw scanLimit();
  const files = new Map();
  const usedNames = new Set();
  for (const selectedFile of new Set(selectedFiles)) {
    signal?.throwIfAborted();
    const name = path.basename(selectedFile);
    if (!isSafeRelativePath(name)) continue;
    const stats = await lstat(selectedFile, { bigint: true });
    if (!stats.isFile() || stats.isSymbolicLink()) continue;
    const root = await selectedDirectory(path.dirname(selectedFile));
    let relativePath = name;
    for (let index = 2; usedNames.has(relativePath.toLowerCase()); index += 1) {
      relativePath = index + "/" + name;
    }
    usedNames.add(relativePath.toLowerCase());
    files.set(relativePath, { relativePath, name, root, components: [name], stats });
  }
  return {
    name: files.size === 1 ? files.values().next().value.name : "已选择的文件",
    files: [...files.values()],
  };
}

async function verifyAssetPath(file) {
  const { root, components } = file;
  const rootStats = await lstat(root.canonical, { bigint: true });
  if (!rootStats.isDirectory() || rootStats.isSymbolicLink() || !sameObject(root.stats, rootStats)
    || !samePath(await realpath(root.canonical), root.canonical)) throw sourceChanged();
  let current = root.canonical;
  for (const component of components.slice(0, -1)) {
    current = path.join(current, component);
    const stats = await lstat(current);
    if (!stats.isDirectory() || stats.isSymbolicLink()) throw sourceChanged();
  }
  const target = path.join(current, components.at(-1));
  const stats = await lstat(target, { bigint: true });
  if (!stats.isFile() || stats.isSymbolicLink() || !sameFile(file.stats, stats)
    || !samePath(await realpath(target), target)) throw sourceChanged();
  return target;
}

export async function readLocalAsset(file, signal) {
  signal?.throwIfAborted();
  if (file.stats.size > BigInt(MAX_IMAGE_BYTES)) {
    throw new DesktopError("LOCAL_ASSET_TOO_LARGE", "单个文件不能超过 32 MB");
  }
  let handle;
  try {
    const target = await verifyAssetPath(file);
    handle = await open(target, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
    const before = await handle.stat({ bigint: true });
    if (!sameFile(file.stats, before)) throw sourceChanged();
    await verifyAssetPath(file);
    signal?.throwIfAborted();
    const bytes = Buffer.alloc(Number(before.size));
    for (let offset = 0; offset < bytes.length;) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) throw sourceChanged();
      offset += bytesRead;
      signal?.throwIfAborted();
    }
    if (!sameFile(before, await handle.stat({ bigint: true }))) throw sourceChanged();
    return bytes;
  } catch (error) {
    if (error instanceof DesktopError || signal?.aborted) throw error;
    throw sourceChanged();
  } finally {
    await handle?.close();
  }
}

export function requireExportComponent(name) {
  if (validateRelativeExportPath(name).length !== 1) {
    throw new DesktopError("LOCAL_ASSET_EXPORT_NAME_INVALID", "导出名称只能包含一个文件名");
  }
  return name;
}

export function requireExportFilename(name, sourceName) {
  requireExportComponent(name);
  if (path.extname(name).toLowerCase() !== path.extname(sourceName).toLowerCase()) {
    throw new DesktopError("LOCAL_ASSET_EXPORT_EXTENSION_INVALID", "修改名称时请保留原文件扩展名");
  }
  return name;
}

export async function createLocalAssetOutputFolder(directory, signal) {
  try {
    const root = await selectedDirectory(directory);
    signal?.throwIfAborted();
    const folder = await mkdtemp(path.join(root.canonical, "AssetPilot-"));
    return selectedDirectory(folder);
  } catch {
    signal?.throwIfAborted();
    throw new DesktopError("LOCAL_ASSET_OUTPUT_INVALID", "无法在所选目录创建导出文件夹");
  }
}

export async function writeLocalAssetCopy(output, projectFolder, filename, bytes, signal) {
  signal?.throwIfAborted();
  const parent = path.join(output.canonical, requireExportComponent(projectFolder));
  try {
    await mkdir(parent, { mode: 0o700 });
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
  const rootStats = await lstat(output.canonical, { bigint: true });
  const parentStats = await lstat(parent);
  if (!sameObject(output.stats, rootStats) || !parentStats.isDirectory() || parentStats.isSymbolicLink()
    || !samePath(await realpath(parent), parent)) {
    throw new DesktopError("LOCAL_ASSET_OUTPUT_UNSAFE", "导出目录已发生变化");
  }
  const target = path.join(parent, requireExportComponent(filename));
  signal?.throwIfAborted();
  const handle = await open(target, "wx", 0o600);
  try {
    await handle.writeFile(bytes);
  } finally {
    await handle.close();
  }
  return [path.basename(output.canonical), projectFolder, filename].join("/");
}

