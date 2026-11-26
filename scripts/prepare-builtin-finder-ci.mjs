import { createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { fileURLToPath } from "node:url";
import { pipeline } from "node:stream/promises";
import lock from "../build/finder-builtin.lock.json" with { type: "json" };
import { stageBuiltinFinder } from "./stage-builtin-finder.mjs";

function assetUrl(value, base) {
  const url = new URL(value, base);
  if (url.protocol !== "https:" || url.username || url.password)
    throw new Error("Finder 组件下载地址必须使用 HTTPS");
  return url;
}

export function pinnedFinderUrl(base, component = lock) {
  if (!base) throw new Error("请在发布环境配置 NGR_FINDER_ASAR_BASE_URL");
  if (!/^[a-f0-9]{40}$/.test(component.commit) || !/^[a-f0-9]{64}$/.test(component.sha256))
    throw new Error("Finder 组件锁缺少有效的源码提交或 SHA-256");
  const url = assetUrl(base);
  if (url.search || url.hash) throw new Error("Finder 下载源应为目录地址");
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/${component.commit}/${component.sha256}/app.asar`;
  return url;
}

export async function prepareBuiltinFinder({
  base = process.env.NGR_FINDER_ASAR_BASE_URL,
  token = process.env.NGR_FINDER_ASAR_TOKEN,
  request = fetch,
} = {}) {
  const origin = pinnedFinderUrl(base);
  const signal = AbortSignal.timeout(300_000);
  let url = origin;
  let response;
  for (let redirects = 0; redirects <= 4; redirects++) {
    response = await request(url, {
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
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await prepareBuiltinFinder();
}
