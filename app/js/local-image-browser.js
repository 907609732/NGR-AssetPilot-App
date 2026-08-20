/* NGR AssetPilot V3.0.6 module: local-image-browser.js */
(function initializeLocalImageBrowserModule(globalScope) {
  "use strict";

  const PAGE_SIZE = 100;
  const FILTER_DEBOUNCE_MS = 250;
  const THUMBNAIL_CONCURRENCY = 4;
  const THUMBNAIL_ROOT_MARGIN = "400px";

  const state = {
    initialized: false,
    mode: "browse",
    library: null,
    modelReady: true,
    folderPrefix: "",
    filter: "",
    sort: "path-asc",
    page: 1,
    pageCount: 1,
    totalItems: 0,
    catalogRevision: null,
    expandedFolders: new Set([""]),
    folderCache: new Map(),
    assetEpoch: 0,
    searchToken: 0,
    lastRefreshAt: 0,
    filterTimer: null,
    observer: null,
    thumbnailQueue: [],
    thumbnailActive: 0,
    thumbnailInflight: new Map(),
    objectUrls: new Map(),
    onStatus: null,
  };

  const nodes = {};
  const $ = (selector) => document.querySelector(selector);
  const bridge = () => globalScope.NgrDesktopBridge?.localImageSearch;

  function collectNodes() {
    [
      "localSearchContentTitle", "localSearchResultCount", "localSearchReturnToLibrary",
      "localSearchBrowser", "localSearchSearchSurface", "localSearchResults", "localSearchResultsEmpty",
      "localSearchAssetRefresh", "localSearchAssetBreadcrumb", "localSearchAssetFolders",
      "localSearchAssetFilter", "localSearchAssetSort", "localSearchAssetGrid", "localSearchAssetEmpty",
      "localSearchAssetStartIndex", "localSearchAssetOpenSettings", "localSearchAssetPagination",
      "localSearchAssetPrevious", "localSearchAssetNext", "localSearchAssetPage",
      "localSearchAssetPageCount", "localSearchAssetPageJump",
    ].forEach((id) => { nodes[id] = $(`#${id}`); });
  }

  function normalizePrefix(value) {
    const raw = String(value || "").replace(/\\/g, "/");
    if (raw.includes("\0")) return "";
    const segments = raw.split("/").filter(Boolean);
    if (segments.some((part) => part === "." || part === "..")) return "";
    return segments.join("/");
  }

  function catalogItemCount(library) {
    const value = library?.catalogItemCount ?? library?.catalog_item_count ?? library?.itemCount ?? 0;
    return Math.max(0, Number(value) || 0);
  }

  function catalogStatus(library) {
    return String(library?.catalogStatus ?? library?.catalog_status ?? (catalogItemCount(library) ? "ready" : "new"));
  }

  function formatBytes(value) {
    const bytes = Math.max(0, Number(value) || 0);
    if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
    if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
    if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${bytes} B`;
  }

  function formatDate(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric <= 0) return "时间未知";
    try {
      return new Date(numeric).toLocaleString();
    } catch {
      return "时间未知";
    }
  }

  function reportStatus(message, tone = "") {
    if (typeof state.onStatus === "function") state.onStatus(message, tone);
  }

  function setMode(mode, options = {}) {
    state.mode = mode;
    const browsing = mode === "browse";
    nodes.localSearchBrowser?.classList.toggle("hidden", !browsing);
    nodes.localSearchSearchSurface?.classList.toggle("hidden", browsing);
    nodes.localSearchReturnToLibrary?.classList.toggle("hidden", browsing);
    if (nodes.localSearchContentTitle) {
      nodes.localSearchContentTitle.textContent = browsing
        ? "素材库"
        : mode === "searching"
          ? "正在搜索"
          : mode === "search-error"
            ? "搜索失败"
            : "搜索结果";
    }
    if (!browsing && options.summary && nodes.localSearchResultCount) {
      nodes.localSearchResultCount.textContent = options.summary;
    }
  }

  function isTaskCurrent(task) {
    if (!task.element?.isConnected || task.libraryId !== state.library?.id) return false;
    return task.surface === "asset"
      ? task.token === state.assetEpoch
      : task.token === state.searchToken;
  }

  function revokeUrl(element) {
    const url = state.objectUrls.get(element);
    if (!url) return;
    URL.revokeObjectURL(url);
    state.objectUrls.delete(element);
  }

  function clearThumbnailSurface(container) {
    if (!container) return;
    container.querySelectorAll("[data-thumbnail-pending]").forEach((element) => state.observer?.unobserve(element));
    for (const [element] of state.objectUrls) {
      if (container.contains(element)) revokeUrl(element);
    }
  }

  function createThumbnailObserver() {
    if (typeof globalScope.IntersectionObserver !== "function") return null;
    return new globalScope.IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        state.observer?.unobserve(entry.target);
        const task = entry.target.__ngrThumbnailTask;
        if (task) enqueueThumbnail(task);
      });
    }, { rootMargin: THUMBNAIL_ROOT_MARGIN });
  }

  function watchThumbnail(element, task) {
    element.__ngrThumbnailTask = { ...task, element };
    element.dataset.thumbnailPending = "true";
    if (state.observer) state.observer.observe(element);
    else enqueueThumbnail(element.__ngrThumbnailTask);
  }

  function enqueueThumbnail(task) {
    if (!isTaskCurrent(task) || task.element.dataset.thumbnailQueued === "true") return;
    task.element.dataset.thumbnailQueued = "true";
    state.thumbnailQueue.push(task);
    pumpThumbnails();
  }

  function getThumbnailOnce(task) {
    const key = `${task.libraryId}:${task.imageId}`;
    let request = state.thumbnailInflight.get(key);
    if (!request) {
      request = Promise.resolve(bridge().getThumbnail({ libraryId: task.libraryId, imageId: task.imageId }))
        .finally(() => state.thumbnailInflight.delete(key));
      state.thumbnailInflight.set(key, request);
    }
    return request;
  }

  function pumpThumbnails() {
    while (state.thumbnailActive < THUMBNAIL_CONCURRENCY && state.thumbnailQueue.length) {
      const task = state.thumbnailQueue.shift();
      if (!isTaskCurrent(task)) continue;
      state.thumbnailActive += 1;
      getThumbnailOnce(task)
        .then((thumbnail) => {
          if (!isTaskCurrent(task)) return;
          const data = thumbnail?.data;
          if (!data) throw new Error("THUMBNAIL_EMPTY");
          const url = URL.createObjectURL(new Blob([data], { type: thumbnail.mimeType || "image/webp" }));
          if (!isTaskCurrent(task)) {
            URL.revokeObjectURL(url);
            return;
          }
          revokeUrl(task.element);
          state.objectUrls.set(task.element, url);
          const image = new Image();
          image.src = url;
          image.alt = task.alt || "素材缩略图";
          task.element.replaceChildren(image);
          delete task.element.dataset.thumbnailPending;
        })
        .catch(() => {
          if (isTaskCurrent(task)) {
            task.element.textContent = "无法预览";
            delete task.element.dataset.thumbnailPending;
          }
        })
        .finally(() => {
          state.thumbnailActive -= 1;
          pumpThumbnails();
        });
    }
  }

  function clearAssetGrid() {
    clearThumbnailSurface(nodes.localSearchAssetGrid);
    nodes.localSearchAssetGrid?.replaceChildren();
  }

  function clearSearchResults(message = "正在准备搜索…") {
    clearThumbnailSurface(nodes.localSearchResults);
    nodes.localSearchResults?.replaceChildren();
    if (nodes.localSearchResultsEmpty) {
      nodes.localSearchResultsEmpty.textContent = message;
      nodes.localSearchResultsEmpty.classList.remove("hidden");
    }
  }

  function renderBreadcrumb() {
    if (!nodes.localSearchAssetBreadcrumb) return;
    nodes.localSearchAssetBreadcrumb.replaceChildren();
    const prefixes = [{ label: "全部素材", prefix: "" }];
    let current = "";
    normalizePrefix(state.folderPrefix).split("/").filter(Boolean).forEach((part) => {
      current = current ? `${current}/${part}` : part;
      prefixes.push({ label: part, prefix: current });
    });
    prefixes.forEach((entry, index) => {
      if (index) nodes.localSearchAssetBreadcrumb.append("/");
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = entry.label;
      button.addEventListener("click", () => selectFolder(entry.prefix));
      nodes.localSearchAssetBreadcrumb.append(button);
    });
  }

  async function loadFolderChildren(parentPrefix, epoch = state.assetEpoch) {
    const prefix = normalizePrefix(parentPrefix);
    if (state.folderCache.has(prefix)) return state.folderCache.get(prefix);
    const response = await bridge().listAssetFolders({ libraryId: state.library.id, parentPrefix: prefix });
    if (epoch !== state.assetEpoch || !state.library) return [];
    const folders = (Array.isArray(response) ? response : response?.folders || []).map((folder) => ({
      name: String(folder.name || normalizePrefix(folder.prefix).split("/").pop() || "未命名文件夹"),
      prefix: normalizePrefix(folder.prefix),
      itemCount: Math.max(0, Number(folder.itemCount) || 0),
    })).filter((folder) => folder.prefix);
    state.folderCache.set(prefix, folders);
    if (response?.catalogRevision != null) state.catalogRevision = response.catalogRevision;
    return folders;
  }

  function createFolderNode(folder, level = 1) {
    const item = document.createElement("li");
    item.setAttribute("role", "none");
    const row = document.createElement("div");
    row.className = "local-search-folder-row";
    row.setAttribute("role", "treeitem");
    row.setAttribute("aria-level", String(level));
    row.setAttribute("aria-expanded", String(state.expandedFolders.has(folder.prefix)));
    row.setAttribute("aria-selected", String(folder.prefix === state.folderPrefix));

    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "local-search-folder-toggle";
    toggle.textContent = state.expandedFolders.has(folder.prefix) ? "▾" : "▸";
    toggle.setAttribute("aria-label", `${state.expandedFolders.has(folder.prefix) ? "收起" : "展开"}${folder.name}`);
    toggle.addEventListener("click", async (event) => {
      event.stopPropagation();
      if (state.expandedFolders.has(folder.prefix)) state.expandedFolders.delete(folder.prefix);
      else {
        state.expandedFolders.add(folder.prefix);
        await loadFolderChildren(folder.prefix).catch(() => []);
      }
      renderFolderTree();
    });

    const select = document.createElement("button");
    select.type = "button";
    select.className = "local-search-folder-select";
    select.setAttribute("aria-current", String(folder.prefix === state.folderPrefix));
    const label = document.createElement("span");
    label.textContent = folder.name;
    const count = document.createElement("small");
    count.textContent = String(folder.itemCount);
    select.append(label, count);
    select.addEventListener("click", () => selectFolder(folder.prefix));
    row.append(toggle, select);
    item.append(row);

    if (state.expandedFolders.has(folder.prefix)) {
      const children = state.folderCache.get(folder.prefix) || [];
      if (children.length) {
        const list = document.createElement("ul");
        children.forEach((child) => list.append(createFolderNode(child, level + 1)));
        item.append(list);
      }
    }
    return item;
  }

  function renderFolderTree() {
    if (!nodes.localSearchAssetFolders) return;
    nodes.localSearchAssetFolders.replaceChildren();
    const list = document.createElement("ul");
    list.setAttribute("role", "group");
    const root = createFolderNode({ name: "全部素材", prefix: "", itemCount: state.totalItems || catalogItemCount(state.library) }, 1);
    root.querySelector(".local-search-folder-toggle").textContent = state.expandedFolders.has("") ? "▾" : "▸";
    const children = state.folderCache.get("") || [];
    if (state.expandedFolders.has("") && children.length) {
      let nested = root.querySelector(":scope > ul");
      if (!nested) {
        nested = document.createElement("ul");
        root.append(nested);
      }
      nested.replaceChildren(...children.map((child) => createFolderNode(child, 2)));
    }
    list.append(root);
    nodes.localSearchAssetFolders.append(list);
  }

  function renderAssetCard(item, epoch, libraryId) {
    const article = document.createElement("article");
    article.className = "local-search-asset-card";
    article.setAttribute("role", "listitem");
    article.dataset.error = String(Boolean(item.errorCode));
    const thumbnail = document.createElement("div");
    thumbnail.className = "local-search-asset-thumb";
    thumbnail.textContent = item.errorCode ? "图片读取异常" : "等待预览";

    const copy = document.createElement("div");
    copy.className = "local-search-asset-copy";
    const name = document.createElement("strong");
    name.textContent = item.fileName || "未命名图片";
    name.title = item.fileName || "";
    const path = document.createElement("small");
    path.textContent = item.relativePath || "";
    path.title = item.relativePath || "";
    const dimensions = item.width && item.height ? `${item.width} × ${item.height}` : "尺寸未知";
    const meta = document.createElement("small");
    meta.textContent = `${dimensions} · ${String(item.format || "未知").toUpperCase()} · ${formatBytes(item.sizeBytes)} · ${formatDate(item.modifiedAt)}`;

    const actions = document.createElement("div");
    actions.className = "local-search-result-actions";
    const open = document.createElement("button");
    open.type = "button";
    open.textContent = "打开";
    const reveal = document.createElement("button");
    reveal.type = "button";
    reveal.textContent = "定位";
    const snapshot = { libraryId, imageId: item.imageId };
    open.setAttribute("aria-label", `打开 ${item.fileName || "素材图片"}`);
    reveal.setAttribute("aria-label", `在资源管理器中定位 ${item.fileName || "素材图片"}`);
    open.addEventListener("click", () => bridge().openResult(snapshot).catch((error) => reportStatus(error?.message || "无法打开图片", "error")));
    reveal.addEventListener("click", () => bridge().revealResult(snapshot).catch((error) => reportStatus(error?.message || "无法定位图片", "error")));
    actions.append(open, reveal);
    copy.append(name, path, meta, actions);
    article.append(thumbnail, copy);
    if (item.errorCode) {
      const badge = document.createElement("span");
      badge.className = "local-search-asset-badge";
      badge.textContent = "异常";
      badge.title = String(item.errorCode);
      article.append(badge);
    } else {
      watchThumbnail(thumbnail, { surface: "asset", token: epoch, libraryId, imageId: item.imageId, alt: item.fileName });
    }
    return article;
  }

  function setEmptyState(kind, detail = "") {
    if (!nodes.localSearchAssetEmpty) return;
    const title = nodes.localSearchAssetEmpty.querySelector("strong");
    const copy = nodes.localSearchAssetEmpty.querySelector("span");
    const actions = nodes.localSearchAssetEmpty.querySelector(".action-row");
    const content = {
      noLibrary: ["尚未选择图库", "请先前往设置创建一个只读图片图库。"],
      unanalyzed: ["尚未建立素材目录", detail || "完成一次图库分析后，这里会按文件夹展示全部已分析图片。"],
      empty: ["当前文件夹没有素材", detail || "可以切换文件夹或清除筛选条件。"],
      error: ["素材目录读取失败", detail || "索引仍然保留，请稍后重试。"],
      loading: ["正在读取素材目录", "图片将在本机加载，不会上传。"],
    }[kind] || ["暂无素材", detail];
    title.textContent = content[0];
    copy.textContent = content[1];
    actions.classList.toggle("hidden", !["noLibrary", "unanalyzed"].includes(kind));
    nodes.localSearchAssetStartIndex.disabled = kind === "noLibrary" || !state.modelReady || Boolean($("#localSearchStartIndex")?.disabled);
    nodes.localSearchAssetEmpty.classList.remove("hidden");
    nodes.localSearchAssetGrid.classList.add("hidden");
    nodes.localSearchAssetGrid.setAttribute("aria-busy", String(kind === "loading"));
    nodes.localSearchAssetPagination.classList.add("hidden");
  }

  function renderAssets(response, epoch, libraryId) {
    if (epoch !== state.assetEpoch || libraryId !== state.library?.id) return;
    const items = Array.isArray(response?.items) ? response.items : [];
    state.page = Math.max(1, Number(response?.page) || 1);
    state.pageCount = Math.max(1, Number(response?.pageCount) || 1);
    state.totalItems = Math.max(0, Number(response?.totalItems) || 0);
    if (response?.catalogRevision != null) state.catalogRevision = response.catalogRevision;

    clearAssetGrid();
    nodes.localSearchAssetEmpty.classList.add("hidden");
    nodes.localSearchAssetGrid.classList.remove("hidden");
    nodes.localSearchAssetGrid.setAttribute("aria-busy", "false");
    if (!items.length) {
      setEmptyState("empty", state.filter ? `没有找到包含“${state.filter}”的名称或路径。` : "可以切换文件夹查看其他素材。");
    } else {
      const fragment = document.createDocumentFragment();
      items.forEach((item) => fragment.append(renderAssetCard(item, epoch, libraryId)));
      nodes.localSearchAssetGrid.append(fragment);
      nodes.localSearchAssetPagination.classList.toggle("hidden", state.pageCount <= 1);
    }
    nodes.localSearchAssetPage.textContent = String(state.page);
    nodes.localSearchAssetPageCount.textContent = String(state.pageCount);
    nodes.localSearchAssetPageJump.value = String(state.page);
    nodes.localSearchAssetPageJump.max = String(state.pageCount);
    nodes.localSearchAssetPrevious.disabled = state.page <= 1;
    nodes.localSearchAssetNext.disabled = state.page >= state.pageCount;
    nodes.localSearchResultCount.textContent = `${state.totalItems} 项 · 每页 ${PAGE_SIZE} 张`;
    renderFolderTree();
  }

  async function refreshAssets(options = {}) {
    if (state.mode !== "browse" && !options.force) return;
    state.assetEpoch += 1;
    const epoch = state.assetEpoch;
    const library = state.library;
    clearAssetGrid();
    renderBreadcrumb();
    if (!library) {
      nodes.localSearchResultCount.textContent = "创建图库后开始浏览";
      nodes.localSearchAssetFolders.replaceChildren();
      setEmptyState("noLibrary");
      return;
    }
    const explicitCatalogCount = library.catalogItemCount ?? library.catalog_item_count;
    if (explicitCatalogCount != null && catalogItemCount(library) === 0 && !["indexing", "paused", "error"].includes(catalogStatus(library))) {
      nodes.localSearchResultCount.textContent = "尚未分析";
      nodes.localSearchAssetFolders.replaceChildren();
      setEmptyState(
        "unanalyzed",
        state.modelReady
          ? "完成一次图库分析后，这里会按文件夹展示全部已分析图片。"
          : "请先在设置中下载或导入离线模型，再开始分析图库。",
      );
      return;
    }
    if (typeof bridge()?.listAssets !== "function" || typeof bridge()?.listAssetFolders !== "function") {
      setEmptyState("error", "当前桌面后端未提供素材分页接口，请完成升级后重试。");
      return;
    }
    setEmptyState("loading");
    try {
      await loadFolderChildren("", epoch);
      if (epoch !== state.assetEpoch || library.id !== state.library?.id) return;
      renderFolderTree();
      const response = await bridge().listAssets({
        libraryId: library.id,
        page: state.page,
        pageSize: PAGE_SIZE,
        folderPrefix: state.folderPrefix,
        filter: state.filter,
        sort: state.sort,
      });
      renderAssets(response || {}, epoch, library.id);
      state.lastRefreshAt = Date.now();
    } catch (error) {
      if (epoch !== state.assetEpoch) return;
      setEmptyState("error", String(error?.message || "无法读取素材目录"));
      reportStatus("素材目录读取失败；已有 AI 索引未受影响。", "error");
    }
  }

  async function selectFolder(prefix) {
    state.folderPrefix = normalizePrefix(prefix);
    state.page = 1;
    const ancestors = [""];
    let current = "";
    state.folderPrefix.split("/").filter(Boolean).forEach((part) => {
      current = current ? `${current}/${part}` : part;
      ancestors.push(current);
    });
    ancestors.forEach((value) => state.expandedFolders.add(value));
    renderBreadcrumb();
    await loadFolderChildren(state.folderPrefix).catch(() => []);
    renderFolderTree();
    await refreshAssets({ force: true });
  }

  function resetAndBrowse(options = {}) {
    state.searchToken += 1;
    setMode("browse");
    clearSearchResults();
    if (options.refresh !== false) void refreshAssets({ force: true });
    if (options.focus !== false) {
      globalScope.requestAnimationFrame(() => nodes.localSearchContentTitle?.focus({ preventScroll: false }));
    }
  }

  function setLibrary(library, options = {}) {
    const nextLibrary = library || null;
    const previousModelReady = state.modelReady;
    if (typeof options.modelReady === "boolean") state.modelReady = options.modelReady;
    const modelReadinessChanged = previousModelReady !== state.modelReady;
    const changed = state.library?.id !== nextLibrary?.id;
    const nextRevision = nextLibrary?.catalogRevision ?? nextLibrary?.catalog_revision ?? null;
    const revisionChanged = !changed
      && nextLibrary
      && nextRevision != null
      && nextRevision !== state.catalogRevision;
    state.library = nextLibrary;
    if (changed) {
      state.folderPrefix = "";
      state.filter = "";
      state.page = 1;
      state.catalogRevision = nextRevision;
      state.expandedFolders = new Set([""]);
      state.folderCache.clear();
      if (nodes.localSearchAssetFilter) nodes.localSearchAssetFilter.value = "";
      state.assetEpoch += 1;
      state.searchToken += 1;
      clearThumbnailSurface(nodes.localSearchAssetGrid);
      clearThumbnailSurface(nodes.localSearchResults);
      setMode("browse");
      clearSearchResults();
      void refreshAssets({ force: true });
    } else if ((revisionChanged || modelReadinessChanged) && state.mode === "browse") {
      if (revisionChanged) {
        state.catalogRevision = nextRevision;
        state.folderCache.clear();
      }
      void refreshAssets({ force: true });
    }
  }

  function beginSearch(libraryId) {
    state.searchToken += 1;
    const token = state.searchToken;
    clearSearchResults("正在本机计算并搜索，请稍候…");
    setMode("searching", { summary: "正在本地搜索" });
    return { token, libraryId };
  }

  function renderSearchResults(searchResult, context = {}) {
    if (context.token !== state.searchToken || context.libraryId !== state.library?.id) return false;
    const results = Array.isArray(searchResult?.results) ? searchResult.results : [];
    clearSearchResults(results.length ? "" : "没有找到相似素材。可以清空查询返回素材库继续浏览。");
    nodes.localSearchResultsEmpty.classList.toggle("hidden", results.length > 0);
    const provider = context.providerLabel || searchResult?.executionProvider || "本地推理";
    setMode("results", { summary: `${results.length} 项 · ${provider}` });
    const fragment = document.createDocumentFragment();
    results.forEach((result) => {
      const article = document.createElement("article");
      article.className = "local-search-result";
      const thumbnail = document.createElement("div");
      thumbnail.className = "local-search-thumb";
      thumbnail.textContent = "等待预览";
      const body = document.createElement("div");
      body.className = "local-search-result-body";
      const name = document.createElement("strong");
      name.textContent = result.fileName || "未命名图片";
      const path = document.createElement("small");
      path.className = "path";
      path.textContent = result.relativePath || "";
      const meta = document.createElement("small");
      meta.className = "meta";
      meta.textContent = `${result.width || "?"} × ${result.height || "?"} · 相似度 ${(Number(result.score || 0) * 100).toFixed(1)}%`;
      const actions = document.createElement("div");
      actions.className = "local-search-result-actions";
      const open = document.createElement("button");
      open.type = "button";
      open.textContent = "打开";
      const reveal = document.createElement("button");
      reveal.type = "button";
      reveal.textContent = "定位";
      const snapshot = { libraryId: context.libraryId, imageId: result.imageId };
      open.setAttribute("aria-label", `打开 ${result.fileName || "搜索结果图片"}`);
      reveal.setAttribute("aria-label", `在资源管理器中定位 ${result.fileName || "搜索结果图片"}`);
      open.addEventListener("click", () => bridge().openResult(snapshot).catch((error) => reportStatus(error?.message || "无法打开图片", "error")));
      reveal.addEventListener("click", () => bridge().revealResult(snapshot).catch((error) => reportStatus(error?.message || "无法定位图片", "error")));
      actions.append(open, reveal);
      body.append(name, path, meta, actions);
      article.append(thumbnail, body);
      fragment.append(article);
      watchThumbnail(thumbnail, {
        surface: "search",
        token: context.token,
        libraryId: context.libraryId,
        imageId: result.imageId,
        alt: result.fileName,
      });
    });
    nodes.localSearchResults.append(fragment);
    return true;
  }

  function showSearchError(message, context = {}) {
    if (context.token !== state.searchToken || context.libraryId !== state.library?.id) return false;
    clearSearchResults(message || "搜索失败，请重试。");
    setMode("search-error", { summary: "本次查询未完成" });
    return true;
  }

  function refreshIfDue(library, intervalMs = 2000) {
    if (library?.id === state.library?.id) state.library = library;
    if (state.mode !== "browse" || Date.now() - state.lastRefreshAt < intervalMs) return;
    state.folderCache.clear();
    void refreshAssets({ force: true });
  }

  function bindEvents() {
    nodes.localSearchReturnToLibrary?.addEventListener("click", () => {
      globalScope.resetLocalImageSearchQuery?.();
      if (!globalScope.resetLocalImageSearchQuery) resetAndBrowse();
    });
    nodes.localSearchAssetRefresh?.addEventListener("click", () => {
      state.folderCache.clear();
      void refreshAssets({ force: true });
    });
    nodes.localSearchAssetFilter?.addEventListener("input", () => {
      clearTimeout(state.filterTimer);
      state.filterTimer = setTimeout(() => {
        state.filter = String(nodes.localSearchAssetFilter.value || "").trim().slice(0, 100);
        state.page = 1;
        void refreshAssets({ force: true });
      }, FILTER_DEBOUNCE_MS);
    });
    nodes.localSearchAssetSort?.addEventListener("change", () => {
      state.sort = nodes.localSearchAssetSort.value || "path-asc";
      state.page = 1;
      void refreshAssets({ force: true });
    });
    nodes.localSearchAssetPrevious?.addEventListener("click", () => {
      if (state.page <= 1) return;
      state.page -= 1;
      void refreshAssets({ force: true });
    });
    nodes.localSearchAssetNext?.addEventListener("click", () => {
      if (state.page >= state.pageCount) return;
      state.page += 1;
      void refreshAssets({ force: true });
    });
    const jumpToPage = () => {
      const page = Math.min(state.pageCount, Math.max(1, Number(nodes.localSearchAssetPageJump.value) || 1));
      if (page === state.page) return;
      state.page = page;
      void refreshAssets({ force: true });
    };
    nodes.localSearchAssetPageJump?.addEventListener("change", jumpToPage);
    nodes.localSearchAssetPageJump?.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        jumpToPage();
      }
    });
    nodes.localSearchAssetStartIndex?.addEventListener("click", () => $("#localSearchStartIndex")?.click());
    nodes.localSearchAssetOpenSettings?.addEventListener("click", () => $("#rulesEntry")?.click());
  }

  function init(options = {}) {
    if (state.initialized) {
      if (typeof options.onStatus === "function") state.onStatus = options.onStatus;
      return;
    }
    state.initialized = true;
    state.onStatus = typeof options.onStatus === "function" ? options.onStatus : null;
    collectNodes();
    state.observer = createThumbnailObserver();
    bindEvents();
    setMode("browse");
    setEmptyState("noLibrary");
  }

  globalScope.NgrLocalImageBrowser = Object.freeze({
    init,
    setLibrary,
    beginSearch,
    renderSearchResults,
    showSearchError,
    resetAndBrowse,
    refreshCatalog: () => refreshAssets({ force: true }),
    refreshIfDue,
    getMode: () => state.mode,
  });
})(window);
