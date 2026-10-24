import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import AdmZip from "adm-zip";
import { InterfaceFinderExtension, inspectFinderExtension, FINDER_ENTRY } from "../desktop/services/interface-finder-extension.mjs";
import { checkExtensions, extensionReleaseNotes } from "../scripts/check-extensions.mjs";

const digest = (data) => createHash("sha256").update(data).digest("hex");
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ngr-finder-"));
  t.after(() => { assert.equal(path.dirname(root), path.resolve(os.tmpdir())); assert.ok(path.basename(root).startsWith("ngr-finder-")); return fs.rm(root, { recursive: true, force: true }); });
  let selected;
  const make = async (options = {}) => {
    const version = options.version || "0.7.0";
    const files = { "resources/app.asar": Buffer.from(`business-${version}`), "resources/worker/python.exe": Buffer.from("python"), "resources/media-tools/ffmpeg.exe": Buffer.from("media"), ...options.files };
    const manifest = { format: 1, id: "quick-interface-finder", name: "快速找界面", version, hostApi: 1, entry: FINDER_ENTRY, platform: "win32", arch: "x64", files: Object.entries(files).map(([file, data]) => ({ path: file, size: data.length, sha256: digest(data) })), ...options.manifest };
    const zip = new AdmZip();
    const prefix = `quick-interface-finder-${version}/`;
    zip.addFile(`${prefix}extension.json`, Buffer.from(JSON.stringify(manifest)));
    for (const [file, data] of Object.entries(files)) zip.addFile(`${prefix}${file}`, data);
    options.change?.(zip, prefix, manifest);
    selected = path.join(root, `${version}-${Math.random()}.zip`);
    zip.writeZip(selected);
    return selected;
  };
  const service = (options = {}) => new InterfaceFinderExtension({ appDataPath: path.join(root, "Roaming"), userDataPath: path.join(root, "profile"), dialog: { showOpenDialog: async () => ({ canceled: !selected, filePaths: selected ? [selected] : [] }) }, getWindow: () => ({ host: true }), platform: "win32", arch: "x64", ...options });
  return { root, make, service };
}

test("安装扩展 ZIP，重启管理器保留版本与文件；不启动独立 EXE", async (t) => {
  const f = await fixture(t); await f.make({ files: { "resources/使用说明.md": Buffer.from("说明"), "resources/第三方组件说明.md": Buffer.from("许可证") } }); const s = f.service();
  assert.equal((await s.status()).state, "not-found");
  const result = await s.choose();
  assert.equal(result.installed, true); assert.equal(result.bound.version, "0.7.0");
  assert.equal((await f.service().status()).bound.root, result.bound.root);
  assert.equal((await inspectFinderExtension(result.bound.root)).version, "0.7.0");
  assert.equal((await fs.readdir(result.bound.root)).includes("快速找界面.exe"), false);
});

test("升级原子切换，保留旧包、项目资料和缓存；取消不改当前安装", async (t) => {
  const f = await fixture(t); await f.make(); const s = f.service();
  const old = (await s.choose()).bound;
  const sentinel = path.join(f.root, "profile", "extensions-data", "quick-interface-finder", "settings.json");
  await fs.mkdir(path.dirname(sentinel), { recursive: true }); await fs.writeFile(sentinel, "existing-project");
  await f.make({ version: "0.7.1" }); const newer = (await s.choose()).bound;
  assert.notEqual(newer.root, old.root); assert.equal(newer.version, "0.7.1");
  assert.ok(await fs.stat(old.root)); assert.equal(await fs.readFile(sentinel, "utf8"), "existing-project");
  s.dialog.showOpenDialog = async () => ({ canceled: true });
  assert.equal((await s.choose()).bound.root, newer.root);
});

test("损坏或缺失文件拒绝安装，当前可用版本不丢失", async (t) => {
  const f = await fixture(t); await f.make(); const s = f.service(); const old = (await s.choose()).bound;
  await f.make({ version: "0.7.1", change(zip, prefix) { zip.updateFile(`${prefix}resources/app.asar`, Buffer.from("forged-payload")); } });
  await assert.rejects(() => s.choose(), /校验|不一致/);
  assert.equal((await s.status()).progress.state, "error");
  assert.equal((await s.status()).bound.root, old.root);
  assert.deepEqual((await fs.readdir(s.installRoot)).filter((name) => name.startsWith(".install-")), []);
  await f.make({ version: "0.7.1" });
  assert.equal((await s.choose()).progress.state, "complete");
});

