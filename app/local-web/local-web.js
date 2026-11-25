const elements = Object.fromEntries(
  [...document.querySelectorAll("[id]")].map((element) => [element.id, element])
);
const byId = (id) => elements[id];
const links = [...document.querySelectorAll("[data-route]")];
const filters = [...document.querySelectorAll("[data-filter]")];
const listPageSize = 50;
const maxJobFiles = 200;
const pollInterval = 700;
const activeStatuses = new Set(["queued", "running"]);
const jobLabels = {
  queued: "等待处理",
  running: "正在处理",
  completed: "已完成",
  failed: "任务失败",
  cancelled: "已取消"
};
const pageDetails = {
  naming: {
    title: "AI 自动命名",
    description: "批量生成切图名称，确认后导出副本。",
    results: "命名结果",
    start: "开始命名",
    method: "start_naming",
    columns: ["原文件", "新文件名", "结果"]
  },
  slice: {
    title: "UI 切图检测",
    description: "检查切图格式、尺寸和规范。",
    results: "检测结果",
    start: "开始检测",
    method: "start_slice_check",
    columns: ["文件", "尺寸", "检测结果"]
  }
};

function createAssetPage() {
  return {
    sourceId: "",
    offset: 0,
    files: [],
    total: 0,
    allSelected: false,
    selection: new Set(),
    sourceBusy: false,
    sourceStatus: "",
    sourceError: false,
    loaded: false,
    mode: "ai",
    job: null,
    action: "",
    pollTimer: null,
    pollErrors: 0,
    jobMessage: "",
    jobError: false,
    filter: "all",
    edits: new Map(),
    exportStatus: "",
    exportError: false,
    exportErrors: []
  };
}

const pages = { naming: createAssetPage(), slice: createAssetPage() };
let connected = false;
let route = "finder";
let sources = [];

function create(tag, value, className) {
  const element = document.createElement(tag);
  if (value !== undefined) element.textContent = value;
  if (className) element.className = className;
  return element;
}

function message(error, fallback) {
  return error instanceof Error && error.message ? error.message : fallback;
}

function setStatus(id, value, error = false) {
  byId(id).textContent = value;
  byId(id).dataset.error = String(error);
}

function showDisconnected(value = "请从桌面端重新打开本地浏览器。") {
  connected = false;
  for (const page of Object.values(pages)) {
    clearTimeout(page.pollTimer);
  }
  byId("finder-frame").removeAttribute("src");
  byId("navigation").hidden = true;
  byId("finder-page").hidden = true;
  byId("asset-page").hidden = true;
  byId("connection").hidden = false;
  byId("connection-title").textContent = "本地连接未建立";
  byId("connection-message").textContent = value;
  byId("retry-connection").hidden = false;
}

async function request(url, payload) {
  const options = { credentials: "same-origin", cache: "no-store" };
  if (payload) {
    options.method = "POST";
    options.headers = { "Content-Type": "application/json" };
    options.body = JSON.stringify(payload);
  }

  let response;
  try {
    response = await fetch(url, options);
  } catch {
    throw new Error("暂时无法连接桌面端，请检查 AI资源领航是否正在运行。");
  }

  const data = await response.json().catch(() => null);
  if (!response.ok || !data || data.error) {
    if (connected && [401, 403, 404].includes(response.status)) showDisconnected();
    const detail = typeof data?.error === "string" ? data.error : data?.error?.message;
    throw new Error(detail || "本地服务暂时无法完成请求。");
  }
  return data;
}

async function assetRequest(method, args = {}) {
  return (await request("/api/assets", { method, args })).result;
}

async function connect(ticket) {
  byId("connection-title").textContent = "正在连接 AI资源领航";
  byId("connection-message").textContent = "请稍候。";
  byId("retry-connection").hidden = true;
  try {
    const result = ticket ? await request("/api/pair", { ticket }) : await request("/api/session");
    if (!result.paired) throw new Error("未找到可用的本地连接。");
    connected = true;
    byId("connection").hidden = true;
    byId("navigation").hidden = false;
    navigate();
    for (const page of Object.values(pages)) schedulePoll(page);
  } catch {
    showDisconnected();
  }
}

