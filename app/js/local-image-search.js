/* NGR AssetPilot V3.0.0 module: local-image-search.js */
(function initializeLocalImageSearchModule(globalScope) {
  "use strict";

  const state = {
    initialized: false,
    libraries: [],
    activeLibraryId: null,
    activeJobId: null,
    modelTimer: null,
    jobTimer: null,
    queryPreviewUrl: "",
    resultUrls: [],
  };
  const $ = (selector) => document.querySelector(selector);
  const bridge = () => globalScope.NgrDesktopBridge?.localImageSearch;

  const nodes = {};
  function collectNodes() {
    [
      "localSearchRuntimeStatus", "localSearchWebOnly", "localSearchDesktopContent", "localSearchModelSummary",
      "localSearchModelState", "localSearchModelProgress", "localSearchDownloadModel", "localSearchCancelDownload",
      "localSearchRetryDownload", "localSearchImportModel", "localSearchExportModel", "localSearchCreateLibrary", "localSearchLibraryList", "localSearchLibraryEmpty",
      "localSearchRemoveModel",
      "localSearchActiveLibraryName", "localSearchLibraryMeta", "localSearchStartIndex", "localSearchCancelIndex",
      "localSearchRemoveLibrary", "localSearchScanned", "localSearchAnalyzed", "localSearchReused", "localSearchSkipped",
      "localSearchErrors", "localSearchImageTab", "localSearchTextTab", "localSearchImagePanel", "localSearchTextPanel",
      "localSearchDropzone", "localSearchImageInput", "localSearchQueryPreview", "localSearchTextInput",
      "localSearchTextSubmit", "localSearchQueryStatus", "localSearchResultCount", "localSearchResults",
      "localSearchResultsEmpty",
    ].forEach((id) => { nodes[id] = $(`#${id}`); });
  }

  function formatBytes(value) {
    const bytes = Number(value || 0);
    return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.round(bytes / 1024)} KB`;
  }

  function showStatus(message, tone = "") {
    nodes.localSearchQueryStatus.textContent = message;
    nodes.localSearchQueryStatus.dataset.tone = tone;
  }

  function friendlyError(error, fallback) {
    return String(error?.message || "").includes("LOCAL_SEARCH_MODEL_REQUIRED")
      ? "请先下载本地 AI 模型"
      : String(error?.message || fallback || "操作失败，请重试");
  }

  async function refreshModelStatus() {
    if (!bridge()?.isAvailable()) return;
    const status = await bridge().getModelStatus();
    const percent = status.totalBytes ? Math.min(100, status.downloadedBytes / status.totalBytes * 100) : 0;
    nodes.localSearchModelProgress.value = percent;
    nodes.localSearchModelSummary.textContent = `${formatBytes(status.downloadedBytes)} / ${formatBytes(status.totalBytes)}`;
    const busy = ["downloading", "importing", "exporting"].includes(status.state);
    nodes.localSearchModelState.textContent = status.state === "importing" ? "导入校验中" : status.state === "exporting" ? "正在导出" : status.ready ? "已就绪" : status.state === "downloading" ? "下载中" : status.state === "error" ? "校验失败" : status.state === "canceled" ? "已取消" : "未下载";
    nodes.localSearchModelState.dataset.state = status.ready ? "ready" : status.state;
    nodes.localSearchDownloadModel.classList.toggle("hidden", status.ready || busy || status.state === "error");
    nodes.localSearchImportModel.classList.toggle("hidden", busy);
    nodes.localSearchExportModel.classList.toggle("hidden", !status.ready || busy);
    nodes.localSearchCancelDownload.classList.toggle("hidden", status.state !== "downloading");
    nodes.localSearchRetryDownload.classList.toggle("hidden", status.state !== "error" && status.state !== "canceled");
    nodes.localSearchRemoveModel.classList.toggle("hidden", !status.ready);
    if (busy) scheduleModelPoll();
  }

  function scheduleModelPoll() {
    clearTimeout(state.modelTimer);
    state.modelTimer = setTimeout(() => refreshModelStatus().catch(() => {}), 500);
  }

  async function startModelDownload() {
    if (!globalScope.confirm("首次使用需要下载约 225 MB 的两个固定量化模型。下载完成后所有分析和搜索均离线运行，是否继续？")) return;
    await bridge().downloadModel();
    showStatus("模型正在下载，可以继续浏览软件。", "working");
    await refreshModelStatus();
  }

  async function importOfflineModel() {
    showStatus("请选择从联网电脑导出的 .ngrmodel 离线模型包。", "working");
    const poll = setInterval(() => refreshModelStatus().catch(() => {}), 500);
    try {
      const result = await bridge().importModel();
      if (result.canceled) return showStatus("已取消导入。", "");
      await refreshModelStatus();
      showStatus("离线模型包已通过完整校验；现在断开网络也能分析和搜索。", "ready");
    } finally {
      clearInterval(poll);
      await refreshModelStatus().catch(() => {});
    }
  }

  async function exportOfflineModel() {
    showStatus("正在生成可复制到纯离线电脑的模型包…", "working");
    const result = await bridge().exportModel();
    if (result.canceled) return showStatus("已取消导出。", "");
    showStatus("离线模型包已导出，可复制到其他电脑后直接导入。", "ready");
    await refreshModelStatus();
  }

  async function removeModel() {
    if (!globalScope.confirm("删除本地模型后，已有图库索引仍会保留，但再次分析或搜索前需要重新下载约 225 MB 模型。是否继续？")) return;
    await bridge().removeModel();
    await refreshModelStatus();
    showStatus("本地模型已删除，图库原图和索引未删除。", "ready");
  }

  async function refreshLibraries(preferredId = null) {
    state.libraries = await bridge().listLibraries();
    if (preferredId && state.libraries.some((item) => item.id === preferredId)) state.activeLibraryId = preferredId;
    if (!state.libraries.some((item) => item.id === state.activeLibraryId)) state.activeLibraryId = state.libraries[0]?.id || null;
    renderLibraries();
    renderActiveLibrary();
  }

  function renderLibraries() {
    nodes.localSearchLibraryList.replaceChildren();
    nodes.localSearchLibraryEmpty.classList.toggle("hidden", state.libraries.length > 0);
    state.libraries.forEach((library) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `local-search-library${library.id === state.activeLibraryId ? " active" : ""}`;
      button.innerHTML = `<strong></strong><span></span>`;
      button.querySelector("strong").textContent = library.name;
      button.querySelector("span").textContent = `${library.itemCount} 张 · ${library.status === "ready" ? "已就绪" : library.status === "indexing" ? "分析中" : "待分析"}`;
      button.addEventListener("click", () => {
        state.activeLibraryId = library.id;
        renderLibraries();
        renderActiveLibrary();
        clearResults();
      });
      nodes.localSearchLibraryList.append(button);
    });
  }

  function renderActiveLibrary() {
    const library = state.libraries.find((item) => item.id === state.activeLibraryId);
    nodes.localSearchActiveLibraryName.textContent = library?.name || "尚未选择图库";
    nodes.localSearchLibraryMeta.textContent = library
      ? `${library.itemCount} 张已索引${library.errorCount ? ` · ${library.errorCount} 个错误` : ""}${library.lastIndexedAt ? ` · ${new Date(library.lastIndexedAt).toLocaleString()}` : ""}`
      : "创建图库后开始分析";
    nodes.localSearchStartIndex.disabled = !library;
    nodes.localSearchRemoveLibrary.disabled = !library;
    if (library?.itemCount) showStatus("图库已就绪，可以粘贴截图、选择图片或输入文字搜索。", "ready");
  }

  async function createLibrary() {
    const result = await bridge().createLibrary();
    if (!result?.canceled) {
      await refreshLibraries(result.library.id);
      showStatus("图库已创建。下载模型后点击“开始分析”。", "ready");
    }
  }

  async function removeLibrary() {
    if (!state.activeLibraryId) return;
    const library = state.libraries.find((item) => item.id === state.activeLibraryId);
    if (!globalScope.confirm(`只删除“${library?.name || "此图库"}”的索引和缩略图，不会删除原图片。是否继续？`)) return;
    await bridge().removeLibrary({ libraryId: state.activeLibraryId });
    state.activeLibraryId = null;
    clearResults();
    await refreshLibraries();
    showStatus("索引已删除，原图片未做任何修改。", "ready");
  }

  async function startIndex() {
    if (!state.activeLibraryId) return;
    try {
      const result = await bridge().startIndex({ libraryId: state.activeLibraryId });
      state.activeJobId = result.jobId;
      nodes.localSearchStartIndex.classList.add("hidden");
      nodes.localSearchCancelIndex.classList.remove("hidden");
      showStatus("正在递归扫描和分析，关闭后下次可以继续增量更新。", "working");
      scheduleJobPoll();
    } catch (error) {
      showStatus(friendlyError(error, "无法开始分析"), "error");
    }
  }

  function scheduleJobPoll() {
    clearTimeout(state.jobTimer);
    state.jobTimer = setTimeout(() => pollJob().catch((error) => showStatus(friendlyError(error), "error")), 500);
  }

  async function pollJob() {
    if (!state.activeJobId) return;
    const job = await bridge().getJobStatus({ jobId: state.activeJobId });
    nodes.localSearchScanned.textContent = job.scanned || 0;
    nodes.localSearchAnalyzed.textContent = job.analyzed || 0;
    nodes.localSearchReused.textContent = job.reused || 0;
    nodes.localSearchSkipped.textContent = job.skipped || 0;
    nodes.localSearchErrors.textContent = job.errors || 0;
    if (job.state === "indexing") return scheduleJobPoll();
    nodes.localSearchStartIndex.classList.remove("hidden");
    nodes.localSearchCancelIndex.classList.add("hidden");
    state.activeJobId = null;
    await refreshLibraries(state.activeLibraryId);
    showStatus(job.state === "completed" ? `分析完成（${job.executionProvider === "dml" ? "DirectML" : "CPU"}）` : job.state === "canceled" ? "分析已停止，已完成部分会在下次复用。" : "分析失败，请重试。", job.state === "completed" ? "ready" : "error");
  }

  async function cancelIndex() {
    if (!state.activeJobId) return;
    await bridge().cancelJob({ jobId: state.activeJobId });
    showStatus("正在安全停止分析…", "working");
  }

  function setTab(tab) {
    const image = tab === "image";
    nodes.localSearchImageTab.classList.toggle("active", image);
    nodes.localSearchTextTab.classList.toggle("active", !image);
    nodes.localSearchImageTab.setAttribute("aria-selected", String(image));
    nodes.localSearchTextTab.setAttribute("aria-selected", String(!image));
    nodes.localSearchImagePanel.classList.toggle("hidden", !image);
    nodes.localSearchTextPanel.classList.toggle("hidden", image);
    if (!image) nodes.localSearchTextInput.focus();
  }

  function clearResultUrls() {
    state.resultUrls.forEach((url) => URL.revokeObjectURL(url));
    state.resultUrls = [];
  }

  function clearResults() {
    clearResultUrls();
    nodes.localSearchResults.replaceChildren();
    nodes.localSearchResultsEmpty.classList.remove("hidden");
    nodes.localSearchResultCount.textContent = "默认返回前 50 项";
  }

  async function renderResults(searchResult) {
    clearResults();
    const results = searchResult?.results || [];
    nodes.localSearchResultsEmpty.classList.toggle("hidden", results.length > 0);
    nodes.localSearchResultCount.textContent = `${results.length} 项 · ${searchResult.executionProvider === "dml" ? "DirectML" : "CPU"}`;
    for (const result of results) {
      const article = document.createElement("article");
      article.className = "local-search-result";
      article.innerHTML = `
        <div class="local-search-thumb"><span>加载中</span></div>
        <div class="local-search-result-body"><strong></strong><small class="path"></small><small class="meta"></small>
          <div class="local-search-result-actions"><button type="button">打开</button><button type="button">定位</button></div>
        </div>`;
      article.querySelector("strong").textContent = result.fileName;
      article.querySelector(".path").textContent = result.relativePath;
      article.querySelector(".meta").textContent = `${result.width || "?"} × ${result.height || "?"} · 相似度 ${(Number(result.score) * 100).toFixed(1)}%`;
      const [openButton, revealButton] = article.querySelectorAll("button");
      openButton.addEventListener("click", () => bridge().openResult({ libraryId: state.activeLibraryId, imageId: result.imageId }));
      revealButton.addEventListener("click", () => bridge().revealResult({ libraryId: state.activeLibraryId, imageId: result.imageId }));
      nodes.localSearchResults.append(article);
      bridge().getThumbnail({ libraryId: state.activeLibraryId, imageId: result.imageId }).then((thumbnail) => {
        if (!article.isConnected) return;
        const url = URL.createObjectURL(new Blob([thumbnail.data], { type: thumbnail.mimeType }));
        state.resultUrls.push(url);
        const image = new Image();
        image.src = url;
        image.alt = result.fileName;
        article.querySelector(".local-search-thumb").replaceChildren(image);
      }).catch(() => { article.querySelector(".local-search-thumb span").textContent = "无法预览"; });
    }
  }

  async function searchImage(file) {
    if (!file || !file.type.startsWith("image/")) return showStatus("请选择有效图片。", "error");
    if (file.size > 25 * 1024 * 1024) return showStatus("查询图片不得超过 25 MB。", "error");
    if (!state.activeLibraryId) return showStatus("请先选择图库。", "error");
    if (state.queryPreviewUrl) URL.revokeObjectURL(state.queryPreviewUrl);
    state.queryPreviewUrl = URL.createObjectURL(file);
    nodes.localSearchQueryPreview.src = state.queryPreviewUrl;
    nodes.localSearchQueryPreview.classList.remove("hidden");
    showStatus("正在本地计算图片向量并精确搜索…", "working");
    try {
      const result = await bridge().searchByImage({ libraryId: state.activeLibraryId, data: await file.arrayBuffer(), mimeType: file.type });
      await renderResults(result);
      showStatus("搜索完成，查询图片未保存。", "ready");
    } catch (error) {
      showStatus(friendlyError(error, "图片搜索失败"), "error");
    }
  }

  async function searchText() {
    const text = nodes.localSearchTextInput.value.trim();
    if (!text) return showStatus("请输入要搜索的中文或英文描述。", "error");
    if (!state.activeLibraryId) return showStatus("请先选择图库。", "error");
    showStatus("正在本地计算文字向量并精确搜索…", "working");
    try {
      const result = await bridge().searchByText({ libraryId: state.activeLibraryId, text });
      await renderResults(result);
      showStatus("搜索完成，文字查询未保存。", "ready");
    } catch (error) {
      showStatus(friendlyError(error, "文字搜索失败"), "error");
    }
  }

  function bindEvents() {
    nodes.localSearchDownloadModel.addEventListener("click", () => startModelDownload().catch((error) => showStatus(friendlyError(error), "error")));
    nodes.localSearchRetryDownload.addEventListener("click", () => startModelDownload().catch((error) => showStatus(friendlyError(error), "error")));
    nodes.localSearchCancelDownload.addEventListener("click", () => bridge().cancelModelDownload().then(refreshModelStatus));
    nodes.localSearchImportModel.addEventListener("click", () => importOfflineModel().catch((error) => showStatus(friendlyError(error, "离线模型包导入失败"), "error")));
    nodes.localSearchExportModel.addEventListener("click", () => exportOfflineModel().catch((error) => showStatus(friendlyError(error, "离线模型包导出失败"), "error")));
    nodes.localSearchRemoveModel.addEventListener("click", () => removeModel().catch((error) => showStatus(friendlyError(error), "error")));
    nodes.localSearchCreateLibrary.addEventListener("click", () => createLibrary().catch((error) => showStatus(friendlyError(error), "error")));
    nodes.localSearchRemoveLibrary.addEventListener("click", () => removeLibrary().catch((error) => showStatus(friendlyError(error), "error")));
    nodes.localSearchStartIndex.addEventListener("click", startIndex);
    nodes.localSearchCancelIndex.addEventListener("click", cancelIndex);
    nodes.localSearchImageTab.addEventListener("click", () => setTab("image"));
    nodes.localSearchTextTab.addEventListener("click", () => setTab("text"));
    nodes.localSearchTextSubmit.addEventListener("click", searchText);
    nodes.localSearchTextInput.addEventListener("keydown", (event) => { if (event.key === "Enter") searchText(); });
    nodes.localSearchDropzone.addEventListener("click", () => nodes.localSearchImageInput.click());
    nodes.localSearchDropzone.addEventListener("keydown", (event) => { if (event.key === "Enter" || event.key === " ") nodes.localSearchImageInput.click(); });
    nodes.localSearchImageInput.addEventListener("change", () => searchImage(nodes.localSearchImageInput.files?.[0]));
    nodes.localSearchDropzone.addEventListener("dragover", (event) => { event.preventDefault(); nodes.localSearchDropzone.classList.add("drag-over"); });
    nodes.localSearchDropzone.addEventListener("dragleave", () => nodes.localSearchDropzone.classList.remove("drag-over"));
    nodes.localSearchDropzone.addEventListener("drop", (event) => {
      event.preventDefault();
      nodes.localSearchDropzone.classList.remove("drag-over");
      searchImage(Array.from(event.dataTransfer?.files || []).find((file) => file.type.startsWith("image/")));
    });
    document.addEventListener("paste", (event) => {
      if (!$("#localImageSearchView")?.classList.contains("active")) return;
      const item = Array.from(event.clipboardData?.items || []).find((candidate) => candidate.type.startsWith("image/"));
      if (item) {
        event.preventDefault();
        searchImage(item.getAsFile());
      }
    });
  }

  async function initLocalImageSearch() {
    if (state.initialized) return;
    state.initialized = true;
    collectNodes();
    bindEvents();
    const available = Boolean(bridge()?.isAvailable());
    nodes.localSearchRuntimeStatus.textContent = available ? "Windows 桌面版 · 本机离线" : "桌面版专属";
    nodes.localSearchWebOnly.classList.toggle("hidden", available);
    nodes.localSearchDesktopContent.classList.toggle("hidden", !available);
    if (!available) return;
    await Promise.all([refreshModelStatus(), refreshLibraries()]);
  }

  globalScope.initLocalImageSearch = initLocalImageSearch;
})(window);