test("拒绝错误身份、任意代码入口、旧接口、平台和清单非法路径", async (t) => {
  const f = await fixture(t); const s = f.service();
  for (const manifest of [{ id: "other" }, { entry: "evil.cjs" }, { hostApi: 2 }, { platform: "linux" }, { arch: "arm64" }, { files: [{ path: "../escape", size: 0, sha256: digest("") }] }]) {
    await f.make({ manifest }); await assert.rejects(() => s.choose(), /身份|清单/);
  }
  await assert.rejects(() => s.choose({ path: "arbitrary.zip" }), /原生文件选择/);
  await assert.rejects(() => s.choose({ candidateIndex: 0 }), /原生文件选择/);
});

test("拒绝额外文件、大小写重复、多个根目录和符号链接", async (t) => {
  const f = await fixture(t); const s = f.service();
  const changes = [
    (zip, prefix) => zip.addFile(`${prefix}unexpected.exe`, Buffer.from("x")),
    (zip, prefix) => zip.addFile(`${prefix}RESOURCES/app.asar`, Buffer.from("x")),
    (zip) => zip.addFile("other/file", Buffer.from("x")),
    (zip, prefix) => { const item = zip.getEntry(`${prefix}resources/app.asar`); item.header.attr = (0o120777 << 16) >>> 0; },
  ];
  for (const change of changes) { await f.make({ change }); await assert.rejects(() => s.choose(), /数量|重复|目录|符号/); }
});

test("打开前再次校验哈希，包被篡改时不加载任何代码", async (t) => {
  const f = await fixture(t); await f.make(); let loads = 0;
  const s = f.service({ loadRuntime: () => { loads++; } }); const installed = (await s.choose()).bound;
  const file = path.join(installed.root, "resources/app.asar");
  const data = await fs.readFile(file); data[0] ^= 1; await fs.writeFile(file, data);
  await assert.rejects(() => s.open(), /校验失败/); assert.equal(loads, 0);
});

test("宿主工厂打开一次、连续点击复用窗口、隔离配置，关闭和退出释放运行时", async (t) => {
  const f = await fixture(t); await f.make(); let loads = 0, starts = 0, shows = 0, disposes = 0, runtimeOptions;
  let options;
  const runtime = { start: async () => { starts++; }, show: async () => { shows++; }, dispose: async () => { disposes++; options.onClosed(); }, getWindow: () => ({ isDestroyed: () => false }) };
  const testSession = { dedicated: true };
  const s = f.service({ sessionFactory: () => testSession, loadRuntime: (entry) => {
    loads++; assert.ok(entry.endsWith(path.join("resources/app.asar/desktop/main.cjs")));
    return { createFinderRuntime: (input) => { options = input; runtimeOptions = input; return runtime; } };
  } });
  await s.choose(); const results = await Promise.all([s.open(), s.open()]);
  assert.equal(results[0].launched, true); assert.equal(loads, 1); assert.equal(starts, 1);
  await s.open(); assert.equal(shows, 1);
  assert.equal(runtimeOptions.hosted, true); assert.equal(runtimeOptions.session, testSession);
  assert.equal(runtimeOptions.profileRoot, path.join(f.root, "profile/extensions-data/quick-interface-finder"));
  assert.equal(runtimeOptions.cacheRoot, path.join(f.root, "profile/extensions-cache/quick-interface-finder"));
  assert.equal(runtimeOptions.inheritSettingsFile, path.join(f.root, "Roaming/QuickInterfaceFinder/settings.json"));
  await assert.rejects(() => s.choose(), /关闭.*工作台/);
  await s.dispose(); assert.equal(disposes, 1); await s.dispose(); assert.equal(disposes, 1);
  await assert.rejects(() => s.open(), /关闭/);
});

test("工厂启动错误清理运行时，不影响已安装扩展；无安装时不加载代码", async (t) => {
  const f = await fixture(t); let disposed = 0, loaded = 0;
  const s = f.service({ loadRuntime: () => { loaded++; return { createFinderRuntime: () => ({ start: async () => { throw Error("start-error"); }, show: async () => {}, dispose: async () => { disposed++; }, getWindow: () => null }) }; } });
  assert.equal((await s.open()).launched, false); assert.equal(loaded, 0);
  await f.make(); await s.choose(); await assert.rejects(() => s.open(), /start-error/);
  assert.equal(disposed, 1); assert.equal((await s.status()).state, "ready"); assert.equal(s.runtime, null);
});

