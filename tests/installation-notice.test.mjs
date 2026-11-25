import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { InstallationNotice } from "../desktop/services/installation-notice.mjs";

async function fixture(t, enabled = true) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ngr-installation-notice-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const resourcesPath = path.join(root, "resources");
  const userDataPath = path.join(root, "profile");
  await Promise.all([fs.mkdir(resourcesPath), fs.mkdir(userDataPath)]);
  return {
    notice: new InstallationNotice({ enabled, resourcesPath, userDataPath, version: "3.0.26" }),
    mark: (text, encoding = "utf8") => fs.writeFile(path.join(resourcesPath, "installation-event.ini"), text, encoding),
    notes: text => fs.writeFile(path.join(resourcesPath, "installation-release-notes.md"), text),
  };
}

const event = ({ id = "install-001", kind = "first", version = "3.0.26", previousVersion = "" } = {}) =>
  `[installation]\r\nid=${id}\r\nkind=${kind}\r\nversion=${version}\r\npreviousVersion=${previousVersion}\r\n`;

test("first installation is presented once after the renderer acknowledges it", async t => {
  const { notice, mark } = await fixture(t);
  assert.equal(await notice.get(), null);
  await mark(event());
  assert.deepEqual(await notice.get(), {
    id: "install-001", kind: "first", version: "3.0.26", previousVersion: null, notes: "",
  });
  assert.equal(await notice.acknowledge("other-installation"), false);
  assert.ok(await notice.get());
  assert.equal(await notice.acknowledge("install-001"), true);
  assert.equal(await notice.get(), null);
});

test("an upgrade and each same-version overwrite use the bundled notes", async t => {
  const { notice, mark, notes } = await fixture(t);
  await notes("# V3.0.26\n\n- 新增安装后更新说明");
  await mark("\uFEFF" + event({ kind: "update", previousVersion: "3.0.25" }), "utf16le");
  assert.deepEqual(await notice.get(), {
    id: "install-001", kind: "update", version: "3.0.26", previousVersion: "3.0.25",
    notes: "# V3.0.26\n\n- 新增安装后更新说明",
  });
  await notice.acknowledge("install-001");
  await mark(event({ id: "install-002", kind: "reinstall", previousVersion: "3.0.26" }));
  assert.equal(await notice.get().then(value => value.kind), "reinstall");
  await notice.acknowledge("install-002");
  await mark(event({ id: "install-003", kind: "reinstall", previousVersion: "3.0.26" }));
  assert.equal(await notice.get().then(value => value.id), "install-003");
});

test("unrelated versions, malformed markers, and non-installed builds do not prompt", async t => {
  const { notice, mark } = await fixture(t);
  for (const marker of [
    event({ version: "3.0.25" }),
    event({ kind: "unexpected" }),
    "[other]\nid=install-001\nkind=first\nversion=3.0.26",
  ]) {
    await mark(marker);
    assert.equal(await notice.get(), null);
  }
  const source = await fixture(t, false);
  await source.mark(event());
  assert.equal(await source.notice.get(), null);
});
