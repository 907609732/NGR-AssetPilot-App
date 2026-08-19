import childProcess from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createProjectEnvironment, projectPaths, projectRoot } from "./project-env.mjs";

function sha256File(filePath) {
  const hash = crypto.createHash("sha256");
  const file = fs.openSync(filePath, "r");
  const chunk = Buffer.allocUnsafe(1024 * 1024);
  try {
    for (;;) {
      const count = fs.readSync(file, chunk, 0, chunk.length, null);
      if (count === 0) break;
      hash.update(chunk.subarray(0, count));
    }
  } finally {
    fs.closeSync(file);
  }
  return hash.digest("hex");
}

function runGit(args) {
  const result = childProcess.spawnSync("git", args, {
    cwd: projectRoot,
    env: createProjectEnvironment(),
    encoding: "utf8",
  });
  return result.status === 0 ? result.stdout.trim() : "unknown";
}

function generateSbom(outputPath) {
  const installedNpmCli = path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
  const npmExecPath = process.env.npm_execpath && fs.existsSync(process.env.npm_execpath)
    ? process.env.npm_execpath
    : (fs.existsSync(installedNpmCli) ? installedNpmCli : null);
  const command = npmExecPath
    ? process.execPath
    : (process.platform === "win32" ? (process.env.ComSpec || "cmd.exe") : "npm");
  const args = npmExecPath
    ? [npmExecPath, "sbom", "--sbom-format=cyclonedx", "--omit=dev"]
    : (process.platform === "win32"
      ? ["/d", "/s", "/c", "npm.cmd sbom --sbom-format=cyclonedx --omit=dev"]
      : ["sbom", "--sbom-format=cyclonedx", "--omit=dev"]);
  const result = childProcess.spawnSync(command, args, {
    cwd: projectRoot,
    env: createProjectEnvironment(),
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.status !== 0 || !result.stdout.trim().startsWith("{")) {
    throw new Error("npm SBOM 生成失败；请先执行 npm ci 并确认 package-lock.json 有效");
  }
  fs.writeFileSync(outputPath, result.stdout, "utf8");
}

export function generateReleaseMetadata(edition) {
  if (!['dev', 'test'].includes(edition)) throw new Error("版本必须是 dev 或 test");
  const artifactDirectory = projectPaths[`${edition}Artifacts`];
  fs.mkdirSync(artifactDirectory, { recursive: true });
  const packageJson = JSON.parse(fs.readFileSync(path.join(projectRoot, "package.json"), "utf8"));
  const version = packageJson.version;
  const editionLabel = edition === "test" ? "Test" : "Dev";
  const metadataPrefix = `NGR-AssetPilot-${editionLabel}-${version}`;
  const sbomName = `${metadataPrefix}-sbom.cdx.json`;
  const checksumsName = `${metadataPrefix}-SHA256SUMS.txt`;
  const manifestName = `${metadataPrefix}-build-manifest.json`;
  const sbomPath = path.join(artifactDirectory, sbomName);
  generateSbom(sbomPath);

  const excluded = new Set([
    "SHA256SUMS.txt", "build-manifest.json", "sbom.cdx.json",
    checksumsName, manifestName, sbomName,
  ]);
  const artifactFiles = fs.readdirSync(artifactDirectory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && !excluded.has(entry.name))
    .map((entry) => {
      const filePath = path.join(artifactDirectory, entry.name);
      return {
        name: entry.name,
        size: fs.statSync(filePath).size,
        sha256: sha256File(filePath),
      };
    })
    .sort((left, right) => left.name.localeCompare(right.name, "en"));

  if (!artifactFiles.some(({ name }) => name.endsWith(".exe"))) {
    throw new Error("发布目录中缺少 Windows EXE 产物");
  }

  const checksums = artifactFiles.map(({ sha256, name }) => `${sha256} *${name}`).join("\n") + "\n";
  fs.writeFileSync(path.join(artifactDirectory, checksumsName), checksums, "utf8");

  const manifest = {
    schemaVersion: 1,
    product: edition === "test" ? "NGR AssetPilot Test" : "NGR AssetPilot Dev",
    edition,
    version,
    generatedAt: new Date().toISOString(),
    gitCommit: runGit(["rev-parse", "HEAD"]),
    gitBranch: runGit(["branch", "--show-current"]),
    gitDirty: runGit(["status", "--porcelain"]) !== "",
    runtime: {
      node: process.versions.node,
      electron: packageJson.devDependencies.electron,
      electronBuilder: packageJson.devDependencies["electron-builder"],
      electronUpdater: packageJson.dependencies["electron-updater"],
      transformersJs: packageJson.dependencies["@huggingface/transformers"],
      onnxRuntimeNode: packageJson.dependencies["onnxruntime-node"],
      sharp: packageJson.dependencies.sharp,
      playwright: packageJson.devDependencies["@playwright/test"],
    },
    platform: "windows",
    architecture: "x64",
    signed: false,
    artifacts: artifactFiles,
  };
  fs.writeFileSync(
    path.join(artifactDirectory, manifestName),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
  return manifest;
}

const isCli = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isCli) {
  try {
    if (process.argv.length !== 3) throw new Error("请指定 dev 或 test");
    const manifest = generateReleaseMetadata(process.argv[2]);
    console.log(`发布元数据已生成：${manifest.artifacts.length} 个文件，版本 ${manifest.version}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "发布元数据生成失败");
    process.exitCode = 1;
  }
}
