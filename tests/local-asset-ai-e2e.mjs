import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { _electron as electron } from "playwright-core";
import sharp from "sharp";

const root = path.resolve(import.meta.dirname, "..");
const scratch = await mkdtemp(path.join(tmpdir(), "ngr-asset-ai-e2e-"));
const input = path.join(scratch, "images");
const output = path.join(scratch, "copies");
await mkdir(input);
await mkdir(output);
const original = await sharp({ create: { width: 64, height: 64, channels: 3, background: "#35846f" } }).png().toBuffer();
await writeFile(path.join(input, "login_test.png"), original);

const requests = [];
const server = createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  requests.push({
    url: request.url,
    authorization: request.headers.authorization,
    payload: JSON.parse(Buffer.concat(chunks).toString("utf8")),
  });
  response.writeHead(200, { "Content-Type": "application/json" });
  response.end(JSON.stringify({ choices: [{ message: { content: '{"names":["Test_Green_Icon"]}' } }] }));
});
let app;
try {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = "http://127.0.0.1:" + server.address().port + "/v1";
  app = await electron.launch({
    executablePath: path.join(root, "node_modules/electron/dist/electron.exe"),
    args: [path.join(root, "desktop/main/index.mjs"), "--ngr-edition=test"],
    cwd: root,
    env: { ...process.env, NGR_E2E_USER_DATA: path.join(scratch, "profile") },
  });
  const window = await app.firstWindow();
  await window.waitForFunction(() => Boolean(window.NgrDesktopBridge && typeof aiSettings !== "undefined" && aiSettings.providerId));
  await window.evaluate(async (baseUrl) => {
    await window.NgrDesktopBridge.upsertProvider({
      provider: { id: "user-ai", service: "ai", apiFormat: "chat", baseUrl, model: "local-vision-test" },
      secretAction: "replace",
      secret: { apiKey: "isolated-test-credential" },
    });
    aiSettings = { ...aiSettings, provider: "compatible" };
    await hydrateDesktopCredentials();
    referenceFile = new File(["private desktop reference"], "private-reference.png", { type: "image/png" });
  }, baseUrl);

  // Keep the default loopback service port free for the full browser/MCP test.
  await app.evaluate(({ BrowserWindow, dialog, ipcMain }, location) => {
    const require = process.getBuiltinModule("node:module").createRequire(location.root + "/package.json");
    const { createLocalAssetTools } = require("./desktop/services/local-asset-tools.mjs");
    const { createLocalAssetRendererRpc, LOCAL_ASSET_RENDERER_CHANNELS } = require("./desktop/services/local-asset-renderer-rpc.mjs");
    const { APP_URL } = require("./desktop/shared/constants.mjs");
    const window = BrowserWindow.getAllWindows().find((window) => window.webContents.getURL().startsWith(APP_URL));
    const rpc = createLocalAssetRendererRpc({ getWindow: () => window });
    ipcMain.removeHandler(LOCAL_ASSET_RENDERER_CHANNELS.reply);
    ipcMain.handle(LOCAL_ASSET_RENDERER_CHANNELS.reply, (event, payload) => rpc.reply(payload, event.sender));
    globalThis.assetAiAcceptance = {
      approve: false,
      messages: [],
    };
    const tools = createLocalAssetTools({
      getWindow: () => window,
      runRenderer: rpc.run,
      dialog: {
        ...dialog,
        showOpenDialog: async (_window, request) => ({
          canceled: false,
          filePaths: [request.title.includes("导出") ? location.output : location.input],
        }),
        showMessageBox: async (_window, request) => {
          globalThis.assetAiAcceptance.messages.push(request);
          return { response: globalThis.assetAiAcceptance.approve ? 1 : 0 };
        },
      },
    });
    globalThis.assetAiAcceptance.invoke = tools.invoke;
  }, { root, input, output });

  const invoke = (method, args = {}) => app.evaluate((_electron, request) => (
    globalThis.assetAiAcceptance.invoke(request.method, request.args)
  ), { method, args });
  const waitForJob = async (jobId) => {
    for (let step = 0; step < 100; step += 1) {
      const result = await invoke("get_asset_job", { jobId });
      if (["completed", "failed", "cancelled"].includes(result.status)) return result;
      await delay(100);
    }
    assert.fail("AI naming job did not finish");
  };
  const { sources: [{ sourceId }] } = await invoke("grant_sources", { kind: "directory" });
  const declined = await invoke("start_naming", { sourceId, mode: "ai" });
  const declinedResult = await waitForJob(declined.jobId);
  assert.equal(declinedResult.status, "cancelled", JSON.stringify(declinedResult));
  assert.equal(requests.length, 0);

  await app.evaluate(() => { globalThis.assetAiAcceptance.approve = true; });
  const approved = await invoke("start_naming", { sourceId, mode: "ai" });
  const job = await waitForJob(approved.jobId);
  assert.equal(job.status, "completed", JSON.stringify(job));
  const [asset] = job.results;
  assert.equal(asset.status, "done", JSON.stringify(asset));
  assert.match(asset.proposedName, /Test_Green_Icon\.png$/);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "/v1/chat/completions");
  assert.equal(requests[0].authorization, "Bearer isolated-test-credential");
  assert.equal(requests[0].payload.model, "local-vision-test");
  const images = requests[0].payload.messages[0].content.filter((part) => part.type === "image_url");
  assert.equal(images.length, 1);
  assert.match(images[0].image_url.url, /^data:image\/jpeg;base64,/);
  const messages = await app.evaluate(() => globalThis.assetAiAcceptance.messages);
  assert.ok(messages.every((request) => request.detail.includes(baseUrl)));
  const exported = await invoke("export_named_copies", { jobId: job.jobId });
  assert.equal(exported.files[0].status, "copied");
  assert.deepEqual(await readFile(path.join(output, exported.files[0].exportPath)), original);
  assert.deepEqual(await readFile(path.join(input, "login_test.png")), original);
  assert.deepEqual(await readdir(input), ["login_test.png"]);
  console.log(JSON.stringify({ realElectron: true, loopbackVisionRequest: true, providerApproval: true, byteIdenticalCopy: true }));
} finally {
  await app?.close().catch(() => {});
  await new Promise((resolve) => server.close(resolve));
  await rm(scratch, { recursive: true, force: true });
}

