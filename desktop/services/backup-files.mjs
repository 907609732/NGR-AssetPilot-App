import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { MAX_BACKUP_BYTES } from "../shared/constants.mjs";
import { DesktopError, isPlainRecord, toBoundedBuffer } from "../shared/core.mjs";

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

export class BackupFileService {
  constructor({ dialog, getWindow }) {
    if (!dialog || typeof dialog.showOpenDialog !== "function" || typeof dialog.showSaveDialog !== "function") {
      throw new TypeError("dialog implementation is required");
    }
    this.dialog = dialog;
    this.getWindow = getWindow;
  }

  async save(input) {
    if (!isPlainRecord(input)) {
      throw new DesktopError("BACKUP_SAVE_INVALID", "备份保存请求无效");
    }
    const data = toBoundedBuffer(input.data, MAX_BACKUP_BYTES, "BACKUP_TOO_LARGE");
    const options = {
      title: "保存 NGR AssetPilot 备份",
      defaultPath: suggestedBackupName(input.suggestedName),
      buttonLabel: "保存备份",
      filters: [{ name: "NGR AssetPilot 备份", extensions: ["ngrap"] }],
      properties: ["showOverwriteConfirmation", "createDirectory"],
    };
    const owner = this.getWindow?.();
    const result = owner
      ? await this.dialog.showSaveDialog(owner, options)
      : await this.dialog.showSaveDialog(options);
    if (result.canceled || !result.filePath) return { canceled: true };

    const filePath = result.filePath.toLowerCase().endsWith(".ngrap")
      ? result.filePath
      : `${result.filePath}.ngrap`;
    try {
      await writeFile(filePath, data, { flag: "w", mode: 0o600 });
    } catch {
      throw new DesktopError("BACKUP_SAVE_FAILED", "备份文件保存失败");
    }
    return {
      canceled: false,
      name: path.basename(filePath),
      bytesWritten: data.byteLength,
    };
  }

  async open() {
    const options = {
      title: "打开 NGR AssetPilot 备份",
      buttonLabel: "打开备份",
      filters: [{ name: "NGR AssetPilot 备份", extensions: ["ngrap"] }],
      properties: ["openFile"],
    };
    const owner = this.getWindow?.();
    const result = owner
      ? await this.dialog.showOpenDialog(owner, options)
      : await this.dialog.showOpenDialog(options);
    if (result.canceled || !result.filePaths?.[0]) return { canceled: true };

    const filePath = result.filePaths[0];
    let fileStats;
    try {
      fileStats = await stat(filePath);
    } catch {
      throw new DesktopError("BACKUP_OPEN_FAILED", "无法读取备份文件");
    }
    if (!fileStats.isFile() || fileStats.size > MAX_BACKUP_BYTES) {
      throw new DesktopError("BACKUP_TOO_LARGE", "备份文件无效或超过大小限制");
    }
    let data;
    try {
      data = await readFile(filePath);
    } catch {
      throw new DesktopError("BACKUP_OPEN_FAILED", "无法读取备份文件");
    }
    if (data.byteLength > MAX_BACKUP_BYTES) {
      throw new DesktopError("BACKUP_TOO_LARGE", "备份文件超过大小限制");
    }
    return {
      canceled: false,
      name: path.basename(filePath),
      size: data.byteLength,
      data: asArrayBuffer(data),
    };
  }
}
