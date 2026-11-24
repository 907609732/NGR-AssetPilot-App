import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

const [source] = process.argv.slice(2);
if (!source) throw new Error("用法：node scripts/stage-builtin-finder.mjs <Finder 基础组件目录>");
const project = path.resolve(import.meta.dirname, "..");
const lock = JSON.parse(await fs.readFile(path.join(project, "build", "finder-builtin.lock.json"), "utf8"));
const archive = path.resolve(source, "resources", "app.asar");
const output = path.join(project, "build", "generated", "finder-builtin", "resources");
const destination = path.join(output, "app.asar");

async function verify(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  if (hash.digest("hex") !== lock.sha256 || (await fs.stat(file)).size !== lock.bytes) {
    throw new Error("Finder 基础组件与固定版本不匹配");
  }
}

await verify(archive);
await fs.mkdir(output, { recursive: true });
const temporary = await fs.mkdtemp(path.join(output, ".staging-"));
try {
  const candidate = path.join(temporary, "app.asar");
  await fs.copyFile(archive, candidate);
  await verify(candidate);
  await fs.rename(candidate, destination);
} finally {
  await fs.rm(path.join(temporary, "app.asar"), { force: true });
  await fs.rmdir(temporary);
}
