import { realpathSync } from "node:fs";
import path from "node:path";

function sourceIdentity(root) {
  const resolved = realpathSync(root);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

// Explicit source launches only. app.quit() retains the normal save/finalizer path.
export function createDevelopmentRestartHandler({ app, edition, sourceRoot, showConflict }) {
  let restarting = false;
  return (data) => {
    if (app.isPackaged || edition !== "dev" || typeof data?.developmentRestartRoot !== "string"
      || !path.isAbsolute(data.developmentRestartRoot)) return false;
    const requestedRoot = data.developmentRestartRoot;
    let sameSource = false;
    try { sameSource = sourceIdentity(sourceRoot) === sourceIdentity(requestedRoot); } catch { /* Report removed/missing roots as conflicts too. */ }
    if (!sameSource) {
      showConflict({ runningRoot: sourceRoot, requestedRoot });
      return true;
    }
    if (!restarting) {
      restarting = true;
      app.relaunch();
      app.quit();
    }
    return true;
  };
}
