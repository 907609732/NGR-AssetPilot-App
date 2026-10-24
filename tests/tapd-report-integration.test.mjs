import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

import { TapdReportWindowService } from "../desktop/services/tapd-report-window.mjs";
import {
  assertSafeImageUrl,
  extractBugImagesToDirectory,
  getBugImagePreview,
  listBugImagePreviews,
  normalizeBugImageCandidates,
  selectBugImageTickets,
  unusedBugImageDirectory,
  weeklyText,
} from "../desktop/services/tapd-report-runtime.mjs";

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
  assert.match(preload.toString("utf8"), /tapd:extract-bug-images/);
  assert.match(preload.toString("utf8"), /tapd:list-bug-images/);
  assert.match(preload.toString("utf8"), /tapd:get-bug-image/);
  assert.equal(template.subarray(0, 2).toString("ascii"), "PK");
});

function capturedItem({
  key = "20416981:Bug:1020416981164433540",
  id = "1020416981164433540",
  shortId = "164433540",
  type = "Bug",
  processedAt = "2026-10-12 10:50:00",
  title = "【S1】【运营活动】示例问题",
} = {}) {
  return {
    key,
    id,
    shortId,
    workspaceId: "20416981",
    workspaceName: "示例项目",
    type,
    typeLabel: type,
    title,
    status: "已解决",
    owner: "tester",
    processedAt,
    url: `https://tapd.tencent.com/tapd_fe/20416981/${type.toLowerCase()}/detail/${id}`,
  };
}

function capturedState(items, overrides = {}) {
  return {
    capture: {
      scope: {
        kind: "range",
        period: { start: "2026-10-12", end: "2026-10-18" },
      },
      id: "capture-1",
      capturedAt: "2026-10-18T12:00:00.000Z",
      account: "tester",
      total: items.length,
      loaded: items.length,
      complete: true,
      issues: [],
      items,
      groups: [],
    },
    overrides,
    budgets: {},
    settings: {
      person: "测试人员",
      supplier: "测试供应商",
      unit: "人日(默认)",
      testOrder: "否",
      content: "交互界面",
      width: 2560,
      height: 1440,
      method: "高模渲染",
      productionLevel: "",
      rules: [],
    },
    history: [],
    exports: [],
  };
}

test("Bug 图片范围按当前报表日期选择、包含排除项并按单号去重", () => {
  const bug = capturedItem();
  const duplicate = { ...bug, key: `${bug.key}:duplicate` };
  const story = capturedItem({
    key: "20416981:Story:1020416981164433541",
    id: "1020416981164433541",
    shortId: "164433541",
    type: "Story",
  });
  const state = capturedState([bug, duplicate, story], {
    [bug.key]: { included: false },
  });
  const tickets = selectBugImageTickets(state, {
    start: "2026-10-12",
    end: "2026-10-18",
  });
  assert.equal(tickets.length, 1);
  assert.equal(tickets[0].shortId, "164433540");
  assert.throws(
    () =>
      selectBugImageTickets(state, {
        start: "2026-10-01",
        end: "2026-10-18",
      }),
    /超出当前采集范围/,
  );
  assert.throws(
    () =>
      selectBugImageTickets(capturedState([story]), {
        start: "2026-10-12",
        end: "2026-10-18",
      }),
    /没有 Bug 单/,
  );
});