function navigate() {
  if (!connected) return;
  const hash = location.hash.slice(1);
  route = Object.hasOwn(pageDetails, hash) ? hash : "finder";
  for (const link of links) {
    if (link.dataset.route === route) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  }

  const showFinder = route === "finder";
  byId("finder-page").hidden = !showFinder;
  byId("asset-page").hidden = showFinder;
  if (showFinder) {
    if (!byId("finder-frame").hasAttribute("src")) byId("finder-frame").src = "/finder/";
    document.title = "快速找界面 · AI资源领航";
    return;
  }

  const details = pageDetails[route];
  const page = pages[route];
  document.title = details.title + " · AI资源领航";
  byId("page-title").textContent = details.title;
  byId("page-description").textContent = details.description;
  byId("results-title").textContent = details.results;
  byId("naming-mode-field").hidden = route !== "naming";
  byId("naming-mode").value = page.mode;
  byId("start-job").textContent = details.start;

  const headerRow = create("tr");
  for (const label of details.columns) {
    const column = create("th", label);
    column.scope = "col";
    headerRow.append(column);
  }
  byId("result-head").replaceChildren(headerRow);
  byId("result-table").classList.toggle("table-naming", route === "naming");

  renderSource(page);
  renderJob(page);
  if ((!page.loaded || (!page.sourceId && sources.length)) && !sourceLocked(page)) loadSources(page);
}

function isVisible(page) {
  return connected && pages[route] === page;
}

function jobActive(page) {
  return activeStatuses.has(page.job?.status);
}

function selectedCount(page) {
  return page.allSelected ? page.total - page.selection.size : page.selection.size;
}

function selected(page, relativePath) {
  return page.allSelected ? !page.selection.has(relativePath) : page.selection.has(relativePath);
}

function sourceLocked(page) {
  return page.sourceBusy || jobActive(page) || Boolean(page.action);
}

function renderSelection(page) {
  const count = selectedCount(page);
  const all = byId("select-all");
  const locked = sourceLocked(page);
  all.checked = page.total > 0 && count === page.total;
  all.indeterminate = count > 0 && count < page.total;
  all.disabled = locked || page.total === 0 || page.total > maxJobFiles;
  byId("selection-count").textContent = "已选 " + count + " / " + page.total;
  byId("start-job").disabled = locked || count === 0;
}

function renderSource(page) {
  if (!isVisible(page)) return;
  const locked = sourceLocked(page);
  byId("grant-files").disabled = locked;
  byId("grant-directory").disabled = locked;
  byId("naming-mode").disabled = locked;
  byId("source-contents").hidden = sources.length === 0;
  byId("source-select").disabled = locked;

  const options = sources.map((source) => {
    const option = create("option", source.name + "（" + source.fileCount + "）");
    option.value = source.sourceId;
    return option;
  });
  byId("source-select").replaceChildren(...options);
  byId("source-select").value = page.sourceId;

  const files = page.files.map((file) => {
    const row = create("li");
    const label = create("label", undefined, "check-label");
    const checkbox = create("input");
    checkbox.type = "checkbox";
    checkbox.checked = selected(page, file.relativePath);
    checkbox.disabled = locked;
    checkbox.addEventListener("change", () => {
      if (!page.allSelected && checkbox.checked && selectedCount(page) === maxJobFiles) {
        checkbox.checked = false;
        setStatus("source-status", "每次最多处理 " + maxJobFiles + " 个文件。", true);
        return;
      }
      const isException = page.allSelected ? !checkbox.checked : checkbox.checked;
      if (isException) page.selection.add(file.relativePath);
      else page.selection.delete(file.relativePath);
      setStatus("source-status", page.sourceStatus, page.sourceError);
      renderSelection(page);
    });
    label.append(checkbox, create("span", file.relativePath));
    row.append(label);
    return row;
  });
  if (!files.length) {
    files.push(create("li", page.sourceBusy ? "正在读取…" : "没有可处理的文件", "file-empty"));
  }
  byId("file-list").replaceChildren(...files);

  byId("pagination").hidden = page.total <= listPageSize;
  byId("previous-files").disabled = locked || page.offset === 0;
  byId("next-files").disabled = locked || page.offset + listPageSize >= page.total;
  byId("page-count").textContent = (Math.floor(page.offset / listPageSize) + 1) + " / " + Math.ceil(page.total / listPageSize);
  setStatus("source-status", page.sourceStatus, page.sourceError);
  byId("retry-sources").hidden = !page.sourceError || !page.loaded;
  byId("retry-sources").disabled = locked;
  renderSelection(page);
}

function useSource(page, sourceId) {
  page.sourceId = sourceId;
  page.offset = 0;
  page.files = [];
  page.total = 0;
  page.allSelected = false;
  page.selection.clear();
}

async function fetchFiles(page, offset, resetSelection = false) {
  if (!page.sourceId) return;
  const data = await assetRequest("list_sources", { sourceId: page.sourceId, offset, limit: listPageSize });
  page.files = data.files;
  page.total = data.total;
  page.offset = offset;
  if (resetSelection) page.allSelected = page.total <= maxJobFiles;
  page.sourceStatus = page.total > maxJobFiles ? "每次最多处理 " + maxJobFiles + " 个文件，请勾选本次要处理的文件。" : "";
}

