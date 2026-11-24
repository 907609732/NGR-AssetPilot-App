import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";

const run = promisify(execFile);
const url = "https://registry.npmjs.org/onnxruntime-node/-/onnxruntime-node-1.30.0.tgz";
const sha512 = "twhs1C2C/BFkz1yc5OY0KIU2GUq6DURO7hD4bx5Q2Qy3nAMJwRXW8xU3NVczE29VA9lolLOYepoD8fjTGOfIqw==";
const expectedBytes = 113507888;
const binaries = ["DirectML.dll", "dxcompiler.dll", "dxil.dll", "onnxruntime_binding.node", "onnxruntime.dll"];

export function createOnnxInstaller(root, fetcher = fetch) {
  const directory = path.join(root, "1.30.0-win32-x64-napi6");
  const ready = () => existsSync(path.join(directory, ".complete")) &&
    binaries.every(name => existsSync(path.join(directory, name)));
  let task;
  async function install(offline) {
    if (ready()) return;
    if (process.platform !== "win32" || process.arch !== "x64" || Number(process.versions.napi) < 6) {
      throw new Error("本地推理组件需要 Windows x64");
    }
    await fs.mkdir(root, { recursive: true });
    const temporary = await fs.mkdtemp(path.join(root, ".install-"));
    try {
      const archive = path.join(temporary, "onnxruntime.tgz");
      const target = path.join(temporary, "runtime");
      await fs.mkdir(target);
      let input;
      if (offline) {
        input = createReadStream(offline);
      } else {
        const response = await fetcher(url, { signal: AbortSignal.timeout(300_000) });
        if (!response.ok || !response.body) throw new Error("本地推理组件下载失败");
        input = response.body;
      }
      const hash = createHash("sha512");
      let bytes = 0;
      await pipeline(input, new Transform({
        transform(chunk, _encoding, next) {
          bytes += chunk.length;
          if (bytes > expectedBytes) return next(new Error("本地推理组件大小不符"));
          hash.update(chunk);
          next(null, chunk);
        },
      }), createWriteStream(archive, { flags: "wx" }));
      if (bytes !== expectedBytes || hash.digest("base64") !== sha512) {
        throw new Error("本地推理组件校验失败");
      }
      const tar = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe");
      const prefix = "package/bin/napi-v6/win32/x64/";
      await run(tar, ["-xzf", archive, "--strip-components", "5", "-C", target,
        ...binaries.map(name => prefix + name)], { windowsHide: true, timeout: 120_000 });
      for (const name of binaries) {
        if (!(await fs.lstat(path.join(target, name))).isFile()) throw new Error("本地推理组件缺少文件");
      }
      await fs.writeFile(path.join(target, ".complete"), sha512, { flag: "wx" });
      try {
        await fs.rename(target, directory);
      } catch (error) {
        if (!ready()) throw error;
      }
    } finally {
      await fs.rm(temporary, { recursive: true, force: true });
    }
  }
  return {
    directory,
    ready,
    install(offline) {
      task ??= install(offline).finally(() => { task = undefined; });
      return task;
    },
  };
}
