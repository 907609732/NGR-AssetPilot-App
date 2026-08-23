import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = fs.readFileSync(path.join(projectRoot, "app", "js", "updates.js"), "utf8");
const fakeWindow = { addEventListener() {} };
new Function("window", "APP_VERSION", source)(fakeWindow, "V3.0.6");
const ui = fakeWindow.NgrUpdateUi;

test("更新下载进度展示真实百分比、流量和速度", () => {
  const view = ui.getProgressViewModel({
    phase: "downloading",
    availableVersion: "3.0.6",
    downloadSize: 1000 * 1024,
    progress: { percent: 37.4, transferred: 374 * 1024, total: 1000 * 1024, bytesPerSecond: 128 * 1024 },
  });
  assert.equal(view.visible, true);
  assert.equal(view.indeterminate, false);
  assert.equal(view.percentLabel, "37%");
  assert.match(view.text, /V3\.0\.6/);
  assert.match(view.detail, /374\.0 KB/);
  assert.match(view.speed, /秒$/);
  assert.deepEqual(view.stages, { download: "active", verify: "waiting", install: "waiting" });
});

test("下载完成后直接进入自动安装且不再显示安装向导", () => {
  const view = ui.getProgressViewModel({ phase: "installing", availableVersion: "3.0.6" });
  assert.equal(view.visible, true);
  assert.equal(view.indeterminate, true);
  assert.equal(view.percentLabel, "安装中");
  assert.match(view.title, /自动安装/);
  assert.match(view.detail, /自动关闭/);
  assert.doesNotMatch(view.title + view.detail, /安装向导|确认安装/);
  assert.deepEqual(view.stages, { download: "complete", verify: "complete", install: "active" });

  const downloaded = ui.getProgressViewModel({ phase: "downloaded", availableVersion: "3.0.6" });
  assert.equal(downloaded.active, true);
  assert.equal(downloaded.indeterminate, true);
  assert.match(downloaded.detail, /无需再次确认/);
});

test("更新弹窗包含自定义进度轨道和三个阶段", () => {
  const html = fs.readFileSync(path.join(projectRoot, "app", "index.html"), "utf8");
  const css = fs.readFileSync(path.join(projectRoot, "app", "styles.css"), "utf8");
  for (const id of ["updateProgressTrack", "updateProgressBar", "updateProgressPercent", "updateStageList"]) {
    assert.match(html, new RegExp(`id=["']${id}["']`));
  }
  assert.equal((html.match(/data-update-stage=/g) || []).length, 3);
  assert.match(html, /自动安装更新/);
  assert.doesNotMatch(html, /启动安装向导|由你确认后开始安装/);
  assert.doesNotMatch(source, /installUpdate|打开安装向导|globalScope\.confirm/);
  assert.match(css, /@keyframes update-indeterminate/);
  assert.match(css, /linear-gradient\(90deg, #0f766e, #06b6d4/);
});

test("手动安装 IPC 已移除且主进程使用静默自动安装", () => {
  const controller = fs.readFileSync(path.join(projectRoot, "desktop", "services", "updater-controller.mjs"), "utf8");
  const ipc = fs.readFileSync(path.join(projectRoot, "desktop", "main", "ipc.mjs"), "utf8");
  const preload = fs.readFileSync(path.join(projectRoot, "desktop", "preload", "index.cjs"), "utf8");
  const sharedChannels = fs.readFileSync(path.join(projectRoot, "desktop", "shared", "ipc-channels.cjs"), "utf8");
  const rendererBridge = fs.readFileSync(path.join(projectRoot, "app", "js", "desktop-bridge.js"), "utf8");
  assert.match(controller, /update-downloaded[\s\S]+#scheduleAutomaticInstall\(\)/);
  assert.match(controller, /quitAndInstall\(true, true\)/);
  for (const bridgeSource of [ipc, preload, sharedChannels, rendererBridge]) {
    assert.doesNotMatch(bridgeSource, /updaterInstall|updater\.install|installUpdate|ngr:updater:install/);
  }
});

test("首页顶部栏提供受控的反馈表单入口", () => {
  const html = fs.readFileSync(path.join(projectRoot, "app", "index.html"), "utf8");
  const lifecycleSource = fs.readFileSync(path.join(projectRoot, "app", "js", "lifecycle-rules.js"), "utf8");
  assert.match(html, /<header class="topbar">[\s\S]*id="feedbackFormLink"[\s\S]*反馈与建议[\s\S]*<\/header>/);
  assert.match(source, /feedbackFormLink\?\.addEventListener\("click", \(\) => void openTrustedExternal\(FEEDBACK_FORM_URL\)\)/);
  assert.match(lifecycleSource, /feedbackFormLink\?\.classList\.toggle\("hidden", name !== "home"\)/);
});