async function withSources(page, pending, action) {
  if (!page || sourceLocked(page)) return;
  page.sourceBusy = true;
  page.sourceStatus = pending;
  page.sourceError = false;
  renderSource(page);
  try {
    await action();
  } catch (error) {
    page.sourceStatus = message(error, "无法读取文件，请重试。");
    page.sourceError = true;
  } finally {
    page.sourceBusy = false;
    page.loaded = true;
    renderSource(page);
  }
}

function loadSources(page) {
  return withSources(page, "正在读取文件…", async () => {
    const data = await assetRequest("list_sources");
    sources = data.sources;
    const nextId = sources.find((source) => source.sourceId === page.sourceId)?.sourceId ?? sources[0]?.sourceId ?? "";
    const changed = page.sourceId !== nextId || !page.files.length;
    if (changed) useSource(page, nextId);
    if (nextId) await fetchFiles(page, page.offset, changed);
    else page.sourceStatus = "请从桌面端选择文件或文件夹。";
  });
}

function grantSources(kind) {
  const page = pages[route];
  return withSources(page, "请在桌面端完成选择。", async () => {
    const data = await assetRequest("grant_sources", { kind });
    if (data.canceled || !data.sources.length) {
      page.sourceStatus = "未添加文件。";
      return;
    }
    const newSource = data.sources[0];
    const merged = new Map(sources.map((source) => [source.sourceId, source]));
    for (const source of data.sources) merged.set(source.sourceId, source);
    sources = [...merged.values()];
    useSource(page, newSource.sourceId);
    await fetchFiles(page, 0, true);
  });
}

async function selectionArgs(page) {
  const args = { sourceId: page.sourceId };
  if (!page.allSelected) {
    args.relativePaths = [...page.selection];
    return args;
  }
  const files = page.total <= listPageSize
    ? page.files
    : (await assetRequest("list_sources", { sourceId: page.sourceId, offset: 0, limit: maxJobFiles })).files;
  args.relativePaths = files
    .filter((file) => selected(page, file.relativePath))
    .map((file) => file.relativePath);
  return args;
}

function schedulePoll(page) {
  clearTimeout(page.pollTimer);
  if (!connected || !jobActive(page) || page.action || page.pollErrors >= 3) return;
  page.pollTimer = setTimeout(() => pollJob(page), pollInterval * (page.pollErrors + 1));
}

async function pollJob(page) {
  if (!connected || !jobActive(page) || page.action) return;
  const requested = page.job;
  try {
    const newJob = await assetRequest("get_asset_job", { jobId: requested.jobId });
    if (page.job !== requested || page.action) return;
    page.pollErrors = 0;
    page.jobMessage = newJob.error || "";
    page.jobError = newJob.status === "failed";
    page.job = newJob;
    if (!jobActive(page)) renderSource(page);
  } catch (error) {
    if (page.job !== requested || page.action) return;
    page.pollErrors += 1;
    if (page.pollErrors >= 3) {
      page.jobMessage = message(error, "无法更新任务进度，请刷新任务。");
      page.jobError = true;
    }
  } finally {
    renderJob(page);
    schedulePoll(page);
  }
}

async function startJob() {
  const page = pages[route];
  const details = pageDetails[route];
  if (!page || sourceLocked(page) || selectedCount(page) === 0) return;
  page.action = "start";
  page.jobMessage = page === pages.naming && page.mode === "ai" ? "请在桌面端确认 AI 命名。" : "正在提交任务…";
  page.jobError = false;
  renderSource(page);
  renderJob(page);
  try {
    const args = await selectionArgs(page);
    if (page === pages.naming) args.mode = page.mode;
    const job = await assetRequest(details.method, args);
    page.job = job;
    page.pollErrors = 0;
    page.filter = "all";
    page.edits.clear();
    page.exportStatus = "";
    page.exportError = false;
    page.exportErrors = [];
    page.jobMessage = job.error || "";
    page.jobError = job.status === "failed";
  } catch (error) {
    page.jobMessage = message(error, "无法启动任务，请重试。");
    page.jobError = true;
  } finally {
    page.action = "";
    renderSource(page);
    renderJob(page);
    schedulePoll(page);
  }
}

