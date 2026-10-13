import initSqlJs, { type Database } from "sql.js";
import { createRequire } from "node:module";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
  defaultSettings,
  normalizeLevel,
  signature,
  validDate,
  validLevel,
} from "../shared/report";
import type { Capture, LocalState, Override, Settings } from "../shared/types";

const require = createRequire(import.meta.url);
export class LocalStore {
  private constructor(
    private db: Database,
    private filename: string,
  ) {}
  static async open(directory: string) {
    mkdirSync(directory, { recursive: true });
    const SQL = await initSqlJs({
      locateFile: (file) => require.resolve(`sql.js/dist/${file}`),
    });
    const filename = join(directory, "reports.sqlite");
    const db = new SQL.Database(
      existsSync(filename) ? readFileSync(filename) : undefined,
    );
    db.run(`CREATE TABLE IF NOT EXISTS snapshots (id TEXT PRIMARY KEY, captured_at TEXT NOT NULL, account TEXT NOT NULL, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS overrides (account TEXT NOT NULL, item_key TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(account,item_key));
      CREATE TABLE IF NOT EXISTS budgets (account TEXT NOT NULL, date TEXT NOT NULL, units INTEGER NOT NULL, PRIMARY KEY(account,date));
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS exports (id INTEGER PRIMARY KEY AUTOINCREMENT, account TEXT NOT NULL, at TEXT NOT NULL, path TEXT NOT NULL, kind TEXT NOT NULL, draft INTEGER NOT NULL);`);
    const store = new LocalStore(db, filename);
    store.flush();
    return store;
  }
  private query(sql: string, params: (string | number)[] = []) {
    const statement = this.db.prepare(sql);
    statement.bind(params);
    const rows: Record<string, any>[] = [];
    try {
      while (statement.step()) rows.push(statement.getAsObject());
    } finally {
      statement.free();
    }
    return rows;
  }
  private flush() {
    mkdirSync(dirname(this.filename), { recursive: true });
    writeFileSync(`${this.filename}.next`, this.db.export());
    renameSync(`${this.filename}.next`, this.filename);
  }
  private activeId() {
    return this.query(
      "SELECT payload FROM settings WHERE key='activeSnapshot'",
    )[0]?.payload as string | undefined;
  }
  load(): LocalState {
    const selected = this.activeId();
    const snapshot = selected
      ? this.query("SELECT payload FROM snapshots WHERE id=?", [selected])[0]
      : undefined;
    const capture: Capture | null = snapshot
      ? JSON.parse(snapshot.payload)
      : null;
    const account = capture?.account ?? "";
    const settingsRow = this.query(
      "SELECT payload FROM settings WHERE key='template'",
    )[0];
    return {
      capture,
      overrides: Object.fromEntries(
        this.query("SELECT item_key,payload FROM overrides WHERE account=?", [
          account,
        ]).map((r) => [r.item_key, JSON.parse(r.payload)]),
      ),
      budgets: Object.fromEntries(
        this.query("SELECT date,units FROM budgets WHERE account=?", [
          account,
        ]).map((r) => [r.date, r.units]),
      ),
      settings: settingsRow
        ? JSON.parse(settingsRow.payload)
        : structuredClone(defaultSettings),
      history: this.query(
        "SELECT id,captured_at,payload FROM snapshots WHERE account=? ORDER BY captured_at DESC LIMIT 30",
        [account],
      ).map((r) => {
        const c: Capture = JSON.parse(r.payload);
        return {
          id: r.id,
          capturedAt: r.captured_at,
          loaded: c.loaded,
          complete: c.complete,
          scope: c.scope,
        };
      }),
      exports: this.query(
        "SELECT at,path,kind,draft FROM exports WHERE account=? ORDER BY id DESC LIMIT 30",
        [account],
      ).map((r) => ({
        at: r.at,
        path: r.path,
        kind: r.kind,
        draft: !!r.draft,
      })),
    };
  }
  capture(capture: Capture) {
    this.db.run("INSERT INTO snapshots VALUES (?,?,?,?)", [
      capture.id,
      capture.capturedAt,
      capture.account,
      JSON.stringify(capture),
    ]);
    this.db.run("INSERT OR REPLACE INTO settings VALUES ('activeSnapshot',?)", [
      capture.id,
    ]);
    this.flush();
    return this.load();
  }
  restore(id: string) {
    const state = this.load();
    if (
      !this.query("SELECT id FROM snapshots WHERE id=? AND account=?", [
        id,
        state.capture?.account ?? "",
      ]).length
    )
      throw new Error("找不到该账号的采集记录");
    this.db.run("INSERT OR REPLACE INTO settings VALUES ('activeSnapshot',?)", [
      id,
    ]);
    this.flush();
    return this.load();
  }
  save(input: {
    overrides?: Record<string, Override>;
    budgets?: Record<string, number>;
    settings?: Settings;
  }) {
    const state = this.load(),
      account = state.capture?.account ?? "";
    this.db.run("BEGIN");
    let committed = false;
    try {
      if (input.overrides)
        for (const [key, patch] of Object.entries(input.overrides)) {
          const raw = state.capture?.items.find((i) => i.key === key);
          if (!raw) throw new Error("源记录不存在，请重新打开报表");
          const current = state.overrides[key] ?? {};
          if (
            patch.dates &&
            (!Array.isArray(patch.dates) ||
              !patch.dates.length ||
              patch.dates.length > 370 ||
              !patch.dates.every(validDate))
          )
            throw new Error("工作日期无效");
          if (patch.level !== undefined && typeof patch.level !== "string")
            throw new Error("S 等级格式无效");
          const level =
            patch.level === undefined ? undefined : normalizeLevel(patch.level);
          if (level !== undefined && level !== "" && !validLevel(level))
            throw new Error("请输入 S 加非负整数，例如 S4 或 4");
          if (
            patch.lockedUnits &&
            Object.entries(patch.lockedUnits).some(
              ([d, u]) => !validDate(d) || !Number.isSafeInteger(u) || u < 0,
            )
          )
            throw new Error("人天必须为非负数，最多两位小数");
          for (const field of ["title", "category"] as const)
            if (
              patch[field] !== undefined &&
              (typeof patch[field] !== "string" || patch[field]!.length > 20000)
            )
              throw new Error("文本内容无效");
          const merged = {
            ...current,
            ...patch,
            ...(level !== undefined ? { level } : {}),
            sourceSignature: current.sourceSignature ?? signature(raw),
          };
          this.db.run("INSERT OR REPLACE INTO overrides VALUES (?,?,?)", [
            account,
            key,
            JSON.stringify(merged),
          ]);
        }
      if (input.budgets)
        for (const [date, units] of Object.entries(input.budgets)) {
          if (!validDate(date) || !Number.isSafeInteger(units) || units < 0)
            throw new Error("每日人天无效");
          this.db.run("INSERT OR REPLACE INTO budgets VALUES (?,?,?)", [
            account,
            date,
            units,
          ]);
        }
      if (input.settings) {
        const settings = input.settings;
        if (
          !settings.person?.trim() ||
          !settings.supplier?.trim() ||
          !Number.isFinite(settings.width) ||
          !Number.isFinite(settings.height) ||
          settings.width <= 0 ||
          settings.height <= 0 ||
          !Array.isArray(settings.rules) ||
          settings.rules.length > 1000 ||
          settings.rules.some(
            (r) =>
              typeof r.keyword !== "string" ||
              typeof r.category !== "string" ||
              !r.keyword.trim() ||
              !r.category.trim(),
          )
        )
          throw new Error("请检查姓名、供应商、尺寸和分类规则");
        this.db.run("INSERT OR REPLACE INTO settings VALUES ('template',?)", [
          JSON.stringify(settings),
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
  recordExport(path: string, kind: string, draft: boolean) {
    this.db.run(
      "INSERT INTO exports(account,at,path,kind,draft) VALUES (?,?,?,?,?)",
      [
        this.load().capture?.account ?? "",
        new Date().toISOString(),
        path,
        kind,
        Number(draft),
      ],
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
}
