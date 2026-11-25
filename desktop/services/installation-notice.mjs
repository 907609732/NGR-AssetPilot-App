import fs from "node:fs/promises";
import path from "node:path";

const EVENT_NAME = "installation-event.ini";
const NOTES_NAME = "installation-release-notes.md";
const SEEN_NAME = "installation-notice-seen.txt";
const ID_PATTERN = /^[A-Za-z0-9{}_.-]{8,96}$/;
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.+-]+)?$/;
const KINDS = new Set(["first", "update", "reinstall"]);

async function readIfPresent(file) {
  try { return await fs.readFile(file); }
  catch (error) {
    if (error.code !== "ENOENT") throw error;
    return null;
  }
}

function readMarker(buffer) {
  if (!buffer || buffer.length > 4096) return null;
  const encoding = buffer[0] === 0xff && buffer[1] === 0xfe ? "utf16le" : "utf8";
  const values = new Map();
  let inInstallation = false;
  for (const line of buffer.toString(encoding).replace(/^\uFEFF/, "").split(/\r?\n/)) {
    const text = line.trim();
    if (text.startsWith("[")) {
      inInstallation = text.toLowerCase() === "[installation]";
      continue;
    }
    const separator = text.indexOf("=");
    if (inInstallation && separator > 0) {
      values.set(text.slice(0, separator).trim().toLowerCase(), text.slice(separator + 1).trim());
    }
  }
  const id = values.get("id") || "";
  const kind = values.get("kind");
  const version = values.get("version") || "";
  if (!ID_PATTERN.test(id) || !KINDS.has(kind) || !VERSION_PATTERN.test(version)) return null;
  const previousVersion = values.get("previousversion") || "";
  return { id, kind, version, previousVersion: VERSION_PATTERN.test(previousVersion) ? previousVersion : null };
}

export class InstallationNotice {
  constructor({ enabled, resourcesPath, userDataPath, version }) {
    this.enabled = enabled;
    this.version = version;
    this.marker = path.join(resourcesPath, EVENT_NAME);
    this.notes = path.join(resourcesPath, NOTES_NAME);
    this.seen = path.join(userDataPath, SEEN_NAME);
  }

  async pending() {
    if (!this.enabled) return null;
    const event = readMarker(await readIfPresent(this.marker));
    if (event?.version !== this.version) return null;
    const seen = await readIfPresent(this.seen);
    return seen?.toString("utf8").trim() === event.id ? null : event;
  }

  async get() {
    const event = await this.pending();
    if (!event) return null;
    const notes = event.kind === "first" ? null : await readIfPresent(this.notes);
    return { ...event, notes: notes?.toString("utf8").trim().slice(0, 20_000) || "" };
  }

  async acknowledge(id) {
    if (typeof id !== "string" || !ID_PATTERN.test(id)) return false;
    const event = await this.pending();
    if (event?.id !== id) return false;
    await fs.writeFile(this.seen, id + "\n", "utf8");
    return true;
  }
}
