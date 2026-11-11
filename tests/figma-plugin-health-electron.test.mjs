import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("Figma 插件检测逐项失败即提示，支持重测、取消与关闭后重开", { timeout: 45_000 }, async () => {
  const runRoot = fs.mkdtempSync(path.join(projectRoot, ".tmp", "figma-health-"));
  const app = await electron.launch({
    args: [projectRoot],
    cwd: projectRoot,
    env: {
      ...process.env,
      APPDATA: path.join(runRoot, "Roaming"),
      LOCALAPPDATA: path.join(runRoot, "Local"),
      NGR_E2E_USER_DATA: path.join(runRoot, "UserData"),
      ELECTRON_ENABLE_LOGGING: "0",
    },
  });
  try {
    await app.evaluate(({ session }) => {
      globalThis.figmaHealthTest = { failHost: "service.arthub.qq.com", delayMs: 600, requests: [] };
      for (const [ses, route] of [
        [session.defaultSession, "system"],
        [session.fromPartition("ngr-network-diagnostics-direct", { cache: false }), "direct"],
      ]) {
        ses.resolveHost = async () => ({ endpoints: [{ address: "93.184.216.34", family: "ipv4" }] });
        ses.resolveProxy = async () => "DIRECT";
        ses.fetch = async (url, options) => {
          const state = globalThis.figmaHealthTest;
          state.requests.push({ url, method: options.method, credentials: options.credentials, route });
          if (new URL(url).hostname === state.failHost) throw new Error("net::ERR_CONNECTION_REFUSED");
          await new Promise((resolve, reject) => {
            const abort = () => { clearTimeout(timer); reject(new DOMException("aborted", "AbortError")); };
            const timer = setTimeout(() => { options.signal.removeEventListener("abort", abort); resolve(); }, state.delayMs);
            options.signal.addEventListener("abort", abort, { once: true });
            if (options.signal.aborted) abort();
          });
          return new Response(null, { status: new URL(url).hostname === "api.figma.com" ? 403 : 204 });
        };
      }
    });
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    await page.locator("#moreFeaturesEntry").click();
    await page.locator("#figmaPluginHealthEntry").click();
    const dialog = page.locator("#figmaPluginHealthDialog");
    const run = page.locator("#figmaPluginHealthRun");
    const warning = page.locator("#figmaPluginHealthWarning");
    await dialog.waitFor();
    await run.click();
    await warning.waitFor();
    assert.equal(await warning.innerText(), "你的Figma插件无法正常使用，因为基地的网络有被限制了");
    assert.equal(await run.isDisabled(), true);
    await run.waitFor({ state: "visible" });
    await page.waitForFunction(() => !document.querySelector("#figmaPluginHealthRun").disabled);
    assert.match(await page.locator("#figmaPluginHealthResults").innerText(), /连接失败/);
    assert.match(await page.locator("#figmaPluginHealthResults").innerText(), /ERR_CONNECTION_REFUSED/);
    await page.screenshot({ path: path.join(projectRoot, ".tmp", "figma-plugin-health-failure.png") });

    await app.evaluate(() => { globalThis.figmaHealthTest.failHost = ""; globalThis.figmaHealthTest.delayMs = 0; });
    await run.click();
    await page.waitForFunction(() => !document.querySelector("#figmaPluginHealthRun").disabled);
    assert.equal(await warning.isVisible(), false);
    assert.match(await page.locator("#figmaPluginHealthResults").innerText(), /403/);
    const requests = await app.evaluate(() => globalThis.figmaHealthTest.requests.slice(-5));
    assert.deepEqual(new Set(requests.map(({ url }) => url)), new Set([
      "https://service.arthub.qq.com/", "https://service.arthub.woa.com/", "http://localhost:31700/",
      "https://api.figma.com/v1/me", "https://www.figma.com/",
    ]));
    assert.ok(requests.every(({ credentials }) => credentials === "omit"));
    assert.equal(requests.find(({ url }) => url.startsWith("http://localhost:")).route, "direct");

    await app.evaluate(() => { globalThis.figmaHealthTest.delayMs = 2000; });
    await run.click();
    await page.locator("#figmaPluginHealthCancel").click();
    await page.waitForFunction(() => !document.querySelector("#figmaPluginHealthRun").disabled);
    assert.equal(await warning.isVisible(), false);
    assert.match(await page.locator("#figmaPluginHealthResults").innerText(), /已取消/);

    await run.click();
    await page.locator("#figmaPluginHealthClose").click();
    await page.locator("#moreFeaturesEntry").click();
    await page.locator("#figmaPluginHealthEntry").click();
    await dialog.waitFor();
    assert.equal(await warning.isVisible(), false);
    assert.match(await page.locator("#figmaPluginHealthResults").innerText(), /待检测/);
    await app.evaluate(() => { globalThis.figmaHealthTest.delayMs = 0; });
    await run.click();
    await page.waitForFunction(() => !document.querySelector("#figmaPluginHealthRun").disabled);
    assert.equal(await warning.isVisible(), false);
  } finally {
    await app.close();
  }
});
