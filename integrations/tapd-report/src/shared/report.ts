import type {
  Capture,
  LocalState,
  Period,
  PreparedItem,
  RawItem,
  Report,
  ReportEntry,
  Settings,
} from "./types";

export const defaultSettings: Settings = {
  person: "陈月财",
  supplier: "郑州名匠网络科技有限公司",
  unit: "人日(默认)",
  testOrder: "否",
  content: "交互界面",
  width: 2560,
  height: 1440,
  method: "高模渲染",
  productionLevel: "",
  rules: [
    { keyword: "戏影蝶梦", category: "运营活动" },
    { keyword: "戏影碟梦", category: "运营活动" },
    { keyword: "姑射侠客行", category: "商业化" },
    { keyword: "稷下百晓生", category: "运营活动" },
    { keyword: "首充有礼", category: "商业化" },
    { keyword: "蛋糕型小额抽奖", category: "商业化" },
    { keyword: "迷你冬活", category: "运营活动" },
    { keyword: "李白角色活动", category: "运营活动" },
    { keyword: "王者周年庆拍照", category: "运营活动" },
    { keyword: "福气连珠", category: "商业化" },
  ],
};
export const signature = (item: RawItem) =>
  JSON.stringify([item.title, item.processedAt, item.status]);
export function normalizeLevel(value: string): string {
  const text = value.trim().toUpperCase();
  const match = text.match(/^(?:S\s*)?(\d+)$/);
  return match ? `S${match[1].replace(/^0+(?=\d)/, "")}` : text;
}
export const validLevel = (value: string): boolean =>
  /^S(?:0|[1-9]\d*)$/.test(value);
export function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(+d) && d.toISOString().slice(0, 10) === value;
}
export function addDays(value: string, days: number): string {
  if (!validDate(value)) throw new Error("日期格式不正确");
  return new Date(Date.parse(`${value}T00:00:00Z`) + days * 86400000)
    .toISOString()
    .slice(0, 10);
}
export function dateRange(start: string, end: string): string[] {
  if (!validDate(start) || !validDate(end) || end < start)
    throw new Error("开始和结束日期不正确");
  const length =
    Math.round((Date.parse(end) - Date.parse(start)) / 86400000) + 1;
  if (length > 370) throw new Error("单次日期范围最多 370 天");
  return Array.from({ length }, (_, i) => addDays(start, i));
}
export function todayShanghai(): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  return ["year", "month", "day"]
    .map((t) => parts.find((p) => p.type === t)?.value)
    .join("-");
}
export function monthPeriod(month: string): Period {
  if (!/^\d{4}-\d{2}$/.test(month) || !validDate(`${month}-01`))
    throw new Error("请选择有效月份");
  const start = `${month}-01`;
  const next = new Date(
    Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5)), 1),
  )
    .toISOString()
    .slice(0, 10);
  return { start, end: addDays(next, -1) };
}
export function weekPeriod(today = todayShanghai()): Period {
  const day = new Date(`${today}T00:00:00Z`).getUTCDay();
  const start = addDays(today, -((day + 6) % 7));
  return { start, end: addDays(start, 6) };
}
export const inPeriod = (d: string, p: Period) =>
  validDate(d) && d >= p.start && d <= p.end;
export function captureCovers(
  capture: Capture | null,
  period: Period,
): boolean {
  if (!capture) return false;
  return (
    capture.scope?.kind !== "range" ||
    (capture.scope.period.start <= period.start &&
      capture.scope.period.end >= period.end)
  );
}
export const captureScopeLabel = (capture: Pick<Capture, "scope">) =>
  capture.scope?.kind === "range"
    ? `${capture.scope.period.start} 至 ${capture.scope.period.end}`
    : "全部历史";
export const effortText = (units: number) =>
  (units / 100).toFixed(2).replace(/\.?0+$/, "") || "0";
export const shortDate = (d: string) =>
  `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`;
export const dateLabel = (dates: string[]) =>
  dates.length > 1
    ? `${shortDate(dates[0])}-${shortDate(dates[dates.length - 1])}`
    : shortDate(dates[0]);
