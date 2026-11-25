import assert from "node:assert/strict";
import { File } from "node:buffer";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const image = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");

function setup() {
  const requests = [];
  const replies = [];
  let onRequest;
  const context = vm.createContext({
    window: {
      ngrDesktop: {
        localAssets: {
          onRequest(handler) { onRequest = handler; },
          onCancel() {},
          async reply(payload) { replies.push(payload); },
        },
      },
      NgrDesktopBridge: {
        isDesktopRuntime: () => true,
        async listProviders() {
          return [{ id: "test-ai", service: "ai", name: "Test AI", model: "Test Vision",
            baseUrl: "https://example.com/v1", apiFormat: "chat", hasSecret: true }];
        },
        async requestProvider(id, operation, body, options) {
          requests.push({ id, operation, body, options });
          return { ok: true, json: async () => ({ choices: [{ message: { content: '{"names":["Login_Icon"]}' } }] }) };
        },
      },
    },
    AbortController,
    File,
    URL,
    Uint8Array,
    TextDecoder,
    crypto: globalThis.crypto,
    document: {
      createElement() {
        return {
          getContext: () => ({ drawImage() {}, getImageData: () => ({ data: new Uint8Array(12 * 12 * 4) }) }),
          toDataURL: () => "data:image/jpeg;base64,AA==",
        };
      },
    },
    Image: class {
      naturalWidth = 64;
      naturalHeight = 64;
      set src(_value) { queueMicrotask(() => this.onload()); }
    },
    rules: { tags: "", pageTerms: "", componentTerms: "", stateTerms: "", filenameRules: "", viewName: "View" },
    prefixLibrary: [],
    aiSettings: { providerId: "test-ai", model: "", apiKey: "" },
    currentWorkProjectName: "Project",
    referenceFile: new File([image], "desktop-private.png"),
    MAX_DUPLICATE_SCAN_ASSETS: 1800,
    validateUploadDimensions: () => ({}),
    normalizeDetectionProfile: (profile) => profile,
    getActiveDetectionProfile: () => ({
      name: "切图标准", mode: "ngr", duplicateSensitivity: "medium",
      minWidth: 4, minHeight: 4, atlasMultiple: 4, largeThreshold: 512, maxSide: 2048,
    }),
    parseKnowledge: () => ({}),
    makeRecommendations: () => ["Local_Icon"],
    makeRecommendationsWithTranslation: (_asset, _knowledge, options) => {
      assert.equal(options.allowExternal, false);
      return ["Local_Icon"];
    },
    getExtension: (name) => name.slice(name.lastIndexOf(".")).toLowerCase(),
    getActiveProject: () => ({ id: "project" }),
    parseList: () => [],
    parseFilenameRules: () => [],
    buildAssetPrefix: () => "Art_",
    buildExportProjectFolderName: () => "Project",
    buildExportName: (asset) => "Art_" + asset.finalBaseName + asset.extension,
    formatNamingName: (name) => String(name || "").replace(/[^A-Za-z0-9_]/g, ""),
    removeTrailingSequence: (name) => name.replace(/_[0-9]+$/, ""),
    formatSequenceNumber: (index) => String(index).padStart(2, "0"),
    appendPart: (left, right) => left + "_" + right,
  });
  for (const file of ["ai-workflow.js", "assets-detection.js", "local-asset-renderer.js"]) {
    vm.runInContext(readFileSync(new URL("../app/js/" + file, import.meta.url), "utf8"), context, { filename: file });
  }
  vm.runInContext("validateUploadDimensions = () => ({});\ngetNgrSpecialDimensionSpec = () => null;", context);
  return {
    requests,
    context,
    async call(action, payload) {
      await onRequest({ id: String(replies.length), action, payload: { contextId: "test-job", ...payload } });
      return JSON.parse(JSON.stringify(replies.at(-1)));
    },
  };
}

test("renderer calls the configured vision provider with only the granted image", async () => {
  const { call, requests } = setup();
  const prepared = await call("prepare_naming", { type: "naming", mode: "ai" });
  assert.equal(prepared.result.provider.endpoint, "https://example.com/v1");
  assert.equal(requests.length, 0);
  await call("inspect_file", { type: "naming", relativePath: "nested/icon.png", name: "icon.png", bytes: image, size: image.length });
  const final = await call("finalize_job", { type: "naming", relativePaths: ["nested/icon.png"] });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].id, "test-ai");
  assert.equal(requests[0].operation, "chat");
  assert.equal(requests[0].options.expectedProviderBaseUrl, "https://example.com/v1");
  assert.equal(requests[0].body.model, "Test Vision");
  assert.equal(requests[0].body.messages[0].content.filter(({ type }) => type === "image_url").length, 1);
  assert.equal(final.result[0].proposedName, "Art_Login_Icon.png");
  assert.equal(final.result[0].status, "done");
});

test("renderer runs local naming without requests and retains existing sequence naming", async () => {
  const { call, requests } = setup();
  await call("prepare_naming", { type: "naming", mode: "local" });
  for (const name of ["first.png", "second.png"]) {
    await call("inspect_file", { type: "naming", relativePath: name, name, bytes: image, size: image.length });
  }
  const final = await call("finalize_job", { type: "naming", relativePaths: ["first.png", "second.png"] });
  assert.equal(requests.length, 0);
  assert.deepEqual(final.result.map(({ proposedName }) => proposedName), ["Art_Local_Icon_01.png", "Art_Local_Icon_02.png"]);
});

test("renderer delegates slice format, dimensions and similarity checks to desktop rules", async () => {
  const { call } = setup();
  const prepared = await call("prepare_slice_check", { type: "slice_check" });
  assert.equal(prepared.result.profileName, "切图标准");
  for (const name of ["first.png", "second.jpg"]) {
    await call("inspect_file", { type: "slice_check", relativePath: "nested/" + name, name, bytes: image, size: image.length });
  }
  const final = await call("finalize_job", { type: "slice_check", relativePaths: ["nested/first.png", "nested/second.jpg"] });
  assert.equal(final.result[0].width, 64);
  assert.equal(final.result[0].height, 64);
  assert.deepEqual(final.result[0].issues, []);
  assert.match(final.result[1].issues[0], /扩展名必须是 \.png/);
  assert.deepEqual(final.result[0].similarNames, ["nested/second.jpg"]);
  assert.match(final.result[0].warnings[0], /疑似重复资源/);
});

