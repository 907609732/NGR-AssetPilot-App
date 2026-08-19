import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { APP_HOST, APP_SCHEME, CONTENT_SECURITY_POLICY } from "../shared/constants.mjs";

const MAX_APP_RESOURCE_BYTES = 64 * 1024 * 1024;
const MIME_TYPES = new Map([
  [".html", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".gif", "image/gif"],
  [".webp", "image/webp"],
  [".svg", "image/svg+xml"],
  [".ico", "image/x-icon"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"],
  [".txt", "text/plain; charset=utf-8"],
]);

function responseHeaders(filePath) {
  return {
    "Content-Type": MIME_TYPES.get(path.extname(filePath).toLowerCase()) || "application/octet-stream",
    "Content-Security-Policy": CONTENT_SECURITY_POLICY,
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "no-cache",
  };
}

function isWithin(root, candidate) {
  const normalizedRoot = path.resolve(root).toLocaleLowerCase("en-US");
  const normalizedCandidate = path.resolve(candidate).toLocaleLowerCase("en-US");
  return normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(`${normalizedRoot}${path.sep}`);
}

export function registerAppScheme(protocol) {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: APP_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
        codeCache: true,
      },
    },
  ]);
}

export function resolveAppResource(appRoot, rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return null;
  }
  if (
    parsed.protocol !== `${APP_SCHEME}:` ||
    parsed.hostname !== APP_HOST ||
    parsed.port ||
    parsed.username ||
    parsed.password
  ) {
    return null;
  }

  let pathname;
  try {
    pathname = decodeURIComponent(parsed.pathname);
  } catch {
    return null;
  }
  if (pathname.includes("\\") || pathname.includes("\0")) return null;
  const relativePath = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  if (!relativePath) return null;
  const candidate = path.resolve(appRoot, relativePath);
  return isWithin(appRoot, candidate) ? candidate : null;
}

export async function installAppProtocol({ protocol, appRoot, ResponseImpl = Response }) {
  const rootRealPath = await realpath(appRoot);
  await protocol.handle(APP_SCHEME, async (request) => {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new ResponseImpl("Method Not Allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
    }
    const candidate = resolveAppResource(rootRealPath, request.url);
    if (!candidate) return new ResponseImpl("Not Found", { status: 404 });

    try {
      const candidateRealPath = await realpath(candidate);
      if (!isWithin(rootRealPath, candidateRealPath)) {
        return new ResponseImpl("Not Found", { status: 404 });
      }
      const fileStats = await stat(candidateRealPath);
      if (!fileStats.isFile() || fileStats.size > MAX_APP_RESOURCE_BYTES) {
        return new ResponseImpl("Not Found", { status: 404 });
      }
      const headers = responseHeaders(candidateRealPath);
      if (request.method === "HEAD") return new ResponseImpl(null, { status: 200, headers });
      const data = await readFile(candidateRealPath);
      return new ResponseImpl(data, { status: 200, headers });
    } catch {
      return new ResponseImpl("Not Found", { status: 404 });
    }
  });
}
