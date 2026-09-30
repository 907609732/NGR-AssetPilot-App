(function initializeDailyReport(globalScope) {
  "use strict";

  const core = globalScope.NgrDailyReportCore;
  if (!core) return;

  const DEFAULTS_KEY = "ngr-daily-report-defaults-v1";
  const DRAFT_KEY = "ngr-daily-report-draft-v1";
  const BLOCKING_PARSE_CODES = new Set(["INPUT_TOO_LARGE", "TASK_WITHOUT_DATE", "GROUP_WITHOUT_TASK"]);
  const FIELDS = [
    ["objectName", "物件名称", "textarea"],
    ["workUnit", "工作量单位", "text"],
    ["dueDate", "期望完成日期", "date"],
    ["productionLevel", "制作等级", "text"],
    ["vendor", "推荐供应商", "text"],
    ["testOrder", "是否测试单", "text"],
    ["requirementType", "需求内容", "text"],
    ["dimensionLength", "尺寸(长)", "number"],
    ["dimensionWidth", "尺寸(宽)", "number"],
    ["productionMethod", "制作方式", "text"],
    ["workload", "数量/预估工作量", "number"],
    ["producer", "制作人员", "text"],
  ];

  const state = {
    initialized: false,
    year: new Date().getFullYear(),
    rows: [],
    groups: [],
    declaredTotal: null,
    month: null,
    parseErrors: [],
    warnings: [],
  };

  const elements = {};
  const byId = (id) => document.getElementById(id);

  function safeParseStorage(key, fallback) {
    try {
      const value = JSON.parse(localStorage.getItem(key) || "null");
      return value && typeof value === "object" ? value : fallback;
    } catch {
      return fallback;
    }
  }

  function getDefaults() {
    const stored = safeParseStorage(DEFAULTS_KEY, {});
    return {
      ...core.DEFAULTS,
      ...stored,
      dimensionLength: Number(stored.dimensionLength || core.DEFAULTS.dimensionLength),
      dimensionWidth: Number(stored.dimensionWidth || core.DEFAULTS.dimensionWidth),
    };
  }

  function fillDefaultInputs(defaults) {
    elements.defaultWorkUnit.value = defaults.workUnit;
    elements.defaultProductionLevel.value = defaults.productionLevel;
    elements.defaultVendor.value = defaults.vendor;
    elements.defaultTestOrder.value = defaults.testOrder;
    elements.defaultRequirementType.value = defaults.requirementType;
    elements.defaultLength.value = defaults.dimensionLength;
    elements.defaultWidth.value = defaults.dimensionWidth;
    elements.defaultMethod.value = defaults.productionMethod;
    elements.defaultProducer.value = defaults.producer;
  }

  function collectDefaults() {
    return {
      workUnit: elements.defaultWorkUnit.value.trim(),
      productionLevel: elements.defaultProductionLevel.value.trim(),
      vendor: elements.defaultVendor.value.trim(),
      testOrder: elements.defaultTestOrder.value.trim(),
      requirementType: elements.defaultRequirementType.value.trim(),
      dimensionLength: Number(elements.defaultLength.value),
      dimensionWidth: Number(elements.defaultWidth.value),
      productionMethod: elements.defaultMethod.value.trim(),
      producer: elements.defaultProducer.value.trim(),
    };
  }

  function saveDefaults() {
    localStorage.setItem(DEFAULTS_KEY, JSON.stringify(collectDefaults()));
  }

  function persistDraft() {
    localStorage.setItem(DRAFT_KEY, JSON.stringify({
      source: elements.source.value,
      year: state.year,
      rows: state.rows,
      groups: state.groups,
      declaredTotal: state.declaredTotal,
      month: state.month,
      parseErrors: state.parseErrors,
      warnings: state.warnings,
    }));
  }

  function extractCategory(name) {
    const match = String(name || "").match(/【([^】]+)】/);
    return match ? match[1].trim() : "未分类";
  }

  function extractLevel(row) {
    return String(row.parsedLevel || String(row.objectName || "").match(/[（(]\s*(S[123])\s*[）)]/i)?.[1] || "未标注").toUpperCase();
  }

  function replaceSelectOptions(select, values, allLabel) {
    const current = select.value;
    select.replaceChildren();
    const all = document.createElement("option");
    all.value = "all";
    all.textContent = allLabel;
    select.appendChild(all);
    values.forEach((value) => {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = value;
      select.appendChild(option);
    });
    select.value = values.includes(current) ? current : "all";
  }

  function refreshFilters() {
    const categories = [...new Set(state.rows.map((row) => extractCategory(row.objectName)))].sort((a, b) => a.localeCompare(b, "zh-CN"));
    const levels = [...new Set(state.rows.map(extractLevel))].sort();
    replaceSelectOptions(elements.categoryFilter, categories, "全部分类");
    replaceSelectOptions(elements.levelFilter, levels, "全部等级");
  }

  function visibleRows() {
    const category = elements.categoryFilter.value;
    const level = elements.levelFilter.value;
    const date = elements.dateFilter.value;
    const search = elements.search.value.trim().toLocaleLowerCase("zh-CN");
    return state.rows
      .map((row, index) => ({ row, index }))
      .filter(({ row }) => category === "all" || extractCategory(row.objectName) === category)
      .filter(({ row }) => level === "all" || extractLevel(row) === level)
      .filter(({ row }) => !date || row.dueDate === date)
      .filter(({ row }) => !search || String(row.objectName || "").toLocaleLowerCase("zh-CN").includes(search));
  }

  function buildValidation() {
    const validation = core.validateRows(state.rows, state.declaredTotal);
    const blockingParseErrors = state.parseErrors.filter((issue) => BLOCKING_PARSE_CODES.has(issue.code));
    return { ...validation, errors: [...blockingParseErrors, ...validation.errors] };
  }

  function renderSummary(validation) {
    const values = [
      state.groups.length,
      state.rows.length,
      state.declaredTotal == null ? "--" : `${state.declaredTotal} 人天`,
      `${validation.calculatedTotal} 人天`,
      validation.difference == null ? "--" : `${validation.difference > 0 ? "+" : ""}${validation.difference}`,
    ];
    elements.summary.querySelectorAll("strong").forEach((node, index) => { node.textContent = values[index]; });
    elements.summary.classList.toggle("has-error", validation.errors.length > 0);
  }

  function renderIssues(validation) {
    const informationalParseErrors = state.parseErrors.filter((issue) => !BLOCKING_PARSE_CODES.has(issue.code) && issue.code !== "SUMMARY_MISMATCH");
    const issues = [...validation.errors, ...informationalParseErrors, ...state.warnings];
    elements.issues.replaceChildren();
    if (!issues.length) {
      elements.issues.className = "daily-report-issues success";
      elements.issues.textContent = "校验通过，可以复制或导出。";
      return;
    }
    elements.issues.className = `daily-report-issues ${validation.errors.length ? "error" : "warning"}`;
    const list = document.createElement("ul");
    issues.slice(0, 12).forEach((issue) => {
      const item = document.createElement("li");
      item.textContent = issue.message;
      list.appendChild(item);
    });
    if (issues.length > 12) {
      const item = document.createElement("li");
      item.textContent = `还有 ${issues.length - 12} 个问题未显示。`;
      list.appendChild(item);
    }
    elements.issues.appendChild(list);
  }

  function renderCategorySummary() {
    const counts = new Map();
    state.rows.forEach((row) => counts.set(extractCategory(row.objectName), (counts.get(extractCategory(row.objectName)) || 0) + 1));
    elements.categorySummary.replaceChildren();
    [...counts.entries()].sort((left, right) => right[1] - left[1]).forEach(([category, count]) => {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = `${category} ${count}`;
      button.addEventListener("click", () => {
        elements.categoryFilter.value = category;
        renderTable();
      });
      elements.categorySummary.appendChild(button);
    });
  }

  function createCellEditor(row, rowIndex, field, type, invalidFields) {
    const cell = document.createElement("td");
    const input = document.createElement(type === "textarea" ? "textarea" : "input");
    if (type !== "textarea") input.type = type;
    if (type === "number") {
      input.step = field === "workload" ? "0.01" : "1";
      input.min = field === "workload" ? "0.01" : "1";
    }
    input.value = row[field] ?? "";
    input.dataset.rowIndex = String(rowIndex);
    input.dataset.field = field;
    input.setAttribute("aria-label", `${FIELDS.find(([key]) => key === field)?.[1] || field} 第 ${rowIndex + 1} 行`);
    if (invalidFields.has(field) || invalidFields.has("row")) input.classList.add("invalid");
    cell.appendChild(input);
    return cell;
  }

  function renderTable() {
    const validation = buildValidation();
    const invalidByRow = new Map();
    validation.errors.forEach((issue) => {
      if (!Number.isInteger(issue.row)) return;
      if (!invalidByRow.has(issue.row)) invalidByRow.set(issue.row, new Set());
      invalidByRow.get(issue.row).add(issue.field || "row");
    });
    const rows = visibleRows();
    elements.tableBody.replaceChildren();
    if (!rows.length) {
      const row = document.createElement("tr");
      const cell = document.createElement("td");
      cell.colSpan = 13;
      cell.className = "daily-report-empty";
      cell.textContent = state.rows.length ? "当前筛选没有匹配任务。" : "解析后的表格会显示在这里。";
      row.appendChild(cell);
      elements.tableBody.appendChild(row);
    } else {
      rows.forEach(({ row, index }) => {
        const tr = document.createElement("tr");
        tr.dataset.rowIndex = String(index);
        if (invalidByRow.has(index)) tr.classList.add("has-error");
        FIELDS.forEach(([field, _label, type]) => tr.appendChild(createCellEditor(row, index, field, type, invalidByRow.get(index) || new Set())));
        const actionCell = document.createElement("td");
        const remove = document.createElement("button");
        remove.type = "button";
        remove.className = "daily-report-remove-row";
        remove.dataset.removeRow = String(index);
        remove.textContent = "删除";
        actionCell.appendChild(remove);
        tr.appendChild(actionCell);
        elements.tableBody.appendChild(tr);
      });
    }
    elements.visibleCount.textContent = `显示 ${rows.length} / ${state.rows.length} 行`;
    renderSummary(validation);
    renderIssues(validation);
    renderCategorySummary();
    const valid = state.rows.length > 0 && validation.errors.length === 0;
    elements.copy.disabled = !valid;
    elements.export.disabled = !valid || !globalScope.NgrDesktopBridge?.hasCapability?.("dailyReport.export");
    elements.redistribute.disabled = !state.rows.length;
    elements.status.textContent = valid ? `已就绪，共 ${state.rows.length} 行、${validation.calculatedTotal} 人天` : `还有 ${validation.errors.length} 个阻断问题`;
  }

  function renderAll() {
    refreshFilters();
    renderTable();
    persistDraft();
  }

  function parseSource() {
    if (state.rows.length && !globalScope.confirm("重新解析会替换当前表格中的编辑内容，是否继续？")) return;
    saveDefaults();
    const result = core.parseDailyReport(elements.source.value, {
      year: state.year,
      defaults: collectDefaults(),
    });
    state.rows = result.rows;
    state.groups = result.groups;
    state.declaredTotal = result.declaredTotal;
    state.month = result.detectedMonth;
    state.parseErrors = result.errors;
    state.warnings = result.warnings;
    renderAll();
    globalScope.showToast?.(result.rows.length ? `已解析 ${result.rows.length} 条任务` : "没有解析到可用任务");
  }

  function resetReport() {
    const hasContent = Boolean(elements.source.value.trim() || state.rows.length);
    if (hasContent && !globalScope.confirm("确定清除所有日报数据吗？原文和当前表格将被清空，常用默认值会保留。")) return;
    elements.source.value = "";
    elements.categoryFilter.value = "all";
    elements.levelFilter.value = "all";
    elements.dateFilter.value = "";
    elements.search.value = "";
    state.rows = [];
    state.groups = [];
    state.declaredTotal = null;
    state.month = null;
    state.parseErrors = [];
    state.warnings = [];
    localStorage.removeItem(DRAFT_KEY);
    renderAll();
    globalScope.showToast?.("日报数据已清除，可以粘贴下一份数据");
  }

  function updateRow(event) {
    const input = event.target.closest("[data-row-index][data-field]");
    if (!input) return;
    const rowIndex = Number(input.dataset.rowIndex);
    const field = input.dataset.field;
    if (!state.rows[rowIndex] || !FIELDS.some(([key]) => key === field)) return;
    state.rows[rowIndex][field] = input.type === "number" ? (input.value === "" ? null : Number(input.value)) : input.value;
    if (field === "objectName") state.rows[rowIndex].parsedLevel = extractLevel({ objectName: input.value, parsedLevel: "" });
    persistDraft();
    refreshFilters();
    renderTable();
  }

  async function writeClipboard(text) {
    if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(text);
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.select();
    const copied = document.execCommand("copy");
    textarea.remove();
    if (!copied) throw new Error("当前环境无法访问剪贴板");
  }

  async function copyTable() {
    const validation = buildValidation();
    if (validation.errors.length) return;
    try {
      await writeClipboard(core.toTsv(state.rows));
      globalScope.showToast?.(`已复制 ${state.rows.length} 行提单数据`);
    } catch (error) {
      globalScope.showToast?.(`复制失败：${error?.message || "未知错误"}`);
    }
  }

  async function exportWorkbook() {
    const validation = buildValidation();
    if (validation.errors.length) return;
    elements.export.disabled = true;
    elements.status.textContent = "正在生成 Excel…";
    try {
      const result = await globalScope.NgrDesktopBridge.exportDailyReport({
        year: state.year,
        month: Number(state.month || new Date().getMonth() + 1),
        producer: collectDefaults().producer,
        rows: state.rows,
      });
      if (result?.canceled) {
        elements.status.textContent = "已取消导出";
        return;
      }
      elements.status.textContent = `已导出 ${result.fileName}`;
      globalScope.showToast?.(`Excel 已导出：${result.fileName}`);
    } catch (error) {
      elements.status.textContent = "导出失败";
      globalScope.showToast?.(`导出失败：${error?.message || "未知错误"}`);
    } finally {
      renderTable();
    }
  }

  function restoreDraft() {
    const draft = safeParseStorage(DRAFT_KEY, null);
    elements.source.value = String(draft?.source || "");
    if (!Array.isArray(draft?.rows) || !draft.rows.length) return;
    state.rows = draft.rows;
    state.groups = Array.isArray(draft.groups) ? draft.groups : [];
    state.declaredTotal = draft.declaredTotal ?? null;
    state.month = draft.month ?? null;
    state.parseErrors = Array.isArray(draft.parseErrors) ? draft.parseErrors : [];
    state.warnings = Array.isArray(draft.warnings) ? draft.warnings : [];
  }

  function bindEvents() {
    elements.parse.addEventListener("click", parseSource);
    elements.reset.addEventListener("click", resetReport);
    elements.resetDefaults.addEventListener("click", () => {
      fillDefaultInputs(core.DEFAULTS);
      saveDefaults();
      globalScope.showToast?.("已恢复提单默认值");
    });
    elements.source.addEventListener("input", persistDraft);
    [
      elements.defaultWorkUnit,
      elements.defaultProductionLevel,
      elements.defaultVendor,
      elements.defaultTestOrder,
      elements.defaultRequirementType,
      elements.defaultLength,
      elements.defaultWidth,
      elements.defaultMethod,
      elements.defaultProducer,
    ].forEach((control) => control.addEventListener("input", saveDefaults));
    elements.tableBody.addEventListener("change", updateRow);
    elements.tableBody.addEventListener("click", (event) => {
      const button = event.target.closest("[data-remove-row]");
      if (!button) return;
      state.rows.splice(Number(button.dataset.removeRow), 1);
      renderAll();
    });
    elements.redistribute.addEventListener("click", () => {
      state.rows = core.redistributeWorkloads(state.rows, state.groups);
      renderAll();
      globalScope.showToast?.("已按当前任务数量重新平均分配工时");
    });
    [elements.categoryFilter, elements.levelFilter, elements.dateFilter, elements.search].forEach((control) => control.addEventListener("input", renderTable));
    elements.clearFilters.addEventListener("click", () => {
      elements.categoryFilter.value = "all";
      elements.levelFilter.value = "all";
      elements.dateFilter.value = "";
      elements.search.value = "";
      renderTable();
    });
    elements.copy.addEventListener("click", copyTable);
    elements.export.addEventListener("click", exportWorkbook);
  }

  function init() {
    if (state.initialized || !byId("dailyReportView")) return;
    state.initialized = true;
    Object.assign(elements, {
      source: byId("dailyReportSource"), parse: byId("dailyReportParse"), reset: byId("dailyReportReset"),
      resetDefaults: byId("dailyReportResetDefaults"), defaultWorkUnit: byId("dailyReportDefaultWorkUnit"),
      defaultProductionLevel: byId("dailyReportDefaultProductionLevel"), defaultVendor: byId("dailyReportDefaultVendor"),
      defaultTestOrder: byId("dailyReportDefaultTestOrder"), defaultRequirementType: byId("dailyReportDefaultRequirementType"),
      defaultLength: byId("dailyReportDefaultLength"), defaultWidth: byId("dailyReportDefaultWidth"),
      defaultMethod: byId("dailyReportDefaultMethod"), defaultProducer: byId("dailyReportDefaultProducer"),
      summary: byId("dailyReportSummary"), issues: byId("dailyReportIssues"), tableHead: byId("dailyReportTableHead"),
      tableBody: byId("dailyReportTableBody"), copy: byId("dailyReportCopy"), export: byId("dailyReportExport"),
      redistribute: byId("dailyReportRedistribute"), status: byId("dailyReportStatus"),
      categoryFilter: byId("dailyReportCategoryFilter"), levelFilter: byId("dailyReportLevelFilter"),
      dateFilter: byId("dailyReportDateFilter"), search: byId("dailyReportSearch"),
      clearFilters: byId("dailyReportClearFilters"), visibleCount: byId("dailyReportVisibleCount"),
      categorySummary: byId("dailyReportCategorySummary"),
    });
    fillDefaultInputs(getDefaults());
    restoreDraft();
    core.HEADERS.forEach((label) => {
      const cell = document.createElement("th");
      cell.textContent = label;
      elements.tableHead.appendChild(cell);
    });
    const action = document.createElement("th");
    action.textContent = "操作";
    elements.tableHead.appendChild(action);
    bindEvents();
    renderAll();
  }

  globalScope.NgrDailyReport = Object.freeze({ init, parseSource });
})(window);
