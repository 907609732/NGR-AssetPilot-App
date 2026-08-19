import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { _electron as electron } from "playwright";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const executablePath = path.join(projectRoot, "artifacts", "test", "win-unpacked", "NGR AssetPilot TEST.exe");
const imageBytes = fs.readFileSync(path.join(projectRoot, "build", "icon.png"));
const marker = `codex_workflow_${Date.now()}`;
const inputName = `${marker}.png`;

async function launch() {
  const app = await electron.launch({
    executablePath,
    env: { ...process.env, ELECTRON_ENABLE_LOGGING: "0" },
    timeout: 30_000,
  });
  const window = await app.firstWindow({ timeout: 30_000 });
  await window.waitForLoadState("domcontentloaded");
  await window.waitForFunction(() => typeof createNamingSession === "function" && namingWorkspacePersistenceReady);
  return { app, window };
}

async function removePriorSmokeSessions(window) {
  await window.evaluate(async () => {
    const ids = namingSessions
      .filter((session) => session.assets.some((asset) => asset.originalBase.startsWith("codex_workflow_")))
      .map((session) => session.id);
    for (const id of ids) {
      if (namingSessions.length > 1) deleteNamingSession(id);
    }
    await saveNamingWorkspaceNow({ force: true });
  });
}

let sessionId;
let exportedName;
let finalBaseName;

{
  const { app, window } = await launch();
  try {
    await removePriorSmokeSessions(window);
    sessionId = await window.evaluate(() => {
      createNamingSession();
      return activeNamingSessionId;
    });

    await window.locator("#singleInput").setInputFiles({
      name: inputName,
      mimeType: "image/png",
      buffer: imageBytes,
    });
    await window.waitForFunction((baseName) => assets.some((asset) => asset.originalBase === baseName), marker);

    await window.evaluate(async () => {
      els.namingModeSelect.value = "local";
      updateNamingRunButton();
      await runSelectedNaming();
    });
    await window.waitForFunction((baseName) => {
      const asset = assets.find((candidate) => candidate.originalBase === baseName);
      return asset?.namingStatus === "done" && Boolean(asset.finalBaseName);
    }, marker);
    finalBaseName = await window.evaluate((baseName) => assets.find((asset) => asset.originalBase === baseName).finalBaseName, marker);

    await window.evaluate(() => {
      showView("work");
      els.exportMenu.open = true;
      els.exportModeSelect.value = "zip";
    });
    const capturedDownload = await window.evaluate(async () => {
      const originalCreateObjectUrl = URL.createObjectURL;
      let generatedBlob = null;
      URL.createObjectURL = function captureGeneratedBlob(blob) {
        generatedBlob = blob;
        return originalCreateObjectUrl.call(this, blob);
      };
      try {
        await exportRenamedFiles();
        if (!generatedBlob) throw new Error("未生成 ZIP Blob");
        return {
          name: buildExportArchiveName([...new Set(assets.map(buildExportProjectFolderName))]),
          bytes: [...new Uint8Array(await generatedBlob.arrayBuffer())],
        };
      } finally {
        URL.createObjectURL = originalCreateObjectUrl;
      }
    });
    exportedName = capturedDownload.name;
    const archiveBytes = Buffer.from(capturedDownload.bytes);
    const exportOutputDirectory = path.join(projectRoot, ".tmp", "workflow-exports");
    fs.mkdirSync(exportOutputDirectory, { recursive: true });
    fs.writeFileSync(path.join(exportOutputDirectory, exportedName), archiveBytes);
    const archive = await window.evaluate((bytes) => {
      const entries = window.fflate.unzipSync(Uint8Array.from(bytes));
      return Object.fromEntries(Object.entries(entries).map(([name, data]) => [name, data.byteLength]));
    }, [...archiveBytes]);
    const archiveEntries = Object.entries(archive);
    assert.equal(archiveEntries.length, 1);
    assert.match(archiveEntries[0][0], /\.png$/i);
    assert.equal(archiveEntries[0][1], imageBytes.byteLength);

    assert.equal(await window.evaluate(() => saveNamingWorkspaceNow({ force: true })), true);
  } finally {
    await app.close();
  }
}

{
  const { app, window } = await launch();
  try {
    await window.waitForFunction((baseName) => assets.some((asset) => asset.originalBase === baseName && asset.file instanceof File), marker);
    const restored = await window.evaluate((baseName) => {
      const asset = assets.find((candidate) => candidate.originalBase === baseName);
      return {
        finalBaseName: asset.finalBaseName,
        fileSize: asset.file.size,
        namingStatus: asset.namingStatus,
      };
    }, marker);
    assert.equal(restored.finalBaseName, finalBaseName);
    assert.equal(restored.fileSize, imageBytes.byteLength);
    assert.equal(restored.namingStatus, "done");

    await window.evaluate(async (createdSessionId) => {
      deleteNamingSession(createdSessionId);
      await saveNamingWorkspaceNow({ force: true });
    }, sessionId);
  } finally {
    await app.close();
  }
}

process.stdout.write(`${JSON.stringify({ localNaming: true, exportedName, restartRestore: true, cleanedTestSession: true })}\n`);
process.stdout.write("LOCAL_WORKFLOW_SMOKE_OK\n");
