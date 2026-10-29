import { createReadStream } from "node:fs";
import { Readable } from "node:stream";

// Serve only a file already resolved through the registered Bug media index.
export function bugMediaFileResponse(file, request) {
  const headers = {
    "Content-Type": file.mimeType,
    "Accept-Ranges": "bytes",
    "Content-Length": String(file.size),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'; sandbox",
    "Cross-Origin-Resource-Policy": "same-origin",
  };
  if (!["GET", "HEAD"].includes(request.method)) return new Response(null, { status: 405 });
  let start = 0, end = file.size - 1, status = 200;
  const range = request.headers.get("range");
  if (range) {
    const match = range.match(/^bytes=(\d*)-(\d*)$/);
    if (!match || (!match[1] && !match[2])) return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${file.size}` } });
    if (!match[1]) start = Math.max(0, file.size - Number(match[2]));
    else {
      start = Number(match[1]);
      end = match[2] ? Math.min(Number(match[2]), end) : end;
    }
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start > end || start >= file.size || (!match[1] && Number(match[2]) === 0))
      return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${file.size}` } });
    status = 206;
    headers["Content-Range"] = `bytes ${start}-${end}/${file.size}`;
    headers["Content-Length"] = String(end - start + 1);
  }
  if (request.method === "HEAD") return new Response(null, { status, headers });
  return new Response(Readable.toWeb(createReadStream(file.absolutePath, { start, end })), { status, headers });
}
