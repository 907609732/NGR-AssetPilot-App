import path from "node:path";
import { parentPort, workerData } from "node:worker_threads";
import { env, pipeline } from "@huggingface/transformers";

if (!parentPort) throw new Error("OFFLINE_TRANSLATION_WORKER_REQUIRED");

env.allowRemoteModels = false;
env.allowLocalModels = true;
env.localModelPath = path.resolve(workerData.modelLibraryRoot);
env.cacheDir = path.join(path.resolve(workerData.modelLibraryRoot), ".disabled-cache");

let translatorPromise = null;

async function getTranslator() {
  if (!translatorPromise) {
    translatorPromise = pipeline("translation", workerData.modelId, {
      device: "cpu",
      dtype: "q8",
    }).catch((error) => {
      translatorPromise = null;
      throw error;
    });
  }
  return translatorPromise;
}

function publicError(error) {
  const code = typeof error?.code === "string" ? error.code : "OFFLINE_TRANSLATION_FAILED";
  return { code, message: code === "OFFLINE_TRANSLATION_FAILED" ? "离线翻译失败" : code };
}

parentPort.on("message", async (message = {}) => {
  const requestId = String(message.requestId || "");
  if (!requestId) return;
  try {
    if (message.action === "status") {
      parentPort.postMessage({ requestId, ok: true, result: { loaded: Boolean(translatorPromise) } });
      return;
    }
    if (message.action !== "translate") throw Object.assign(new Error("unsupported action"), { code: "OFFLINE_TRANSLATION_ACTION_INVALID" });
    const translator = await getTranslator();
    const result = await translator(String(message.text || ""), {
      max_new_tokens: 64,
      num_beams: 1,
    });
    const text = String(result?.[0]?.translation_text || "").trim();
    if (!text) throw Object.assign(new Error("empty result"), { code: "OFFLINE_TRANSLATION_EMPTY" });
    parentPort.postMessage({ requestId, ok: true, result: { text, from: "zh", to: "en" } });
  } catch (error) {
    parentPort.postMessage({ requestId, ok: false, error: publicError(error) });
  }
});
