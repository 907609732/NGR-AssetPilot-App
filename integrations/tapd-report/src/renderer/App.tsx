import { useEffect, useMemo, useState } from "react";
import { LevelEditor } from "./LevelEditor";
import { ActionMenu } from "./ActionMenu";
import {
  buildReport,
  captureCovers,
  dateRange,
  defaultSettings,
  effortText,
  monthPeriod,
  signature,
  todayShanghai,
  validDate,
  validLevel,
  weeklyText,
  weekPeriod,
} from "../shared/report";
import type {
  Bridge,
  BugImagePreviewGroup,
  BugImagePreviewItem,
  ExportKind,
  LocalState,
  Override,
  Period,
  PreparedItem,
  Progress,
} from "../shared/types";
declare global {
  interface Window {
    tapd: Bridge;
  }
}

function BugImageGallery({
  period,
  bugId,
  images,
}: {
  period: Period;
  bugId: string;
  images: BugImagePreviewItem[];
}) {
  const [loaded, setLoaded] = useState<
    { item: BugImagePreviewItem; url: string }[]
  >([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(0);
  const [selected, setSelected] = useState<{
    item: BugImagePreviewItem;
    url: string;
  } | null>(null);

  useEffect(() => {
    let disposed = false;
    const created: string[] = [];
    setLoaded([]);
    setFailed(0);
    setLoading(true);
    setSelected(null);
    void (async () => {
      const results: ({ item: BugImagePreviewItem; url: string } | null)[] =
        new Array(images.length).fill(null);
      let next = 0;
      let failures = 0;
      const workers = Array.from(
        { length: Math.min(4, Math.max(1, images.length)) },
        async () => {
          while (!disposed) {
            const index = next++;
            if (index >= images.length) break;
            const item = images[index];
            try {
              const preview = await window.tapd.getBugImage({
                period,
                bugId,
                imageId: item.id,
              });
              const url = URL.createObjectURL(
                new Blob([preview.data], { type: preview.mimeType }),
              );
              created.push(url);
              results[index] = { item, url };
            } catch {
              failures++;
            }
          }
        },
      );
      await Promise.all(workers);
      if (!disposed) {
        setLoaded(results.filter((value) => value !== null));
        setFailed(failures);
        setLoading(false);
      }
    })();
    return () => {
      disposed = true;
      created.forEach((url) => URL.revokeObjectURL(url));
    };
  }, [period.start, period.end, bugId, images]);

  return (
    <div className="bug-image-panel" aria-label={`Bug ${bugId} 图片`}>
      {loading && <p className="bug-image-loading">正在加载图片…</p>}
      {!loading && loaded.length === 0 && (
        <p className="bug-image-loading">图片暂时无法显示。</p>
      )}
      {loaded.length > 0 && (
        <div className="bug-image-grid">
          {loaded.map(({ item, url }) => (
            <button
              className="bug-image-card"
              key={item.id}
              aria-label={`查看大图 ${item.fileName}`}
              onClick={() => setSelected({ item, url })}
            >
              <img src={url} alt={`${item.source}图片：${item.fileName}`} />
              <span>
                {item.source} · {item.width}×{item.height}
              </span>
            </button>
          ))}
        </div>
      )}
      {failed > 0 && (
        <p className="bug-image-warning">另有 {failed} 张预览加载失败</p>
      )}
      {selected && (
        <div
          className="bug-image-lightbox"
          role="dialog"
          aria-modal="true"
          aria-label={`查看图片 ${selected.item.fileName}`}
          onClick={() => setSelected(null)}
        >
          <button
            className="bug-image-lightbox-close"
            aria-label="关闭大图"
            onClick={() => setSelected(null)}
          >
            ×
          </button>
          <img
            src={selected.url}
            alt={`${selected.item.source}图片：${selected.item.fileName}`}
            onClick={(event) => event.stopPropagation()}
          />
        </div>
      )}
    </div>
  );
}

const empty: LocalState = {
  capture: null,
  overrides: {},
  budgets: {},
  settings: defaultSettings,
  history: [],
  exports: [],
};
function loadSelection() {
  const fallback = {
    mode: "week" as "month" | "week" | "custom",
    month: todayShanghai().slice(0, 7),
    week: weekPeriod(),
    custom: weekPeriod(),
  };
  try {
    const saved = JSON.parse(
      localStorage.getItem("tapd-report-date-selection") ?? "null",
    );
    if (!saved || !["month", "week", "custom"].includes(saved.mode))
      return fallback;
    monthPeriod(saved.month);
    dateRange(saved.week.start, saved.week.end);
    dateRange(saved.custom.start, saved.custom.end);
    // Every launch starts with this week's report; retain other date choices
    // for when the user explicitly switches to a month or custom range.
    return { ...saved, mode: "week", week: weekPeriod() } as typeof fallback;
  } catch {
    return fallback;
  }
}

export default function App() {
  const [initial] = useState(loadSelection);
  const [state, setState] = useState<LocalState>(empty);
  const [mode, setMode] = useState<"month" | "week" | "custom">(initial.mode);
  const [view, setView] = useState<"monthly" | "weekly">(
    initial.mode === "week" ? "weekly" : "monthly",
  );
  const [month, setMonth] = useState(initial.month);
  const [week, setWeek] = useState<Period>(initial.week);
  const [custom, setCustom] = useState<Period>(initial.custom);
  const [busyTask, setBusyTask] = useState<"collect" | "images" | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(true);
  const [showAllLevels, setShowAllLevels] = useState(false);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [draft, setDraft] = useState(false);
  const [savedPath, setSavedPath] = useState("");
  const [bugImageGroups, setBugImageGroups] = useState<BugImagePreviewGroup[]>([]);
  const [openBugId, setOpenBugId] = useState("");
  const period = useMemo(
    () =>
      mode === "month" ? monthPeriod(month) : mode === "week" ? week : custom,
    [mode, month, week, custom],
  );
  const invalidPeriod =
    !validDate(period.start) ||
    !validDate(period.end) ||
    period.start > period.end ||
    (Date.parse(period.end) - Date.parse(period.start)) / 86400000 >= 370;
  const busy = busyTask !== null;
  const report = useMemo(
    () =>
      buildReport(
        invalidPeriod ? empty : state,
        invalidPeriod ? monthPeriod(todayShanghai().slice(0, 7)) : period,
      ),
    [state, period, invalidPeriod],
  );
  const covered = captureCovers(state.capture, period);
  const needsCapture = !state.capture?.complete || !covered;
  const included = report.items.filter((item) => item.included);
  const bugCount = new Set(
    report.items
      .filter((item) => String(item.type).toLowerCase() === "bug")
      .map((item) => `${item.workspaceId}:${item.id}`),
  ).size;
  const pending = included.filter(
    (item) => !validLevel(item.level) || !item.category.trim() || item.changed,
  );
  const bugImagesById = useMemo(
    () => new Map(bugImageGroups.map((group) => [group.bugId, group.images])),
    [bugImageGroups],
  );
  const confirmationItems = showAllLevels ? included : pending;
  const categories = [
    ...new Set([
      "运营活动",
      "商业化",
      ...state.settings.rules.map((rule) => rule.category),
      ...included.map((item) => item.category).filter(Boolean),
    ]),
  ];
  const issues = [
    ...(!state.capture?.complete ? ["采集尚未完成"] : []),
    ...report.issues,
  ];
  const exportDisabled =
    busy ||
    saving ||
    invalidPeriod ||
    !report.entries.length ||
    (!draft && issues.length > 0);
  async function run<T>(fn: () => Promise<T>, message?: string) {
    setError("");
    try {
      const result = await fn();
      if (message) setNotice(message);
      return result;
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message.replace(
              /^Error invoking remote method '[^']+': Error: /,
              "",
            )
          : String(e),
      );
      return undefined;
    }
  }
  useEffect(() => {
    void run(async () => setState(await window.tapd.load()));
    return window.tapd.onProgress(setProgress);
  }, []);
  useEffect(() => {
    if (!invalidPeriod)
      localStorage.setItem(
        "tapd-report-date-selection",
        JSON.stringify({ mode, month, week, custom }),
      );
  }, [mode, month, week, custom, invalidPeriod]);
  useEffect(() => {
    let active = true;
    setOpenBugId("");
    if (invalidPeriod) {
      setBugImageGroups([]);
      return () => {
        active = false;
      };
    }
    void window.tapd
      .listBugImages({ period })
      .then((groups) => {
        if (active) setBugImageGroups(groups);
      })
      .catch(() => {
        if (active) setBugImageGroups([]);
      });
    return () => {
      active = false;
    };
  }, [period.start, period.end, invalidPeriod, state.exports]);
  async function collect(all = false) {
    setBusyTask("collect");
    setNotice("");
    setSavedPath("");
    try {
      await run(async () =>
        setState(
          await window.tapd.collect(
            all ? { kind: "all" } : { kind: "range", period },
          ),
        ),
      );
    } finally {
      setBusyTask(null);
    }
  }
  async function extractBugImages() {
    setBusyTask("images");
    setNotice("");
    setSavedPath("");
    try {
      const result = await run(() => window.tapd.extractBugImages({ period }));
      if (!result) return;
      setSavedPath(result.outputPath);
      const refreshed = await run(() => window.tapd.load());
      if (refreshed) setState(refreshed);
      setNotice(
        result.message
          ? `${result.message}；已保留 ${result.imageCount} 张图片，失败 ${result.failedCount} 项`
          : result.canceled
          ? `已停止提取：保留 ${result.imageCount} 张图片，失败 ${result.failedCount} 项`
          : `Bug 图片提取完成：${result.imageCount} 张，重复 ${result.duplicateCount} 张，失败 ${result.failedCount} 项`,
      );
    } finally {
      setBusyTask(null);
    }
  }
  async function output(kind: ExportKind) {
    await run(async () => {
      const path = await window.tapd.export({
        kind,
        period,
        draft: kind === "csv" ? !state.capture?.complete || !covered : draft,
      });
      if (path) {
        setSavedPath(path);
        setState(await window.tapd.load());
        setNotice("报表已保存");
      }
    });
  }
  async function clearAllData() {
    setNotice("");
    setSavedPath("");
    const cleared = await run(() => window.tapd.clearAllData());
    if (!cleared) return;
    localStorage.removeItem("tapd-report-date-selection");
    const currentWeek = weekPeriod();
    setState(cleared);
    setMode("week");
    setView("weekly");
    setMonth(todayShanghai().slice(0, 7));
    setWeek(currentWeek);
    setCustom(currentWeek);
    setDraft(false);
    setProgress(null);
    setConfirmOpen(true);
    setShowAllLevels(false);
    setBugImageGroups([]);
    setOpenBugId("");
    setNotice("所有报表数据已清除");
  }
  async function confirmItem(item: PreparedItem, patch: Override) {
    setSaving(true);
    setNotice("");
    setSavedPath("");
    const saved = await run(
      async () => {
        // A merged item must keep a single grade/category across all its source
        // rows, including captured dates outside the selected week.
        const keys =
          item.mergeId &&
          (patch.level !== undefined || patch.category !== undefined)
            ? state
                .capture!.items.filter(
                  (raw) => state.overrides[raw.key]?.mergeId === item.mergeId,
                )
                .map((raw) => raw.key)
            : [item.key];
        setState(
          await window.tapd.save({
            overrides: Object.fromEntries(keys.map((key) => [key, patch])),
          }),
        );
        return true;
      },
      patch.level !== undefined
        ? "S 等级已保存，报表已更新"
        : patch.category !== undefined
          ? "分类已保存，报表已更新"
          : "原始信息已核对",
    );
    setSaving(false);
    return saved === true;
  }
  function levelSelect(item: PreparedItem) {
    return (
      <LevelEditor
        key={item.key}
        shortId={item.shortId}
        value={item.level}
        disabled={busy || saving}
        onSave={(level) => confirmItem(item, { level })}
      />
    );
  }
  return (
    <main className="report-app">
      <header className="app-header">
        <h1>报表预览</h1>
        <div className="header-actions">
          <span>{state.settings.person}</span>
        </div>
      </header>
      <div className="content">
        <div className="period-toolbar">
          <div className="period-left">
            <div className="segmented">
              <button
                aria-pressed={mode === "week"}
                className={mode === "week" ? "selected" : ""}
                onClick={() => {
                  setMode("week");
                  setView("weekly");
                }}
                disabled={busy || saving}
              >
                周报
              </button>
              <button
                aria-pressed={mode === "month"}
                className={mode === "month" ? "selected" : ""}
                onClick={() => {
                  setMode("month");
                  setView("monthly");
                }}
                disabled={busy || saving}
              >
                月报
              </button>
            </div>
            {mode === "month" ? (
              <label className="date-field">
                报告月份
                <input
                  aria-label="报告月份"
                  type="month"
                  disabled={busy || saving}
                  value={month}
                  onChange={(e) => {
                    if (e.target.value) setMonth(e.target.value);
                  }}
                />
              </label>
            ) : (
              <div className="week-inputs">
                <input
                  aria-label={mode === "week" ? "周报开始日期" : "采集开始日期"}
                  type="date"
                  disabled={busy || saving}
                  value={period.start}
                  onChange={(e) =>
                    mode === "week"
                      ? setWeek({ ...week, start: e.target.value })
                      : setCustom({ ...custom, start: e.target.value })
                  }
                />
                <span>至</span>
                <input
                  aria-label={mode === "week" ? "周报结束日期" : "采集结束日期"}
                  type="date"
                  disabled={busy || saving}
                  value={period.end}
                  onChange={(e) =>
                    mode === "week"
                      ? setWeek({ ...week, end: e.target.value })
                      : setCustom({ ...custom, end: e.target.value })
                  }
                />
                {mode === "week" && (
                  <button
                    disabled={busy || saving}
                    onClick={() => setWeek(weekPeriod())}
                  >
                    本周
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
        <div className="capture-actions" role="group" aria-label="按顺序完成采集">
          <button
            className="secondary workflow-step"
            onClick={() => run(() => window.tapd.login())}
            disabled={busy || saving}
          >
            <span className="step-number" aria-hidden="true">1</span> 登录 TAPD
          </button>

            <button
              className={`workflow-step ${needsCapture ? "primary" : "secondary"}`}
              onClick={() => collect()}
              disabled={busy || saving || invalidPeriod}
            >
              <span className="step-number" aria-hidden="true">2</span>
              {busyTask === "collect" ? "正在抓取…" : "抓取所选日期"}
            </button>
            <button
              className="secondary workflow-step"
              onClick={() => void extractBugImages()}
              disabled={
                busy ||
                saving ||
                invalidPeriod ||
                !state.capture?.complete ||
                !covered ||
                bugCount === 0
              }
              title={
                !state.capture
                  ? "请先抓取所选日期"
                  : !state.capture.complete
                    ? "当前采集尚未完成，请重新抓取"
                    : !covered
                      ? "所选日期超出当前采集范围"
                      : bugCount === 0
                        ? "当前日期范围没有 Bug 单"
                        : `提取当前范围内 ${bugCount} 个 Bug 单的图片`
              }
            >
              <span className="step-number" aria-hidden="true">3</span>
              {busyTask === "images" ? "正在提取图片…" : "提取 Bug 单图片"}
            </button>
            <ActionMenu label="更多采集" align="right" className="capture-menu">
              <p>需要完整历史时，读取所有时间的已办，耗时较长。</p>
              <button disabled={busy || saving} onClick={() => collect(true)}>
                抓取全部历史
              </button>
            </ActionMenu>
        </div>
        {invalidPeriod && (
          <p className="warning">请选择有效日期，单次最多 370 天</p>
        )}

        {progress && (
          <div
            role="status"
            className={`progress-line ${progress.phase === "incomplete" ? "warning" : ""}`}
          >
            <span className={busy ? "spinner" : "status-dot"} />
            <span>{progress.message}</span>
            {busy && (
              <button onClick={() => run(() => window.tapd.cancel())}>
                {busyTask === "images" ? "停止提取" : "停止并保存草稿"}
              </button>
            )}
          </div>
        )}
        {(error || notice) && (
          <div
            role="status"
            className={`notice ${error ? "error" : "success"}`}
          >
            <span>{error || notice}</span>
            {savedPath && !error && (
              <button
                onClick={() => run(() => window.tapd.openPath(savedPath))}
              >
                打开文件位置 ↗
              </button>
            )}
            <button
              aria-label="关闭提示"
              onClick={() => {
                setError("");
                setNotice("");
              }}
            >
              ×
            </button>
          </div>
        )}
        {state.capture && !covered && (
          <p className="warning">
            所选日期超出已采集范围。点击“抓取所选日期”获取相应数据。
          </p>
        )}
        {state.capture && !state.capture.complete && (
          <p className="warning">
            采集未完成：{state.capture.issues.join("；")}
            。当前数据可预览和导出草稿。
          </p>
        )}
        {state.capture?.complete && covered && !invalidPeriod && bugCount === 0 && (
          <p className="warning">
            当前日期范围没有 Bug 单，图片提取按钮已禁用。
          </p>
        )}
        <div className="export-toolbar" aria-label="报表导出">
          <span className="toolbar-label">导出报告</span>
          <button
            className={
              !needsCapture && view === "weekly" ? "primary" : "secondary"
            }
            aria-label="复制周报纯文本"
            disabled={exportDisabled}
            onClick={() =>
              run(
                () => window.tapd.copy({ period, html: false, draft }),
                "周报纯文本已复制",
              )
            }
          >
            复制周报
          </button>
          <button
            className={
              !needsCapture && view === "monthly" ? "primary" : "secondary"
            }
            disabled={exportDisabled}
            onClick={() => output("xlsx")}
          >
            下载月报 Excel
          </button>
          <ActionMenu label="更多导出">
            <button
              disabled={exportDisabled}
              onClick={() =>
                run(
                  () => window.tapd.copy({ period, html: true, draft }),
                  "单列表格已复制，可粘贴到 Word 或在线文档",
                )
              }
            >
              复制周报单列表格
            </button>
            <button disabled={exportDisabled} onClick={() => output("txt")}>
              下载 TXT
            </button>
            <button disabled={exportDisabled} onClick={() => output("md")}>
              下载 Markdown
            </button>
            <button
              disabled={busy || saving || invalidPeriod || !state.capture}
              onClick={() => output("csv")}
            >
              原始清单 CSV
            </button>
          </ActionMenu>
          <label className="checkline">
            <input
              type="checkbox"
              checked={draft}
              onChange={(e) => setDraft(e.target.checked)}
            />
            导出草稿
          </label>
          <button
            className="danger-action"
            disabled={busy || saving}
            onClick={() => void clearAllData()}
          >
            清除所有数据
          </button>
        </div>
        {state.capture && included.length > 0 && (
          <div className="confirmation-toolbar">
            <button
              className={
                pending.length ? "confirmation-action" : "quiet-button"
              }
              aria-expanded={confirmOpen && confirmationItems.length > 0}
              aria-controls="report-confirmations"
              disabled={busy || saving}
              onClick={() => {
                if (confirmOpen && confirmationItems.length)
                  setConfirmOpen(false);
                else {
                  setConfirmOpen(true);
                  setShowAllLevels(pending.length === 0);
                }
              }}
            >
              {pending.length
                ? `确认 S 等级 / 分类（${pending.length} 项待确认）`
                : "修改 S 等级 / 分类"}
            </button>
            <span className={pending.length ? "" : "confirmed-note"}>
              {saving
                ? "正在保存…"
                : pending.length
                  ? "在下方选择等级，自动保存并更新报告。"
                  : "等级与分类已确认"}
            </span>
          </div>
        )}
        {state.capture && confirmOpen && confirmationItems.length > 0 && (
          <section
            id="report-confirmations"
            className="confirmation-section"
            aria-label="确认 S 等级与分类"
          >
            <div className="confirmation-heading">
              <h2>{showAllLevels ? "等级与分类" : "待确认项"}</h2>
              <button
                disabled={busy || saving}
                onClick={() => setShowAllLevels(!showAllLevels)}
              >
                {showAllLevels ? "只看待确认" : "查看全部等级"}
              </button>
            </div>
            <p className="confirmation-help">
              选择 S1、S2、S3 自动保存；其他等级点“自定义”，输入如 S4 或 4
              后点“保存等级”。Bug 单可在单号后点击“显示图片”核对。
            </p>
            <ul className="confirmation-list">
              {confirmationItems.map((item) => (
                <li key={item.key}>
                  <div className="confirmation-item">
                    <div className="confirmation-meta-row">
                      <span className="confirmation-meta">
                        {item.dates[0]} · #{item.shortId}
                      </span>
                      {String(item.type).toLowerCase() === "bug" && (() => {
                        const images = bugImagesById.get(item.shortId) ?? [];
                        const expanded = openBugId === item.shortId;
                        return (
                          <button
                            className="bug-image-toggle"
                            disabled={!images.length}
                            aria-expanded={expanded}
                            title={
                              images.length
                                ? `查看 Bug #${item.shortId} 的 ${images.length} 张图片`
                                : "请先点击上方“提取 Bug 单图片”"
                            }
                            onClick={() =>
                              setOpenBugId(expanded ? "" : item.shortId)
                            }
                          >
                            {expanded ? "收起图片" : "显示图片"}
                            {images.length ? ` (${images.length})` : ""}
                          </button>
                        );
                      })()}
                    </div>
                    <p>{item.cleanTitle}</p>
                    <details>
                      <summary>
                        查看原始标题{item.changed ? "（内容已变化）" : ""}
                      </summary>
                      <p>{item.title}</p>
                      <p>
                        {item.processedAt} · {item.status}
                      </p>
                      {item.changed && (
                        <button
                          disabled={busy || saving}
                          onClick={() =>
                            confirmItem(item, {
                              acknowledgedSignature: signature(item),
                            })
                          }
                        >
                          已核对原始信息
                        </button>
                      )}
                    </details>
                    {openBugId === item.shortId && (
                      <BugImageGallery
                        period={period}
                        bugId={item.shortId}
                        images={bugImagesById.get(item.shortId) ?? []}
                      />
                    )}
                  </div>
                  <div className="confirmation-field">
                    <span>S 等级</span>
                    {levelSelect(item)}
                  </div>
                  <label>
                    分类
                    <select
                      aria-label={`分类 ${item.shortId}`}
                      className={!item.category ? "needs-confirmation" : ""}
                      value={item.category}
                      disabled={busy || saving}
                      onChange={(e) =>
                        confirmItem(item, { category: e.target.value })
                      }
                    >
                      <option value="">待分类</option>
                      {categories.map((category) => (
                        <option key={category}>{category}</option>
                      ))}
                    </select>
                  </label>
                </li>
              ))}
            </ul>
          </section>
        )}
        {state.capture && issues.length > 0 && (
          <details className="report-issues">
            <summary>尚有未确认内容，确认后可正式导出（查看详情）</summary>
            <p>在上方选择缺失的等级或分类；也可勾选“导出草稿”先复制或下载。</p>
            <ul>
              {issues.map((issue, i) => (
                <li key={i}>{issue}</li>
              ))}
            </ul>
          </details>
        )}
        <div className="preview-heading">
          <div className="preview-tabs" role="tablist" aria-label="预览格式">
            <button
              role="tab"
              aria-selected={view === "weekly"}
              aria-controls="weekly-preview"
              id="weekly-tab"
              onClick={() => setView("weekly")}
            >
              周报内容
            </button>
            <button
              role="tab"
              aria-selected={view === "monthly"}
              aria-controls="monthly-preview"
              id="monthly-tab"
              onClick={() => setView("monthly")}
            >
              月报行预览
            </button>
          </div>
          {state.capture && (
            <span className="report-summary">
              <span>
                <strong>{report.includedCount}</strong> 单
              </span>
              <span>
                <strong>{report.dayCount}</strong> 天
              </span>
              <span>
                <strong>{effortText(report.totalUnits)}</strong> 人天
              </span>
            </span>
          )}
        </div>
        {!state.capture ? (
          <p className="empty-state">
            选择日期，登录 TAPD 后点击“抓取所选日期”，即可预览并导出报告。
          </p>
        ) : !report.entries.length ? (
          <p className="empty-state">所选日期暂无事项。</p>
        ) : view === "weekly" ? (
          <section
            id="weekly-preview"
            role="tabpanel"
            aria-labelledby="weekly-tab"
          >
            <pre className="weekly-text">
              {weeklyText(report, draft)
                .split(
                  /(^\d{1,2}\/\d{1,2}(?:-\d{1,2}\/\d{1,2})?（[^）\n]+）[\d.]+人天)/gm,
                )
                .map((part, i) =>
                  i % 2 ? (
                    <strong className="week-group-label" key={i}>
                      {part}
                    </strong>
                  ) : (
                    part
                  ),
                )}
            </pre>
          </section>
        ) : (
          <section
            id="monthly-preview"
            role="tabpanel"
            aria-labelledby="monthly-tab"
            className="table-scroll"
          >
            <table className="preview-table">
              <thead>
                <tr>
                  <th>工作日期</th>
                  <th>物件内容</th>
                  <th>S 等级</th>
                  <th>人天</th>
                  <th>制作人员</th>
                </tr>
              </thead>
              <tbody>
                {report.entries.map((e) => (
                  <tr key={e.key}>
                    <td>
                      {e.dates[0]}
                      {e.dates.length > 1 && <> 至 {e.dates.at(-1)}</>}
                    </td>
                    <td>
                      <span className="item-category">
                        【{e.category || "待分类"}】
                      </span>
                      {e.title}
                    </td>
                    <td>
                      {levelSelect(
                        report.items.find(
                          (item) => item.key === e.sourceKeys[0],
                        )!,
                      )}
                    </td>
                    <td>{effortText(e.units)}</td>
                    <td>{state.settings.person}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        )}
      </div>
      <footer>
        <span>v1.3.0</span>
      </footer>
    </main>
  );
}
