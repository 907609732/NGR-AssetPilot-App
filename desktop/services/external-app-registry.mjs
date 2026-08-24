import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access, lstat, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { DesktopError, isPlainRecord } from "../shared/core.mjs";

const STORE_VERSION = 1;
const BUILTIN_ARTHUB_ID = "arthub";
const BUILTIN_FIGMA_ID = "figma";
const BUILTIN_NGR_IMAGE_SEARCH_ID = "ngr-online-ai-search";
const BUILTIN_NGR_IMAGE_SEARCH_URL = "https://bag.ecology.smoba.qq.com/imagebag";
const BUILTIN_APPS = Object.freeze([
  Object.freeze({ id: BUILTIN_ARTHUB_ID, name: "ArtHub" }),
  Object.freeze({ id: BUILTIN_FIGMA_ID, name: "Figma" }),
]);
const BUILTIN_APP_IDS = new Set(BUILTIN_APPS.map(({ id }) => id));
const MAX_APPS = 20;

function publicEntry(entry, available) {
  return Object.freeze({
    id: entry.id,
    name: entry.name,
    builtin: entry.builtin === true,
    configured: Boolean(entry.executablePath),
    available,
  });
}

function publicWebsiteEntry() {
  return Object.freeze({
    id: BUILTIN_NGR_IMAGE_SEARCH_ID,
    name: "NGR在线AI搜图",
    builtin: true,
    configured: true,
    available: true,
    kind: "website",
  });
}

async function isLaunchableExecutable(candidate) {
  if (process.platform !== "win32" || typeof candidate !== "string" || !path.isAbsolute(candidate)) return false;
  if (path.extname(candidate).toLowerCase() !== ".exe") return false;
  try {
    const stat = await lstat(candidate);
    if (!stat.isFile() || stat.isSymbolicLink()) return false;
    await access(candidate, fsConstants.R_OK);
    return true;
  } catch {
    return false;
  }
}

function defaultArtHubCandidates() {
  const roots = new Set([
    process.env.ProgramFiles,
    process.env["ProgramFiles(x86)"],
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "Programs") : null,
    "C:\\Program Files",
    "D:\\Program Files",
    "E:\\Program Files",
  ].filter(Boolean));
  return [...roots].map((root) => path.join(root, "ArtHub", "ArtHub.exe"));
}

function defaultFigmaCandidates() {
  return [
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "Figma", "Figma.exe") : null,
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "Programs", "Figma", "Figma.exe") : null,
    process.env.ProgramFiles ? path.join(process.env.ProgramFiles, "Figma", "Figma.exe") : null,
    process.env["ProgramFiles(x86)"] ? path.join(process.env["ProgramFiles(x86)"], "Figma", "Figma.exe") : null,
    "C:\\Program Files\\Figma\\Figma.exe",
    "D:\\Program Files\\Figma\\Figma.exe",
    "E:\\Program Files\\Figma\\Figma.exe",
  ].filter(Boolean);
}

function validateId(payload) {
  const id = String(payload?.appId || "");
  if (!/^[a-z0-9_-]{1,80}$/i.test(id)) throw new DesktopError("APP_ID_INVALID", "快捷应用标识无效");
  return id;
}

export class ExternalAppRegistry {
  constructor({ userDataPath, dialog, shell, getWindow, artHubCandidates = null, figmaCandidates = null }) {
    this.dialog = dialog;
    this.shell = shell;
    this.getWindow = getWindow;
    this.storePath = path.join(userDataPath, "external-apps.json");
    this.entries = [];
    this.artHubCandidates = artHubCandidates || defaultArtHubCandidates();
    this.figmaCandidates = figmaCandidates || defaultFigmaCandidates();
  }

  async initialize() {
    await mkdir(path.dirname(this.storePath), { recursive: true });
    try {
      const parsed = JSON.parse(await readFile(this.storePath, "utf8"));
      if (parsed?.version === STORE_VERSION && Array.isArray(parsed.apps)) {
        this.entries = parsed.apps.filter((entry) =>
          isPlainRecord(entry) && /^[a-z0-9_-]{1,80}$/i.test(entry.id) &&
          typeof entry.name === "string" && typeof entry.executablePath === "string",
        ).slice(0, MAX_APPS).map((entry) => ({
          id: entry.id,
          name: entry.name.slice(0, 60),
          executablePath: entry.executablePath ? path.resolve(entry.executablePath) : "",
          builtin: BUILTIN_APP_IDS.has(entry.id),
        }));
      }
    } catch (error) {
      if (error?.code !== "ENOENT") throw new DesktopError("APP_REGISTRY_CORRUPT", "快捷应用配置损坏", { cause: error });
    }
    let changed = false;
    for (const builtin of BUILTIN_APPS) {
      const existing = this.entries.find((entry) => entry.id === builtin.id);
      if (existing) {
        existing.name = builtin.name;
        existing.builtin = true;
        continue;
      }
      const detectedPath = await this.#detectBuiltin(builtin.id);
      this.entries.push({ ...builtin, executablePath: detectedPath || "", builtin: true });
      changed = true;
    }
    this.entries.sort((left, right) => {
      const leftIndex = BUILTIN_APPS.findIndex(({ id }) => id === left.id);
      const rightIndex = BUILTIN_APPS.findIndex(({ id }) => id === right.id);
      if (leftIndex >= 0 && rightIndex >= 0) return leftIndex - rightIndex;
      if (leftIndex >= 0) return -1;
      if (rightIndex >= 0) return 1;
      return 0;
    });
    if (changed) {
      await this.#save();
    }
    return this.list();
  }

