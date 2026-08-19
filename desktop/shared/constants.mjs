export const APP_SCHEME = "ngr-assetpilot";
export const APP_HOST = "app";
export const APP_ORIGIN = `${APP_SCHEME}://${APP_HOST}`;
export const APP_URL = `${APP_ORIGIN}/`;

export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "base-uri 'none'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "media-src 'self' data: blob:",
  "connect-src 'none'",
  "worker-src 'self' blob:",
  "child-src 'none'",
  "frame-src 'none'",
].join("; ");

export const MAX_NETWORK_RESPONSE_BYTES = 2 * 1024 * 1024;
export const MAX_NETWORK_REQUEST_BYTES = 2 * 1024 * 1024;
export const MAX_EXPORT_CHUNK_BYTES = 8 * 1024 * 1024;
export const MAX_BACKUP_BYTES = 2 * 1024 * 1024 * 1024;