export function isNoiseTag(tag: string): boolean {
  return (
    /^(S\d+|OT|NGR|BUG|必现|偶现|一般|严重|轻微|兼容适配(?:PC)?|热更申请)$/i.test(
      tag,
    ) ||
    /^(?:PC|iOS|Android|Harmony|安卓|通用)(?:[\s/、&和]|通用|$)/i.test(tag) ||
    /^(?:双端|双折叠|双端平板|双端折叠|安卓通用|折叠屏|平板)/i.test(tag) ||
    /^(?:i[3579]-|RTX\s|RX\s|Ryzen\s|Ultra\s|Titan\s|TMC-|HUAWEI\s|iPhone\s|Vivo\s|OPPO\s|Realme\s|Xiaomi\s)/i.test(
      tag,
    ) ||
    /^\d+\s*(?:GB?|×\d+|x\d+)$/i.test(tag)
  );
}
export function cleanTitle(
  raw: string,
  settings: Settings,
): { title: string; category: string; level: string } {
  const source = raw.trim();
  const leading =
    source.match(/^(?:[【\[(（][^】\])）]+[】\])）]\s*)+/)?.[0] ?? "";
  const level = normalizeLevel(
    leading.match(/[【\[(（]\s*(S\d+)\s*[】\])）]/i)?.[1] ?? "",
  );
  let title = source.replace(/^[（(]\s*S\d+\s*[）)]\s*/i, "");
  const tags = [...source.matchAll(/[【\[]([^】\]]+)[】\]]/g)].map((m) =>
    m[1].trim(),
  );
  const matches = settings.rules.filter(
    (r) => r.keyword.trim() && source.includes(r.keyword.trim()),
  );
  const matchedCategories = [
    ...new Set(matches.map((r) => r.category.trim()).filter(Boolean)),
  ];
  let category = matchedCategories.length === 1 ? matchedCategories[0] : "";
  if (!matches.length) {
    const categories = new Set<string>();
    for (const tag of tags) {
      if (/^(活动|活动中心|运营活动)$/.test(tag)) categories.add("运营活动");
      if (/^商业化$/.test(tag)) categories.add("商业化");
      if (/^系统$/.test(tag)) categories.add("系统");
      if (tag.includes("&") && tag.includes("商业化")) {
        categories.add("商业化");
        categories.add("运营活动");
      }
    }
    if (categories.size === 1) category = [...categories][0];
  }
  title = title
    .replace(/[【\[]([^】\]]+)[】\]]/g, (whole, tag: string) => {
      const t = tag.trim();
      return isNoiseTag(t) ||
        /^(活动|活动中心|运营活动|商业化|系统)$/.test(t) ||
        (!!category && t === "时装&商业化活动")
        ? ""
        : whole;
    })
    .trim();
  // Only leading content tags become activity names. Retain trailing author/content tags.
  const prefix = title.match(/^(?:[【\[][^】\]]+[】\]]\s*)+/)?.[0] ?? "";
  if (prefix) {
    const body = title.slice(prefix.length).trim();
    const names = [...prefix.matchAll(/[【\[]([^】\]]+)[】\]]/g)].map(
      (m) => m[1],
    );
    title = [...names.filter((name) => !body.startsWith(name)), body]
      .filter(Boolean)
      .join(" ");
  }
  return {
    title: title.replace(/[\t\r\n\u00a0 ]+/g, " ").trim(),
    category,
    level,
  };
}

