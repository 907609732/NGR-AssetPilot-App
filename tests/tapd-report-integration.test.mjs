import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { TapdReportWindowService } from "../desktop/services/tapd-report-window.mjs";
import { weeklyText } from "../desktop/services/tapd-report-runtime.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("TAPD 月报集成产物和模板随主软件提供", async () => {
  const [html, renderer, styles, runtime, preload, template] = await Promise.all([
    readFile(path.join(projectRoot, "app/tapd-report/index.html")),
    readFile(path.join(projectRoot, "app/tapd-report/assets/index.js")),
    readFile(path.join(projectRoot, "app/tapd-report/assets/index.css")),
    readFile(path.join(projectRoot, "desktop/services/tapd-report-runtime.mjs")),
    readFile(path.join(projectRoot, "desktop/preload/tapd-report.cjs")),
    readFile(path.join(projectRoot, "app/tapd-report/monthly-template.xlsx")),
  ]);
  assert.ok(html.length > 100);
  assert.ok(renderer.length > 100_000);
  assert.ok(styles.length > 5_000);
  assert.ok(runtime.length > 30_000);
  assert.ok(preload.length > 500);
  assert.equal(template.subarray(0, 2).toString("ascii"), "PK");
});

test("周报按日期汇总且每天只输出一次日期和总人天", () => {
  const report = {
    items: [],
    issues: [],
    includedCount: 3,
    dayCount: 1,
    totalUnits: 100,
    days: [{ date: "2026-10-12", budget: 100, allocated: 100 }],
    entries: [
      {
        key: "a",
        sourceKeys: ["a"],
        title: "第一项",
        category: "运营活动",
        level: "S1",
        dates: ["2026-10-12"],
        units: 34,
        allocations: { "2026-10-12": 34 },
      },
      {
        key: "b",
        sourceKeys: ["b"],
        title: "第二项",
        category: "商业化",
        level: "S2",
        dates: ["2026-10-12"],
        units: 33,
        allocations: { "2026-10-12": 33 },
      },
      {
        key: "c",
        sourceKeys: ["c"],
        title: "第三项",
        category: "运营活动",
        level: "S2",
        dates: ["2026-10-12"],
        units: 33,
        allocations: { "2026-10-12": 33 },
      },
    ],
  };
  const text = weeklyText(report);
  assert.equal((text.match(/10\/12/g) ?? []).length, 1);
  assert.equal(
    text,
    "10/12（S1/S2）1人天\n【运营活动】第一项\n【商业化】第二项\n【运营活动】第三项",
  );
});

test("TAPD 子窗口只接受自身主框架请求并清理 IPC", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "ngr-tapd-integration-"));
  const previousE2eRoot = process.env.NGR_E2E_USER_DATA;
  process.env.NGR_E2E_USER_DATA = path.join(temporaryRoot, "UserData");
  const handlers = new Map();
  const ipcMain = {
    handle(channel, handler) { handlers.set(channel, handler); },
    removeHandler(channel) { handlers.delete(channel); },
  };
  const created = [];
  class FakeWindow {
    constructor(options) {
      this.options = options;
      this.destroyed = false;
      this.events = new Map();
      this.webContents = {
        id: 51,
        mainFrame: { routingId: 7, url: "" },
        send() {},
        getURL: () => this.webContents.mainFrame.url,
      };
      created.push(this);
    }
    isDestroyed() { return this.destroyed; }
    isMinimized() { return false; }
    once(name, callback) { this.events.set(name, callback); }
    on(name, callback) { this.events.set(name, callback); }
    show() {}
    focus() {}
    restore() {}
    destroy() {
      this.destroyed = true;
      this.events.get("closed")?.();
    }
    async loadURL(url) {
      this.webContents.mainFrame.url = url;
      this.events.get("ready-to-show")?.();
    }
  }
  const app = {
    getPath(name) {
      const paths = {
        appData: path.join(temporaryRoot, "Roaming"),
        userData: path.join(temporaryRoot, "UserData"),
        documents: path.join(temporaryRoot, "Documents"),
      };
      return paths[name];
    },
  };
  const mainWindow = { isDestroyed: () => false };
  const service = new TapdReportWindowService({
    app,
    BrowserWindow: FakeWindow,
    clipboard: { write() {}, writeText() {} },
    dialog: {
      async showMessageBox() { return { response: 1 }; },
    },
    ipcMain,
    shell: {},
    createWindowOptions: (preload) => ({ webPreferences: { preload } }),
    hardenWindow() {},
    getMainWindow: () => mainWindow,
    preloadPath: path.join(projectRoot, "desktop/preload/tapd-report.cjs"),
    pageUrl: "ngr-assetpilot://app/tapd-report/index.html",
    templatePath: path.join(projectRoot, "app/tapd-report/monthly-template.xlsx"),
  });
  try {
    assert.equal(handlers.size, 11);
    assert.deepEqual(await service.open(), { opened: true });
    assert.equal(created.length, 1);
    const child = created[0];
    const trustedEvent = { sender: child.webContents, senderFrame: child.webContents.mainFrame };
    const state = await handlers.get("tapd:load")(trustedEvent);
    assert.equal(state.capture, null);
    const cleared = await handlers.get("tapd:clear-all-data")(trustedEvent);
    assert.equal(cleared.capture, null);
    assert.deepEqual(cleared.history, []);
    assert.deepEqual(cleared.exports, []);
    await assert.rejects(
      () => handlers.get("tapd:load")({ sender: child.webContents, senderFrame: { routingId: 8, url: child.webContents.mainFrame.url } }),
      /不受信任/,
    );
  } finally {
    await service.dispose();
    if (previousE2eRoot === undefined) delete process.env.NGR_E2E_USER_DATA;
    else process.env.NGR_E2E_USER_DATA = previousE2eRoot;
    await rm(temporaryRoot, { recursive: true, force: true });
  }
  assert.equal(handlers.size, 0);
});
