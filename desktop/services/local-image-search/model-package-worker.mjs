import { parentPort, workerData } from "node:worker_threads";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import AdmZip from "adm-zip";
import {
  LOCAL_IMAGE_SEARCH_VERSION,
  MODEL_PACKAGE_FORMAT,
  MODEL_PACKAGE_VERSION,
} from "./constants.mjs";

const MANIFEST_NAME = "manifest.json";
const MAX_MANIFEST_BYTES = 64 * 1024;

function packagePath(file) {
  return `${file.model}/${file.relativePath}`;
}

function sourcePath(root, file) {
  return path.join(root, file.model, ...file.relativePath.split("/"));
}

async function sha256(filePath) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

async function assertFile(filePath, expected) {
  const info = await stat(filePath);
  if (!info.isFile() || info.size !== expected.size) throw new Error("MODEL_PACKAGE_SIZE_MISMATCH");
  if (await sha256(filePath) !== expected.sha256) throw new Error("MODEL_PACKAGE_HASH_MISMATCH");
}

function expectedManifest(files) {
  return {
    format: MODEL_PACKAGE_FORMAT,
    formatVersion: MODEL_PACKAGE_VERSION,
    modelVersion: LOCAL_IMAGE_SEARCH_VERSION,
    totalBytes: files.reduce((sum, file) => sum + file.size, 0),
    files: files.map((file) => ({
      path: packagePath(file),
      size: file.size,
      sha256: file.sha256,
    })),
  };
}

function assertManifest(actual, expected) {
  if (!actual || typeof actual !== "object" || Array.isArray(actual)) throw new Error("MODEL_PACKAGE_MANIFEST_INVALID");
  if (
    actual.format !== expected.format
    || actual.formatVersion !== expected.formatVersion
    || actual.modelVersion !== expected.modelVersion
    || actual.totalBytes !== expected.totalBytes
    || JSON.stringify(actual.files) !== JSON.stringify(expected.files)
  ) throw new Error("MODEL_PACKAGE_VERSION_MISMATCH");
}

async function exportPackage() {
  const { modelRoot, packagePath: targetPath, files } = workerData;
  const manifest = expectedManifest(files);
  let completedBytes = 0;
  const zip = new AdmZip();
  zip.addFile(MANIFEST_NAME, Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8"));
  for (const file of files) {
    const filePath = sourcePath(modelRoot, file);
    await assertFile(filePath, file);
    const entryPath = packagePath(file);
    zip.addLocalFile(filePath, `${path.posix.dirname(entryPath)}/`, path.posix.basename(entryPath));
    completedBytes += file.size;
    parentPort.postMessage({ type: "progress", completedBytes });
  }
  await zip.writeZipPromise(targetPath, { overwrite: true });
  return { packagePath: targetPath, totalBytes: manifest.totalBytes };
}

async function importPackage() {
  const { packagePath: archivePath, stagingRoot, files } = workerData;
  const archiveInfo = await stat(archivePath);
  const expected = expectedManifest(files);
  if (!archiveInfo.isFile() || archiveInfo.size > expected.totalBytes + 32 * 1024 * 1024) {
    throw new Error("MODEL_PACKAGE_TOO_LARGE");
  }
  const zip = new AdmZip(archivePath);
  const entries = zip.getEntries().filter((entry) => !entry.isDirectory);
  const names = entries.map((entry) => entry.entryName);
  const allowedNames = new Set([MANIFEST_NAME, ...expected.files.map((file) => file.path)]);
  if (names.length !== allowedNames.size || new Set(names).size !== names.length || names.some((name) => !allowedNames.has(name))) {
    throw new Error("MODEL_PACKAGE_ENTRIES_INVALID");
  }
  const manifestEntry = zip.getEntry(MANIFEST_NAME);
  if (!manifestEntry || manifestEntry.header.size > MAX_MANIFEST_BYTES) throw new Error("MODEL_PACKAGE_MANIFEST_INVALID");
  let manifest;
  try {
    manifest = JSON.parse(zip.readAsText(manifestEntry, "utf8"));
  } catch {
    throw new Error("MODEL_PACKAGE_MANIFEST_INVALID");
  }
  assertManifest(manifest, expected);
  await rm(stagingRoot, { recursive: true, force: true });
  await mkdir(stagingRoot, { recursive: true });
  let completedBytes = 0;
  for (const file of files) {
    const entryName = packagePath(file);
    const entry = zip.getEntry(entryName);
    if (!entry || entry.header.size !== file.size) throw new Error("MODEL_PACKAGE_SIZE_MISMATCH");
    zip.extractEntryTo(entry, stagingRoot, true, true);
    await assertFile(sourcePath(stagingRoot, file), file);
    completedBytes += file.size;
    parentPort.postMessage({ type: "progress", completedBytes });
  }
  return { stagingRoot, totalBytes: expected.totalBytes };
}

try {
  const result = workerData.action === "export" ? await exportPackage() : await importPackage();
  parentPort.postMessage({ type: "complete", result });
} catch (error) {
  parentPort.postMessage({ type: "error", code: String(error?.message || "MODEL_PACKAGE_FAILED") });
}
