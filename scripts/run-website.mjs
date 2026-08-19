import childProcess from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createProjectEnvironment, projectRoot } from "./project-env.mjs";

const command = ["dev", "build", "start"].includes(process.argv[2]) ? process.argv[2] : "dev";
const websiteRoot = path.join(projectRoot, "website");
const vinext = path.join(websiteRoot, "node_modules", "vinext", "dist", "cli.js");
if (!fs.existsSync(vinext)) {
  throw new Error("官网依赖尚未安装；请先在 website 目录执行 npm ci");
}
const env = createProjectEnvironment({
  WRANGLER_LOG_PATH: path.join(projectRoot, "logs", "website-wrangler.log"),
});
const result = childProcess.spawnSync(process.execPath, [vinext, command], {
  cwd: websiteRoot,
  env,
  stdio: "inherit",
});
process.exitCode = result.status ?? 1;
