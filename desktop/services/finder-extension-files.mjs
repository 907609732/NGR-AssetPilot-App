import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";
import AdmZip from "adm-zip";

export const FINDER_ID = "quick-interface-finder";
export const FINDER_DOWNLOAD = "https://github.com/907609732/lingtu-interface-finder-releases/releases/latest";
export const FINDER_ENTRY = "resources/app.asar/desktop/main.cjs";
export const FINDER_SCHEME = "library";
const require = createRequire(import.meta.url);
// Installation validates and writes physical ASAR archives, not Electron's virtual ASAR directory.
const physicalFs = process.versions.electron ? require("original-fs") : require("node:fs");
const { createReadStream } = physicalFs;
const { readFile, readdir, lstat, stat, mkdir, writeFile, rename, rm } = physicalFs.promises;
const MAX_ARCHIVE = 1024 * 1024 * 1024;
const MAX_EXPANDED = 2 * 1024 * 1024 * 1024;
const MAX_FILE = 512 * 1024 * 1024;
const MAX_FILES = 25_000;
const VERSION = /^\d+\.\d+\.\d+(?:-[\w.-]+)?$/;
const json = async (file) => JSON.parse(await readFile(file, "utf8"));
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const childOf = (root, file) => file === root || file.startsWith(`${root}${path.sep}`);

function safePath(value) {
  if (typeof value !== "string" || !value || value.length > 1024 || /[\x00-\x1f<>:"|?*\\]/.test(value)) return false;
  if (value.startsWith("/") || value.includes("\0")) return false;
  return value.split("/").every((part) => part && part !== "." && part !== ".." && !/[. ]$/.test(part) && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part));
}

function allowedPayload(value) {
  return ["resources/app.asar", "resources/使用说明.md", "resources/第三方组件说明.md"].includes(value) || value.startsWith("resources/worker/") || value.startsWith("resources/media-tools/");
}

function checkManifest(manifest) {
  if (manifest?.format !== 1 || manifest.id !== FINDER_ID || manifest.name !== "快速找界面" || !VERSION.test(manifest.version || "") || manifest.hostApi !== 1 || manifest.entry !== FINDER_ENTRY || manifest.platform !== "win32" || manifest.arch !== "x64") throw new Error("扩展身份、格式或宿主接口不兼容，请选择快速找界面的 Windows 扩展包");
  if (!Array.isArray(manifest.files) || !manifest.files.length || manifest.files.length > MAX_FILES) throw new Error("扩展文件清单无效");
  const files = new Map();
  let total = 0;
  for (const item of manifest.files) {
    if (!safePath(item?.path) || !allowedPayload(item.path) || !Number.isSafeInteger(item.size) || item.size < 0 || item.size > MAX_FILE || !/^[a-f0-9]{64}$/.test(item.sha256 || "") || files.has(item.path.toLowerCase())) throw new Error("扩展文件清单存在非法路径、大小或重复文件");
    total += item.size;
    if (total > MAX_EXPANDED) throw new Error("扩展解压大小超过限制");
    files.set(item.path.toLowerCase(), item);
  }
  if (!files.has("resources/app.asar") || !files.has("resources/worker/python.exe")) throw new Error("扩展缺少业务程序或推理运行环境");
  return files;
}

async function hashFile(file, onBytes = () => {}) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) { hash.update(chunk); onBytes(chunk.length); }
  return hash.digest("hex");
}

async function walk(root, current = root) {
  const result = [];
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const file = path.join(current, entry.name);
    const info = await lstat(file);
    if (info.isSymbolicLink()) throw new Error("扩展目录不允许符号链接或目录联接");
    if (info.isDirectory()) result.push(...await walk(root, file));
    else if (info.isFile()) result.push(path.relative(root, file).split(path.sep).join("/"));
    else throw new Error("扩展包含不支持的文件类型");
  }
  return result;
}

export async function readFinderExtensionMetadata(root, { manifestHash } = {}) {
  if (typeof root !== "string" || !path.isAbsolute(root)) throw new Error("扩展目录无效");
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error("扩展目录无效");
  const manifestFile = path.join(root, "extension.json"), manifestInfo = await lstat(manifestFile);
  if (!manifestInfo.isFile() || manifestInfo.isSymbolicLink() || manifestInfo.size > 4 * 1024 * 1024) throw new Error("扩展清单已损坏或被修改，请重新导入");
  const raw = await readFile(manifestFile);
  if (raw.length > 4 * 1024 * 1024 || manifestHash && sha(raw) !== manifestHash) throw new Error("扩展清单已损坏或被修改，请重新导入");
  const manifest = JSON.parse(raw.toString("utf8"));
  const files = checkManifest(manifest);
  // Constant-size checks for the trusted container roots, not a payload walk.
  // Full directory, file, size and hash verification remains mandatory before open.
  const containers = ["resources", "resources/worker"];
  if (manifest.files.some(item => item.path.startsWith("resources/media-tools/"))) containers.push("resources/media-tools");
  for (const directory of containers) {
    const info = await lstat(path.join(root, directory));
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("扩展目录不允许符号链接或目录联接");
  }
  return { entry: { id: FINDER_ID, name: manifest.name, version: manifest.version, root, manifestHash: sha(raw), hostApi: manifest.hostApi }, files };
}

