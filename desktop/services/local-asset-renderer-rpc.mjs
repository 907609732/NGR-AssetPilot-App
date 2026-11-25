import { randomUUID } from "node:crypto";

import { isTrustedAppUrl } from "../main/security.mjs";
import { DesktopError, isPlainRecord } from "../shared/core.mjs";

export const LOCAL_ASSET_RENDERER_CHANNELS = Object.freeze({
  request: "ngr:local-asset:request",
  cancel: "ngr:local-asset:cancel",
  reply: "ngr:local-asset:reply",
});

const RPC_TIMEOUT_MS = 145_000;
const MAX_PENDING = 16;
const MAX_REPLY_BYTES = 4 * 1024 * 1024;
const RENDERER_ERRORS = new Map([
  ["not_ready", "桌面配置仍在加载，请稍后重试"],
  ["provider_required", "请先在桌面设置可用的 AI 命名服务"],
  ["settings_changed", "桌面命名设置已修改，请重新启动任务"],
  ["context_missing", "桌面窗口已重新加载，请重新启动任务"],
]);

function rendererError(message = "桌面资源处理暂不可用，请打开应用后重试") {
  return new DesktopError("LOCAL_ASSET_RENDERER_FAILED", message);
}

export function createLocalAssetRendererRpc({ getWindow, timeoutMs = RPC_TIMEOUT_MS }) {
  const pending = new Map();
  let disposed = false;

  async function run(action, payload, { signal } = {}) {
    signal?.throwIfAborted();
    const window = getWindow();
    const contents = window && !window.isDestroyed() ? window.webContents : null;
    if (disposed || pending.size >= MAX_PENDING || !contents || contents.isDestroyed() || !isTrustedAppUrl(contents.getURL())) {
      throw rendererError();
    }

    const id = randomUUID();
    return new Promise((resolve, reject) => {
      function finish(error, result, notifyCancel = false) {
        if (!pending.delete(id)) return;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        contents.removeListener("render-process-gone", onGone);
        contents.removeListener("did-start-navigation", onNavigation);
        contents.removeListener("destroyed", onGone);
        if (notifyCancel && !contents.isDestroyed()) {
          try {
            contents.send(LOCAL_ASSET_RENDERER_CHANNELS.cancel, { id });
          } catch {
            // The renderer can close while the request is being cancelled.
          }
        }
        if (error) reject(error);
        else resolve(result);
      }

      const onAbort = () => finish(signal.reason, undefined, true);
      const onGone = () => finish(rendererError());
      const onNavigation = (details) => {
        if (details.isMainFrame && !details.isSameDocument) onGone();
      };
      const timer = setTimeout(() => finish(rendererError("桌面资源处理超时，请重试"), undefined, true), timeoutMs);
      timer.unref?.();

      pending.set(id, { contents, finish });
      contents.once("render-process-gone", onGone);
      contents.on("did-start-navigation", onNavigation);
      contents.once("destroyed", onGone);
      signal?.addEventListener("abort", onAbort, { once: true });
      try {
        contents.send(LOCAL_ASSET_RENDERER_CHANNELS.request, { id, action, payload });
      } catch {
        finish(rendererError());
      }
    });
  }

  function reply(payload, contents) {
    if (!isPlainRecord(payload) || typeof payload.id !== "string") return { accepted: false };
    const request = pending.get(payload.id);
    if (!request || request.contents !== contents || disposed) return { accepted: false };
    if (payload.error) {
      request.finish(rendererError(RENDERER_ERRORS.get(payload.error) || "桌面资源处理失败，请重试"));
      return { accepted: true };
    }
    try {
      if (payload.result !== undefined && Buffer.byteLength(JSON.stringify(payload.result), "utf8") > MAX_REPLY_BYTES) {
        throw rendererError("桌面资源处理结果过大");
      }
      request.finish(null, payload.result);
    } catch {
      request.finish(rendererError("桌面资源处理结果无效"));
    }
    return { accepted: true };
  }

  function dispose() {
    disposed = true;
    for (const request of pending.values()) request.finish(rendererError(), undefined, true);
  }

  return { run, reply, dispose };
}

