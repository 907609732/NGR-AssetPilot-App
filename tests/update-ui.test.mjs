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

test("安装交接阶段使用动态进度并明确提示安装向导", () => {
  const view = ui.getProgressViewModel({ phase: "installing", availableVersion: "3.0.6" });
  assert.equal(view.visible, true);
  assert.equal(view.indeterminate, true);
  assert.equal(view.percentLabel, "准备中");
  assert.match(view.title, /安装向导/);
  assert.match(view.detail, /确认安装/);
  assert.deepEqual(view.stages, { download: "complete", verify: "complete", install: "active" });
});

test("更新弹窗包含自定义进度轨道和三个阶段", () => {
  const html = fs.readFileSync(path.join(projectRoot, "app", "index.html"), "utf8");
  const css = fs.readFileSync(path.join(projectRoot, "app", "styles.css"), "utf8");
  for (const id of ["updateProgressTrack", "updateProgressBar", "updateProgressPercent", "updateStageList"]) {
    assert.match(html, new RegExp(`id=["']${id}["']`));
  }
  assert.equal((html.match(/data-update-stage=/g) || []).length, 3);
  assert.match(css, /@keyframes update-indeterminate/);
  assert.match(css, /linear-gradient\(90deg, #0f766e, #06b6d4/);
});

test("首页顶部栏提供受控的反馈表单入口", () => {
  const html = fs.readFileSync(path.join(projectRoot, "app", "index.html"), "utf8");
  const lifecycleSource = fs.readFileSync(path.join(projectRoot, "app", "js", "lifecycle-rules.js"), "utf8");
  assert.match(html, /<header class="topbar">[\s\S]*id="feedbackFormLink"[\s\S]*反馈与建议[\s\S]*<\/header>/);
  assert.match(source, /feedbackFormLink\?\.addEventListener\("click", \(\) => void openTrustedExternal\(FEEDBACK_FORM_URL\)\)/);
  assert.match(lifecycleSource, /feedbackFormLink\?\.classList\.toggle\("hidden", name !== "home"\)/);
});
