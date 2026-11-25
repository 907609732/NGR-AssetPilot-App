import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { LocalToolsServer } from "../desktop/services/local-tools-server.mjs";

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ngr-local-tools-"));
  await fs.writeFile(path.join(root, "index.html"), "<title>Local tools</title>");
  const server = new LocalToolsServer({
    port: 0,
    webRoot: root,
    assets: {
      tools: [{
        name: "start_slice_check",
        description: "Check slices",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        run: async () => ({ state: "queued" }),
      }],
      invoke: async method => ({ method }),
    },
    getFinder: async () => null,
  });
  t.after(async () => {
    await server.dispose();
    await fs.rm(root, { recursive: true, force: true });
  });
  return server;
}

test("browser uses single-use pairing, same-origin POST, and revocable sessions", async t => {
  const server = await fixture(t);
  assert.equal(server.status().webEnabled, false);
  await server.setEnabled("web", true);
  const open = new URL(server.browserLink());
  const ticket = new URLSearchParams(open.hash.slice(1)).get("ticket");
  const post = (url, body, headers = {}) => fetch(new URL(url, open.origin), {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: open.origin, ...headers },
    body: JSON.stringify(body),
  });
  assert.equal((await fetch(open.origin)).status, 200);
  assert.equal((await post("/api/assets", { method: "list_sources" })).status, 401);
  const pair = await post("/api/pair", { ticket });
  assert.equal(pair.status, 200);
  const cookie = pair.headers.get("Set-Cookie").split(";")[0];
  assert.match(pair.headers.get("Set-Cookie"), /HttpOnly; SameSite=Strict/);
  assert.equal((await post("/api/pair", { ticket })).status, 401);
  assert.equal((await post("/api/assets", {}, { Cookie: cookie, Origin: "http://other.test" })).status, 403);
  assert.deepEqual(await (await post("/api/assets", { method: "list_sources" }, { Cookie: cookie })).json(),
    { result: { method: "list_sources" } });
  await server.setEnabled("mcp", true);
  await server.setEnabled("web", false);
  assert.equal((await post("/api/assets", { method: "list_sources" }, { Cookie: cookie })).status, 404);
  assert.equal(server.status().mcpEnabled, true);
});

test("standard MCP client lists and calls authenticated tools and old tokens are rejected", async t => {
  const server = await fixture(t);
  await server.setEnabled("mcp", true);
  const url = new URL(server.status().mcpUrl);
  const token = server.getToken();
  const connect = async bearer => {
    const client = new Client({ name: "ngr-smoke", version: "1" });
    try {
      await client.connect(new StreamableHTTPClientTransport(url, {
        requestInit: { headers: { Authorization: `Bearer ${bearer}` } },
      }));
      return client;
    } catch (error) {
      await client.close();
      throw error;
    }
  };
  await assert.rejects(connect("bad"));
  const client = await connect(token);
  try {
    assert.equal((await client.listTools()).tools[0].name, "start_slice_check");
    assert.deepEqual((await client.callTool({ name: "start_slice_check", arguments: {} })).structuredContent,
      { state: "queued" });
    assert.equal((await client.callTool({ name: "start_slice_check", arguments: { unknown: true } })).isError, true);
  } finally {
    await client.close();
  }
  server.rotateToken();
  await assert.rejects(connect(token));
});