test("Bug 详情图片分类保留描述、评论和附件并排除头像与导航素材", () => {
  const base = {
    kind: "image",
    fileName: "截图.png",
    ownHints: "IMG screenshot",
    ancestorHints: "DIV bug-description rich-content",
    inMain: true,
    visible: true,
    width: 800,
    height: 600,
  };
  const candidates = normalizeBugImageCandidates(
    [
      { ...base, urls: ["/files/description.png"] },
      {
        ...base,
        urls: ["https://cdn.example.com/comment.jpg"],
        ancestorHints: "DIV comment activity",
        visible: false,
      },
      {
        ...base,
        kind: "attachment",
        urls: ["https://cdn.example.com/download?id=1"],
        ancestorHints: "DIV attachment-list",
      },
      {
        ...base,
        urls: ["https://cdn.example.com/avatar.png"],
        ownHints: "IMG user-avatar",
        width: 64,
        height: 64,
      },
      {
        ...base,
        urls: ["https://cdn.example.com/logo.png"],
        ancestorHints: "NAV global-header navbar",
      },
      {
        ...base,
        kind: "attachment",
        urls: ["https://tapd.tencent.com/static/file-image.svg"],
        fileName: "图片.svg",
        ancestorHints: "DIV attachment-list",
        width: 24,
        height: 24,
      },
    ],
    "https://tapd.tencent.com/tapd_fe/20416981/bug/detail/1",
  );
  assert.deepEqual(
    candidates.map((candidate) => candidate.source),
    ["描述", "评论", "附件"],
  );
  assert.equal(candidates[0].urls[0], "https://tapd.tencent.com/files/description.png");
});

