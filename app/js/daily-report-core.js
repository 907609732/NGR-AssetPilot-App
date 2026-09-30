(function initializeDailyReportCore(globalScope) {
  "use strict";

  const HEADERS = Object.freeze([
    "物件名称",
    "工作量单位",
    "期望完成日期",
    "制作等级",
    "推荐供应商",
    "是否测试单",
    "需求内容",
    "尺寸(长)",
    "尺寸(宽)",
    "制作方式",
    "数量/预估工作量",
    "制作人员",
  ]);

  const DEFAULTS = Object.freeze({
    workUnit: "人日(默认)",
    productionLevel: "",
    vendor: "郑州名匠网络科技有限公司",
    testOrder: "否",
    requirementType: "交互界面",
    dimensionLength: 2560,
    dimensionWidth: 1440,
    productionMethod: "高模渲染",
    producer: "陈月财",
  });

  const DATE_PREFIX = /^(\d{1,2})\s*[\/.]\s*(\d{1,2})(?:\s*[-–—~～至]\s*(?:(\d{1,2})\s*[\/.]\s*)?(\d{1,2}))?/;
  const WORKLOAD = /(\d+(?:\.\d+)?)\s*(?:人天|人日)/;
  const LEVEL = /[（(]\s*(S[123])\s*[）)]/i;
  const SUMMARY = /^共计\s*(\d+(?:\.\d+)?)\s*人天(?:任务)?/;

  function round2(value) {
    return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
  }

  function parseNumber(value) {
    if (value === "" || value == null) return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  function normalizeLine(value) {
    return String(value || "")
      .replace(/[\u00a0\u2007\u202f\u3000]/g, " ")
      .trim();
  }

  function isValidDateParts(year, month, day) {
    if (![year, month, day].every(Number.isInteger)) return false;
    const date = new Date(Date.UTC(year, month - 1, day));
    return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
  }

  function toIsoDate(year, month, day) {
    return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  }

  function isValidIsoDate(value) {
    const match = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
    return Boolean(match && isValidDateParts(Number(match[1]), Number(match[2]), Number(match[3])));
  }

  function parseDatePrefix(line, targetYear) {
    const match = normalizeLine(line).match(DATE_PREFIX);
    if (!match) return null;
    const startMonth = Number(match[1]);
    const startDay = Number(match[2]);
    const endMonth = match[4] ? Number(match[3] || startMonth) : startMonth;
    const endDay = match[4] ? Number(match[4]) : startDay;
    const endYear = endMonth < startMonth ? targetYear + 1 : targetYear;
    return {
      text: match[0],
      startMonth,
      startDay,
      endMonth,
      endDay,
      endYear,
      valid: isValidDateParts(targetYear, startMonth, startDay) && isValidDateParts(endYear, endMonth, endDay),
      dueDate: isValidDateParts(endYear, endMonth, endDay) ? toIsoDate(endYear, endMonth, endDay) : "",
    };
  }

  function hasInlineTask(normalizedLine, dateText) {
    const remainder = normalizedLine.slice(dateText.length)
      .replace(LEVEL, "")
      .replace(WORKLOAD, "")
      .trim();
    return Boolean(remainder);
  }

  function distributeHundredths(total, count) {
    if (!Number.isFinite(total) || total <= 0 || !Number.isInteger(count) || count < 1) return [];
    const hundredths = Math.round(total * 100);
    const base = Math.floor(hundredths / count);
    const remainder = hundredths - (base * count);
    return Array.from({ length: count }, (_value, index) => (base + (index < remainder ? 1 : 0)) / 100);
  }

  function buildRow(task, group, workload, defaults) {
    return {
      objectName: task.raw,
      workUnit: defaults.workUnit,
      dueDate: group.dueDate,
      productionLevel: defaults.productionLevel,
      vendor: defaults.vendor,
      testOrder: defaults.testOrder,
      requirementType: defaults.requirementType,
      dimensionLength: defaults.dimensionLength,
      dimensionWidth: defaults.dimensionWidth,
      productionMethod: defaults.productionMethod,
      workload,
      producer: defaults.producer,
      sourceLine: task.sourceLine,
      groupId: group.id,
      inheritedDate: task.inheritedDate,
      parsedLevel: task.level || group.level || "",
    };
  }

  function parseDailyReport(input, options = {}) {
    const targetYear = Number(options.year || new Date().getFullYear());
    const defaults = { ...DEFAULTS, ...(options.defaults || {}) };
    const errors = [];
    const warnings = [];
    const groups = [];
    let declaredTotal = null;
    let currentGroup = null;

    const source = String(input || "").replace(/\r\n?/g, "\n");
    if (source.length > 100_000) {
      errors.push({ code: "INPUT_TOO_LARGE", message: "原文超过 100 KB，请拆分后再解析。" });
      return { targetYear, detectedMonth: null, rows: [], groups: [], declaredTotal, calculatedTotal: 0, difference: null, errors, warnings };
    }

    const lines = source.split("\n");
    for (let index = 0; index < lines.length; index += 1) {
      const raw = lines[index].trim();
      const normalized = normalizeLine(lines[index]);
      if (!normalized) continue;
      const summaryMatch = normalized.match(SUMMARY);
      if (summaryMatch) {
        declaredTotal = Number(summaryMatch[1]);
        continue;
      }

      const date = parseDatePrefix(normalized, targetYear);
      if (date) {
        const workloadMatch = normalized.match(WORKLOAD);
        const levelMatch = normalized.match(LEVEL);
        currentGroup = {
          id: `group-${groups.length + 1}`,
          sourceLine: index + 1,
          startMonth: date.startMonth,
          startDay: date.startDay,
          endMonth: date.endMonth,
          endDay: date.endDay,
          endYear: date.endYear,
          dueDate: date.dueDate,
          totalWorkload: workloadMatch ? Number(workloadMatch[1]) : null,
          level: levelMatch ? levelMatch[1].toUpperCase() : "",
          tasks: [],
        };
        groups.push(currentGroup);
        if (!date.valid) {
          errors.push({ code: "INVALID_DATE", line: index + 1, groupId: currentGroup.id, message: `第 ${index + 1} 行日期无效。` });
        }
        if (!workloadMatch || !(currentGroup.totalWorkload > 0)) {
          errors.push({ code: "MISSING_WORKLOAD", line: index + 1, groupId: currentGroup.id, message: `第 ${index + 1} 行缺少有效的人天数。` });
        }
        if (hasInlineTask(normalized, date.text)) {
          currentGroup.tasks.push({ raw, sourceLine: index + 1, inheritedDate: false, level: currentGroup.level });
        }
        continue;
      }

      if (!currentGroup) {
        errors.push({ code: "TASK_WITHOUT_DATE", line: index + 1, message: `第 ${index + 1} 行任务前没有日期。` });
        continue;
      }
      const ownLevel = normalized.match(LEVEL)?.[1]?.toUpperCase() || "";
      currentGroup.tasks.push({ raw, sourceLine: index + 1, inheritedDate: true, level: ownLevel });
    }

    const rows = [];
    for (const group of groups) {
      if (!group.tasks.length) {
        errors.push({ code: "GROUP_WITHOUT_TASK", line: group.sourceLine, groupId: group.id, message: `第 ${group.sourceLine} 行日期组没有任务内容。` });
        continue;
      }
      const allocations = distributeHundredths(group.totalWorkload, group.tasks.length);
      group.tasks.forEach((task, index) => rows.push(buildRow(task, group, allocations[index] ?? null, defaults)));
    }

    const calculatedTotal = round2(rows.reduce((sum, row) => sum + (Number(row.workload) || 0), 0));
    const difference = declaredTotal == null ? null : round2(calculatedTotal - declaredTotal);
    if (declaredTotal == null) {
      warnings.push({ code: "SUMMARY_MISSING", message: "未找到“共计…人天”汇总行，将仅按解析结果导出。" });
    } else if (difference !== 0) {
      errors.push({ code: "SUMMARY_MISMATCH", message: `文本声明 ${declaredTotal} 人天，当前表格合计 ${calculatedTotal} 人天。` });
    }
    if (groups.length && new Set(groups.map((group) => group.startMonth)).size > 1) {
      warnings.push({ code: "MULTIPLE_MONTHS", message: "原文包含多个起始月份，导出文件名使用第一组任务月份。" });
    }

    return {
      targetYear,
      detectedMonth: groups[0]?.startMonth || null,
      rows,
      groups,
      declaredTotal,
      calculatedTotal,
      difference,
      errors,
      warnings,
    };
  }

  function validateRows(rows, declaredTotal = null) {
    const errors = [];
    const list = Array.isArray(rows) ? rows : [];
    if (!list.length) errors.push({ code: "ROWS_EMPTY", message: "没有可导出的任务行。" });
    if (list.length > 1000) errors.push({ code: "ROWS_TOO_MANY", message: "任务行不能超过 1000 行。" });
    list.forEach((row, index) => {
      const line = index + 1;
      if (!String(row.objectName || "").trim()) errors.push({ code: "NAME_REQUIRED", row: index, message: `第 ${line} 行物件名称不能为空。` });
      if (String(row.objectName || "").length > 5000) errors.push({ code: "CELL_TOO_LONG", row: index, field: "objectName", message: `第 ${line} 行物件名称超过 5000 字。` });
      if (!isValidIsoDate(row.dueDate)) errors.push({ code: "DATE_REQUIRED", row: index, field: "dueDate", message: `第 ${line} 行期望完成日期无效。` });
      const workload = parseNumber(row.workload);
      if (!(workload > 0)) errors.push({ code: "WORKLOAD_REQUIRED", row: index, field: "workload", message: `第 ${line} 行工作量必须大于 0。` });
      for (const field of ["dimensionLength", "dimensionWidth"]) {
        if (!(parseNumber(row[field]) > 0)) errors.push({ code: "DIMENSION_INVALID", row: index, field, message: `第 ${line} 行尺寸必须大于 0。` });
      }
      for (const field of ["workUnit", "vendor", "testOrder", "requirementType", "productionMethod", "producer"]) {
        if (!String(row[field] || "").trim()) errors.push({ code: "FIELD_REQUIRED", row: index, field, message: `第 ${line} 行“${field}”不能为空。` });
        if (String(row[field] || "").length > 5000) errors.push({ code: "CELL_TOO_LONG", row: index, field, message: `第 ${line} 行内容超过 5000 字。` });
      }
    });
    const calculatedTotal = round2(list.reduce((sum, row) => sum + (parseNumber(row.workload) || 0), 0));
    const difference = declaredTotal == null ? null : round2(calculatedTotal - Number(declaredTotal));
    if (declaredTotal != null && difference !== 0) {
      errors.push({ code: "SUMMARY_MISMATCH", message: `文本声明 ${declaredTotal} 人天，当前表格合计 ${calculatedTotal} 人天。` });
    }
    return { errors, calculatedTotal, difference };
  }

  function redistributeWorkloads(rows, groups) {
    const output = (Array.isArray(rows) ? rows : []).map((row) => ({ ...row }));
    const groupMap = new Map((Array.isArray(groups) ? groups : []).map((group) => [group.id, group]));
    const indexesByGroup = new Map();
    output.forEach((row, index) => {
      if (!indexesByGroup.has(row.groupId)) indexesByGroup.set(row.groupId, []);
      indexesByGroup.get(row.groupId).push(index);
    });
    for (const [groupId, indexes] of indexesByGroup) {
      const allocations = distributeHundredths(Number(groupMap.get(groupId)?.totalWorkload), indexes.length);
      indexes.forEach((rowIndex, index) => { output[rowIndex].workload = allocations[index] ?? null; });
    }
    return output;
  }

  function formatDisplayDate(isoDate) {
    const match = String(isoDate || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
    return match ? `${Number(match[1])}/${Number(match[2])}/${Number(match[3])}` : String(isoDate || "");
  }

  function toTsv(rows) {
    const fields = ["objectName", "workUnit", "dueDate", "productionLevel", "vendor", "testOrder", "requirementType", "dimensionLength", "dimensionWidth", "productionMethod", "workload", "producer"];
    const clean = (value) => String(value ?? "").replace(/[\t\r\n]+/g, " ").trim();
    const body = (Array.isArray(rows) ? rows : []).map((row) => fields.map((field) => clean(field === "dueDate" ? formatDisplayDate(row[field]) : row[field])).join("\t"));
    return [HEADERS.join("\t"), ...body].join("\r\n");
  }

  globalScope.NgrDailyReportCore = Object.freeze({
    HEADERS,
    DEFAULTS,
    parseDailyReport,
    validateRows,
    redistributeWorkloads,
    toTsv,
    formatDisplayDate,
  });
})(typeof window === "undefined" ? globalThis : window);