export async function inspectFinderExtension(root, { manifestHash, verifyHashes = true, onProgress = () => {} } = {}) {
  onProgress({ phase: "verifying", stage: "检查已安装扩展", indeterminate: true });
  const { entry, files } = await readFinderExtensionMetadata(root, { manifestHash });
  const actual = await walk(root);
  if (actual.length !== files.size + 1 || !actual.includes("extension.json")) throw new Error("扩展文件数量与清单不一致");
  const bytesTotal = [...files.values()].reduce((sum, item) => sum + item.size, 0);
  let done = 0, bytesDone = 0;
  for (const relative of actual) {
    if (relative === "extension.json") continue;
    const item = files.get(relative.toLowerCase());
    if (!item || relative !== item.path) throw new Error("扩展包含未登记或名称不一致的文件");
    const file = path.join(root, relative);
    const progress = () => onProgress({ phase: "verifying", stage: "校验已安装文件", done, total: files.size, bytesDone, bytesTotal, currentFile: relative, indeterminate: !verifyHashes });
    progress();
    if ((await lstat(file)).size !== item.size || verifyHashes && await hashFile(file, count => { bytesDone += count; progress(); }) !== item.sha256) throw new Error(`扩展文件校验失败：${relative}`);
    done++;
    if (!verifyHashes) bytesDone += item.size;
    progress();
  }
  return entry;
}

// Executes only in a Node worker during imports. It never publishes current.json.
export async function installFinderArchive({ archivePath, installRoot, staging }, onProgress = () => {}) {
  const archiveStat = await stat(archivePath);
  if (!archiveStat.isFile() || archiveStat.size > MAX_ARCHIVE || archiveStat.size === 0) throw new Error("扩展 ZIP 无效或超过 1 GB 限制");
  onProgress({ phase: "reading", stage: "读取扩展包", currentFile: path.basename(archivePath), bytesTotal: archiveStat.size, indeterminate: true });
  const zip = new AdmZip(await readFile(archivePath), { fs: physicalFs });
  onProgress({ phase: "manifest", stage: "检查扩展身份与文件清单", indeterminate: true });
  const entries = zip.getEntries();
  if (!entries.length || entries.length > MAX_FILES + 1000) throw new Error("扩展 ZIP 文件数量异常");
  const indexed = new Map();
  let directory = null, totalBytes = 0;
  for (const entry of entries) {
    const name = entry.isDirectory ? entry.entryName.replace(/\/$/, "") : entry.entryName;
    if (!safePath(name) || entry.header.encrypted || ((entry.header.attr >>> 16) & 0xf000) === 0xa000) throw new Error("扩展 ZIP 包含非法路径、符号链接或加密文件");
    const parts = name.split("/");
    if (directory === null) directory = parts[0];
    if (parts[0] !== directory || !/^quick-interface-finder-\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(directory)) throw new Error("扩展 ZIP 必须包含唯一的快速找界面版本目录");
    if (entry.isDirectory) continue;
    const relative = parts.slice(1).join("/");
    if (!relative || indexed.has(relative.toLowerCase()) || !Number.isSafeInteger(entry.header.size) || entry.header.size < 0 || entry.header.size > MAX_FILE) throw new Error("扩展 ZIP 文件路径、大小或重复名称无效");
    totalBytes += entry.header.size;
    if (totalBytes > MAX_EXPANDED) throw new Error("扩展解压大小超过 2 GB 限制");
    indexed.set(relative.toLowerCase(), { entry, relative });
  }
  const manifestEntry = indexed.get("extension.json");
  if (!manifestEntry || manifestEntry.relative !== "extension.json" || manifestEntry.entry.header.size > 4 * 1024 * 1024) throw new Error("缺少有效的 extension.json 扩展清单");
  const raw = manifestEntry.entry.getData();
  const manifest = JSON.parse(raw.toString("utf8"));
  const files = checkManifest(manifest);
  if (directory !== `quick-interface-finder-${manifest.version}` || indexed.size !== files.size + 1) throw new Error("扩展版本或文件数量与清单不一致");
  for (const [key, item] of files) {
    const record = indexed.get(key);
    if (!record || record.relative !== item.path || record.entry.header.size !== item.size) throw new Error(`扩展缺少文件或名称不一致：${item.path}`);
  }
  await mkdir(installRoot, { recursive: true });
  if ((await lstat(installRoot)).isSymbolicLink()) throw new Error("扩展安装目录不允许目录联接");
  if (!childOf(installRoot, staging) || path.dirname(staging) !== installRoot || !path.basename(staging).startsWith(".install-")) throw new Error("临时安装目录越界");
  await mkdir(staging);
  let done = 0, bytesDone = 0;
  for (const [key, record] of indexed) {
    if (key !== "extension.json" && !files.has(key)) throw new Error("扩展包含未登记文件");
    const progress = () => onProgress({ phase: "extracting", stage: "解压并校验文件", done, total: indexed.size, bytesDone, bytesTotal: totalBytes, currentFile: record.relative, indeterminate: false, force: record.entry.header.size > 8 * 1024 * 1024 });
    progress();
    const data = key === "extension.json" ? raw : record.entry.getData();
    const expected = files.get(key);
    if (expected && (data.length !== expected.size || sha(data) !== expected.sha256)) throw new Error(`扩展文件校验失败：${record.relative}`);
    const target = path.resolve(staging, record.relative);
    if (!childOf(staging, target)) throw new Error("扩展路径越界");
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, data, { flag: "wx" });
    done++; bytesDone += data.length; progress();
  }
  const manifestHash = sha(raw), destinationName = `v${manifest.version}-${manifestHash.slice(0, 16)}`, destination = path.join(installRoot, destinationName);
  const existing = await lstat(destination).catch(failure => { if (failure.code === "ENOENT") return null; throw failure; });
  if (existing) await inspectFinderExtension(destination, { manifestHash, onProgress });
  else await rename(staging, destination);
  return { entry: { id: FINDER_ID, name: manifest.name, version: manifest.version, root: destination, manifestHash, hostApi: manifest.hostApi }, directory: destinationName, done, total: indexed.size, bytesDone, bytesTotal: totalBytes };
}
