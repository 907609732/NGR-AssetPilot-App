// integrations/tapd-report/src/main/store.ts
import initSqlJs from "sql.js";
import { createRequire } from "node:module";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync
} from "node:fs";
import { dirname, join } from "node:path";

// integrations/tapd-report/src/shared/report.ts
var defaultSettings = {
  person: "\u9648\u6708\u8D22",
  supplier: "\u90D1\u5DDE\u540D\u5320\u7F51\u7EDC\u79D1\u6280\u6709\u9650\u516C\u53F8",
  unit: "\u4EBA\u65E5(\u9ED8\u8BA4)",
  testOrder: "\u5426",
  content: "\u4EA4\u4E92\u754C\u9762",
  width: 2560,
  height: 1440,
  method: "\u9AD8\u6A21\u6E32\u67D3",
  productionLevel: "",
  rules: [
    { keyword: "\u620F\u5F71\u8776\u68A6", category: "\u8FD0\u8425\u6D3B\u52A8" },
    { keyword: "\u620F\u5F71\u789F\u68A6", category: "\u8FD0\u8425\u6D3B\u52A8" },
    { keyword: "\u59D1\u5C04\u4FA0\u5BA2\u884C", category: "\u5546\u4E1A\u5316" },
    { keyword: "\u7A37\u4E0B\u767E\u6653\u751F", category: "\u8FD0\u8425\u6D3B\u52A8" },
    { keyword: "\u9996\u5145\u6709\u793C", category: "\u5546\u4E1A\u5316" },
    { keyword: "\u86CB\u7CD5\u578B\u5C0F\u989D\u62BD\u5956", category: "\u5546\u4E1A\u5316" },
    { keyword: "\u8FF7\u4F60\u51AC\u6D3B", category: "\u8FD0\u8425\u6D3B\u52A8" },
    { keyword: "\u674E\u767D\u89D2\u8272\u6D3B\u52A8", category: "\u8FD0\u8425\u6D3B\u52A8" },
    { keyword: "\u738B\u8005\u5468\u5E74\u5E86\u62CD\u7167", category: "\u8FD0\u8425\u6D3B\u52A8" },
    { keyword: "\u798F\u6C14\u8FDE\u73E0", category: "\u5546\u4E1A\u5316" }
  ]
};
var signature = (item) => JSON.stringify([item.title, item.processedAt, item.status]);
function normalizeLevel(value) {
  const text = value.trim().toUpperCase();
  const match = text.match(/^(?:S\s*)?(\d+)$/);
  return match ? `S${match[1].replace(/^0+(?=\d)/, "")}` : text;
}
var validLevel = (value) => /^S(?:0|[1-9]\d*)$/.test(value);
function validDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = /* @__PURE__ */ new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(+d) && d.toISOString().slice(0, 10) === value;
}
function addDays(value, days) {
  if (!validDate(value)) throw new Error("\u65E5\u671F\u683C\u5F0F\u4E0D\u6B63\u786E");
  return new Date(Date.parse(`${value}T00:00:00Z`) + days * 864e5).toISOString().slice(0, 10);
}
function dateRange(start, end) {
  if (!validDate(start) || !validDate(end) || end < start)
    throw new Error("\u5F00\u59CB\u548C\u7ED3\u675F\u65E5\u671F\u4E0D\u6B63\u786E");
  const length = Math.round((Date.parse(end) - Date.parse(start)) / 864e5) + 1;
  if (length > 370) throw new Error("\u5355\u6B21\u65E5\u671F\u8303\u56F4\u6700\u591A 370 \u5929");
  return Array.from({ length }, (_, i) => addDays(start, i));
}
function todayShanghai() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(/* @__PURE__ */ new Date());
  return ["year", "month", "day"].map((t) => parts.find((p) => p.type === t)?.value).join("-");
}
function monthPeriod(month) {
  if (!/^\d{4}-\d{2}$/.test(month) || !validDate(`${month}-01`))
    throw new Error("\u8BF7\u9009\u62E9\u6709\u6548\u6708\u4EFD");
  const start = `${month}-01`;
  const next = new Date(
    Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5)), 1)
  ).toISOString().slice(0, 10);
  return { start, end: addDays(next, -1) };
}
function weekPeriod(today = todayShanghai()) {
  const day = (/* @__PURE__ */ new Date(`${today}T00:00:00Z`)).getUTCDay();
  const start = addDays(today, -((day + 6) % 7));
  return { start, end: addDays(start, 6) };
}
var inPeriod = (d, p) => validDate(d) && d >= p.start && d <= p.end;
function captureCovers(capture, period) {
  if (!capture) return false;
  return capture.scope?.kind !== "range" || capture.scope.period.start <= period.start && capture.scope.period.end >= period.end;
}
var captureScopeLabel = (capture) => capture.scope?.kind === "range" ? `${capture.scope.period.start} \u81F3 ${capture.scope.period.end}` : "\u5168\u90E8\u5386\u53F2";
var effortText = (units) => (units / 100).toFixed(2).replace(/\.?0+$/, "") || "0";
var shortDate = (d) => `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`;
var dateLabel = (dates) => dates.length > 1 ? `${shortDate(dates[0])}-${shortDate(dates[dates.length - 1])}` : shortDate(dates[0]);
function isNoiseTag(tag) {
  return /^(S\d+|OT|NGR|BUG|必现|偶现|一般|严重|轻微|兼容适配(?:PC)?|热更申请)$/i.test(
    tag
  ) || /^(?:PC|iOS|Android|Harmony|安卓|通用)(?:[\s/、&和]|通用|$)/i.test(tag) || /^(?:双端|双折叠|双端平板|双端折叠|安卓通用|折叠屏|平板)/i.test(tag) || /^(?:i[3579]-|RTX\s|RX\s|Ryzen\s|Ultra\s|Titan\s|TMC-|HUAWEI\s|iPhone\s|Vivo\s|OPPO\s|Realme\s|Xiaomi\s)/i.test(
    tag
  ) || /^\d+\s*(?:GB?|×\d+|x\d+)$/i.test(tag);
}
function cleanTitle(raw, settings) {
  const source = raw.trim();
  const leading = source.match(/^(?:[【\[(（][^】\])）]+[】\])）]\s*)+/)?.[0] ?? "";
  const level = normalizeLevel(
    leading.match(/[【\[(（]\s*(S\d+)\s*[】\])）]/i)?.[1] ?? ""
  );
  let title = source.replace(/^[（(]\s*S\d+\s*[）)]\s*/i, "");
  const tags = [...source.matchAll(/[【\[]([^】\]]+)[】\]]/g)].map(
    (m) => m[1].trim()
  );
  const matches = settings.rules.filter(
    (r) => r.keyword.trim() && source.includes(r.keyword.trim())
  );
  const matchedCategories = [
    ...new Set(matches.map((r) => r.category.trim()).filter(Boolean))
  ];
  let category = matchedCategories.length === 1 ? matchedCategories[0] : "";
  if (!matches.length) {
    const categories = /* @__PURE__ */ new Set();
    for (const tag of tags) {
      if (/^(活动|活动中心|运营活动)$/.test(tag)) categories.add("\u8FD0\u8425\u6D3B\u52A8");
      if (/^商业化$/.test(tag)) categories.add("\u5546\u4E1A\u5316");
      if (/^系统$/.test(tag)) categories.add("\u7CFB\u7EDF");
      if (tag.includes("&") && tag.includes("\u5546\u4E1A\u5316")) {
        categories.add("\u5546\u4E1A\u5316");
        categories.add("\u8FD0\u8425\u6D3B\u52A8");
      }
    }
    if (categories.size === 1) category = [...categories][0];
  }
  title = title.replace(/[【\[]([^】\]]+)[】\]]/g, (whole, tag) => {
    const t = tag.trim();
    return isNoiseTag(t) || /^(活动|活动中心|运营活动|商业化|系统)$/.test(t) || !!category && t === "\u65F6\u88C5&\u5546\u4E1A\u5316\u6D3B\u52A8" ? "" : whole;
  }).trim();
  const prefix = title.match(/^(?:[【\[][^】\]]+[】\]]\s*)+/)?.[0] ?? "";
  if (prefix) {
    const body = title.slice(prefix.length).trim();
    const names = [...prefix.matchAll(/[【\[]([^】\]]+)[】\]]/g)].map(
      (m) => m[1]
    );
    title = [...names.filter((name) => !body.startsWith(name)), body].filter(Boolean).join(" ");
  }
  return {
    title: title.replace(/[\t\r\n\u00a0 ]+/g, " ").trim(),
    category,
    level
  };
}
function buildReport(state, period) {
  dateRange(period.start, period.end);
  const all = (state.capture?.items ?? []).map((raw) => {
    const base = cleanTitle(raw.title, state.settings), o = state.overrides[raw.key] ?? {};
    const dates = [
      ...new Set(o.dates ?? [raw.processedAt.slice(0, 10)])
    ].sort();
    const changed = !!o.sourceSignature && o.sourceSignature !== signature(raw) && o.acknowledgedSignature !== signature(raw);
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
      issues: []
    };
  });
  const issues = [];
  if (state.capture && !captureCovers(state.capture, period))
    issues.push(
      `\u5F53\u524D\u5FEB\u7167\u4EC5\u8986\u76D6 ${captureScopeLabel(state.capture)}\uFF0C\u8BF7\u6309\u6240\u9009\u65E5\u671F\u91CD\u65B0\u6293\u53D6`
    );
  const days = /* @__PURE__ */ new Map();
  for (const item of all) {
    if (!item.included) continue;
    for (const date of item.dates) {
      if (!validDate(date)) {
        item.issues.push("\u5DE5\u4F5C\u65E5\u671F\u7F3A\u5931\u6216\u65E0\u6548");
        continue;
      }
      const group = days.get(date) ?? [];
      group.push(item);
      days.set(date, group);
    }
  }
  const dayResults = [];
  for (const [date, items] of days) {
    items.sort((a, b) => a.key.localeCompare(b.key));
    const budget = state.budgets[date] ?? 100;
    const locked = items.filter(
      (i) => state.overrides[i.key]?.lockedUnits?.[date] !== void 0
    );
    const flexible = items.filter((i) => !locked.includes(i));
    let fixed = 0;
    for (const item of locked) {
      const units = state.overrides[item.key].lockedUnits[date];
      if (!Number.isSafeInteger(units) || units < 0)
        item.issues.push(`${date} \u4EBA\u5929\u65E0\u6548`);
      item.allocations[date] = units;
      fixed += units;
    }
    const remaining = Math.max(0, budget - fixed);
    flexible.forEach((item, index) => {
      item.allocations[date] = Math.floor(remaining / flexible.length) + (index < remaining % flexible.length ? 1 : 0);
    });
    const allocated = items.reduce((sum, i) => sum + i.allocations[date], 0);
    if (inPeriod(date, period)) {
      dayResults.push({ date, budget, allocated });
      if (!Number.isSafeInteger(budget) || budget < 0 || allocated !== budget)
        issues.push(
          `${date}\uFF1A\u5206\u914D ${effortText(allocated)} \u4EBA\u5929\u4E0E\u6BCF\u65E5\u603B\u91CF ${effortText(budget)} \u4E0D\u4E00\u81F4`
        );
    }
  }
  const visible = all.filter(
    (item) => item.dates.some((d) => inPeriod(d, period)) || !item.dates.every(validDate) && inPeriod(item.processedAt.slice(0, 10), period)
  );
  const entries = /* @__PURE__ */ new Map();
  for (const item of visible) {
    if (!item.included) continue;
    if (!item.cleanTitle.trim()) item.issues.push("\u4E8B\u9879\u6807\u9898\u4E3A\u7A7A");
    if (!item.category.trim()) item.issues.push("\u5206\u7C7B\u5F85\u786E\u8BA4");
    if (!validLevel(item.level)) item.issues.push("S \u7B49\u7EA7\u5F85\u786E\u8BA4");
    if (item.changed) item.issues.push("\u6E90\u8BB0\u5F55\u5DF2\u53D8\u5316\uFF0C\u8BF7\u6838\u5BF9");
    if (item.issues.length)
      issues.push(`${item.shortId}\uFF1A${item.issues.join("\uFF1B")}`);
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
      units: 0
    };
    if (entries.has(entryKey) && (entry.title !== item.cleanTitle || entry.level !== item.level || entry.category !== item.category))
      issues.push(`${item.shortId}\uFF1A\u5408\u5E76\u4E8B\u9879\u7684\u6807\u9898\u3001\u5206\u7C7B\u548C\u7B49\u7EA7\u9700\u4E00\u81F4`);
    entry.sourceKeys.push(item.key);
    for (const date of dates) {
      entry.allocations[date] = (entry.allocations[date] ?? 0) + (item.allocations[date] ?? 0);
    }
    entry.dates = Object.keys(entry.allocations).sort();
    entry.units = Object.values(entry.allocations).reduce((a, b) => a + b, 0);
    entries.set(entryKey, entry);
  }
  const sorted = [...entries.values()].filter((e) => e.dates.length).sort(
    (a, b) => a.dates[0].localeCompare(b.dates[0]) || a.dates.join().localeCompare(b.dates.join()) || a.level.localeCompare(b.level, "en", { numeric: true }) || a.key.localeCompare(b.key)
  );
  for (const entry of sorted)
    if (dateRange(entry.dates[0], entry.dates.at(-1)).length !== entry.dates.length)
      issues.push(`${entry.title}\uFF1A\u5408\u5E76\u65E5\u671F\u4E0D\u8FDE\u7EED\uFF0C\u8BF7\u62C6\u5206\u6216\u8C03\u6574`);
  return {
    items: visible.sort(
      (a, b) => a.dates[0].localeCompare(b.dates[0]) || a.key.localeCompare(b.key)
    ),
    entries: sorted,
    issues: [...new Set(issues)],
    includedCount: visible.filter((i) => i.included).length,
    dayCount: dayResults.length,
    totalUnits: sorted.reduce((sum, entry) => sum + entry.units, 0),
    days: dayResults.sort((a, b) => a.date.localeCompare(b.date))
  };
}
function reportGroups(entries) {
  const groups = /* @__PURE__ */ new Map();
  for (const entry of entries) {
    const key = `${entry.dates.join(",")}|${entry.level}`;
    const group = groups.get(key) ?? {
      label: `${dateLabel(entry.dates)}\uFF08${entry.level || "\u5F85\u786E\u8BA4"}\uFF09`,
      units: 0,
      entries: []
    };
    group.units += entry.units;
    group.entries.push(entry);
    groups.set(key, group);
  }
  return [...groups.values()];
}
function weeklyText(report, draft = false) {
  const body = report.days.map((day) => {
    const entries = report.entries.filter(
      (entry) => Object.prototype.hasOwnProperty.call(entry.allocations, day.date)
    );
    const levels = [
      ...new Set(entries.map((entry) => entry.level || "\u5F85\u786E\u8BA4"))
    ].sort((a, b) => {
      const aValid = validLevel(a), bValid = validLevel(b);
      if (aValid !== bValid) return aValid ? -1 : 1;
      return a.localeCompare(b, "en", { numeric: true });
    });
    const heading = `${shortDate(day.date)}\uFF08${levels.join("/")}\uFF09${effortText(day.allocated)}\u4EBA\u5929`;
    return [
      heading,
      ...entries.map(
        (entry) => `\u3010${entry.category || "\u5F85\u5206\u7C7B"}\u3011${entry.title}`
      )
    ].join("\n");
  }).join("\n");
  return (draft ? "\u3010\u8349\u7A3F\uFF1A\u91C7\u96C6\u6216\u6574\u7406\u5C1A\u672A\u5B8C\u6210\u3011\n" : "") + body;
}
var escapeHtml = (value) => value.replace(
  /[&<>"']/g,
  (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]
);
var weeklyHtml = (report, draft = false) => `<table style="border-collapse:collapse"><tbody><tr><td style="border:1px solid #d9e1e5;white-space:pre-wrap">${escapeHtml(weeklyText(report, draft)).replace(/\n/g, "<br>")}</td></tr></tbody></table>`;
var weeklyMarkdown = (report, draft = false) => `| \u5468\u62A5 |
| --- |
| ${weeklyText(report, draft).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\|/g, "\\|").replace(/\n/g, "<br>")} |
`;

// integrations/tapd-report/src/main/store.ts
var require2 = createRequire(import.meta.url);
var LocalStore = class _LocalStore {
  constructor(db, filename) {
    this.db = db;
    this.filename = filename;
  }
  static async open(directory) {
    mkdirSync(directory, { recursive: true });
    const SQL = await initSqlJs({
      locateFile: (file) => require2.resolve(`sql.js/dist/${file}`)
    });
    const filename = join(directory, "reports.sqlite");
    const db = new SQL.Database(
      existsSync(filename) ? readFileSync(filename) : void 0
    );
    db.run(`CREATE TABLE IF NOT EXISTS snapshots (id TEXT PRIMARY KEY, captured_at TEXT NOT NULL, account TEXT NOT NULL, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS overrides (account TEXT NOT NULL, item_key TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(account,item_key));
      CREATE TABLE IF NOT EXISTS budgets (account TEXT NOT NULL, date TEXT NOT NULL, units INTEGER NOT NULL, PRIMARY KEY(account,date));
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS exports (id INTEGER PRIMARY KEY AUTOINCREMENT, account TEXT NOT NULL, at TEXT NOT NULL, path TEXT NOT NULL, kind TEXT NOT NULL, draft INTEGER NOT NULL);`);
    const store = new _LocalStore(db, filename);
    store.flush();
    return store;
  }
  query(sql, params = []) {
    const statement = this.db.prepare(sql);
    statement.bind(params);
    const rows = [];
    try {
      while (statement.step()) rows.push(statement.getAsObject());
    } finally {
      statement.free();
    }
    return rows;
  }
  flush() {
    mkdirSync(dirname(this.filename), { recursive: true });
    writeFileSync(`${this.filename}.next`, this.db.export());
    renameSync(`${this.filename}.next`, this.filename);
  }
  activeId() {
    return this.query(
      "SELECT payload FROM settings WHERE key='activeSnapshot'"
    )[0]?.payload;
  }
  load() {
    const selected = this.activeId();
    const snapshot = selected ? this.query("SELECT payload FROM snapshots WHERE id=?", [selected])[0] : void 0;
    const capture = snapshot ? JSON.parse(snapshot.payload) : null;
    const account = capture?.account ?? "";
    const settingsRow = this.query(
      "SELECT payload FROM settings WHERE key='template'"
    )[0];
    return {
      capture,
      overrides: Object.fromEntries(
        this.query("SELECT item_key,payload FROM overrides WHERE account=?", [
          account
        ]).map((r) => [r.item_key, JSON.parse(r.payload)])
      ),
      budgets: Object.fromEntries(
        this.query("SELECT date,units FROM budgets WHERE account=?", [
          account
        ]).map((r) => [r.date, r.units])
      ),
      settings: settingsRow ? JSON.parse(settingsRow.payload) : structuredClone(defaultSettings),
      history: this.query(
        "SELECT id,captured_at,payload FROM snapshots WHERE account=? ORDER BY captured_at DESC LIMIT 30",
        [account]
      ).map((r) => {
        const c = JSON.parse(r.payload);
        return {
          id: r.id,
          capturedAt: r.captured_at,
          loaded: c.loaded,
          complete: c.complete,
          scope: c.scope
        };
      }),
      exports: this.query(
        "SELECT at,path,kind,draft FROM exports WHERE account=? ORDER BY id DESC LIMIT 30",
        [account]
      ).map((r) => ({
        at: r.at,
        path: r.path,
        kind: r.kind,
        draft: !!r.draft
      }))
    };
  }
  capture(capture) {
    this.db.run("INSERT INTO snapshots VALUES (?,?,?,?)", [
      capture.id,
      capture.capturedAt,
      capture.account,
      JSON.stringify(capture)
    ]);
    this.db.run("INSERT OR REPLACE INTO settings VALUES ('activeSnapshot',?)", [
      capture.id
    ]);
    this.flush();
    return this.load();
  }
  restore(id) {
    const state = this.load();
    if (!this.query("SELECT id FROM snapshots WHERE id=? AND account=?", [
      id,
      state.capture?.account ?? ""
    ]).length)
      throw new Error("\u627E\u4E0D\u5230\u8BE5\u8D26\u53F7\u7684\u91C7\u96C6\u8BB0\u5F55");
    this.db.run("INSERT OR REPLACE INTO settings VALUES ('activeSnapshot',?)", [
      id
    ]);
    this.flush();
    return this.load();
  }
  save(input) {
    const state = this.load(), account = state.capture?.account ?? "";
    this.db.run("BEGIN");
    let committed = false;
    try {
      if (input.overrides)
        for (const [key, patch] of Object.entries(input.overrides)) {
          const raw = state.capture?.items.find((i) => i.key === key);
          if (!raw) throw new Error("\u6E90\u8BB0\u5F55\u4E0D\u5B58\u5728\uFF0C\u8BF7\u91CD\u65B0\u6253\u5F00\u62A5\u8868");
          const current = state.overrides[key] ?? {};
          if (patch.dates && (!Array.isArray(patch.dates) || !patch.dates.length || patch.dates.length > 370 || !patch.dates.every(validDate)))
            throw new Error("\u5DE5\u4F5C\u65E5\u671F\u65E0\u6548");
          if (patch.level !== void 0 && typeof patch.level !== "string")
            throw new Error("S \u7B49\u7EA7\u683C\u5F0F\u65E0\u6548");
          const level = patch.level === void 0 ? void 0 : normalizeLevel(patch.level);
          if (level !== void 0 && level !== "" && !validLevel(level))
            throw new Error("\u8BF7\u8F93\u5165 S \u52A0\u975E\u8D1F\u6574\u6570\uFF0C\u4F8B\u5982 S4 \u6216 4");
          if (patch.lockedUnits && Object.entries(patch.lockedUnits).some(
            ([d, u]) => !validDate(d) || !Number.isSafeInteger(u) || u < 0
          ))
            throw new Error("\u4EBA\u5929\u5FC5\u987B\u4E3A\u975E\u8D1F\u6570\uFF0C\u6700\u591A\u4E24\u4F4D\u5C0F\u6570");
          for (const field of ["title", "category"])
            if (patch[field] !== void 0 && (typeof patch[field] !== "string" || patch[field].length > 2e4))
              throw new Error("\u6587\u672C\u5185\u5BB9\u65E0\u6548");
          const merged = {
            ...current,
            ...patch,
            ...level !== void 0 ? { level } : {},
            sourceSignature: current.sourceSignature ?? signature(raw)
          };
          this.db.run("INSERT OR REPLACE INTO overrides VALUES (?,?,?)", [
            account,
            key,
            JSON.stringify(merged)
          ]);
        }
      if (input.budgets)
        for (const [date, units] of Object.entries(input.budgets)) {
          if (!validDate(date) || !Number.isSafeInteger(units) || units < 0)
            throw new Error("\u6BCF\u65E5\u4EBA\u5929\u65E0\u6548");
          this.db.run("INSERT OR REPLACE INTO budgets VALUES (?,?,?)", [
            account,
            date,
            units
          ]);
        }
      if (input.settings) {
        const settings = input.settings;
        if (!settings.person?.trim() || !settings.supplier?.trim() || !Number.isFinite(settings.width) || !Number.isFinite(settings.height) || settings.width <= 0 || settings.height <= 0 || !Array.isArray(settings.rules) || settings.rules.length > 1e3 || settings.rules.some(
          (r) => typeof r.keyword !== "string" || typeof r.category !== "string" || !r.keyword.trim() || !r.category.trim()
        ))
          throw new Error("\u8BF7\u68C0\u67E5\u59D3\u540D\u3001\u4F9B\u5E94\u5546\u3001\u5C3A\u5BF8\u548C\u5206\u7C7B\u89C4\u5219");
        this.db.run("INSERT OR REPLACE INTO settings VALUES ('template',?)", [
          JSON.stringify(settings)
        ]);
      }
      this.db.run("COMMIT");
      committed = true;
      this.flush();
      return this.load();
    } catch (error) {
      if (!committed) this.db.run("ROLLBACK");
      throw error;
    }
  }
  recordExport(path, kind, draft) {
    this.db.run(
      "INSERT INTO exports(account,at,path,kind,draft) VALUES (?,?,?,?,?)",
      [
        this.load().capture?.account ?? "",
        (/* @__PURE__ */ new Date()).toISOString(),
        path,
        kind,
        Number(draft)
      ]
    );
    this.flush();
  }
  clearReportData() {
    this.db.run("BEGIN");
    let committed = false;
    try {
      this.db.run("DELETE FROM snapshots");
      this.db.run("DELETE FROM overrides");
      this.db.run("DELETE FROM budgets");
      this.db.run("DELETE FROM exports");
      this.db.run("DELETE FROM settings WHERE key='activeSnapshot'");
      this.db.run("COMMIT");
      committed = true;
      this.flush();
      return this.load();
    } catch (error) {
      if (!committed) this.db.run("ROLLBACK");
      throw error;
    }
  }
  close() {
    this.flush();
    this.db.close();
  }
};

// integrations/tapd-report/src/main/collector.ts
import { chromium } from "playwright-core";
import { mkdirSync as mkdirSync2 } from "node:fs";

// integrations/tapd-report/src/main/collect-page.ts
import { randomUUID } from "node:crypto";

// integrations/tapd-report/src/main/tapd-dom.ts
function readTapdDOM() {
  const text = (e) => e?.textContent?.trim() ?? "";
  const projects = /* @__PURE__ */ new Map();
  document.querySelectorAll("a[href]").forEach((a) => {
    const match = a.getAttribute("href")?.match(/\/tapd_fe\/(\d+)\/(?:story|bug|task)\//);
    if (match && text(a) && !/^\d+$/.test(text(a)))
      projects.set(match[1], text(a));
  });
  const invalid = [];
  const items = [];
  const heads = [...document.querySelectorAll(".item-head")];
  const groups = heads.map((head, index) => {
    const parent = head.parentElement;
    const name = text(head.querySelector(".item-name")) || `\u5206\u7EC4${index + 1}`;
    const expected = Number(
      text(head.querySelector(".item-total")).replace(/[^0-9]/g, "")
    );
    const container = parent.querySelector(
      ".item-container"
    );
    const collapsed = !!container && getComputedStyle(container).display === "none";
    const rows = parent.querySelectorAll("tr[workspace_id][type]");
    rows.forEach((row) => {
      const id = row.getAttribute("id") ?? "";
      const workspaceId = row.getAttribute("workspace_id") ?? "";
      const type = row.getAttribute("type") ?? "";
      const titleEl = row.querySelector(
        ".title-input__link--clickable, .title-input__link"
      );
      const title = text(titleEl);
      const timeEl = row.querySelector('[data-grid-field="done_time"]');
      const processedAt = timeEl?.getAttribute("data-grid-value") || text(timeEl);
      if (!id || !workspaceId || !type || !title || !/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/.test(processedAt)) {
        invalid.push(`\u5206\u7EC4${name}\u4E2D\u6709\u8BB0\u5F55\u7F3A\u5C11ID\u3001\u6807\u9898\u6216\u5904\u7406\u65F6\u95F4`);
        return;
      }
      const linkEl = row.querySelector('[data-grid-field="id"] [href]');
      items.push({
        key: `${workspaceId}:${type}:${id}`,
        id,
        workspaceId,
        type,
        title,
        workspaceName: projects.get(workspaceId) ?? workspaceId,
        shortId: text(linkEl) || id,
        typeLabel: text(row.querySelector(".workitem-icon")) || type,
        status: text(row.querySelector('[data-grid-field="status"]')),
        owner: row.querySelector('[data-grid-field="owner"]')?.getAttribute("data-grid-value") ?? "",
        processedAt: processedAt.replace("T", " ").slice(0, 19),
        url: linkEl?.getAttribute("href") || titleEl?.getAttribute("href") || "",
        group: name
      });
    });
    return { name, expected, collapsed, index };
  });
  const totalText = text(
    document.querySelector(".operation-right__filter-info")
  );
  const totalMatch = totalText.match(/共\s*([\d,]+)\s*个/);
  const active = text(
    document.querySelector(
      ".worktable-tab-left:not(.new-tab-left) .list-item--active"
    )
  );
  const account = document.querySelector(".avatar-nav")?.getAttribute("title") ?? "";
  const scopes = ["space", "category"].map(
    (s) => text(document.querySelector(`.item-value__${s} > .tapd-select-tag`))
  );
  const filters = [
    ...document.querySelectorAll(
      ".tapd-filter-item__value:not(.tapd-filter-item__value--empty)"
    )
  ].map((e) => text(e));
  const keyword = document.querySelector(
    ".tapd-filter-item--keyword input"
  )?.value ?? "";
  return {
    account,
    active,
    scopes,
    filters,
    keyword,
    total: totalMatch ? Number(totalMatch[1].replace(/,/g, "")) : null,
    groups,
    items,
    invalid
  };
}

// integrations/tapd-report/src/main/capture-range.ts
function groupMayIntersect(name, period, today) {
  const canonical = name === "\u672C\u5E74" ? "\u4ECA\u5E74" : name;
  if (!["\u672C\u5468", "\u672C\u6708", "\u4ECA\u5E74", "\u5176\u4ED6"].includes(canonical)) return true;
  const week = weekPeriod(today);
  return dateRange(period.start, period.end).some((date) => {
    if (date > today) return false;
    const bucket = inPeriod(date, week) ? "\u672C\u5468" : date.slice(0, 7) === today.slice(0, 7) ? "\u672C\u6708" : date.slice(0, 4) === today.slice(0, 4) ? "\u4ECA\u5E74" : "\u5176\u4ED6";
    return bucket === canonical;
  });
}
function hasDescendingDates(dates) {
  return dates.every((date, index) => index === 0 || dates[index - 1] >= date);
}

// integrations/tapd-report/src/main/collect-page.ts
async function collectPage(page, scope, check, progress, settle) {
  const today = todayShanghai();
  const capture = {
    id: randomUUID(),
    capturedAt: (/* @__PURE__ */ new Date()).toISOString(),
    scope,
    account: "",
    total: null,
    pageTotal: null,
    scanned: 0,
    loaded: 0,
    complete: false,
    issues: [],
    items: [],
    groups: []
  };
  const byKey = /* @__PURE__ */ new Map();
  const scanned = /* @__PURE__ */ new Set();
  const label = captureScopeLabel(capture);
  const verify = (dom) => {
    check();
    if (!dom.account || capture.account && capture.account !== dom.account)
      throw new Error("\u767B\u5F55\u5DF2\u5931\u6548\u6216\u8D26\u53F7\u53D1\u751F\u53D8\u5316\uFF0C\u8BF7\u91CD\u65B0\u767B\u5F55\u540E\u6293\u53D6");
    if (dom.active !== "\u5DF2\u529E") throw new Error("\u5DF2\u79BB\u5F00\u5DF2\u529E\u9875\u9762\uFF0C\u8BF7\u91CD\u65B0\u6293\u53D6");
    if (dom.scopes.some((s) => s !== "\u6240\u6709") || dom.filters.length || dom.keyword)
      throw new Error("TAPD \u7B5B\u9009\u6761\u4EF6\u53D1\u751F\u53D8\u5316\uFF0C\u8BF7\u91CD\u65B0\u6293\u53D6");
  };
  const announce = (group) => progress({
    phase: "collecting",
    message: `\u6B63\u5728\u6293\u53D6${label} \xB7 ${group}\uFF1A\u5DF2\u7EB3\u5165 ${byKey.size} \u6761\uFF0C\u68C0\u67E5 ${scanned.size} \u6761`,
    loaded: byKey.size,
    total: scope.kind === "all" ? capture.pageTotal : null
  });
  try {
    await page.waitForFunction(
      () => {
        const text = document.querySelector(".operation-right__filter-info")?.textContent ?? "";
        return /共\s*0\s*个/.test(text) || document.querySelectorAll(".item-head").length > 0;
      },
      void 0,
      { timeout: 3e4 }
    );
    const first = await page.evaluate(readTapdDOM);
    verify(first);
    capture.account = first.account;
    capture.pageTotal = first.total;
    if (first.total === null)
      throw new Error("\u672A\u80FD\u8BFB\u53D6\u9875\u9762\u603B\u6570\uFF0C\u65E0\u6CD5\u6838\u5BF9\u91C7\u96C6\u8303\u56F4");
    capture.groups = first.groups.map((g) => ({
      name: g.name,
      expected: g.expected,
      loaded: 0,
      skipped: scope.kind === "range" && !groupMayIntersect(g.name, scope.period, today)
    }));
    if (scope.kind === "range" && first.groups.reduce((sum, group) => sum + group.expected, 0) !== first.total)
      throw new Error(
        "\u65F6\u95F4\u5206\u7EC4\u6570\u91CF\u4E0E\u9875\u9762\u603B\u6570\u4E0D\u4E00\u81F4\uFF0C\u65E0\u6CD5\u786E\u8BA4\u6240\u9009\u65E5\u671F\u662F\u5426\u5B8C\u6574\uFF0C\u8BF7\u91CD\u8BD5"
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
      await container.locator("tr[workspace_id][type]").first().waitFor({ state: "attached", timeout: 3e4 });
      await settle();
      const seen = /* @__PURE__ */ new Map();
      let stagnant = 0;
      for (let pass = 0; pass < 2e3; pass++) {
        const dom = await page.evaluate(readTapdDOM);
        verify(dom);
        if (dom.groups[group.index]?.name !== group.name || dom.groups[group.index]?.expected !== group.expected)
          throw new Error("\u91C7\u96C6\u671F\u95F4\u65F6\u95F4\u5206\u7EC4\u6216\u6570\u91CF\u53D1\u751F\u53D8\u5316\uFF0C\u8BF7\u91CD\u65B0\u6293\u53D6");
        const invalid = dom.invalid.filter(
          (s) => s.startsWith(`\u5206\u7EC4${group.name}\u4E2D`)
        );
        if (invalid.length) throw new Error(invalid[0]);
        for (const { group: _name, ...item } of dom.items.filter(
          (i) => i.group === group.name
        )) {
          seen.set(item.key, item);
          scanned.add(item.key);
          if (scope.kind === "all" || inPeriod(item.processedAt.slice(0, 10), scope.period))
            byKey.set(item.key, item);
        }
        result.loaded = seen.size;
        capture.loaded = byKey.size;
        capture.scanned = scanned.size;
        announce(group.name);
        if (seen.size > group.expected)
          throw new Error(`\u201C${group.name}\u201D\u7684\u8BB0\u5F55\u6570\u91CF\u8D85\u8FC7\u9875\u9762\u603B\u6570\uFF0C\u8BF7\u91CD\u8BD5`);
        if (seen.size === group.expected) break;
        if (scope.kind === "range") {
          const dates = [...seen.values()].map((i) => i.processedAt);
          if (!hasDescendingDates(dates))
            throw new Error(
              `\u201C${group.name}\u201D\u672A\u6309\u5904\u7406\u65F6\u95F4\u5012\u5E8F\u6392\u5217\uFF0C\u65E0\u6CD5\u63D0\u524D\u505C\u6B62\uFF1B\u8BF7\u4F7F\u7528\u201C\u6293\u53D6\u5168\u90E8\u5386\u53F2\u201D\u6838\u5BF9`
            );
          if (dates.length && dates.at(-1).slice(0, 10) < scope.period.start) {
            result.bounded = true;
            break;
          }
        }
        const lastRow = container.locator("tr[workspace_id][type]").last();
        if (await lastRow.count()) await lastRow.scrollIntoViewIfNeeded();
        await settle();
        const more = container.locator(".load-more").filter({ hasText: "\u5C55\u5F00\u66F4\u591A" });
        try {
          await more.waitFor({ state: "visible", timeout: 3e4 });
        } catch {
          throw new Error(
            `\u201C${group.name}\u201D\u5C1A\u672A\u8BFB\u5230\u65E5\u671F\u8FB9\u754C\u6216\u5168\u90E8\u8BB0\u5F55\uFF0C\u4F46\u52A0\u8F7D\u5165\u53E3\u672A\u51FA\u73B0\uFF0C\u8BF7\u91CD\u8BD5`
          );
        }
        check();
        const before = await container.locator("tr[workspace_id][type]").evaluateAll((es) => es.map((e) => e.id).join("|"));
        await more.click({ timeout: 15e3 });
        await settle();
        await page.waitForFunction(
          ({ index, before: before2 }) => [
            ...document.querySelectorAll(".item-head")[index]?.parentElement?.querySelectorAll(
              "tr[workspace_id][type]"
            ) ?? []
          ].map((e) => e.id).join("|") !== before2,
          { index: group.index, before },
          { timeout: 15e3 }
        ).catch(() => {
        });
        const after = await container.locator("tr[workspace_id][type]").evaluateAll((es) => es.map((e) => e.id).join("|"));
        stagnant = after === before ? stagnant + 1 : 0;
        if (stagnant >= 3)
          throw new Error("\u8FDE\u7EED\u4E09\u6B21\u52A0\u8F7D\u6CA1\u6709\u65B0\u589E\u8BB0\u5F55\uFF0C\u8BF7\u68C0\u67E5\u7F51\u7EDC\u540E\u91CD\u65B0\u6293\u53D6");
        if (pass === 1999)
          throw new Error("\u52A0\u8F7D\u6B21\u6570\u8FBE\u5230\u4E0A\u9650\uFF0C\u5C1A\u672A\u8BFB\u5230\u65E5\u671F\u8FB9\u754C");
      }
    }
    const final = await page.evaluate(readTapdDOM);
    verify(final);
    if (final.total !== first.total)
      throw new Error("\u91C7\u96C6\u671F\u95F4\u9875\u9762\u603B\u6570\u53D1\u751F\u53D8\u5316\uFF0C\u8BF7\u91CD\u65B0\u6293\u53D6");
    if (scope.kind === "all" && byKey.size !== final.total)
      throw new Error(`\u9875\u9762\u663E\u793A ${final.total} \u6761\uFF0C\u5B9E\u9645\u8BFB\u53D6 ${byKey.size} \u6761`);
    if (capture.groups.some(
      (g) => !g.skipped && !g.bounded && g.loaded !== g.expected
    ))
      throw new Error("\u6240\u9009\u8303\u56F4\u5185\u4ECD\u6709\u672A\u5B8C\u6574\u8BFB\u53D6\u7684\u5206\u7EC4");
    capture.complete = true;
    capture.total = scope.kind === "all" ? final.total : byKey.size;
  } catch (error) {
    if (!capture.account) throw error;
    capture.issues.push(error instanceof Error ? error.message : "\u91C7\u96C6\u5931\u8D25");
    capture.total = scope.kind === "all" ? capture.pageTotal ?? null : null;
  }
  capture.items = [...byKey.values()].sort(
    (a, b) => a.processedAt.localeCompare(b.processedAt) || a.key.localeCompare(b.key)
  );
  capture.loaded = capture.items.length;
  capture.scanned = scanned.size;
  progress({
    phase: capture.complete ? "complete" : "incomplete",
    message: capture.complete ? `\u5DF2\u5B8C\u6210${label}\u91C7\u96C6\uFF0C\u5171 ${capture.loaded} \u6761\u5DF2\u529E` : `\u5DF2\u4FDD\u5B58 ${capture.loaded} \u6761\u8349\u7A3F\uFF1A${capture.issues[0]}`,
    loaded: capture.loaded,
    total: capture.total
  });
  return capture;
}

// integrations/tapd-report/src/main/collector.ts
var WORK_URL = "https://tapd.tencent.com/tapd_fe/my/work";
var TapdCollector = class {
  constructor(profilePath, progress) {
    this.profilePath = profilePath;
    this.progress = progress;
  }
  context = null;
  page = null;
  stopped = false;
  running = false;
  async login() {
    if (this.running) throw new Error("\u6B63\u5728\u91C7\u96C6\uFF0C\u8BF7\u7B49\u5F85\u5B8C\u6210\u6216\u505C\u6B62");
    await this.browser();
    await this.page.bringToFront();
    this.progress({
      phase: "login",
      message: "\u4E13\u7528 Chrome \u5DF2\u6253\u5F00\u3002\u5B8C\u6210\u767B\u5F55\u540E\uFF0C\u9009\u62E9\u65E5\u671F\u5E76\u70B9\u51FB\u201C\u6293\u53D6\u6240\u9009\u65E5\u671F\u201D\u3002"
    });
    const page = this.page;
    void page.locator(".avatar-nav[title]").waitFor({ state: "attached", timeout: 18e5 }).then(() => {
      this.progress({
        phase: "ready",
        message: "\u767B\u5F55\u5DF2\u5C31\u7EEA\uFF0C\u53EF\u4EE5\u6293\u53D6\u5DF2\u529E\u3002"
      });
    }).catch(() => {
    });
  }
  async browser() {
    if (!this.context) {
      mkdirSync2(this.profilePath, { recursive: true });
      try {
        this.context = await chromium.launchPersistentContext(
          this.profilePath,
          {
            channel: "chrome",
            headless: false,
            viewport: null,
            acceptDownloads: false
          }
        );
      } catch {
        throw new Error(
          "\u65E0\u6CD5\u542F\u52A8\u4E13\u7528 Chrome\u3002\u8BF7\u786E\u8BA4\u5DF2\u5B89\u88C5 Chrome\uFF0C\u4E14\u4E0A\u4E00\u6B21\u91C7\u96C6\u7A97\u53E3\u5DF2\u5173\u95ED\u3002"
        );
      }
      this.context.on("close", () => {
        this.context = null;
        this.page = null;
      });
    }
    if (!this.page || this.page.isClosed()) {
      this.page = this.context.pages()[0] ?? await this.context.newPage();
      await this.page.goto(WORK_URL, {
        waitUntil: "domcontentloaded",
        timeout: 45e3
      });
    }
    return this.page;
  }
  cancel() {
    this.stopped = true;
  }
  check() {
    if (this.stopped) throw new Error("\u5DF2\u505C\u6B62\u91C7\u96C6\uFF0C\u5F53\u524D\u8BB0\u5F55\u4FDD\u5B58\u4E3A\u4E0D\u5B8C\u6574\u8349\u7A3F");
  }
  async settle(page) {
    await page.waitForTimeout(900);
    await page.locator(".el-loading-mask:visible").first().waitFor({ state: "hidden", timeout: 15e3 }).catch(() => {
    });
  }
  async resetScope(page) {
    const done = page.locator(".worktable-tab-left:not(.new-tab-left) .list-item").filter({ hasText: /^\s*已办\s*$/ });
    try {
      await done.waitFor({ state: "visible", timeout: 3e4 });
    } catch {
      throw new Error(
        "\u672A\u80FD\u6253\u5F00\u6211\u7684\u5DE5\u4F5C\uFF0C\u8BF7\u5728\u4E13\u7528 Chrome \u4E2D\u786E\u8BA4\u767B\u5F55\u548C\u7F51\u7EDC\u540E\u91CD\u8BD5"
      );
    }
    if (!(await done.getAttribute("class"))?.includes("list-item--active")) {
      await done.click();
      await this.settle(page);
    }
    const space = page.locator(".item-value__space");
    if ((await space.locator(":scope > .tapd-select-tag").innerText()).trim() !== "\u6240\u6709") {
      await space.click();
      await space.getByText("\u6240\u6709\u7A7A\u95F4", { exact: true }).click();
      await page.locator(".worktable-tab-left:not(.new-tab-left)").click();
      await this.settle(page);
    }
    const category = page.locator(".item-value__category");
    if ((await category.locator(":scope > .tapd-select-tag").innerText()).trim() !== "\u6240\u6709") {
      await category.click();
      for (let i = 0; i < 20; i++) {
        const unselected = category.locator(
          ".tapd-select-dropmenu__item:not(.selected):visible"
        );
        if (!await unselected.count()) break;
        await unselected.first().click();
      }
      await page.locator(".worktable-tab-left:not(.new-tab-left)").click();
      await this.settle(page);
    }
    if (!await page.locator(".tapd-filter__body").isVisible())
      await page.locator(".list-item__filter").click();
    const keyword = page.locator(".tapd-filter-item--keyword input");
    if (await keyword.count() && await keyword.inputValue()) {
      await keyword.fill("");
      await keyword.press("Enter");
      await this.settle(page);
    }
    for (let i = 0; i < 100; i++) {
      const active = page.locator(".tapd-filter-item").filter({
        has: page.locator(
          ".tapd-filter-item__value:not(.tapd-filter-item__value--empty)"
        )
      });
      if (!await active.count()) break;
      await active.first().locator(".close-field").click();
      await this.settle(page);
    }
    if (await page.locator(".tapd-filter__body").isVisible())
      await page.locator(".list-item__filter").click();
    await this.settle(page);
  }
  async collect(scope = {
    kind: "range",
    period: monthPeriod(todayShanghai().slice(0, 7))
  }) {
    if (this.running) throw new Error("\u5DF2\u6709\u91C7\u96C6\u6B63\u5728\u8FDB\u884C");
    if (!scope || !["range", "all"].includes(scope.kind))
      throw new Error("\u8BF7\u9009\u62E9\u91C7\u96C6\u65E5\u671F\u6216\u5168\u90E8\u5386\u53F2");
    if (scope.kind === "range")
      dateRange(scope.period?.start, scope.period?.end);
    this.running = true;
    this.stopped = false;
    this.progress({
      phase: "preparing",
      message: scope.kind === "all" ? "\u6B63\u5728\u51C6\u5907\u91C7\u96C6\u5168\u90E8\u5386\u53F2\u2026" : `\u6B63\u5728\u51C6\u5907\u91C7\u96C6 ${scope.period.start} \u81F3 ${scope.period.end}\u2026`
    });
    try {
      const reusePage = !!this.page && !this.page.isClosed();
      const page = await this.browser();
      if (!page.url().startsWith(WORK_URL))
        await page.goto(WORK_URL, {
          waitUntil: "domcontentloaded",
          timeout: 45e3
        });
      else if (reusePage)
        await page.reload({ waitUntil: "domcontentloaded", timeout: 45e3 });
      await this.resetScope(page);
      this.check();
      return await collectPage(
        page,
        scope,
        () => this.check(),
        (p) => this.progress(p),
        () => this.settle(page)
      );
    } finally {
      this.running = false;
    }
  }
  async close() {
    this.cancel();
    await this.context?.close().catch(() => {
    });
  }
};

// integrations/tapd-report/src/main/exporter.ts
import ExcelJS from "exceljs";
import { existsSync as existsSync2 } from "node:fs";
import { writeFile } from "node:fs/promises";
import { dirname as dirname2, extname, basename, join as join2 } from "node:path";
var safeFilename = (text) => text.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").replace(/[. ]+$/, "").slice(0, 120) || "\u62A5\u8868";
function suggestedName(kind, period, state, draft) {
  const prefix = draft ? "\u8349\u7A3F--" : "";
  return kind === "xlsx" ? `${prefix}\u57FA\u5730--${Number(period.start.slice(5, 7))}\u6708UI\u63D0\u5355--${safeFilename(state.settings.person)}.xlsx` : `${prefix}${kind === "csv" ? "TAPD\u539F\u59CB\u6E05\u5355" : "\u5468\u62A5"}--${period.start}\u81F3${period.end}.${kind}`;
}
function unusedPath(path) {
  const ext = extname(path), stem = basename(path, ext);
  let n = 2, next = path;
  while (existsSync2(next)) next = join2(dirname2(path), `${stem} (${n++})${ext}`);
  return next;
}
function csvCell(value) {
  const text = /^[\s]*[=+@-]/.test(value) ? `'${value}` : value;
  return `"${text.replace(/"/g, '""')}"`;
}
function rawCsv(state, period) {
  const header = [
    "\u5B8C\u6574ID",
    "\u77EDID",
    "\u9879\u76EEID",
    "\u9879\u76EE",
    "\u7C7B\u578B",
    "\u539F\u59CB\u6807\u9898",
    "\u72B6\u6001",
    "\u5F53\u524D\u5904\u7406\u4EBA",
    "\u5904\u7406\u65F6\u95F4\uFF08\u5317\u4EAC\u65F6\u95F4\uFF09",
    "\u94FE\u63A5",
    "\u91C7\u96C6\u65F6\u95F4",
    "\u91C7\u96C6\u5B8C\u6574\u6027",
    "\u91C7\u96C6\u8303\u56F4"
  ];
  const rows = (state.capture?.items ?? []).filter((i) => inPeriod(i.processedAt.slice(0, 10), period)).map((i) => [
    i.id,
    i.shortId,
    i.workspaceId,
    i.workspaceName,
    i.type,
    i.title,
    i.status,
    i.owner,
    i.processedAt,
    i.url,
    state.capture.capturedAt,
    state.capture.complete && captureCovers(state.capture, period) ? "\u5B8C\u6574" : "\u6240\u9009\u8303\u56F4\u672A\u5B8C\u6574\u91C7\u96C6",
    captureScopeLabel(state.capture)
  ]);
  return "\uFEFF" + [header, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n");
}
function exportProblems(state, period) {
  const report = buildReport(state, period);
  const issues = [...report.issues];
  if (!state.capture) issues.unshift("\u5C1A\u672A\u91C7\u96C6 TAPD");
  else if (!state.capture.complete) issues.unshift("\u91C7\u96C6\u4E0D\u5B8C\u6574\uFF0C\u8BF7\u91CD\u65B0\u6293\u53D6");
  if (!report.entries.length) issues.push("\u6240\u9009\u65E5\u671F\u6CA1\u6709\u7EB3\u5165\u7684\u4E8B\u9879");
  return issues;
}
async function writeExport(path, kind, state, period, draft, template) {
  const problems = exportProblems(state, period);
  if (kind !== "csv" && problems.length && !draft)
    throw new Error(
      `\u8BF7\u5148\u5B8C\u6210\u6574\u7406\uFF0C\u6216\u9009\u62E9\u5BFC\u51FA\u8349\u7A3F\uFF1A${problems.slice(0, 3).join("\uFF1B")}`
    );
  const report = buildReport(state, period);
  if (kind === "csv")
    return writeFile(path, rawCsv(state, period), {
      encoding: "utf8",
      flag: "wx"
    });
  if (kind !== "xlsx")
    return writeFile(
      path,
      kind === "md" ? weeklyMarkdown(report, draft) : weeklyText(report, draft),
      { encoding: "utf8", flag: "wx" }
    );
  const source = new ExcelJS.Workbook();
  await source.xlsx.readFile(template);
  const original = source.worksheets[0];
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet(original.name, {
    pageSetup: structuredClone(original.pageSetup),
    properties: structuredClone(original.properties)
  });
  for (let col = 1; col <= 12; col++) {
    sheet.getColumn(col).width = original.getColumn(col).width;
    sheet.getCell(1, col).value = original.getCell(1, col).value;
    sheet.getCell(1, col).style = structuredClone(
      original.getCell(1, col).style
    );
  }
  sheet.getRow(1).height = original.getRow(1).height;
  const styles = Array.from(
    { length: 12 },
    (_, i) => structuredClone(original.getCell(2, i + 1).style)
  );
  const defaultHeight = original.getRow(2).height ?? 80;
  for (const group of reportGroups(report.entries)) {
    group.entries.forEach((entry, index) => {
      const prefix = index === 0 ? `${group.label}${effortText(group.units)}\u4EBA\u5929` : "";
      const name = `${draft ? "\u3010\u8349\u7A3F\u3011" : ""}${prefix}\u3010${entry.category || "\u5F85\u5206\u7C7B"}\u3011${entry.title}`;
      const s = state.settings;
      const row = sheet.addRow([
        name,
        s.unit,
        /* @__PURE__ */ new Date(`${entry.dates.at(-1)}T00:00:00Z`),
        s.productionLevel || null,
        s.supplier,
        s.testOrder,
        s.content,
        s.width,
        s.height,
        s.method,
        entry.units / 100,
        s.person
      ]);
      row.eachCell({ includeEmpty: true }, (cell, col) => {
        if (col <= 12) cell.style = structuredClone(styles[col - 1]);
      });
      row.getCell(3).numFmt = "yyyy/m/d";
      row.getCell(11).numFmt = "0.##";
      const textUnits = [...name].reduce(
        (sum, ch) => sum + (ch.charCodeAt(0) > 255 ? 2 : 1),
        0
      );
      row.height = Math.max(defaultHeight, Math.ceil(textUnits / 58) * 15 + 12);
    });
  }
  sheet.pageSetup.printArea = `A1:L${Math.max(1, sheet.rowCount)}`;
  workbook.creator = "TAPD\u6708\u62A5\u5DE5\u5177";
  workbook.modified = /* @__PURE__ */ new Date();
  const buffer = await workbook.xlsx.writeBuffer();
  await writeFile(path, Buffer.from(buffer), { flag: "wx" });
}
export {
  LocalStore,
  TapdCollector,
  buildReport,
  captureCovers,
  exportProblems,
  suggestedName,
  unusedPath,
  weeklyHtml,
  weeklyText,
  writeExport
};