test("工作台窗口已关但清理尚未回调时，可安全快速重新打开", async (t) => {
  const f = await fixture(t); await f.make(); let loads = 0, destroyed = false, disposed = 0;
  const s = f.service({ loadRuntime: () => {
    loads++;
    return { createFinderRuntime: (options) => ({
      start: async () => { destroyed = false; }, show: async () => { if (destroyed) throw Error("closed"); },
      dispose: async () => { disposed++; options.onClosed(); }, getWindow: () => ({ isDestroyed: () => destroyed }),
    }) };
  } });
  await s.choose(); await s.open(); destroyed = true;
  assert.equal((await s.open()).launched, true); assert.equal(loads, 2); assert.equal(disposed, 1);
});

test("安装状态目录越界和已安装清单损坏被拒绝", async (t) => {
  const f = await fixture(t); await f.make(); const s = f.service(); const installed = (await s.choose()).bound;
  const pointer = JSON.parse(await fs.readFile(s.bindingFile, "utf8"));
  await fs.writeFile(s.bindingFile, JSON.stringify({ ...pointer, directory: "../other" }));
  assert.equal((await s.status()).state, "invalid");
  await fs.writeFile(s.bindingFile, JSON.stringify(pointer));
  await fs.writeFile(path.join(installed.root, "extension.json"), "{}");
  assert.equal((await s.status()).state, "invalid");
});

test("已安装包中的目录联接不进入校验或执行", async (t) => {
  const f = await fixture(t); await f.make(); const s = f.service(); const installed = (await s.choose()).bound;
  const worker = path.join(installed.root, "resources/worker");
  const stored = path.join(f.root, "worker-original");
  await fs.rename(worker, stored); await fs.symlink(stored, worker, "junction");
  assert.equal((await s.status()).state, "invalid");
  await assert.rejects(() => inspectFinderExtension(installed.root), /符号链接|目录联接/);
});

test("版本检查保留已验证记录，离线不声称公开发布成功", async (t) => {
  const f = await fixture(t); const manifestPath = path.join(f.root, "extensions.json");
  await fs.writeFile(manifestPath, JSON.stringify({ extensions: [{ id: "quick-interface-finder", name: "快速找界面", repository: "907609732/lingtu-interface-finder-releases", verifiedVersion: "0.5.6", downloadUrl: "https://github.com/907609732/lingtu-interface-finder-releases/releases/latest" }] }));
  const report = await checkExtensions({ manifestPath, fetchImpl: async () => { throw Error("offline"); } });
  assert.equal(report.extensions[0].checkState, "unchecked"); assert.equal(report.extensions[0].verifiedVersion, "0.5.6"); assert.match(extensionReleaseNotes(report), /未检查/);
});

test("导入在 worker 中报告真实阶段与计数，忙碌状态轮询不重新扫描安装目录", async (t) => {
  const f = await fixture(t); await f.make({ files: { "resources/worker/large.dll": Buffer.alloc(24 * 1024 * 1024, 37) } });
  const s = f.service(), changes = [];
  const update = s.updateProgress.bind(s), current = s.current.bind(s);
  let busyScans = 0, beats = 0, observedWorker = false, polls = [];
  s.updateProgress = value => { update(value); changes.push({ ...s.progress }); };
  s.current = (...args) => { if (s.worker) busyScans++; return current(...args); };
  const timer = setInterval(() => { beats++; observedWorker ||= Boolean(s.worker?.threadId > 0); polls.push(s.status()); }, 5);
  let result;
  try { result = await s.choose(); } finally { clearInterval(timer); await Promise.all(polls); }
  assert.ok(observedWorker, "CPU-heavy work must own a real Node worker thread");
  assert.ok(beats > 1, "main-thread heartbeat must continue while the worker installs");
  assert.equal(busyScans, 0);
  for (const phase of ["selecting", "reading", "manifest", "extracting", "publishing", "complete"]) assert.ok(changes.some(item => item.phase === phase), phase);
  const extracting = changes.filter(item => item.phase === "extracting");
  assert.ok(extracting.some(item => item.currentFile === "resources/worker/large.dll"));
  assert.ok(extracting.every(item => item.total === 5 && item.bytesTotal > 24 * 1024 * 1024));
  assert.ok(extracting.every(item => item.percent >= 0 && item.percent <= 100));
  assert.equal(result.progress.bytesDone, result.progress.bytesTotal); assert.equal(result.progress.done, 5); assert.equal(result.progress.percent, 100); assert.equal(result.progress.active, false);
  assert.ok(changes.every((item, index) => !index || item.revision > changes[index - 1].revision));
});