async function cancelJob() {
  const page = pages[route];
  if (!page || !jobActive(page) || page.action) return;
  page.action = "cancel";
  page.pollErrors = 0;
  page.jobMessage = "正在取消…";
  page.jobError = false;
  clearTimeout(page.pollTimer);
  renderJob(page);
  try {
    page.job = await assetRequest("cancel_asset_job", { jobId: page.job.jobId });
    page.jobMessage = page.job.error || "";
    page.jobError = page.job.status === "failed";
  } catch (error) {
    page.jobMessage = message(error, "任务取消失败，请重试。");
    page.jobError = true;
  } finally {
    page.action = "";
    renderSource(page);
    renderJob(page);
    schedulePoll(page);
  }
}

function namingCell(page, result, index) {
  const cell = create("td");
  if (!result.proposedName) return cell;
  const input = create("input", undefined, "name-input");
  input.type = "text";
  input.autocomplete = "off";
  input.setAttribute("aria-label", "新文件名 " + result.relativePath);
  input.value = page.edits.get(result.relativePath) ?? result.proposedName;
  input.disabled = page.job.status !== "completed" || Boolean(page.action);
  input.addEventListener("input", () => {
    if (input.value === result.proposedName) page.edits.delete(result.relativePath);
    else page.edits.set(result.relativePath, input.value);
    byId("export-copies").disabled = !editsValid(page);
  });
  cell.append(input);
  const alternatives = [...new Set(result.recommendations ?? [])].filter((name) => name !== result.proposedName);
  if (alternatives.length) {
    const options = create("datalist");
    options.id = "name-options-" + index;
    input.setAttribute("list", options.id);
    for (const name of alternatives) {
      const option = create("option");
      option.value = name;
      options.append(option);
    }
    cell.append(options);
  }
  return cell;
}

function detectionKind(result) {
  if (result.issues.length) return "issue";
  if (result.warnings.length) return "warning";
  return "pass";
}

function detailItems(texts, className) {
  const list = create("ul", undefined, "cell-detail " + className);
  list.append(...texts.map((name) => create("li", name)));
  return list;
}

function resultRow(page, result, index) {
  const row = create("tr");
  row.append(create("td", result.relativePath));
  if (page === pages.naming) {
    const labels = {
      done: ["已生成", "tone-success"],
      fallback: ["已用本地规则", "tone-warning"],
      failed: ["失败", "tone-danger"]
    };
    const [label, tone] = labels[result.status] ?? ["已处理", ""];
    const status = create("td");
    status.append(create("strong", label, tone));
    if (result.message) status.append(create("small", result.message, "status-detail"));
    row.append(namingCell(page, result, index), status);
    return row;
  }

  const size = create("td", result.width && result.height ? result.width + " × " + result.height : "—");
  if (result.format) size.append(create("small", result.format.toUpperCase(), "status-detail"));
  const detail = create("td");
  if (result.issues.length) detail.append(detailItems(result.issues, "tone-danger"));
  if (result.warnings.length) detail.append(detailItems(result.warnings, "tone-warning"));
  if (!result.issues.length && !result.warnings.length) detail.append(create("strong", "通过", "tone-success"));
  if (result.similarNames?.length) {
    detail.append(create("small", "疑似重复：" + result.similarNames.join("、"), "status-detail"));
  }
  row.append(size, detail);
  return row;
}

function renderResults(page) {
  const results = page.job?.results ?? [];
  const isSlice = page === pages.slice;
  byId("result-filters").hidden = !isSlice || !results.length;
  if (isSlice && results.length) {
    const counts = { all: results.length, issue: 0, warning: 0, pass: 0 };
    const labels = { all: "全部", issue: "问题", warning: "警告", pass: "通过" };
    for (const result of results) counts[detectionKind(result)] += 1;
    for (const filter of filters) {
      const key = filter.dataset.filter;
      filter.textContent = labels[key] + " " + counts[key];
      filter.setAttribute("aria-pressed", String(page.filter === key));
    }
  }
  const visible = !isSlice || page.filter === "all" ? results : results.filter((result) => detectionKind(result) === page.filter);
  byId("result-body").replaceChildren(...visible.map((result, index) => resultRow(page, result, index)));
  byId("result-table").hidden = visible.length === 0;
  byId("empty-results").hidden = visible.length > 0;
  byId("empty-results").textContent = results.length ? "当前筛选没有结果。" : (page.job || page.action) ? "暂无结果。" : "选择文件并开始处理，结果将在这里显示。";
}

function editsValid(page) {
  return [...page.edits.values()].every((name) => name.trim());
}

