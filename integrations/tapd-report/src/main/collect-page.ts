import { randomUUID } from "node:crypto";
import type { Page } from "playwright-core";
import type { Capture, CaptureScope, Progress, RawItem } from "../shared/types";
import { captureScopeLabel, inPeriod, todayShanghai } from "../shared/report";
import { readTapdDOM, type DOMCapture } from "./tapd-dom";
import { groupMayIntersect, hasDescendingDates } from "./capture-range";

export async function collectPage(
  page: Page,
  scope: CaptureScope,
  check: () => void,
  progress: (value: Progress) => void,
  settle: () => Promise<void>,
): Promise<Capture> {
  const today = todayShanghai();
  const capture: Capture = {
    id: randomUUID(),
    capturedAt: new Date().toISOString(),
    scope,
    account: "",
    total: null,
    pageTotal: null,
    scanned: 0,
    loaded: 0,
    complete: false,
    issues: [],
    items: [],
    groups: [],
  };
  const byKey = new Map<string, RawItem>();
  const scanned = new Set<string>();
  const label = captureScopeLabel(capture);
  const verify = (dom: DOMCapture) => {
    check();
    if (!dom.account || (capture.account && capture.account !== dom.account))
      throw new Error("登录已失效或账号发生变化，请重新登录后抓取");
    if (dom.active !== "已办") throw new Error("已离开已办页面，请重新抓取");
    if (
      dom.scopes.some((s) => s !== "所有") ||
      dom.filters.length ||
      dom.keyword
    )
      throw new Error("TAPD 筛选条件发生变化，请重新抓取");
  };
  const announce = (group: string) =>
    progress({
      phase: "collecting",
      message: `正在抓取${label} · ${group}：已纳入 ${byKey.size} 条，检查 ${scanned.size} 条`,
      loaded: byKey.size,
      total: scope.kind === "all" ? capture.pageTotal : null,
    });
  try {
    await page.waitForFunction(
      () => {
        const text =
          document.querySelector(".operation-right__filter-info")
            ?.textContent ?? "";
        return (
          /共\s*0\s*个/.test(text) ||
          document.querySelectorAll(".item-head").length > 0
        );
      },
      undefined,
      { timeout: 30000 },
    );
    const first = await page.evaluate(readTapdDOM);
    verify(first);
    capture.account = first.account;
    capture.pageTotal = first.total;
    if (first.total === null)
      throw new Error("未能读取页面总数，无法核对采集范围");
    capture.groups = first.groups.map((g) => ({
      name: g.name,
      expected: g.expected,
      loaded: 0,
      skipped:
        scope.kind === "range" &&
        !groupMayIntersect(g.name, scope.period, today),
    }));
    if (
      scope.kind === "range" &&
      first.groups.reduce((sum, group) => sum + group.expected, 0) !==
        first.total
    )
      throw new Error(
        "时间分组数量与页面总数不一致，无法确认所选日期是否完整，请重试",
      );
    for (const group of first.groups) {
      const result = capture.groups[group.index];
      if (result.skipped || group.expected === 0) continue;
      check();
      announce(group.name);
      const head = page.locator(".item-head").nth(group.index);
      const container = head.locator("..");
      await head.scrollIntoViewIfNeeded();
      const current = (await page.evaluate(readTapdDOM)).groups[group.index];
      if (current?.collapsed) await head.locator(".header_click").click();
      await container
        .locator("tr[workspace_id][type]")
        .first()
        .waitFor({ state: "attached", timeout: 30000 });
      await settle();
      const seen = new Map<string, RawItem>();
      let stagnant = 0;
      for (let pass = 0; pass < 2000; pass++) {
        const dom = await page.evaluate(readTapdDOM);
        verify(dom);
        if (
          dom.groups[group.index]?.name !== group.name ||
          dom.groups[group.index]?.expected !== group.expected
        )
          throw new Error("采集期间时间分组或数量发生变化，请重新抓取");
        const invalid = dom.invalid.filter((s) =>
          s.startsWith(`分组${group.name}中`),
        );
        if (invalid.length) throw new Error(invalid[0]);
        for (const { group: _name, ...item } of dom.items.filter(
          (i) => i.group === group.name,
        )) {
          seen.set(item.key, item);
          scanned.add(item.key);
          if (
            scope.kind === "all" ||
            inPeriod(item.processedAt.slice(0, 10), scope.period)
          )
            byKey.set(item.key, item);
        }
        result.loaded = seen.size;
        capture.loaded = byKey.size;
        capture.scanned = scanned.size;
        announce(group.name);
        if (seen.size > group.expected)
          throw new Error(`“${group.name}”的记录数量超过页面总数，请重试`);
        if (seen.size === group.expected) break;
        if (scope.kind === "range") {
          const dates = [...seen.values()].map((i) => i.processedAt);
          // Only cross a date boundary in a verified descending stream. If the
          // page ordering changes, fail closed instead of silently omitting rows.
          if (!hasDescendingDates(dates))
            throw new Error(
              `“${group.name}”未按处理时间倒序排列，无法提前停止；请使用“抓取全部历史”核对`,
            );
          if (dates.length && dates.at(-1)!.slice(0, 10) < scope.period.start) {
            result.bounded = true;
            break;
          }
        }
        const lastRow = container.locator("tr[workspace_id][type]").last();
        if (await lastRow.count()) await lastRow.scrollIntoViewIfNeeded();
        await settle();
        const more = container
          .locator(".load-more")
          .filter({ hasText: "展开更多" });
        try {
          await more.waitFor({ state: "visible", timeout: 30000 });
        } catch {
          throw new Error(
            `“${group.name}”尚未读到日期边界或全部记录，但加载入口未出现，请重试`,
          );
        }
        check();
        const before = await container
          .locator("tr[workspace_id][type]")
          .evaluateAll((es) => es.map((e) => e.id).join("|"));
        await more.click({ timeout: 15000 });
        await settle();
        await page
          .waitForFunction(
            ({ index, before }) =>
              [
                ...(document
                  .querySelectorAll(".item-head")
                  [index]?.parentElement?.querySelectorAll(
                    "tr[workspace_id][type]",
                  ) ?? []),
              ]
                .map((e) => e.id)
                .join("|") !== before,
            { index: group.index, before },
            { timeout: 15000 },
          )
          .catch(() => {});
        const after = await container
          .locator("tr[workspace_id][type]")
          .evaluateAll((es) => es.map((e) => e.id).join("|"));
        stagnant = after === before ? stagnant + 1 : 0;
        if (stagnant >= 3)
          throw new Error("连续三次加载没有新增记录，请检查网络后重新抓取");
        if (pass === 1999)
          throw new Error("加载次数达到上限，尚未读到日期边界");
      }
    }
    const final = await page.evaluate(readTapdDOM);
    verify(final);
    if (final.total !== first.total)
      throw new Error("采集期间页面总数发生变化，请重新抓取");
    if (scope.kind === "all" && byKey.size !== final.total)
      throw new Error(`页面显示 ${final.total} 条，实际读取 ${byKey.size} 条`);
    if (
      capture.groups.some(
        (g) => !g.skipped && !g.bounded && g.loaded !== g.expected,
      )
    )
      throw new Error("所选范围内仍有未完整读取的分组");
    capture.complete = true;
    capture.total = scope.kind === "all" ? final.total : byKey.size;
  } catch (error) {
    if (!capture.account) throw error;
    capture.issues.push(error instanceof Error ? error.message : "采集失败");
    capture.total = scope.kind === "all" ? (capture.pageTotal ?? null) : null;
  }
  capture.items = [...byKey.values()].sort(
    (a, b) =>
      a.processedAt.localeCompare(b.processedAt) || a.key.localeCompare(b.key),
  );
  capture.loaded = capture.items.length;
  capture.scanned = scanned.size;
  progress({
    phase: capture.complete ? "complete" : "incomplete",
    message: capture.complete
      ? `已完成${label}采集，共 ${capture.loaded} 条已办`
      : `已保存 ${capture.loaded} 条草稿：${capture.issues[0]}`,
    loaded: capture.loaded,
    total: capture.total,
  });
  return capture;
}
