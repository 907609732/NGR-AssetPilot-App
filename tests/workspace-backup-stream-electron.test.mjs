import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { _electron as electron } from "playwright";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const appEntry = path.join(projectRoot, "desktop", "main", "index.mjs");

test("Electron Worker 使用真实 IndexedDB staging 流式校验 v1 备份", { timeout: 45_000 }, async () => {
  fs.mkdirSync(path.join(projectRoot, ".tmp"), { recursive: true });
  const runRoot = fs.mkdtempSync(path.join(projectRoot, ".tmp", "backup-stream-e2e-"));
  const electronApp = await electron.launch({
    args: [appEntry],
    cwd: projectRoot,
    env: {
      ...process.env,
      NGR_E2E_USER_DATA: path.join(runRoot, "UserData"),
      ELECTRON_ENABLE_LOGGING: "0",
    },
  });
  try {
    const window = await electronApp.firstWindow();
    await window.waitForLoadState("domcontentloaded");
    await window.waitForFunction(() => Boolean(window.NgrWorkspaceBackup && window.fflate));
    const result = await window.evaluate(async () => {
      const workspace = {
        schemaVersion: 1,
        sessions: [{ id: "session-1", referenceName: "", assets: [{ id: "asset-1" }] }],
      };
      const fileData = new TextEncoder().encode("real IndexedDB staging");
      const archive = await window.NgrWorkspaceBackup.buildArchive({
        settings: { schemaVersion: 1, entries: {} },
        workspace,
        files: [{
          path: "files/assets/000001-real.txt",
          key: "asset:session-1:asset-1",
          workspaceKey: "default",
          sessionId: "session-1",
          assetId: "asset-1",
          kind: "asset",
          storedAt: 1,
          name: "real.txt",
          type: "text/plain",
          lastModified: 1,
          data: fileData,
        }],
      }, { fflate: window.fflate, appVersion: "V3.0.6" });
      const worker = new Worker("js/workspace-backup-stream-worker.js?v=V3.0.6");
      let sequence = 0;
      const pending = new Map();
      worker.onmessage = (event) => {
        const message = event.data || {};
        const request = pending.get(message.requestId);
        if (!request) return;
        pending.delete(message.requestId);
        if (message.type === "import-error") request.reject(new Error(`${message.code}: ${message.message}`));
        else request.resolve(message);
      };
      const request = (type, payload, transfer = []) => new Promise((resolve, reject) => {
        const requestId = `request-${++sequence}`;
        pending.set(requestId, { resolve, reject });
        worker.postMessage({ type, requestId, ...payload }, transfer);
      });
      const sessionId = crypto.randomUUID();
      await request("import-start", { payload: { sessionId, password: "" } });
      const bytes = archive.bytes.buffer.slice(archive.bytes.byteOffset, archive.bytes.byteOffset + archive.bytes.byteLength);
      const completed = await request("import-chunk", { sessionId, data: bytes, final: true }, [bytes]);
      worker.terminate();

      const db = await new Promise((resolve, reject) => {
        const open = indexedDB.open("ngr-assetpilot-import-staging-v1", 1);
        open.onsuccess = () => resolve(open.result);
        open.onerror = () => reject(open.error);
      });
      const chunks = await new Promise((resolve, reject) => {
        const transaction = db.transaction("chunks", "readonly");
        const read = transaction.objectStore("chunks").index("by-entry")
          .getAll(IDBKeyRange.only([sessionId, "files/assets/000001-real.txt"]));
        read.onsuccess = () => resolve(read.result);
        read.onerror = () => reject(read.error);
      });
      db.close();
      const text = await new Blob(
        chunks.sort((left, right) => left.sequence - right.sequence).map((chunk) => chunk.data),
      ).text();
      return {
        complete: completed.complete,
        formatVersion: completed.parsed?.manifest?.formatVersion,
        hasInlineData: Object.hasOwn(completed.parsed?.files?.[0] || {}, "data"),
        stagedText: text,
      };
    });
    assert.deepEqual(result, {
      complete: true,
      formatVersion: 1,
      hasInlineData: false,
      stagedText: "real IndexedDB staging",
    });

    const recovered = await window.evaluate(async () => {
      const requestValue = (request) => new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const transactionDone = (transaction) => new Promise((resolve, reject) => {
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error);
      });
      const workspaceDb = await openNamingWorkspaceDb();
      const oldTransaction = workspaceDb.transaction(["workspace", "files"], "readonly");
      const oldDone = transactionDone(oldTransaction);
      const oldWorkspaceRequest = requestValue(oldTransaction.objectStore("workspace").get(NAMING_WORKSPACE_KEY));
      const oldFilesRequest = requestValue(oldTransaction.objectStore("files").getAll());
      const [oldWorkspace, oldFiles] = await Promise.all([oldWorkspaceRequest, oldFilesRequest]);
      await oldDone;

      localStorage.setItem("ngr-assetpilot-desktop-migration-v1", "before-notice");
      const apply = await window.NgrDesktopBridge.beginBackupApply();
      const journalDb = await new Promise((resolve, reject) => {
        const open = indexedDB.open("ngr-assetpilot-import-apply-journal-v1", 1);
        open.onupgradeneeded = () => {
          open.result.createObjectStore("meta", { keyPath: "id" });
          open.result.createObjectStore("files", { keyPath: "key" });
        };
        open.onsuccess = () => resolve(open.result);
        open.onerror = () => reject(open.error);
      });
      const journalTransaction = journalDb.transaction(["meta", "files"], "readwrite");
      const journalDone = transactionDone(journalTransaction);
      journalTransaction.objectStore("meta").put({
        id: "active",
        transactionId: apply.transactionId,
        workspace: oldWorkspace || null,
        settings: Object.fromEntries([APP_VERSION_KEY, ...APP_STORAGE_KEYS].map((key) => [key, localStorage.getItem(key)])),
        migrationNotice: "before-notice",
        createdAt: Date.now(),
      });
      for (const record of oldFiles) journalTransaction.objectStore("files").put(record);
      await journalDone;
      journalDb.close();

      const mutate = workspaceDb.transaction(["workspace", "files"], "readwrite");
      mutate.objectStore("workspace").clear();
      mutate.objectStore("files").clear();
      mutate.objectStore("workspace").put({
        key: NAMING_WORKSPACE_KEY,
        schemaVersion: 1,
        sessions: [{ id: "partially-imported", referenceName: "", assets: [] }],
      });
      await transactionDone(mutate);
      localStorage.setItem("ngr-assetpilot-desktop-migration-v1", "completed");

      await window.NgrWorkspaceMigration.recoverInterruptedWorkspaceImport();
      const verifyDb = await openNamingWorkspaceDb();
      const verify = verifyDb.transaction("workspace", "readonly");
      const verifyDone = transactionDone(verify);
      const restoredWorkspace = await requestValue(verify.objectStore("workspace").get(NAMING_WORKSPACE_KEY));
      await verifyDone;
      const state = await window.NgrDesktopBridge.getBackupApplyState(apply.transactionId);
      return {
        workspaceRestored: JSON.stringify(restoredWorkspace || null) === JSON.stringify(oldWorkspace || null),
        migrationNotice: localStorage.getItem("ngr-assetpilot-desktop-migration-v1"),
        providerTransactionPhase: state.phase,
      };
    });
    assert.deepEqual(recovered, {
      workspaceRestored: true,
      migrationNotice: "before-notice",
      providerTransactionPhase: "missing",
    });
  } finally {
    await electronApp.close();
    const resolvedRunRoot = path.resolve(runRoot);
    assert.equal(resolvedRunRoot.startsWith(path.resolve(projectRoot, ".tmp") + path.sep), true);
    fs.rmSync(resolvedRunRoot, { recursive: true, force: true });
  }
});