function renderJob(page) {
  if (!isVisible(page)) return;
  const job = page.job;
  byId("job-progress").hidden = !job;
  if (job) {
    byId("job-status").textContent = jobLabels[job.status] ?? "等待处理";
    byId("job-count").textContent = job.processed + " / " + job.total;
    byId("job-profile").textContent = job.profileName || "";
    const progress = byId("progress-bar");
    progress.max = Math.max(job.total, 1);
    if (job.status === "queued") progress.removeAttribute("value");
    else progress.value = job.processed;
  }
  byId("cancel-job").hidden = !jobActive(page);
  byId("cancel-job").disabled = Boolean(page.action);
  byId("retry-job").hidden = !jobActive(page) || page.pollErrors < 3;
  const awaitingNamingApproval = page === pages.naming && jobActive(page) && job.processed === 0 && (job.mode ?? page.mode) === "ai";
  setStatus("job-message", page.jobMessage || (awaitingNamingApproval ? "如需确认，请在桌面端处理。" : ""), page.jobError);
  byId("export-copies").hidden = page !== pages.naming || job?.status !== "completed" || !job.results.some((result) => result.proposedName);
  byId("export-copies").disabled = Boolean(page.action) || !editsValid(page);
  setStatus("export-status", page.exportStatus, page.exportError);
  byId("export-errors").replaceChildren(...page.exportErrors.map((error) => create("li", error)));
  byId("export-errors").hidden = !page.exportErrors.length;
  renderResults(page);
}

async function exportCopies() {
  const page = pages.naming;
  if (route !== "naming" || page.job?.status !== "completed" || page.action || !editsValid(page)) return;
  page.action = "export";
  page.exportStatus = "请在桌面端选择副本保存位置。";
  page.exportError = false;
  page.exportErrors = [];
  renderSource(page);
  renderJob(page);
  try {
    const edits = [...page.edits].map(([relativePath, name]) => ({ relativePath, name: name.trim() }));
    const result = await assetRequest("export_named_copies", { jobId: page.job.jobId, edits });
    if (result.canceled) {
      page.exportStatus = "已取消导出。";
    } else {
      const copied = result.files.filter((file) => file.status === "copied").length;
      const skipped = result.files.filter((file) => file.status === "skipped").length;
      const failed = result.files.length - copied - skipped;
      page.exportError = failed > 0;
      page.exportStatus = ["已导出 " + copied + " 个副本", skipped && "跳过 " + skipped + " 个", failed && "失败 " + failed + " 个"].filter(Boolean).join("，");
      page.exportErrors = result.files.filter((file) => file.status !== "copied")
        .map((file) => file.relativePath + "：" + (file.message || (file.status === "skipped" ? "已跳过" : "导出失败")));
    }
  } catch (error) {
    page.exportStatus = message(error, "无法导出副本，请重试。");
    page.exportError = true;
  } finally {
    page.action = "";
    renderSource(page);
    renderJob(page);
  }
}

byId("retry-connection").addEventListener("click", () => connect());
window.addEventListener("hashchange", navigate);
byId("grant-files").addEventListener("click", () => grantSources("files"));
byId("grant-directory").addEventListener("click", () => grantSources("directory"));
byId("retry-sources").addEventListener("click", () => loadSources(pages[route]));
byId("source-select").addEventListener("change", (event) => {
  const page = pages[route];
  const sourceId = event.target.value;
  withSources(page, "正在读取文件…", async () => {
    useSource(page, sourceId);
    await fetchFiles(page, 0, true);
  });
});
byId("select-all").addEventListener("change", (event) => {
  const page = pages[route];
  page.allSelected = event.target.checked;
  page.selection.clear();
  renderSource(page);
});
byId("previous-files").addEventListener("click", () => {
  const page = pages[route];
  withSources(page, "正在读取文件…", () => fetchFiles(page, page.offset - listPageSize));
});
byId("next-files").addEventListener("click", () => {
  const page = pages[route];
  withSources(page, "正在读取文件…", () => fetchFiles(page, page.offset + listPageSize));
});
byId("naming-mode").addEventListener("change", (event) => { pages.naming.mode = event.target.value; });
byId("start-job").addEventListener("click", startJob);
byId("cancel-job").addEventListener("click", cancelJob);
byId("retry-job").addEventListener("click", () => {
  const page = pages[route];
  page.pollErrors = 0;
  byId("retry-job").hidden = true;
  pollJob(page);
});
byId("export-copies").addEventListener("click", exportCopies);
for (const filter of filters) {
  filter.addEventListener("click", () => {
    pages.slice.filter = filter.dataset.filter;
    renderResults(pages.slice);
  });
}

function initialize() {
  const ticket = new URLSearchParams(location.hash.slice(1)).get("ticket");
  if (ticket !== null) {
    history.replaceState(null, "", location.pathname + location.search);
  }
  connect(ticket);
}

initialize();