  async #detectBuiltin(appId) {
    const candidates = appId === BUILTIN_FIGMA_ID ? this.figmaCandidates : this.artHubCandidates;
    for (const candidate of candidates) {
      if (await isLaunchableExecutable(candidate)) return path.resolve(candidate);
    }
    return "";
  }

  async #save() {
    const temporaryPath = `${this.storePath}.part`;
    const body = JSON.stringify({ version: STORE_VERSION, apps: this.entries }, null, 2);
    await writeFile(temporaryPath, body, { encoding: "utf8", flag: "w" });
    try {
      await rename(temporaryPath, this.storePath);
    } catch (error) {
      await unlink(temporaryPath).catch(() => {});
      throw error;
    }
  }

  async list() {
    const applications = await Promise.all(
      this.entries.map(async (entry) => publicEntry(entry, await isLaunchableExecutable(entry.executablePath))),
    );
    const builtinApplicationCount = applications.filter((entry) => entry.builtin).length;
    return {
      apps: [
        ...applications.slice(0, builtinApplicationCount),
        publicWebsiteEntry(),
        ...applications.slice(builtinApplicationCount),
      ],
      defaultAppId: BUILTIN_ARTHUB_ID,
    };
  }

  async choose(payload = {}) {
    const existingId = payload?.appId ? validateId(payload) : null;
    if (existingId === BUILTIN_NGR_IMAGE_SEARCH_ID) {
      throw new DesktopError("APP_CONFIGURATION_NOT_REQUIRED", "NGR在线AI搜图使用内置网址，无需配置");
    }
    const existing = existingId ? this.entries.find((entry) => entry.id === existingId) : null;
    if (existingId && !existing) throw new DesktopError("APP_NOT_FOUND", "快捷应用不存在");
    if (!existing && this.entries.length >= MAX_APPS) throw new DesktopError("APP_LIMIT_REACHED", "最多添加 20 个快捷应用");
    const owner = this.getWindow();
    const options = {
      title: existing ? `重新选择 ${existing.name}` : "选择要快速打开的软件",
      buttonLabel: "添加此软件",
      properties: ["openFile"],
      filters: [{ name: "Windows 应用程序", extensions: ["exe"] }],
    };
    const result = owner ? await this.dialog.showOpenDialog(owner, options) : await this.dialog.showOpenDialog(options);
    if (result.canceled || !result.filePaths?.[0]) return { canceled: true };
    const executablePath = path.resolve(result.filePaths[0]);
    if (!(await isLaunchableExecutable(executablePath))) {
      throw new DesktopError("APP_EXECUTABLE_INVALID", "请选择有效的 Windows EXE 应用程序");
    }
    if (existing) {
      existing.executablePath = executablePath;
      if (!existing.builtin) existing.name = path.basename(executablePath, path.extname(executablePath)).slice(0, 60);
    } else {
      this.entries.push({
        id: `app_${randomUUID().replaceAll("-", "")}`,
        name: path.basename(executablePath, path.extname(executablePath)).slice(0, 60) || "桌面应用",
        executablePath,
        builtin: false,
      });
    }
    await this.#save();
    return { canceled: false, ...(await this.list()) };
  }

  async remove(payload) {
    const id = validateId(payload);
    if (id === BUILTIN_NGR_IMAGE_SEARCH_ID) {
      throw new DesktopError("BUILTIN_APP_REQUIRED", "默认 NGR在线AI搜图 快捷入口不能删除");
    }
    const entry = this.entries.find((item) => item.id === id);
    if (!entry) throw new DesktopError("APP_NOT_FOUND", "快捷应用不存在");
    if (entry.builtin) throw new DesktopError("BUILTIN_APP_REQUIRED", `默认 ${entry.name} 快捷入口不能删除，可以重新选择路径`);
    this.entries = this.entries.filter((item) => item.id !== id);
    await this.#save();
    return this.list();
  }

  async launch(payload) {
    const id = validateId(payload);
    if (id === BUILTIN_NGR_IMAGE_SEARCH_ID) {
      await this.shell.openExternal(BUILTIN_NGR_IMAGE_SEARCH_URL, { activate: true });
      return { opened: true, appId: id, name: "NGR在线AI搜图" };
    }
    const entry = this.entries.find((item) => item.id === id);
    if (!entry) throw new DesktopError("APP_NOT_FOUND", "快捷应用不存在");
    if (!(await isLaunchableExecutable(entry.executablePath))) {
      throw new DesktopError("APP_NOT_CONFIGURED", `${entry.name} 未安装或路径已失效，请重新选择`);
    }
    const errorMessage = await this.shell.openPath(entry.executablePath);
    if (errorMessage) throw new DesktopError("APP_LAUNCH_FAILED", `无法打开 ${entry.name}`);
    return { opened: true, appId: entry.id, name: entry.name };
  }
}
