import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { OFFLINE_TRANSLATION_MODEL } from "../desktop/services/offline-translation/manifest.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputRoot = path.join(projectRoot, "build", "generated", "offline-translation");
const modelRoot = path.join(outputRoot, ...OFFLINE_TRANSLATION_MODEL.id.split("/"));

async function sha256(filePath) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

async function isValid(file, target) {
  try {
    const stat = await fs.stat(target);
    return stat.isFile() && stat.size === file.size && await sha256(target) === file.sha256;
  } catch {
    return false;
  }
}

async function download(file, target) {
  const url = `https://huggingface.co/${OFFLINE_TRANSLATION_MODEL.id}/resolve/${OFFLINE_TRANSLATION_MODEL.revision}/${file.path}`;
  const part = `${target}.part`;
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.rm(part, { force: true });
  const response = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(120_000) });
  if (!response.ok || !response.body) throw new Error(`模型下载失败 ${file.path}: HTTP ${response.status}`);
  const declared = Number(response.headers.get("content-length") || 0);
  if (declared && declared !== file.size) throw new Error(`模型文件大小声明不匹配: ${file.path}`);
  await pipeline(Readable.fromWeb(response.body), createWriteStream(part, { flags: "wx" }));
  if (!await isValid(file, part)) {
    await fs.rm(part, { force: true });
    throw new Error(`模型文件校验失败: ${file.path}`);
  }
  await fs.rename(part, target);
}

export async function prepareOfflineTranslationModel() {
  for (const file of OFFLINE_TRANSLATION_MODEL.files) {
    const target = path.join(modelRoot, ...file.path.split("/"));
    if (await isValid(file, target)) continue;
    process.stdout.write(`准备离线翻译模型：${file.path}\n`);
    await download(file, target);
  }
  await fs.writeFile(path.join(outputRoot, "manifest.json"), `${JSON.stringify(OFFLINE_TRANSLATION_MODEL, null, 2)}\n`, "utf8");
  return { outputRoot, modelRoot };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await prepareOfflineTranslationModel();
  process.stdout.write(`离线翻译模型已校验：${result.modelRoot}\n`);
}
