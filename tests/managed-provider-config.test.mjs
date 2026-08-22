import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { parseManagedProviderConfig } from "../desktop/services/managed-provider-config.mjs";
import { ProviderRegistry } from "../desktop/services/provider-registry.mjs";

class EmptyCredentialStore {
  constructor(filePath) {
    this.filePath = filePath;
  }

  isAvailable() { return false; }
  async exists() { return false; }
  async getStatus() { return { configured: false, providers: {} }; }
  async getProviderSecret() { return null; }
  async updateProviderSecret() { return true; }
}

test("托管 CFC 配置只接受百度 HTTPS 地址和合规 Bearer Token", () => {
  const config = parseManagedProviderConfig({
    version: 1,
    baiduCfc: {
      enabled: true,
      endpoint: "https://abc123.cfc-execute.bj.baidubce.com/ngr-assetpilot/translate",
      bearerToken: "A".repeat(48),
    },
  });
  assert.equal(config.baiduCfc.endpoint, "https://abc123.cfc-execute.bj.baidubce.com/ngr-assetpilot/translate");
  assert.throws(() => parseManagedProviderConfig({
    version: 1,
    baiduCfc: {
      enabled: true,
      endpoint: "https://baidubce.com.evil.example/ngr-assetpilot/translate",
      bearerToken: "A".repeat(48),
    },
  }), { code: "MANAGED_PROVIDER_URL_INVALID" });
  assert.throws(() => parseManagedProviderConfig({
    version: 1,
    baiduCfc: {
      enabled: true,
      endpoint: "https://abc123.cfc-execute.bj.baidubce.com/ngr-assetpilot/translate",
      bearerToken: "short",
    },
  }), { code: "MANAGED_PROVIDER_TOKEN_INVALID" });
});

test("托管 CFC Provider 无需用户密钥并且不向渲染层返回 Token", async () => {
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "ngr-managed-provider-"));
  try {
    const token = "B".repeat(48);
    const managedProviderConfig = parseManagedProviderConfig({
      version: 1,
      baiduCfc: {
        enabled: true,
        endpoint: "https://abc123.cfc-execute.bj.baidubce.com/ngr-assetpilot/translate",
        bearerToken: token,
      },
    });
    const registry = new ProviderRegistry({
      credentialStore: new EmptyCredentialStore(path.join(temporaryDirectory, "credentials.v2.json")),
      userDataPath: temporaryDirectory,
      managedProviderConfig,
    });
    await registry.initialize();
    const providers = await registry.list();
    const cfc = providers.find((provider) => provider.id === "baidu-cfc");
    assert.equal(cfc.managed, true);
    assert.equal(cfc.hasSecret, true);
    assert.equal(JSON.stringify(providers).includes(token), false);

    const request = await registry.resolveRequest({
      requestId: "managed-cfc-test-1",
      providerId: "baidu-cfc",
      operation: "translate",
      body: { q: "测试", from: "zh", to: "en" },
    });
    assert.equal(request.method, "POST");
    assert.equal(request.url.href, managedProviderConfig.baiduCfc.endpoint);
    assert.equal(request.headers.authorization, `Bearer ${token}`);
    assert.equal(request.headers["content-type"], "application/json");
    assert.deepEqual(request.body, { q: "测试", from: "zh", to: "en" });
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});
