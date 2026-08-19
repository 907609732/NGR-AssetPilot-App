import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const vendorModule = { exports: {} };
const vendorSource = fs.readFileSync(new URL("../app/vendor/fflate-0.8.3.min.js", import.meta.url), "utf8");
Function("module", "exports", "require", vendorSource)(vendorModule, vendorModule.exports, () => { throw new Error("unexpected require"); });
const fflate = vendorModule.exports;
await import("../app/js/workspace-backup.js");

const backup = globalThis.NgrWorkspaceBackup;
const password = "correct-horse-battery-staple";
const secretPayload = {
  ai: { apiKey: "unit-test-ai-secret" },
  translation: {
    baiduAppId: "unit-test-app-id",
    baiduSecret: "unit-test-translation-secret",
    textApiKey: "unit-test-model-secret",
  },
};

function sampleWorkspace() {
  return {
    key: "default",
    schemaVersion: 1,
    appVersion: "V3.0.0",
    savedAt: 1770000000000,
    activeNamingSessionId: "session-1",
    sessions: [{
      id: "session-1",
      name: "测试记录",
      referenceName: "reference.png",
      assets: [{ id: "asset-1", name: "source.png", extension: ".png" }],
    }],
  };
}

function sampleSettings() {
  return {
    schemaVersion: 1,
    appVersion: "V3.0.0",
    entries: {
      "ngr-ai-autoname-ai-settings": JSON.stringify({ provider: "kimi", apiKey: "" }),
      "ngr-ai-autoname-translation-settings": JSON.stringify({ provider: "baidu", baiduSecret: "" }),
    },
  };
}

function sampleFiles() {
  return [
    {
      path: "files/assets/000001-source.png",
      key: "asset:session-1:asset-1",
      workspaceKey: "default",
      sessionId: "session-1",
      assetId: "asset-1",
      kind: "asset",
      name: "source.png",
      type: "image/png",
      lastModified: 1770000000000,
      data: new Uint8Array([1, 2, 3, 4]),
    },
    {
      path: "files/references/000002-reference.png",
      key: "reference:session-1",
      workspaceKey: "default",
      sessionId: "session-1",
      kind: "reference",
      name: "reference.png",
      type: "image/png",
      lastModified: 1770000000001,
      data: new Uint8Array([9, 8, 7]),
    },
  ];
}

test("PBKDF2 600000 + AES-256-GCM 能往返加密凭据", async () => {
  const encrypted = await backup.encryptSecrets(secretPayload, password, { createdAt: "2026-08-19T00:00:00.000Z" });
  const block = JSON.parse(new TextDecoder().decode(encrypted));
  assert.equal(block.kdf.algorithm, "PBKDF2");
  assert.equal(block.kdf.hash, "SHA-256");
  assert.equal(block.kdf.iterations, 600000);
  assert.equal(block.cipher.algorithm, "AES-256-GCM");
  assert.equal(Buffer.from(encrypted).includes(Buffer.from(secretPayload.ai.apiKey)), false);
  assert.deepEqual(await backup.decryptSecrets(encrypted, password), secretPayload);
});

test("迁移密码不足 12 位或错误时拒绝解密", async () => {
  await assert.rejects(() => backup.encryptSecrets(secretPayload, "too-short"), { code: "PASSWORD_TOO_SHORT" });
  const encrypted = await backup.encryptSecrets(secretPayload, password);
  await assert.rejects(() => backup.decryptSecrets(encrypted, "wrong-password-123"), { code: "DECRYPTION_FAILED" });
});

test(".ngrap 可完整往返 manifest/settings/workspace/files/secrets.enc", async () => {
  const archive = await backup.buildArchive({
    settings: sampleSettings(),
    workspace: sampleWorkspace(),
    files: sampleFiles(),
    secrets: secretPayload,
  }, {
    password,
    appVersion: "V3.0.0",
    createdAt: "2026-08-19T00:00:00.000Z",
    fflate,
  });

  assert.equal(archive.manifest.includesSecrets, true);
  assert.equal(Buffer.from(archive.bytes).includes(Buffer.from(secretPayload.ai.apiKey)), false);
  const parsed = await backup.parseArchive(archive.bytes, { password, fflate });
  assert.deepEqual(parsed.settings, sampleSettings());
  assert.deepEqual(parsed.workspace, sampleWorkspace());
  assert.deepEqual(parsed.secrets, secretPayload);
  assert.deepEqual([...parsed.files[0].data], [1, 2, 3, 4]);
  assert.deepEqual([...parsed.files[1].data], [9, 8, 7]);
});

test("不含凭据的迁移包无需密码，篡改条目会被 SHA-256 拒绝", async () => {
  const archive = await backup.buildArchive({
    settings: sampleSettings(),
    workspace: sampleWorkspace(),
    files: sampleFiles(),
  }, { appVersion: "V3.0.0", fflate });
  const parsed = await backup.parseArchive(archive.bytes, { fflate });
  assert.equal(parsed.secrets, null);
  assert.equal(parsed.manifest.includesSecrets, false);

  const entries = fflate.unzipSync(archive.bytes);
  entries["settings.json"] = new TextEncoder().encode('{"schemaVersion":1,"entries":{}}');
  const tampered = fflate.zipSync(entries, { level: 0 });
  await assert.rejects(() => backup.parseArchive(tampered, { fflate }), { code: "INTEGRITY_CHECK_FAILED" });
});

test("创建迁移包时拒绝目录穿越路径", async () => {
  const files = sampleFiles();
  files[0].path = "files/../outside.bin";
  await assert.rejects(() => backup.buildArchive({
    settings: sampleSettings(),
    workspace: sampleWorkspace(),
    files,
  }, { fflate }), { code: "UNSAFE_ARCHIVE_PATH" });
});

test(".ngrap 可校验并往返 10,000 条素材元数据", { timeout: 60_000 }, async () => {
  const itemCount = 10_000;
  const assets = Array.from({ length: itemCount }, (_value, index) => ({
    id: `asset-${index}`,
    name: `source-${index}.png`,
    extension: ".png",
  }));
  const files = assets.map((asset, index) => ({
    path: `files/assets/${String(index).padStart(5, "0")}.png`,
    key: `asset:session-large:${asset.id}`,
    workspaceKey: "default",
    sessionId: "session-large",
    assetId: asset.id,
    kind: "asset",
    name: asset.name,
    type: "image/png",
    lastModified: 1770000000000 + index,
    data: new Uint8Array([index & 0xff]),
  }));
  const workspace = {
    key: "default",
    schemaVersion: 1,
    appVersion: "V3.0.0",
    savedAt: 1770000000000,
    activeNamingSessionId: "session-large",
    sessions: [{ id: "session-large", name: "10k", assets }],
  };

  const archive = await backup.buildArchive({ settings: sampleSettings(), workspace, files }, { fflate });
  const parsed = await backup.parseArchive(archive.bytes, { fflate });
  assert.equal(parsed.workspace.sessions[0].assets.length, itemCount);
  assert.equal(parsed.files.length, itemCount);
  assert.equal(parsed.manifest.entries.length, itemCount + 2);
});
