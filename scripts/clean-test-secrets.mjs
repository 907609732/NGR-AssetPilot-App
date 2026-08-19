import fs from "node:fs";
import path from "node:path";
import { projectPaths } from "./project-env.mjs";

const generatedTargets = [
  path.join(projectPaths.generated, "test-secrets.bin"),
  path.join(projectPaths.generated, "test-secrets-key.mjs"),
];

for (const target of generatedTargets) {
  const resolved = path.resolve(target);
  if (!resolved.startsWith(path.resolve(projectPaths.generated) + path.sep)) {
    throw new Error("拒绝清理生成目录之外的文件");
  }
  fs.rmSync(resolved, { force: true });
}

console.log("测试密钥生成物已清理。");
