import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import lock from "../build/finder-builtin.lock.json" with { type: "json" };
import { stageBuiltinFinder } from "./stage-builtin-finder.mjs";

export function verifyFinderArtifact(artifactCommit, manifest, component = lock) {
  if (!/^[a-f0-9]{40}$/.test(component.commit) ||
      !/^[a-f0-9]{40}$/.test(component.artifactCommit) ||
      artifactCommit !== component.artifactCommit) {
    throw new Error("Finder 私有产物提交与组件锁不符");
  }
  if (manifest?.sourceCommit !== component.commit ||
      manifest.sha256 !== component.sha256 || manifest.bytes !== component.bytes) {
    throw new Error("Finder 产物清单与组件锁不符");
  }
}

export async function prepareBuiltinFinder(checkout) {
  if (!checkout) throw new Error("用法：node scripts/prepare-builtin-finder-ci.mjs <私有产物检出目录>");
  const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: checkout, encoding: "utf8" }).trim();
  const manifest = JSON.parse(await fs.readFile(path.join(checkout, "component.json"), "utf8"));
  verifyFinderArtifact(commit, manifest);
  await stageBuiltinFinder(checkout);
  console.log(`Finder ${lock.commit} 已从 ${commit} 校验并暂存`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await prepareBuiltinFinder(process.argv[2]);
}
