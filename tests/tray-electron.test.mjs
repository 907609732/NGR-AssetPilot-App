import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { _electron as electron } from "playwright";

test("点击窗口关闭后缩到 Windows 托盘，重新启动请求会恢复窗口", { timeout: 45_000 }, async () => {
  const root = path.resolve(import.meta.dirname, "..");
  fs.mkdirSync(path.join(root, ".tmp"), { recursive: true });
  const runRoot = fs.mkdtempSync(path.join(root, ".tmp", "tray-electron-"));
  const electronApp = await electron.launch({
    args: [path.join(root, "desktop/main/index.mjs")],
    cwd: root,
    env: {
      ...process.env,
      NGR_E2E_USER_DATA: path.join(runRoot, "UserData"),
      ELECTRON_ENABLE_LOGGING: "0",
    },
  });
  try {
    const page = await electronApp.firstWindow();
    await page.waitForFunction(() => Boolean(window.ngrDesktop?.environment?.getInfo));
    const hidden = await electronApp.evaluate(async ({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      window.close();
      await new Promise((resolve) => setTimeout(resolve, 100));
      return {
        destroyed: window.isDestroyed(),
        visible: window.isVisible(),
        count: BrowserWindow.getAllWindows().length,
      };
    });
    assert.deepEqual(hidden, { destroyed: false, visible: false, count: 1 });
    const restored = await electronApp.evaluate(async ({ app, BrowserWindow }) => {
      app.emit("second-instance", {}, [], process.cwd(), {});
      await new Promise((resolve) => setTimeout(resolve, 100));
      const window = BrowserWindow.getAllWindows()[0];
      return { visible: window.isVisible(), focused: window.isFocused() };
    });
    assert.deepEqual(restored, { visible: true, focused: true });
  } finally {
    await electronApp.close();
  }
});
