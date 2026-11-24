import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
const fs = process.versions.electron ? require("original-fs") : require("node:fs");

export function createBundledFinder(root, lock) {
  if (!lock || process.platform !== "win32" || process.arch !== "x64") return undefined;
  return async ({ verify = false } = {}) => {
    const file = path.join(root, "resources", "app.asar");
    const stat = await fs.promises.lstat(file);
    if (!stat.isFile() || stat.size !== lock.bytes) throw new Error("内置快速找界面文件不完整，请修复安装");
    if (verify) {
      const hash = createHash("sha256");
      for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
      if (hash.digest("hex") !== lock.sha256) throw new Error("内置快速找界面文件校验失败，请修复安装");
    }
    return { builtin: true, root, version: lock.version };
  };
}
