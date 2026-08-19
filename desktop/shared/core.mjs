const FORBIDDEN_OBJECT_KEYS = new Set(["__proto__", "prototype", "constructor"]);

export class DesktopError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "DesktopError";
    this.code = code;
  }
}

export function isPlainRecord(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function cloneAndValidateCredentials(value) {
  let nodes = 0;
  let stringBytes = 0;

  function visit(input, depth) {
    nodes += 1;
    if (nodes > 512 || depth > 6) {
      throw new DesktopError("INVALID_CREDENTIALS", "凭据配置结构过大");
    }

    if (input === null || typeof input === "boolean") return input;
    if (typeof input === "number") {
      if (!Number.isFinite(input)) {
        throw new DesktopError("INVALID_CREDENTIALS", "凭据配置包含无效数值");
      }
      return input;
    }
    if (typeof input === "string") {
      stringBytes += Buffer.byteLength(input, "utf8");
      if (stringBytes > 128 * 1024 || input.length > 32 * 1024) {
        throw new DesktopError("INVALID_CREDENTIALS", "凭据配置超过大小限制");
      }
      return input;
    }
    if (Array.isArray(input)) {
      if (input.length > 128) {
        throw new DesktopError("INVALID_CREDENTIALS", "凭据配置数组过大");
      }
      return input.map((item) => visit(item, depth + 1));
    }
    if (!isPlainRecord(input)) {
      throw new DesktopError("INVALID_CREDENTIALS", "凭据配置必须是普通对象");
    }

    const output = Object.create(null);
    const entries = Object.entries(input);
    if (entries.length > 128) {
      throw new DesktopError("INVALID_CREDENTIALS", "凭据配置字段过多");
    }
    for (const [key, child] of entries) {
      if (!key || key.length > 80 || FORBIDDEN_OBJECT_KEYS.has(key)) {
        throw new DesktopError("INVALID_CREDENTIALS", "凭据配置包含非法字段");
      }
      output[key] = visit(child, depth + 1);
    }
    return output;
  }

  if (!isPlainRecord(value)) {
    throw new DesktopError("INVALID_CREDENTIALS", "凭据配置必须是对象");
  }
  return visit(value, 0);
}

export function credentialStatus(credentials) {
  const configuredPaths = [];
  const secretKeyPattern = /(api.?key|secret|token|password|app.?id)/i;

  function walk(value, path, depth) {
    if (depth > 6 || value === null || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      const nextPath = path ? `${path}.${key}` : key;
      if (typeof child === "string" && child.trim() && secretKeyPattern.test(key)) {
        configuredPaths.push(nextPath);
      } else if (child && typeof child === "object") {
        walk(child, nextPath, depth + 1);
      }
    }
  }

  walk(credentials, "", 0);
  const providers = Object.create(null);
  for (const provider of ["ai", "openai", "kimi", "translation", "baidu"]) {
    const candidate = credentials?.[provider];
    providers[provider] = Boolean(
      candidate &&
        typeof candidate === "object" &&
        Object.entries(candidate).some(
          ([key, child]) => typeof child === "string" && child.trim() && secretKeyPattern.test(key),
        ),
    );
  }

  return {
    configured: configuredPaths.length > 0,
    configuredFieldCount: configuredPaths.length,
    providers,
  };
}

export function toBoundedBuffer(value, maxBytes, errorCode = "PAYLOAD_TOO_LARGE") {
  let buffer;
  if (Buffer.isBuffer(value)) {
    buffer = value;
  } else if (value instanceof ArrayBuffer) {
    buffer = Buffer.from(value);
  } else if (ArrayBuffer.isView(value)) {
    buffer = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  } else {
    throw new DesktopError("INVALID_BINARY_PAYLOAD", "二进制数据格式无效");
  }
  if (buffer.byteLength > maxBytes) {
    throw new DesktopError(errorCode, "二进制数据超过大小限制");
  }
  return buffer;
}

export function publicError(error, fallbackCode = "DESKTOP_OPERATION_FAILED") {
  if (error instanceof DesktopError) return error;
  const wrapped = new DesktopError(fallbackCode, "桌面操作失败，请重试");
  if (error && typeof error === "object" && typeof error.code === "string") {
    wrapped.causeCode = error.code.slice(0, 40);
  }
  return wrapped;
}

export function errorCodeOnly(error, fallback = "UNKNOWN_ERROR") {
  if (error && typeof error === "object") {
    if (typeof error.code === "string" && /^[A-Z0-9_\-]{1,64}$/.test(error.code)) return error.code;
    if (typeof error.name === "string" && /^[A-Za-z0-9_\-]{1,64}$/.test(error.name)) return error.name;
  }
  return fallback;
}