export function buildReport(
  state: Pick<LocalState, "capture" | "overrides" | "budgets" | "settings">,
  period: Period,
): Report {
  dateRange(period.start, period.end);
  const all: PreparedItem[] = (state.capture?.items ?? []).map((raw) => {
    const base = cleanTitle(raw.title, state.settings),
      o = state.overrides[raw.key] ?? {};
    const dates = [
      ...new Set(o.dates ?? [raw.processedAt.slice(0, 10)]),
    ].sort();
    const changed =
      !!o.sourceSignature &&
      o.sourceSignature !== signature(raw) &&
      o.acknowledgedSignature !== signature(raw);
    return {
      ...raw,
      cleanTitle: o.title ?? base.title,
      category: o.category ?? base.category,
      level: o.level ?? base.level,
      included: o.included !== false,
      dates,
      allocations: {},
      mergeId: o.mergeId,
      changed,
      issues: [],
    };
  });
  const issues: string[] = [];
  if (state.capture && !captureCovers(state.capture, period))
    issues.push(
      `当前快照仅覆盖 ${captureScopeLabel(state.capture)}，请按所选日期重新抓取`,
    );
  const days = new Map<string, PreparedItem[]>();
  for (const item of all) {
    if (!item.included) continue;
    for (const date of item.dates) {
      if (!validDate(date)) {
        item.issues.push("工作日期缺失或无效");
        continue;
      }
      const group = days.get(date) ?? [];
      group.push(item);
      days.set(date, group);
    }
  }
  const dayResults: Report["days"] = [];
  for (const [date, items] of days) {
    items.sort((a, b) => a.key.localeCompare(b.key));
    const budget = state.budgets[date] ?? 100;
    const locked = items.filter(
      (i) => state.overrides[i.key]?.lockedUnits?.[date] !== undefined,
    );
    const flexible = items.filter((i) => !locked.includes(i));
    let fixed = 0;
    for (const item of locked) {
      const units = state.overrides[item.key].lockedUnits![date];
      if (!Number.isSafeInteger(units) || units < 0)
        item.issues.push(`${date} 人天无效`);
      item.allocations[date] = units;
      fixed += units;
    }
    const remaining = Math.max(0, budget - fixed);
    flexible.forEach((item, index) => {
      item.allocations[date] =
        Math.floor(remaining / flexible.length) +
        (index < remaining % flexible.length ? 1 : 0);
    });
    const allocated = items.reduce((sum, i) => sum + i.allocations[date], 0);
    if (inPeriod(date, period)) {
      dayResults.push({ date, budget, allocated });
      if (!Number.isSafeInteger(budget) || budget < 0 || allocated !== budget)
        issues.push(
          `${date}：分配 ${effortText(allocated)} 人天与每日总量 ${effortText(budget)} 不一致`,
        );
    }
  }
  const visible = all.filter(
    (item) =>
      item.dates.some((d) => inPeriod(d, period)) ||
      (!item.dates.every(validDate) &&
        inPeriod(item.processedAt.slice(0, 10), period)),
  );
  const entries = new Map<string, ReportEntry>();
  for (const item of visible) {
    if (!item.included) continue;
    if (!item.cleanTitle.trim()) item.issues.push("事项标题为空");
    if (!item.category.trim()) item.issues.push("分类待确认");
    if (!validLevel(item.level)) item.issues.push("S 等级待确认");
    if (item.changed) item.issues.push("源记录已变化，请核对");
    if (item.issues.length)
      issues.push(`${item.shortId}：${item.issues.join("；")}`);
    const dates = item.dates.filter((d) => inPeriod(d, period));
    const entryKey = item.mergeId ?? item.key;
    const entry = entries.get(entryKey) ?? {
      key: entryKey,
      sourceKeys: [],
      title: item.cleanTitle,
      category: item.category,
      level: item.level,
      dates: [],
      allocations: {},
      units: 0,
    };
    if (
      entries.has(entryKey) &&
      (entry.title !== item.cleanTitle ||
        entry.level !== item.level ||
        entry.category !== item.category)
    )
      issues.push(`${item.shortId}：合并事项的标题、分类和等级需一致`);
    entry.sourceKeys.push(item.key);
    for (const date of dates) {
      entry.allocations[date] =
        (entry.allocations[date] ?? 0) + (item.allocations[date] ?? 0);
    }
    entry.dates = Object.keys(entry.allocations).sort();
    entry.units = Object.values(entry.allocations).reduce((a, b) => a + b, 0);
    entries.set(entryKey, entry);
  }
  const sorted = [...entries.values()]
    .filter((e) => e.dates.length)
    .sort(
      (a, b) =>
        a.dates[0].localeCompare(b.dates[0]) ||
        a.dates.join().localeCompare(b.dates.join()) ||
        a.level.localeCompare(b.level, "en", { numeric: true }) ||
        a.key.localeCompare(b.key),
    );
  for (const entry of sorted)
    if (
      dateRange(entry.dates[0], entry.dates.at(-1)!).length !==
      entry.dates.length
    )
      issues.push(`${entry.title}：合并日期不连续，请拆分或调整`);
  return {
    items: visible.sort(
      (a, b) =>
        a.dates[0].localeCompare(b.dates[0]) || a.key.localeCompare(b.key),
    ),
    entries: sorted,
    issues: [...new Set(issues)],
    includedCount: visible.filter((i) => i.included).length,
    dayCount: dayResults.length,
    totalUnits: sorted.reduce((sum, entry) => sum + entry.units, 0),
    days: dayResults.sort((a, b) => a.date.localeCompare(b.date)),
  };
}
export function reportGroups(entries: ReportEntry[]) {
  const groups = new Map<
    string,
    { label: string; units: number; entries: ReportEntry[] }
  >();
  for (const entry of entries) {
    const key = `${entry.dates.join(",")}|${entry.level}`;
    const group = groups.get(key) ?? {
      label: `${dateLabel(entry.dates)}（${entry.level || "待确认"}）`,
      units: 0,
      entries: [],
    };
    group.units += entry.units;
    group.entries.push(entry);
    groups.set(key, group);
  }
  return [...groups.values()];
}
export function weeklyText(report: Report, draft = false): string {
  const body = report.days
    .map((day) => {
      const entries = report.entries.filter((entry) =>
        Object.prototype.hasOwnProperty.call(entry.allocations, day.date),
      );
      const levels = [
        ...new Set(entries.map((entry) => entry.level || "待确认")),
      ].sort((a, b) => {
        const aValid = validLevel(a),
          bValid = validLevel(b);
        if (aValid !== bValid) return aValid ? -1 : 1;
        return a.localeCompare(b, "en", { numeric: true });
      });
      const heading = `${shortDate(day.date)}（${levels.join("/")}）${effortText(day.allocated)}人天`;
      return [
        heading,
        ...entries.map(
          (entry) => `【${entry.category || "待分类"}】${entry.title}`,
        ),
      ].join("\n");
    })
    .join("\n");
  return (draft ? "【草稿：采集或整理尚未完成】\n" : "") + body;
}
export const escapeHtml = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
export const weeklyHtml = (report: Report, draft = false) =>
  `<table style="border-collapse:collapse"><tbody><tr><td style="border:1px solid #d9e1e5;white-space:pre-wrap">${escapeHtml(weeklyText(report, draft)).replace(/\n/g, "<br>")}</td></tr></tbody></table>`;
export const weeklyMarkdown = (report: Report, draft = false) =>
  `| 周报 |\n| --- |\n| ${weeklyText(report, draft).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\|/g, "\\|").replace(/\n/g, "<br>")} |\n`;
