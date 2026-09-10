import childProcess from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { projectPaths } from "./project-env.mjs";

function walkExecutables(directory) {
  if (!fs.existsSync(directory)) return [];
  const executables = [];
  const pending = [directory];
  while (pending.length) {
    const current = pending.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(fullPath);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith(".exe")) executables.push(fullPath);
    }
  }
  return executables;
}

export function verifyWindowsSignatures({ edition = "prod", artifactDirectory = projectPaths[`${edition}Artifacts`], spawnSync = childProcess.spawnSync } = {}) {
  if (!["prod", "dev", "test"].includes(edition)) throw new Error("签名验证版本无效");
  const executables = walkExecutables(artifactDirectory);
  if (!executables.length) throw new Error("没有可验证的 Windows 可执行文件");
  const command = [
    "$paths = @($input | ConvertFrom-Json)",
    "$results = foreach ($file in $paths) {",
    "  $signature = Get-AuthenticodeSignature -LiteralPath $file",
    "  [pscustomobject]@{ file = [IO.Path]::GetFileName($file); status = [string]$signature.Status }",
    "}",
    "$results | ConvertTo-Json -Compress",
  ].join("\n");
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], {
    input: JSON.stringify(executables),
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.status !== 0) throw new Error("无法执行 Windows Authenticode 验证");
  const parsed = JSON.parse(String(result.stdout || "null"));
  const signatures = Array.isArray(parsed) ? parsed : [parsed];
  const invalid = signatures.filter((item) => item?.status !== "Valid");
  if (invalid.length) throw new Error(`Windows 签名验证失败：${invalid.map((item) => `${item.file}=${item.status}`).join("；")}`);
  return { executableCount: signatures.length };
}

const isCli = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isCli) {
  try {
    const result = verifyWindowsSignatures({ edition: process.argv[2] || "prod" });
    console.log(`Windows Authenticode 验证通过：${result.executableCount} 个可执行文件。`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Windows Authenticode 验证失败");
    process.exitCode = 1;
  }
}
