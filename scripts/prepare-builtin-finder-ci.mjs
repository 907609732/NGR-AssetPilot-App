import { createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import lock from "../build/finder-builtin.lock.json" with { type: "json" };
import { stageBuiltinFinder } from "./stage-builtin-finder.mjs";

const source = process.env.NGR_FINDER_ASAR_URL;
if (!source) throw new Error("请在发布环境配置 NGR_FINDER_ASAR_URL，指向组件锁对应的 Finder ASAR 文件");

function assetUrl(value, base) {
  const url = new URL(value, base);
  if (url.protocol !== "https:" || url.username || url.password)
    throw new Error("Finder 组件下载地址必须使用 HTTPS");
  return url;
}

const origin = assetUrl(source);
const token = process.env.NGR_FINDER_ASAR_TOKEN;
const signal = AbortSignal.timeout(300_000);
let url = origin;
let response;
for (let redirects = 0; redirects <= 4; redirects++) {
  response = await fetch(url, {
    redirect: "manual",
    signal,
    headers: {
      Accept: "application/octet-stream",
      ...(token && url.origin === origin.origin ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
  if (![301, 302, 303, 307, 308].includes(response.status)) break;
  const location = response.headers.get("location");
  await response.body?.cancel();
  if (!location || redirects === 4) throw new Error("Finder 组件下载重定向无效");
  url = assetUrl(location, url);
}
if (!response.ok || !response.body) throw new Error(`Finder 下载失败（HTTP ${response.status}）`);

const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "ngr-finder-ci-"));
try {
  const resources = path.join(temporary, "resources");
  await fs.mkdir(resources);
  let bytes = 0;
  await pipeline(Readable.fromWeb(response.body), new Transform({
    transform(chunk, _encoding, done) {
      bytes += chunk.length;
      if (bytes > lock.bytes) return done(new Error("Finder 下载文件大小超出组件锁"));
      done(null, chunk);
    },
  }), createWriteStream(path.join(resources, "app.asar"), { flags: "wx" }));
  await stageBuiltinFinder(temporary);
  console.log(`Finder ${lock.commit} 已校验并暂存`);
} finally {
  await fs.rm(temporary, { recursive: true, force: true });
}
