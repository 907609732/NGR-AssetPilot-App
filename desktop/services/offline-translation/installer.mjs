import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { OFFLINE_TRANSLATION_MODEL as model } from "./manifest.mjs";

export function createTranslationInstaller(root, { fetcher = fetch } = {}) {
  const library = path.join(root, model.revision);
  const target = path.join(library, ...model.id.split("/"));
  let task;
  async function transfer(file, input, destination) {
    const hash = createHash("sha256");
    let bytes = 0;
    await pipeline(input, new Transform({
      transform(chunk, _encoding, next) {
        bytes += chunk.length;
        if (bytes > file.size) return next(new Error("翻译模型文件大小不符"));
        hash.update(chunk);
        next(null, chunk);
      },
    }), createWriteStream(destination, { flags: "wx" }));
    if (bytes !== file.size || hash.digest("hex") !== file.sha256) {
      throw new Error("翻译模型文件校验失败：" + file.path);
    }
  }

  async function ready() {
    for (const file of model.files) {
      const name = path.join(target, ...file.path.split("/"));
      try {
        const stat = await fs.lstat(name);
        if (!stat.isFile() || stat.size !== file.size) return false;
        const hash = createHash("sha256");
        for await (const chunk of createReadStream(name)) hash.update(chunk);
        if (hash.digest("hex") !== file.sha256) return false;
      } catch (error) {
        if (error.code === "ENOENT") return false;
        throw error;
      }
    }
    return true;
  }

  async function install(directory) {
    if (await ready()) return;
    await fs.mkdir(root, { recursive: true });
    const stage = await fs.mkdtemp(path.join(root, ".install-"));
    try {
      for (const file of model.files) {
        const relative = file.path.split("/");
        const destination = path.join(stage, ...model.id.split("/"), ...relative);
        await fs.mkdir(path.dirname(destination), { recursive: true });
        let input;
        if (directory) {
          input = createReadStream(path.join(directory, ...relative));
        } else {
          const url = `https://huggingface.co/${model.id}/resolve/${model.revision}/${file.path}`;
          const response = await fetcher(url, { signal: AbortSignal.timeout(300000) });
          if (!response.ok || !response.body) throw new Error(`翻译模型下载失败（HTTP ${response.status}）`);
          input = response.body;
        }
        await transfer(file, input, destination);
      }
      try {
        await fs.rename(stage, library);
      } catch (error) {
        if (!await ready()) throw error;
      }
    } finally {
      await fs.rm(stage, { recursive: true, force: true });
    }
  }

  return {
    library,
    install(directory) {
      task ??= install(directory).finally(() => { task = undefined; });
      return task;
    },
  };
}