test("Bug 图片预览只读取登记目录中的有效大图并返回安全缩略图", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "ngr-tapd-preview-"));
  const period = { start: "2026-10-12", end: "2026-10-18" };
  const outputPath = path.join(
    temporaryRoot,
    "TAPD-Bug图片--2026-10-12至2026-10-18",
  );
  const ticketPath = path.join(outputPath, "164433540-示例问题");
  try {
    await mkdir(ticketPath, { recursive: true });
    await writeFile(
      path.join(ticketPath, "01-描述-截图.png"),
      await sharp({
        create: {
          width: 320,
          height: 180,
          channels: 4,
          background: { r: 22, g: 80, b: 140, alpha: 1 },
        },
      })
        .png()
        .toBuffer(),
    );
    await writeFile(
      path.join(ticketPath, "02-附件-图标.png"),
      await sharp({
        create: {
          width: 24,
          height: 24,
          channels: 4,
          background: { r: 20, g: 200, b: 190, alpha: 1 },
        },
      })
        .png()
        .toBuffer(),
    );
    await writeFile(path.join(ticketPath, "03-附件-图片.svg"), "<svg width=\"24\" height=\"24\"/>");
    const state = capturedState([capturedItem()]);
    state.exports = [
      {
        at: new Date().toISOString(),
        path: outputPath,
        kind: "bug-images",
        draft: false,
      },
    ];
    const groups = await listBugImagePreviews(state, period);
    assert.equal(groups.length, 1);
    assert.equal(groups[0].bugId, "164433540");
    assert.equal(groups[0].images.length, 1);
    assert.equal(groups[0].images[0].source, "描述");
    assert.equal(groups[0].images[0].width, 320);
    assert.equal("absolutePath" in groups[0].images[0], false);
    const preview = await getBugImagePreview(state, {
      period,
      bugId: groups[0].bugId,
      imageId: groups[0].images[0].id,
    });
    assert.equal(preview.mimeType, "image/webp");
    assert.ok(preview.data instanceof ArrayBuffer);
    assert.ok(preview.data.byteLength > 0);
    await assert.rejects(
      () =>
        getBugImagePreview(state, {
          period,
          bugId: "164433540",
          imageId: "../outside",
        }),
      /图片标识无效/,
    );
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("Bug 图片导出按单号建目录、去重并记录部分失败", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "ngr-tapd-images-"));
  const outputPath = path.join(temporaryRoot, "TAPD-Bug图片--2026-10-12至2026-10-18");
  const png = await sharp({
    create: {
      width: 4,
      height: 4,
      channels: 4,
      background: { r: 20, g: 80, b: 140, alpha: 1 },
    },
  })
    .png()
    .toBuffer();
  const candidates = [
    { source: "描述", urls: ["https://cdn.example.com/a"], fileName: "截图.png" },
    { source: "评论", urls: ["https://cdn.example.com/b"], fileName: "重复.png" },
    { source: "附件", urls: ["https://cdn.example.com/c"], fileName: "损坏.png" },
  ];
  const progress = [];
  try {
    const result = await extractBugImagesToDirectory({
      context: {},
      page: {},
      tickets: [
        {
          id: "1020416981164433540",
          shortId: "164433540",
          workspaceId: "20416981",
          title: "标题/包含非法字符",
          url: "https://tapd.tencent.com/tapd_fe/20416981/bug/detail/1020416981164433540",
        },
      ],
      outputPath,
      progress: (value) => progress.push(value),
      stopped: () => false,
      readCandidates: async () => candidates,
      downloadCandidate: async (candidate) => {
        if (candidate.source === "附件") throw new Error("HTTP 403");
        return {
          body: png,
          url: candidate.urls[0],
          format: "png",
          contentType: "image/png",
          fileName: "",
        };
      },
    });
    assert.equal(result.imageCount, 1);
    assert.equal(result.duplicateCount, 1);
    assert.equal(result.failedCount, 1);
    assert.equal(result.canceled, false);
    const entries = await readdir(outputPath);
    assert.ok(entries.some((entry) => entry.startsWith("164433540-")));
    const manifest = await readFile(path.join(outputPath, "提取清单.csv"), "utf8");
    assert.equal(manifest.charCodeAt(0), 0xfeff);
    assert.match(manifest, /成功/);
    assert.match(manifest, /重复/);
    assert.match(manifest, /HTTP 403/);
    assert.ok(progress.some((entry) => entry.phase === "extracting-images"));
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("Bug 图片导出取消时保留清单、登录失效时记录原因且不覆盖旧目录", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "ngr-tapd-images-stop-"));
  const period = { start: "2026-10-12", end: "2026-10-18" };
  const firstPath = unusedBugImageDirectory(temporaryRoot, period);
  const ticket = {
    id: "1020416981164433540",
    shortId: "164433540",
    workspaceId: "20416981",
    title: "登录测试",
    url: "https://tapd.tencent.com/tapd_fe/20416981/bug/detail/1020416981164433540",
  };
  try {
    const canceled = await extractBugImagesToDirectory({
      context: {},
      page: {},
      tickets: [ticket],
      outputPath: firstPath,
      progress() {},
      stopped: () => true,
      readCandidates: async () => [],
      downloadCandidate: async () => {
        throw new Error("不应下载");
      },
    });
    assert.equal(canceled.canceled, true);
    assert.equal((await readFile(path.join(firstPath, "提取清单.csv"), "utf8")).charCodeAt(0), 0xfeff);
    const secondPath = unusedBugImageDirectory(temporaryRoot, period);
    assert.notEqual(secondPath, firstPath);
    assert.match(secondPath, /\(2\)$/);
    const expiredPath = path.join(temporaryRoot, "expired");
    const expired = await extractBugImagesToDirectory({
      context: {},
      page: {},
      tickets: [ticket],
      outputPath: expiredPath,
      progress() {},
      stopped: () => false,
      readCandidates: async () => {
        throw new Error("TAPD 登录已失效，请重新登录后再试");
      },
      downloadCandidate: async () => {
        throw new Error("不应下载");
      },
    });
    assert.equal(expired.failedCount, 1);
    assert.match(expired.message, /登录已失效/);
    assert.match(await readFile(path.join(expiredPath, "提取清单.csv"), "utf8"), /登录已失效/);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("Bug 图片地址拒绝非 HTTPS、本机和内网目标", async () => {
  await assert.rejects(() => assertSafeImageUrl("http://tapd.tencent.com/a.png"), /HTTPS/);
  await assert.rejects(() => assertSafeImageUrl("https://127.0.0.1/a.png"), /内网/);
  await assert.rejects(() => assertSafeImageUrl("https://192.168.1.10/a.png"), /内网/);
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
    assert.equal(handlers.size, 14);
    assert.equal(handlers.has("tapd:extract-bug-images"), true);
    assert.equal(handlers.has("tapd:list-bug-images"), true);
    assert.equal(handlers.has("tapd:get-bug-image"), true);
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
