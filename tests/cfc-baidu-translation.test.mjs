import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const cfcModule = require("../infra/cfc/baidu-translation/index.js");
const { handle } = cfcModule.__test;

test("CFC 使用环境变量签名调用百度翻译并返回兼容结果", async () => {
  const previousFetch = globalThis.fetch;
  const previousAppId = process.env.BAIDU_TRANSLATE_APP_ID;
  const previousSecret = process.env.BAIDU_TRANSLATE_SECRET;
  process.env.BAIDU_TRANSLATE_APP_ID = "test-app-id";
  process.env.BAIDU_TRANSLATE_SECRET = "test-app-secret";
  let captured = null;
  globalThis.fetch = async (url, options) => {
    captured = { url, options };
    return {
      ok: true,
      status: 200,
      async json() {
        return { from: "zh", to: "en", trans_result: [{ src: "托管测试", dst: "Managed test" }] };
      },
    };
  };
  try {
    const result = await handle({
      httpMethod: "POST",
      body: JSON.stringify({ q: "托管测试", from: "zh", to: "en" }),
      isBase64Encoded: false,
      requestContext: { requestId: "cfc-handler-test-1", sourceIp: "192.0.2.10" },
    });
    assert.equal(result.statusCode, 200);
    assert.deepEqual(JSON.parse(result.body).trans_result, [{ src: "托管测试", dst: "Managed test" }]);
    assert.equal(captured.url, "https://fanyi-api.baidu.com/api/trans/vip/translate");
    assert.equal(captured.options.method, "POST");
    const payload = new URLSearchParams(captured.options.body);
    assert.equal(payload.get("appid"), "test-app-id");
    assert.equal(payload.get("q"), "托管测试");
    assert.match(payload.get("sign"), /^[a-f0-9]{32}$/);
    assert.equal(captured.options.body.includes("test-app-secret"), false);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousAppId === undefined) delete process.env.BAIDU_TRANSLATE_APP_ID;
    else process.env.BAIDU_TRANSLATE_APP_ID = previousAppId;
    if (previousSecret === undefined) delete process.env.BAIDU_TRANSLATE_SECRET;
    else process.env.BAIDU_TRANSLATE_SECRET = previousSecret;
  }
});

test("CFC 健康检查不泄露密钥，且拒绝超长翻译文本", async () => {
  const previousAppId = process.env.BAIDU_TRANSLATE_APP_ID;
  const previousSecret = process.env.BAIDU_TRANSLATE_SECRET;
  process.env.BAIDU_TRANSLATE_APP_ID = "health-app-id";
  process.env.BAIDU_TRANSLATE_SECRET = "health-secret";
  try {
    const health = await handle({ httpMethod: "GET", requestContext: { requestId: "health-1" } });
    assert.equal(health.statusCode, 200);
    const healthPayload = JSON.parse(health.body);
    assert.deepEqual(healthPayload, { ok: true, service: "ngr-baidu-translation", configured: true });
    assert.equal(health.body.includes("health-secret"), false);

    const invalid = await handle({
      httpMethod: "POST",
      body: JSON.stringify({ q: "中".repeat(201), from: "zh", to: "en" }),
      requestContext: { sourceIp: "192.0.2.11" },
    });
    assert.equal(invalid.statusCode, 400);
    assert.match(JSON.parse(invalid.body).error, /1-200/);
  } finally {
    if (previousAppId === undefined) delete process.env.BAIDU_TRANSLATE_APP_ID;
    else process.env.BAIDU_TRANSLATE_APP_ID = previousAppId;
    if (previousSecret === undefined) delete process.env.BAIDU_TRANSLATE_SECRET;
    else process.env.BAIDU_TRANSLATE_SECRET = previousSecret;
  }
});