test("关闭管理器终止正在导入的 worker，旧版本指针保持完整", async (t) => {
  const f = await fixture(t); await f.make(); const s = f.service(); await s.choose();
  const before = await fs.readFile(s.bindingFile, "utf8");
  await f.make({ version: "0.7.1", files: { "resources/worker/large.dll": Buffer.alloc(32 * 1024 * 1024, 51) } });
  const pending = s.choose(), rejected = assert.rejects(pending, /停止|关闭/);
  for (let attempt = 0; !s.worker && attempt < 200; attempt++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.ok(s.worker, "worker must start before shutdown is tested");
  const worker = s.worker;
  await s.dispose(); await rejected;
  assert.equal(worker.threadId, -1); assert.equal(s.worker, null); assert.equal(s.progress.active, false); assert.equal(s.progress.state, "cancelled");
  assert.equal(await fs.readFile(s.bindingFile, "utf8"), before);
  assert.deepEqual((await fs.readdir(s.installRoot)).filter(name => name.startsWith(".install-") || name.startsWith(".current-")), []);
});

test("打开工作台的全包哈希校验也报告真实进度，加载阶段使用等待状态", async (t) => {
  const f = await fixture(t); await f.make({ files: { "resources/worker/large.dll": Buffer.alloc(8 * 1024 * 1024, 64) } });
  const s = f.service({ loadRuntime: () => ({ createFinderRuntime: () => ({ start: async () => {}, show: async () => {}, dispose: async () => {}, getWindow: () => ({ isDestroyed: () => false }) }) }) });
  await s.choose(); const changes = [], update = s.updateProgress.bind(s);
  s.updateProgress = value => { update(value); changes.push({ ...s.progress }); };
  const result = await s.open();
  assert.equal(result.launched, true); assert.equal(result.progress.operation, "open");
  assert.ok(changes.some(item => item.phase === "verifying" && item.percent === 100 && item.bytesDone === item.bytesTotal));
  assert.ok(changes.some(item => item.phase === "loading" && item.indeterminate && item.percent === null));
  await s.dispose();
});

test("清单大小写变体不发布为可用安装，旧指针不变", async (t) => {
  const f = await fixture(t); await f.make(); const s = f.service(); await s.choose();
  const before = await fs.readFile(s.bindingFile, "utf8");
  await f.make({ version: "0.7.1", change(zip, prefix) { const raw = zip.readFile(`${prefix}extension.json`); zip.deleteFile(`${prefix}extension.json`); zip.addFile(`${prefix}EXTENSION.JSON`, raw); } });
  await assert.rejects(s.choose(), /extension.json/);
  assert.equal(await fs.readFile(s.bindingFile, "utf8"), before);
});

test("空闲状态只读安装元信息，不遍历载荷；打开前仍完整拒绝未登记文件", async (t) => {
  const f = await fixture(t); await f.make(); let loads = 0;
  const s = f.service({ loadRuntime: () => { loads++; } }); const installed = (await s.choose()).bound;
  const extra = path.join(installed.root, "resources/worker/deep/unregistered.bin");
  await fs.mkdir(path.dirname(extra), { recursive: true }); await fs.writeFile(extra, "unregistered");
  // A payload walk here would reject the unexpected file. Status deliberately
  // reports installed metadata; only the full worker check grants code loading.
  assert.equal((await s.status()).state, "ready");
  assert.equal((await s.current()).version, installed.version);
  await assert.rejects(s.open(), /数量|未登记/); assert.equal(loads, 0);
});


test("未公开的扩展仅链接项目页，不能把旧独立版标成扩展下载", () => {
  const report = { extensions: [{ name: "快速找界面", verifiedVersion: "0.7.0", publishedVersion: "0.5.7", checkState: "checked", message: "版本不同", publicDownloadAvailable: false, downloadUrl: "https://github.com/907609732/lingtu-interface-finder-releases/releases/latest" }] };
  const notes = extensionReleaseNotes(report);
  assert.match(notes, /尚未公开下载/);
  assert.match(notes, /旧独立版不能导入/);
  assert.match(notes, /\[项目发布页\]/);
  assert.doesNotMatch(notes, /\[下载扩展\]/);
  report.extensions[0].publicDownloadAvailable = true;
  assert.match(extensionReleaseNotes(report), /\[下载扩展\]/);
});
