import childProcess from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createProjectEnvironment, projectPaths, projectRoot } from "./project-env.mjs";

const nodeMajor = Number.parseInt(process.versions.node.split(".")[0], 10);
if (!Number.isInteger(nodeMajor) || nodeMajor < 22) {
  throw new Error(`需要 Node.js 22 或更高版本，当前为 ${process.versions.node}`);
}

const npmExecPath = process.env.npm_execpath;
const npmCommand = npmExecPath && fs.existsSync(npmExecPath)
  ? process.execPath
  : (process.platform === "win32" ? (process.env.ComSpec || "cmd.exe") : "npm");
const npmArguments = npmExecPath && fs.existsSync(npmExecPath)
  ? [npmExecPath, "--version"]
  : (process.platform === "win32" ? ["/d", "/s", "/c", "npm.cmd --version"] : ["--version"]);
const npmCheck = childProcess.spawnSync(npmCommand, npmArguments, {
  cwd: projectRoot,
  env: createProjectEnvironment(),
  encoding: "utf8",
});
if (npmCheck.status !== 0) {
  throw new Error("未检测到可用的 npm 命令");
}

for (const [name, directory] of Object.entries(projectPaths)) {
  fs.accessSync(directory, fs.constants.W_OK);
  const resolved = path.resolve(directory);
  if (!resolved.toLowerCase().startsWith(projectRoot.toLowerCase() + path.sep)) {
    throw new Error(`${name} 未位于桌面工程目录内`);
  }
}

console.log(`环境检查通过：Node ${process.versions.node}，npm ${npmCheck.stdout.trim()}`);
console.log(`缓存、临时文件和发布物根目录：${projectRoot}`);
