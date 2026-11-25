import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { createLocalAssetTools } from "../desktop/services/local-asset-tools.mjs";

async function setup(t, options = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "ngr-local-assets-test-"));
  const source = path.join(root, "source");
  const output = path.join(root, "output");
  await mkdir(source);
  await mkdir(output);
  await mkdir(path.join(source, "nested"));
  await writeFile(path.join(source, "nested", "icon.png"), "source asset");
  await writeFile(path.join(source, "label.png"), "other asset");
  const linked = path.join(source, "linked");
  await symlink(output, linked, process.platform === "win32" ? "junction" : "dir");
  await writeFile(path.join(output, "outside.png"), "private asset");

  const dialogCalls = [];
  const rendererCalls = [];
  const dialog = {
    async showOpenDialog(_window, request) {
      dialogCalls.push(request);
      await options.beforePickerReturns?.(request);
      return { canceled: false, filePaths: request.title.includes("导出")
        ? [options.selectSourceForExport ? source : output]
        : request.properties.includes("openFile") ? [path.join(source, "label.png")] : [source] };
    },
    async showMessageBox(_window, request) {
      dialogCalls.push(request);
      return { response: options.approveAi ? 1 : 0 };
    },
  };
  const adapter = createLocalAssetTools({
    dialog,
    getWindow: () => ({ isDestroyed: () => false }),
    async runRenderer(action, payload, context) {
      rendererCalls.push({ action, payload });
      if (action === "prepare_naming") return { provider: { name: "Configured AI", endpoint: "https://example.com/v1", model: "vision-model" } };
      if (action === "prepare_slice_check") return { profileName: "NGR" };
      if (action === "inspect_file") {
        if (options.inspectFile) return options.inspectFile(payload, context);
        if (payload.type === "naming") return { status: "done" };
        return { status: "done" };
      }
      if (action === "finalize_job") return payload.relativePaths.map((relativePath, index) => payload.type === "naming"
        ? { relativePath, recommendations: ["Named"], proposedName: "Named_" + index + ".png", projectFolder: "Project", status: "done" }
        : { relativePath, width: 64, height: 64, format: "PNG", issues: [], warnings: [], similarNames: [] });
      assert.equal(action, "release_job");
    },
  });
  t.after(async () => {
    adapter.dispose();
    await rm(root, { recursive: true, force: true });
  });
  return { adapter, source, output, dialogCalls, rendererCalls };
}

async function waitForJob(adapter, jobId) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const job = await adapter.invoke("get_asset_job", { jobId });
    if (["completed", "failed", "cancelled"].includes(job.status)) return job;
    await delay(10);
  }
  assert.fail("job did not settle");
}

test("native source grants expose only snapshotted relative paths and reject traversal", async (t) => {
  const { adapter, source, rendererCalls } = await setup(t);
  const grantTool = adapter.tools.find(({ name }) => name === "grant_sources");
  const { sources: [grant] } = await grantTool.run({ kind: "directory" });
  assert.equal(grant.name, "source");
  assert.equal(grant.fileCount, 2);
  assert.ok(grant.sourceId);
  const listing = await adapter.invoke("list_sources", { sourceId: grant.sourceId, limit: 1 });
  assert.equal(listing.total, 2);
  assert.deepEqual(listing.files, [{ relativePath: "label.png", size: 11 }]);
  assert.ok(!JSON.stringify(listing).includes(source));
  await assert.rejects(adapter.invoke("start_slice_check", {
    sourceId: grant.sourceId,
    relativePaths: ["linked/outside.png"],
  }));
  await assert.rejects(adapter.invoke("start_slice_check", {
    sourceId: grant.sourceId,
    relativePaths: ["../output/outside.png"],
  }));
  assert.deepEqual(rendererCalls, []);
  const { sources: [filesGrant] } = await adapter.invoke("grant_sources", { kind: "files" });
  assert.equal(filesGrant.fileCount, 1);
  assert.ok(adapter.tools.every(({ inputSchema }) => inputSchema.type === "object"));
});

test("AI naming reads images only after native provider approval", async (t) => {
  const { adapter, rendererCalls, dialogCalls } = await setup(t);
  const { sources: [grant] } = await adapter.invoke("grant_sources", { kind: "directory" });
  const job = await adapter.invoke("start_naming", { sourceId: grant.sourceId, mode: "ai" });
  const result = await waitForJob(adapter, job.jobId);
  assert.equal(result.status, "cancelled");
  assert.equal(rendererCalls.some(({ action }) => action === "inspect_file"), false);
  assert.match(dialogCalls[1].detail, /example\.com/);
  assert.match(dialogCalls[1].detail, /vision-model/);
});

