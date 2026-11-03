import { chromium, type BrowserContext, type Page } from "playwright-core";
import { mkdirSync } from "node:fs";
import type {
  BugImageExportResult,
  Capture,
  CaptureScope,
  Progress,
} from "../shared/types";
import { cleanTitle, dateRange, defaultSettings, levelFromFixBranch, monthPeriod, todayShanghai, validLevel } from "../shared/report";
import { collectPage } from "./collect-page";
import {
  extractBugImagesToDirectory,
  type BugImageTicket,
} from "./bug-images";

const WORK_URL = "https://tapd.tencent.com/tapd_fe/my/work";
export class TapdCollector {
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private stopped = false;
  private running = false;
  private mediaPages = new Set<Page>();
  constructor(
    private profilePath: string,
    private progress: (p: Progress) => void,
  ) {}
  async login() {
    if (this.running) throw new Error("正在采集，请等待完成或停止");
    await this.browser();
    await this.page!.bringToFront();
    this.progress({
      phase: "login",
      message: "专用 Chrome 已打开。完成登录后，选择日期并点击“抓取所选日期”。",
    });
    const page = this.page!;
    void page
      .locator(".avatar-nav[title]")
      .waitFor({ state: "attached", timeout: 1800000 })
      .then(() => {
        this.progress({
          phase: "ready",
          message: "登录已就绪，可以抓取已办。",
        });
      })
      .catch(() => {});
  }
  private async browser() {
    if (!this.context) {
      mkdirSync(this.profilePath, { recursive: true });
      try {
        this.context = await chromium.launchPersistentContext(
          this.profilePath,
          {
            channel: "chrome",
            headless: false,
            viewport: null,
            acceptDownloads: false,
          },
        );
      } catch {
        throw new Error(
          "无法启动专用 Chrome。请确认已安装 Chrome，且上一次采集窗口已关闭。",
        );
      }
      this.context.on("close", () => {
        this.context = null;
        this.page = null;
      });
    }
    if (!this.page || this.page.isClosed()) {
      this.page = this.context.pages()[0] ?? (await this.context.newPage());
      await this.page.goto(WORK_URL, {
        waitUntil: "domcontentloaded",
        timeout: 45000,
      });
    }
    return this.page;
  }
  cancel() {
    this.stopped = true;
    // Only extraction-owned detail pages are closed; the user's original TAPD page stays open.
    for (const page of this.mediaPages) void page.close().catch(() => {});
  }
  private check() {
    if (this.stopped) throw new Error("已停止采集，当前记录保存为不完整草稿");
  }
  private async settle(page: Page) {
    await page.waitForTimeout(900);
    await page
      .locator(".el-loading-mask:visible")
      .first()
      .waitFor({ state: "hidden", timeout: 15000 })
      .catch(() => {});
  }
  private async authenticatedPage() {
    const page = await this.browser();
    if (/\/ptlogin\/|\/login(?:[/?]|$)/i.test(page.url())) {
      await page.bringToFront();
      throw new Error("TAPD 登录已失效，请在专用 Chrome 完成登录后重试");
    }
    try {
      await page
        .locator(".avatar-nav[title]")
        .waitFor({ state: "attached", timeout: 15000 });
    } catch {
      await page.bringToFront();
      throw new Error("未检测到 TAPD 登录状态，请在专用 Chrome 完成登录后重试");
    }
    return page;
  }
  async prepareBugImageExtraction() {
    if (this.running) throw new Error("已有采集或图片提取正在进行");
    await this.authenticatedPage();
  }
  async extractBugImages(
    tickets: BugImageTicket[],
    outputPath: string,
  ): Promise<BugImageExportResult> {
    if (this.running) throw new Error("已有采集或图片提取正在进行");
    this.running = true;
    this.stopped = false;
    const detailPages: Page[] = [];
    try {
      const page = await this.authenticatedPage();
      for (let index = 0; index < Math.min(2, tickets.length) && !this.stopped; index++) {
        const detailPage = await this.context!.newPage();
        detailPages.push(detailPage);
        this.mediaPages.add(detailPage);
        if (this.stopped) await detailPage.close().catch(() => {});
      }
      return await extractBugImagesToDirectory({
        context: this.context!,
        page,
        pages: detailPages,
        tickets,
        outputPath,
        progress: (progress) => this.progress(progress),
        stopped: () => this.stopped,
      });
    } finally {
      await Promise.allSettled(detailPages.map((page) => page.close()));
      detailPages.forEach((page) => this.mediaPages.delete(page));
      this.running = false;
    }
  }
  private async resetScope(page: Page) {
    const done = page
      .locator(".worktable-tab-left:not(.new-tab-left) .list-item")
      .filter({ hasText: /^\s*已办\s*$/ });
    try {
      await done.waitFor({ state: "visible", timeout: 30000 });
    } catch {
      throw new Error(
        "未能打开我的工作，请在专用 Chrome 中确认登录和网络后重试",
      );
    }
    if (!(await done.getAttribute("class"))?.includes("list-item--active")) {
      await done.click();
      await this.settle(page);
    }
    const space = page.locator(".item-value__space");
    if (
      (await space.locator(":scope > .tapd-select-tag").innerText()).trim() !==
      "所有"
    ) {
      await space.click();
      await space.getByText("所有空间", { exact: true }).click();
      await page.locator(".worktable-tab-left:not(.new-tab-left)").click();
      await this.settle(page);
    }
    const category = page.locator(".item-value__category");
    if (
      (
        await category.locator(":scope > .tapd-select-tag").innerText()
      ).trim() !== "所有"
    ) {
      await category.click();
      for (let i = 0; i < 20; i++) {
        const unselected = category.locator(
          ".tapd-select-dropmenu__item:not(.selected):visible",
        );
        if (!(await unselected.count())) break;
        await unselected.first().click();
      }
      await page.locator(".worktable-tab-left:not(.new-tab-left)").click();
      await this.settle(page);
    }
    if (!(await page.locator(".tapd-filter__body").isVisible()))
      await page.locator(".list-item__filter").click();
    const keyword = page.locator(".tapd-filter-item--keyword input");
    if ((await keyword.count()) && (await keyword.inputValue())) {
      await keyword.fill("");
      await keyword.press("Enter");
      await this.settle(page);
    }
    for (let i = 0; i < 100; i++) {
      const active = page.locator(".tapd-filter-item").filter({
        has: page.locator(
          ".tapd-filter-item__value:not(.tapd-filter-item__value--empty)",
        ),
      });
      if (!(await active.count())) break;
      await active.first().locator(".close-field").click();
      await this.settle(page);
    }
    if (await page.locator(".tapd-filter__body").isVisible())
      await page.locator(".list-item__filter").click();
    await this.settle(page);
  }
  private async enrichFixBranches(capture: Capture) {
    const missing = capture.items.filter((item) =>
      item.type.toLowerCase() === "bug" && !validLevel(cleanTitle(item.title, defaultSettings).level),
    );
    if (!missing.length || !this.context) return capture;
    let next = 0;
    let completed = 0;
    const workers = Array.from({ length: Math.min(2, missing.length) }, async () => {
      const detailPage = await this.context!.newPage().catch(() => null);
      if (!detailPage) return;
      try {
        while (next < missing.length && !this.stopped) {
          const item = missing[next++];
          try {
            const url = new URL(item.url, WORK_URL);
            if (url.protocol !== "https:" || url.hostname !== "tapd.tencent.com" ||
                !/^\/tapd_fe\/\d+\/bug\/detail\/\d+\/?$/.test(url.pathname)) throw new Error("Bug 详情地址无效");
            await detailPage.goto(url.href, { waitUntil: "domcontentloaded", timeout: 30000 });
            const field = detailPage.locator(".entity-detail-right-col").filter({
              has: detailPage.locator(".entity-detail-right-col__key").getByText("修复分支", { exact: true }),
            }).first().locator(".entity-detail-right-col__value");
            const deadline = Date.now() + 12000;
            await field.waitFor({ state: "attached", timeout: 12000 });
            // TAPD mounts the field before its asynchronous value arrives.
            // Keep the wait bounded and allow cancel to stop before saving a late value.
            while (!this.stopped && Date.now() < deadline) {
              const value = field.locator("[field]").first();
              const hasValue = (await value.count()) > 0;
              if (this.stopped || Date.now() >= deadline) break;
              let branch = (hasValue ? await value.getAttribute("value", { timeout: Math.max(1, deadline - Date.now()) }) : "")?.trim() || "";
              if (this.stopped || Date.now() >= deadline) break;
              if (!branch) branch = (await field.innerText({ timeout: Math.max(1, deadline - Date.now()) })).trim();
              if (this.stopped || Date.now() >= deadline) break;
              if (branch && !/^(?:加载中|正在加载|loading)[.\s…]*$/i.test(branch)) {
                item.fixBranch = branch;
                break;
              }
              await detailPage.waitForTimeout(100);
            }
          } catch {
            // If the detail field is unavailable, the S level remains editable by hand.
          }
          completed++;
          this.progress({ phase: "collecting", message: `正在读取 Bug 修复分支 ${completed}/${missing.length}`, current: completed, total: missing.length });
        }
      } finally {
        await detailPage.close().catch(() => {});
      }
    });
    await Promise.all(workers);
    const recognized = missing.filter((item) => validLevel(levelFromFixBranch(item.fixBranch ?? ""))).length;
    this.progress({
      phase: capture.complete ? "complete" : "incomplete",
      message: `Bug 修复分支识别 S 等级：${recognized}/${missing.length}${recognized < missing.length ? "；其余请人工选择" : ""}`,
      loaded: capture.loaded,
      total: capture.total,
    });
    return capture;
  }
  async collect(
    scope: CaptureScope = {
      kind: "range",
      period: monthPeriod(todayShanghai().slice(0, 7)),
    },
  ): Promise<Capture> {
    if (this.running) throw new Error("已有采集正在进行");
    if (!scope || !["range", "all"].includes(scope.kind))
      throw new Error("请选择采集日期或全部历史");
    if (scope.kind === "range")
      dateRange(scope.period?.start, scope.period?.end);
    this.running = true;
    this.stopped = false;
    this.progress({
      phase: "preparing",
      message:
        scope.kind === "all"
          ? "正在准备采集全部历史…"
          : `正在准备采集 ${scope.period.start} 至 ${scope.period.end}…`,
    });
    try {
      const reusePage = !!this.page && !this.page.isClosed();
      const page = await this.browser();
      if (!page.url().startsWith(WORK_URL))
        await page.goto(WORK_URL, {
          waitUntil: "domcontentloaded",
          timeout: 45000,
        });
      else if (reusePage)
        // Start from fresh initial pages so a previous full-history run does
        // not carry its expanded rows or stale source data into a short range.
        await page.reload({ waitUntil: "domcontentloaded", timeout: 45000 });
      await this.resetScope(page);
      this.check();
      const capture = await collectPage(
        page,
        scope,
        () => this.check(),
        (p) => this.progress(p),
        () => this.settle(page),
      );
      return await this.enrichFixBranches(capture);
    } finally {
      this.running = false;
    }
  }
  async close() {
    this.cancel();
    await this.context?.close().catch(() => {});
  }
}
