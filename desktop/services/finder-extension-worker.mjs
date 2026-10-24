// Node-only job. ZIP decompression and hashing never execute on Electron's UI thread.
import { parentPort, workerData } from "node:worker_threads";
import { installFinderArchive, inspectFinderExtension } from "./finder-extension-files.mjs";

let lastAt = 0, lastPhase;
function progress(value) {
  const now = Date.now();
  if (!value.force && value.phase === lastPhase && value.done !== value.total && now - lastAt < 80) return;
  lastAt = now; lastPhase = value.phase;
  const { force, ...data } = value;
  parentPort.postMessage({ type: "progress", progress: data });
}
try {
  const result = workerData.kind === "install"
    ? await installFinderArchive(workerData.payload, progress)
    : await inspectFinderExtension(workerData.payload.root, { ...workerData.payload.options, onProgress: progress });
  parentPort.postMessage({ type: "result", result });
} catch (error) {
  parentPort.postMessage({ type: "error", error: { message: error.message, code: error.code } });
} finally { parentPort.close(); }
