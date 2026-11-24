import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { InterfaceFinderExtension } from "../desktop/services/interface-finder-extension.mjs";
import { createBundledFinder } from "../desktop/services/finder-builtin.mjs";

test("the bundled Finder takes precedence over an imported extension", async () => {
  const bundled = { version: "0.7.5", root: "bundled" };
  const finder = new InterfaceFinderExtension({ appDataPath: ".", bundledFinder: async () => bundled });
  finder.current = async () => ({ version: "0.7.0", root: "imported" });
  assert.equal((await finder.status()).bound, bundled);
});

test("the bundled Finder verifies archive contents before loading", {
  skip: process.platform !== "win32" || process.arch !== "x64",
}, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ngr-bundled-finder-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const resource = path.join(root, "resources");
  await fs.mkdir(resource);
  const archive = path.join(resource, "app.asar");
  await fs.writeFile(archive, "trusted");
  const sha256 = createHash("sha256").update("trusted").digest("hex");
  const finder = createBundledFinder(root, { version: "0.7.5", bytes: 7, sha256 });
  assert.equal((await finder({ verify: true })).builtin, true);
  await fs.writeFile(archive, "changed");
  await assert.rejects(finder({ verify: true }), /校验失败/);
});