test("approved naming exports byte-identical copies from retained inputs only", async (t) => {
  const { adapter, source, rendererCalls, dialogCalls } = await setup(t, { approveAi: true, selectSourceForExport: true });
  const { sources: [grant] } = await adapter.invoke("grant_sources", { kind: "directory" });
  const started = await adapter.invoke("start_naming", { sourceId: grant.sourceId, mode: "ai" });
  const job = await waitForJob(adapter, started.jobId);
  assert.equal(job.status, "completed");
  assert.deepEqual(job.results.map(({ proposedName }) => proposedName), ["Named_0.png", "Named_1.png"]);
  assert.equal(rendererCalls.filter(({ action }) => action === "inspect_file").length, 2);

  await assert.rejects(adapter.invoke("export_named_copies", { jobId: job.jobId, edits: [{ relativePath: "label.png", name: "../changed.png" }] }));
  await assert.rejects(adapter.invoke("export_named_copies", { jobId: job.jobId, edits: [{ relativePath: "label.png", name: "changed.jpg" }] }));
  assert.equal(dialogCalls.length, 2);
  await writeFile(path.join(source, "label.png"), "replacement");
  const copied = await adapter.invoke("export_named_copies", {
    jobId: job.jobId,
    edits: [{ relativePath: "nested/icon.png", name: "Edited.png" }],
  });
  assert.equal(copied.files[0].status, "failed");
  assert.equal(copied.files[1].status, "copied");
  assert.match(copied.files[1].exportPath, /\/Project\/Edited\.png$/);
  assert.equal(await readFile(path.join(source, copied.files[1].exportPath), "utf8"), "source asset");
  assert.equal(await readFile(path.join(source, "nested", "icon.png"), "utf8"), "source asset");
  assert.equal(await readFile(path.join(source, "label.png"), "utf8"), "replacement");
});

test("duplicate edited names are rejected before choosing an export folder", async (t) => {
  const { adapter, output, dialogCalls } = await setup(t);
  const { sources: [grant] } = await adapter.invoke("grant_sources", { kind: "directory" });
  const started = await adapter.invoke("start_naming", { sourceId: grant.sourceId });
  const job = await waitForJob(adapter, started.jobId);
  await assert.rejects(adapter.invoke("export_named_copies", {
    jobId: job.jobId,
    edits: [{ relativePath: "label.png", name: "Edited.png" }, { relativePath: "nested/icon.png", name: "EDITED.png" }],
  }));
  assert.equal(dialogCalls.length, 1);
  assert.deepEqual(await readdir(output), ["outside.png"]);
});

test("slice check catches replaced intermediate paths and cancels an active renderer request", async (t) => {
  let inspectionStarted;
  const inspectionReady = new Promise((resolve) => { inspectionStarted = resolve; });
  const { adapter, source, output } = await setup(t, {
    async inspectFile(_payload, { signal }) {
      inspectionStarted();
      await delay(5000, undefined, { signal });
      return { status: "done" };
    },
  });
  const { sources: [grant] } = await adapter.invoke("grant_sources", { kind: "directory" });
  await rm(path.join(source, "nested"), { recursive: true });
  await symlink(output, path.join(source, "nested"), process.platform === "win32" ? "junction" : "dir");
  const started = await adapter.invoke("start_slice_check", { sourceId: grant.sourceId, relativePaths: ["nested/icon.png", "label.png"] });
  await inspectionReady;
  const cancelled = await adapter.invoke("cancel_asset_job", { jobId: started.jobId });
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.results[0].relativePath, "nested/icon.png");
  assert.ok(cancelled.results[0].issues.length);
  const job = await waitForJob(adapter, started.jobId);
  assert.equal(job.status, "cancelled");
});

test("an aborted picker grants no files and writes no copies", async (t) => {
  const controller = new AbortController();
  const { adapter, output } = await setup(t, {
    beforePickerReturns(request) {
      if (request.title.includes("导出")) controller.abort();
    },
  });
  const stopped = new AbortController();
  stopped.abort();
  await assert.rejects(adapter.invoke("grant_sources", { kind: "directory" }, { signal: stopped.signal }), { name: "AbortError" });
  assert.deepEqual((await adapter.invoke("list_sources")).sources, []);
  const { sources: [grant] } = await adapter.invoke("grant_sources", { kind: "directory" });
  const started = await adapter.invoke("start_naming", { sourceId: grant.sourceId });
  const job = await waitForJob(adapter, started.jobId);
  await assert.rejects(adapter.invoke("export_named_copies", { jobId: job.jobId }, { signal: controller.signal }), { name: "AbortError" });
  assert.deepEqual(await readdir(output), ["outside.png"]);
});

test("reset invalidates an outstanding native source selection and permits a fresh selection", async (t) => {
  let pendingPicker;
  const { adapter } = await setup(t, {
    async beforePickerReturns() {
      await pendingPicker;
    },
  });
  let resolve;
  pendingPicker = new Promise((done) => { resolve = done; });
  const originalGrant = adapter.invoke("grant_sources", { kind: "directory" });
  adapter.reset();
  resolve();
  await assert.rejects(originalGrant, { name: "AbortError" });
  assert.deepEqual((await adapter.invoke("list_sources")).sources, []);
  const { sources } = await adapter.invoke("grant_sources", { kind: "directory" });
  assert.equal(sources.length, 1);
});

