// Recognize supported video containers from bytes, never from a link's suffix alone.
export function detectVideoFormat(prefix: Buffer): { format: string; mimeType: string } | null {
  if (prefix.length >= 16 && prefix.toString("ascii", 4, 8) === "ftyp") {
    const boxSize = prefix.readUInt32BE(0);
    if (boxSize < 16 || boxSize > 1024 * 1024) return null;
    const brand = prefix.toString("ascii", 8, 12);
    if (brand === "qt  ") return { format: "mov", mimeType: "video/quicktime" };
    if (/^(?:isom|iso[2-9]|mp4[12]|avc1|M4V |MSNV|dash|cmf[cv]|[34]g[pe][0-9])$/.test(brand))
      return { format: "mp4", mimeType: "video/mp4" };
  }
  if (prefix.length >= 16 && prefix.readUInt32BE(0) === 0x1a45dfa3 && prefix.includes(Buffer.from("webm")))
    return { format: "webm", mimeType: "video/webm" };
  return null;
}
