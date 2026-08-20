/* NGR AssetPilot V3.0.4 module: local-image-search.js */
(function initializeLocalImageSearchModule(globalScope) {
  "use strict";

  const GUIDE_SEEN_KEY = "local-search-guide-seen";
  const ACTIVE_LIBRARY_KEY = "local-search-active-library-id";
  const MODEL_STAGE_LABELS = Object.freeze({
    scanning: "扫描文件",
    hashing: "校验文件",
    preprocessing: "解码图片",
    inference: "模型批量推理",
    saving: "保存索引",
    finalizing: "整理索引",
    restarting: "执行配置变化，安全重建",
  });

  const state = {
    initialized: false,
    libraries: [],
    activeLibraryId: null,
    models: [],
    activeModelId: null,
    modelValidation: null,
    packageStatus: null,
    engineStatus: null,
    activeJobId: null,
    modelTimer: null,
    jobTimer: null,
    engineTimer: null,
    queryPreviewUrl: "",
  };
  const $ = (selector) => document.querySelector(selector);
  const bridge = () => globalScope.NgrDesktopBridge?.localImageSearch;
  const assetBrowser = () => globalScope.NgrLocalImageBrowser;

  const nodes = {};
  function collectNodes() {
    [
      "localSearchRuntimeStatus", "localSearchWebOnly", "localSearchDesktopContent", "localSearchModelSummary",
      "localSearchModelState", "localSearchModelProgress", "localSearchDownloadModel", "localSearchCancelDownload",
      "localSearchRetryDownload", "localSearchImportModel", "localSearchExportModel", "localSearchCreateLibrary", "localSearchLibraryList", "localSearchLibraryEmpty",
      "localSearchRemoveModel", "localSearchModelSelect", "localSearchModelMeta", "localSearchManageModels",
      "localSearchEngineDetails", "localSearchEngineState", "localSearchVisionProvider", "localSearchTextProvider",
      "localSearchEngineBatch", "localSearchEngineFallback", "localSearchJobStage", "localSearchJobSpeed",
      "localSearchJobEta", "localSearchJobProvider",
      "localSearchActiveLibraryName", "localSearchLibraryMeta", "localSearchStartIndex", "localSearchCancelIndex",
      "localSearchRemoveLibrary", "localSearchScanned", "localSearchAnalyzed", "localSearchReused", "localSearchSkipped",
      "localSearchErrors", "localSearchImageTab", "localSearchTextTab", "localSearchImagePanel", "localSearchTextPanel",
      "localSearchDropzone", "localSearchImageInput", "localSearchQueryPreview", "localSearchTextInput",
      "localSearchTextSubmit", "localSearchClearTextQuery", "localSearchQueryStatus", "localSearchResultCount", "localSearchResults",
      "localSearchClearImageQuery",
      "localSearchResultsEmpty", "localSearchLibrarySelect", "localSearchQuickLibrarySelect", "localSearchGuideOverlay", "localSearchGuideClose", "localSearchGuideStart",
      "localSearchModelManagerOverlay", "localSearchModelManagerClose", "localSearchCustomImportStart",
      "localSearchManagedModels", "localSearchManagedModelsEmpty", "localSearchModelWizard", "localSearchCustomModelName",
      "localSearchCustomModelType", "localSearchCustomModelLicense", "localSearchCustomLayout", "localSearchCustomWidth",
      "localSearchCustomHeight", "localSearchCustomColorSpace", "localSearchCustomResizeMode", "localSearchCustomPixelType",
      "localSearchCustomScale", "localSearchCustomDimensions", "localSearchCustomNormalize", "localSearchCustomInputName",
      "localSearchCustomOutputName", "localSearchCustomMeanR", "localSearchCustomMeanG", "localSearchCustomMeanB",
      "localSearchCustomStdR", "localSearchCustomStdG", "localSearchCustomStdB", "localSearchCustomTextFields",
      "localSearchCustomTextInputName", "localSearchCustomTextOutputName", "localSearchModelValidationStatus",
      "localSearchModelValidationFiles", "localSearchValidateModel", "localSearchCommitModel", "localSearchCancelModelWizard",
    ].forEach((id) => { nodes[id] = $(`#${id}`); });
  }

  function readLocalStorageString(key) {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  }

  function writeLocalStorageString(key, value) {
    try {
      if (!value) {
        localStorage.removeItem(key);
        return;
      }
      localStorage.setItem(key, value);
    } catch {
      // ignore localStorage failures in restricted environments
    }
  }

  function formatBytes(value) {
    const bytes = Number(value || 0);
    return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.round(bytes / 1024)} KB`;
  }

  function getActiveModel() {
    return state.models.find((model) => model.id === state.activeModelId) || null;
  }

  function getPackageModelId() {
    const selected = getActiveModel();
    if (selected?.builtin) return selected.id;
    return state.models.find((model) => model.builtin)?.id || state.activeModelId || null;
  }

  function modelSupportsText(model) {
    if (!model) return true;
    return model.supportsText === true || model.kind === "image-text" || model.kind === "multimodal";
  }

  function formatGpuCompatibility(value) {
    const normalized = typeof value === "object" && value ? value.status || value.state : value;
    if ([true, "compatible", "ready", "dml"].includes(normalized)) return "DirectML 已通过";
    if ([false, "incompatible", "cpu-only", "failed"].includes(normalized)) return "仅 CPU";
    return "GPU 待验证";
  }

  function isDirectML(provider) {
    return ["dml", "directml", "gpu"].includes(String(provider || "").toLowerCase());
  }

  function formatProvider(provider, deviceName = "") {
    const normalized = String(provider || "").toLowerCase();
    const label = isDirectML(normalized) ? "GPU DirectML" : normalized === "cpu" ? "CPU 兼容模式" : provider ? String(provider) : "待检测";
    return deviceName ? `${label} · ${deviceName}` : label;
  }

  function formatEta(seconds) {
    const value = Number(seconds);
    if (!Number.isFinite(value) || value < 0) return "预计剩余 —";
    if (value < 60) return `预计剩余 ${Math.ceil(value)} 秒`;
    const minutes = Math.floor(value / 60);
    const remainingSeconds = Math.ceil(value % 60);
    return `预计剩余 ${minutes} 分 ${remainingSeconds} 秒`;
  }

  function readNumber(node, fallback = 0) {
    const value = Number(node?.value);
    return Number.isFinite(value) ? value : fallback;
  }

  function renderTextCapability() {
    const supported = modelSupportsText(getActiveModel());
    const searchable = isActiveLibrarySearchable();
    nodes.localSearchImageTab.disabled = !searchable;
    nodes.localSearchImageTab.setAttribute("aria-disabled", String(!searchable));
    nodes.localSearchTextTab.disabled = !supported || !searchable;
    nodes.localSearchTextTab.setAttribute("aria-disabled", String(!supported || !searchable));
    nodes.localSearchTextTab.title = !supported
      ? "当前模型仅支持图片搜索"
      : searchable
        ? "使用当前模型进行文字搜索"
        : "请先用当前模型完成图库分析";
    nodes.localSearchTextSubmit.disabled = !supported || !searchable;
    nodes.localSearchTextInput.disabled = !supported || !searchable;
    nodes.localSearchTextInput.placeholder = !supported
      ? "当前模型仅支持图片搜索"
      : searchable
        ? "例如：红色跑车、blue ocean sunset"
        : "当前模型尚未完成图库分析";
    nodes.localSearchImageInput.disabled = !searchable;
    nodes.localSearchDropzone.setAttribute("aria-disabled", String(!searchable));
    nodes.localSearchDropzone.tabIndex = searchable ? 0 : -1;
    if (!supported && !nodes.localSearchTextPanel.classList.contains("hidden")) setTab("image");
  }

  function renderModelStatus() {
    const packageStatus = state.packageStatus || {};
    const activeModel = getActiveModel();
    const percent = packageStatus.totalBytes ? Math.min(100, Number(packageStatus.downloadedBytes || 0) / Number(packageStatus.totalBytes) * 100) : 0;
    nodes.localSearchModelProgress.value = percent;

    if (activeModel) {
      const dimensions = Number(activeModel.dimensions || 0);
      const textLabel = modelSupportsText(activeModel) ? "图片 + 文字" : "仅图片";
      nodes.localSearchModelSummary.textContent = `${activeModel.name} · ${dimensions ? `${dimensions} 维 · ` : ""}${textLabel}`;
      nodes.localSearchModelMeta.textContent = `${activeModel.builtin ? "内置认证模型" : "未认证自定义模型"} · ${formatGpuCompatibility(activeModel.gpuCompatibility)}${activeModel.license ? ` · ${activeModel.license}` : ""}${activeModel.totalBytes ? ` · 模型 ${formatBytes(activeModel.totalBytes)}` : ""}${activeModel.estimatedVectorBytesPer100k ? ` · 10 万张向量约 ${formatBytes(activeModel.estimatedVectorBytesPer100k)}` : ""}${activeModel.fingerprint ? ` · 指纹 ${String(activeModel.fingerprint).slice(0, 12)}` : ""}`;
      nodes.localSearchModelState.textContent = activeModel.ready === false || activeModel.status === "missing" ? "未就绪" : activeModel.builtin ? "已认证" : "未认证";
      nodes.localSearchModelState.dataset.state = activeModel.ready === false ? "missing" : activeModel.builtin ? "ready" : "uncertified";
    } else {
      nodes.localSearchModelSummary.textContent = packageStatus.totalBytes
        ? `${formatBytes(packageStatus.downloadedBytes)} / ${formatBytes(packageStatus.totalBytes)}`
        : "约 190 MB，首次使用需下载或导入";
      nodes.localSearchModelMeta.textContent = "内置模型支持图片和中英文文字搜索";
      nodes.localSearchModelState.textContent = packageStatus.state === "importing" ? "导入校验中" : packageStatus.state === "exporting" ? "正在导出" : packageStatus.ready ? "已就绪" : packageStatus.state === "downloading" ? "下载中" : packageStatus.state === "error" ? "校验失败" : packageStatus.state === "canceled" ? "已取消" : "未下载";
      nodes.localSearchModelState.dataset.state = packageStatus.ready ? "ready" : packageStatus.state;
    }

    const busy = ["downloading", "importing", "exporting"].includes(packageStatus.state);
    const packageModel = state.models.find((model) => model.id === getPackageModelId());
    const builtinReady = packageModel?.builtin
      ? packageModel.ready !== false && packageModel.status !== "missing"
      : Boolean(packageStatus.ready);
    nodes.localSearchDownloadModel.classList.toggle("hidden", builtinReady || busy || packageStatus.state === "error");
    nodes.localSearchImportModel.classList.toggle("hidden", busy);
    nodes.localSearchExportModel.classList.toggle("hidden", !packageStatus.ready || busy);
    nodes.localSearchCancelDownload.classList.toggle("hidden", packageStatus.state !== "downloading");
    nodes.localSearchRetryDownload.classList.toggle("hidden", packageStatus.state !== "error" && packageStatus.state !== "canceled");
    nodes.localSearchRemoveModel.classList.toggle("hidden", !builtinReady);
    renderTextCapability();
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

  function getStoredGuideSeen() {
    return readLocalStorageString(GUIDE_SEEN_KEY) === "1";
  }

  function setGuideSeen() {
    writeLocalStorageString(GUIDE_SEEN_KEY, "1");
  }

  function getStoredActiveLibraryId() {
    const saved = readLocalStorageString(ACTIVE_LIBRARY_KEY);
    return typeof saved === "string" && saved ? saved : null;
  }

  function persistActiveLibraryId(libraryId) {
    writeLocalStorageString(ACTIVE_LIBRARY_KEY, libraryId || "");
  }

  function clearStoredActiveLibraryId() {
    writeLocalStorageString(ACTIVE_LIBRARY_KEY, "");
  }

  function getActiveLibrary() {
    return state.libraries.find((item) => item.id === state.activeLibraryId);
  }

  function isActiveLibrarySearchable() {
    const library = getActiveLibrary();
    const activeModel = getActiveModel();
    const modelReady = !state.models.length || Boolean(activeModel && activeModel.ready !== false && activeModel.status !== "missing");
    return Boolean(
      library
      && modelReady
      && Number(library.itemCount || 0) > 0
      && library.status !== "stale"
      && !state.activeJobId
    );
  }

  function searchUnavailableMessage() {
    const library = getActiveLibrary();
    if (!library) return "请先选择图库。";
    if (state.activeJobId) return "图库正在分析；完成或停止后再使用 AI 搜索。";
    const activeModel = getActiveModel();
    if (state.models.length && (!activeModel || activeModel.ready === false || activeModel.status === "missing")) {
      return "当前模型尚未就绪，请先下载、导入或切换模型。";
    }
    if (library.status === "stale") return "当前模型索引已过期，请重新分析后再搜索。";
    return "请先用当前模型完成图库分析；现有素材仍可直接浏览。";
  }

  function showGuideOverlay() {
    if (!nodes.localSearchGuideOverlay) return;
    nodes.localSearchGuideOverlay.classList.remove("hidden");
    nodes.localSearchGuideOverlay.setAttribute("aria-hidden", "false");
    window.setTimeout(() => nodes.localSearchGuideStart?.focus(), 0);
  }

  function hideGuideOverlay() {
    if (!nodes.localSearchGuideOverlay) return;
    nodes.localSearchGuideOverlay.classList.add("hidden");
    nodes.localSearchGuideOverlay.setAttribute("aria-hidden", "true");
  }

  function maybeShowGuide() {
    if (getStoredGuideSeen()) return;
    showGuideOverlay();
  }

  function markGuideComplete() {
    setGuideSeen();
    hideGuideOverlay();
  }

  async function refreshModelStatus() {
    if (!bridge()?.isAvailable()) return;
    const wasReady = Boolean(state.packageStatus?.ready);
    const modelId = getPackageModelId();
    const status = await bridge().getModelStatus(modelId ? { modelId } : undefined);
    state.packageStatus = status;
    renderModelStatus();
    if (["downloading", "importing", "exporting"].includes(status.state)) scheduleModelPoll();
    else if (status.ready && !wasReady && typeof bridge()?.listModels === "function") {
      await refreshModels();
      await refreshEngineStatus().catch(() => {});
    }
  }

  function scheduleModelPoll() {
    clearTimeout(state.modelTimer);
    state.modelTimer = setTimeout(() => refreshModelStatus().catch(() => {}), 500);
  }

  async function refreshModels() {
    if (typeof bridge()?.listModels !== "function") {
      state.models = [];
      state.activeModelId = null;
      renderModelOptions();
      renderManagedModels();
      renderModelStatus();
      return;
    }
    const response = await bridge().listModels();
    state.models = Array.isArray(response) ? response : Array.isArray(response?.models) ? response.models : [];
    const requestedActiveId = Array.isArray(response) ? null : response?.activeModelId;
    const availableIds = new Set(state.models.map((model) => model.id));
    state.activeModelId = availableIds.has(requestedActiveId)
      ? requestedActiveId
      : availableIds.has(state.activeModelId)
        ? state.activeModelId
        : state.models.find((model) => model.ready !== false && model.status !== "missing")?.id || state.models[0]?.id || null;
    renderModelOptions();
    renderManagedModels();
    renderModelStatus();
    renderActiveLibrary();
  }

  function renderModelOptions() {
    if (!nodes.localSearchModelSelect) return;
    nodes.localSearchModelSelect.replaceChildren();
    if (!state.models.length) {
      const option = document.createElement("option");
      option.value = "";
      option.textContent = "暂无可用模型";
      nodes.localSearchModelSelect.appendChild(option);
      nodes.localSearchModelSelect.disabled = true;
      return;
    }
    nodes.localSearchModelSelect.disabled = false;
    state.models.forEach((model) => {
      const option = document.createElement("option");
      option.value = model.id;
      option.textContent = `${model.name}${model.builtin ? "（内置）" : "（未认证）"}${model.ready === false || model.status === "missing" ? " · 未就绪" : ""}`;
      option.selected = model.id === state.activeModelId;
      nodes.localSearchModelSelect.appendChild(option);
    });
    nodes.localSearchModelSelect.value = state.activeModelId || "";
  }

  function renderManagedModels() {
    if (!nodes.localSearchManagedModels) return;
    nodes.localSearchManagedModels.replaceChildren();
    nodes.localSearchManagedModelsEmpty.classList.toggle("hidden", state.models.length > 0);
    state.models.forEach((model) => {
      const card = document.createElement("article");
      card.className = `local-search-managed-model${model.id === state.activeModelId ? " active" : ""}`;

      const copy = document.createElement("div");
      copy.className = "local-search-managed-model-copy";
      const title = document.createElement("div");
      const name = document.createElement("strong");
      name.textContent = model.name;
      const badge = document.createElement("span");
      badge.className = model.builtin ? "local-search-certified" : "local-search-uncertified";
      badge.textContent = model.builtin ? "已认证" : "未认证";
      title.append(name, badge);
      const meta = document.createElement("small");
      const capability = modelSupportsText(model) ? "图片 + 文字" : "仅图片";
      meta.textContent = `${Number(model.dimensions || 0) ? `${model.dimensions} 维 · ` : ""}${capability} · ${formatGpuCompatibility(model.gpuCompatibility)}${model.license ? ` · ${model.license}` : ""}${model.totalBytes ? ` · 模型 ${formatBytes(model.totalBytes)}` : ""}${model.estimatedVectorBytesPer100k ? ` · 10 万张向量约 ${formatBytes(model.estimatedVectorBytesPer100k)}` : ""}`;
      const fingerprint = document.createElement("small");
      fingerprint.textContent = model.fingerprint ? `SHA-256 ${String(model.fingerprint).slice(0, 16)}…` : "等待模型指纹";
      copy.append(title, meta, fingerprint);

      const actions = document.createElement("div");
      actions.className = "local-search-managed-model-actions";
      const activate = document.createElement("button");
      activate.type = "button";
      activate.className = "ghost-action";
      activate.textContent = model.id === state.activeModelId ? "当前模型" : "使用";
      activate.disabled = model.id === state.activeModelId || model.ready === false || model.status === "missing";
      activate.addEventListener("click", () => activateModel(model.id).catch((error) => showStatus(friendlyError(error, "模型切换失败"), "error")));
      actions.appendChild(activate);

      if (!model.builtin) {
        const validate = document.createElement("button");
        validate.type = "button";
        validate.className = "ghost-action";
        validate.textContent = "重新验证";
        validate.addEventListener("click", () => revalidateInstalledModel(model).catch((error) => showModelManagerStatus(friendlyError(error, "模型验证失败"), "error")));
        actions.appendChild(validate);
      }

      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "danger-action";
      remove.textContent = "删除";
      remove.addEventListener("click", () => removeManagedModel(model).catch((error) => showModelManagerStatus(friendlyError(error, "删除模型失败"), "error")));
      actions.appendChild(remove);

      card.append(copy, actions);
      nodes.localSearchManagedModels.appendChild(card);
    });
  }

  async function activateModel(modelId) {
    const model = state.models.find((item) => item.id === modelId);
    if (!model || model.ready === false || model.status === "missing") {
      throw new Error("该模型尚未就绪，请先下载或重新导入");
    }
    const result = await bridge().setActiveModel({ modelId });
    state.activeModelId = result?.activeModelId || result?.model?.id || modelId;
    resetQueryAndBrowse({ refresh: false });
    await Promise.all([refreshModels(), refreshLibraries(), refreshEngineStatus()]);
    await refreshModelStatus();
    showStatus(`已切换到“${model.name}”；该模型首次使用时需要重新分析图库。`, "ready");
  }

  function showModelManager() {
    nodes.localSearchModelManagerOverlay.classList.remove("hidden");
    nodes.localSearchModelManagerOverlay.setAttribute("aria-hidden", "false");
    renderManagedModels();
    window.setTimeout(() => nodes.localSearchModelManagerClose?.focus(), 0);
  }

  function hideModelManager() {
    nodes.localSearchModelManagerOverlay.classList.add("hidden");
    nodes.localSearchModelManagerOverlay.setAttribute("aria-hidden", "true");
    hideModelWizard();
  }

  function showModelManagerStatus(message, tone = "") {
    nodes.localSearchModelValidationStatus.textContent = message;
    nodes.localSearchModelValidationStatus.dataset.tone = tone;
  }

  function resetModelValidation(message = "先配置预处理参数，再选择本地模型文件进行隔离验证。") {
    state.modelValidation = null;
    nodes.localSearchCommitModel.disabled = true;
    nodes.localSearchModelValidationFiles.replaceChildren();
    nodes.localSearchModelValidationFiles.classList.add("hidden");
    showModelManagerStatus(message);
  }

  function showModelWizard() {
    nodes.localSearchModelWizard.classList.remove("hidden");
    nodes.localSearchCustomTextFields.classList.toggle("hidden", nodes.localSearchCustomModelType.value !== "image-text");
    resetModelValidation();
    window.setTimeout(() => nodes.localSearchCustomModelName?.focus(), 0);
  }

  function hideModelWizard() {
    nodes.localSearchModelWizard.classList.add("hidden");
    nodes.localSearchModelWizard.reset();
    nodes.localSearchCustomTextFields.classList.add("hidden");
    resetModelValidation();
  }

  function collectCustomPreprocessing() {
    const preprocessing = {
      layout: nodes.localSearchCustomLayout.value,
      width: readNumber(nodes.localSearchCustomWidth, 224),
      height: readNumber(nodes.localSearchCustomHeight, 224),
      colorSpace: nodes.localSearchCustomColorSpace.value,
      resizeMode: nodes.localSearchCustomResizeMode.value,
      pixelType: nodes.localSearchCustomPixelType.value,
      scale: readNumber(nodes.localSearchCustomScale, 1 / 255),
      mean: [nodes.localSearchCustomMeanR, nodes.localSearchCustomMeanG, nodes.localSearchCustomMeanB].map((node) => readNumber(node)),
      std: [nodes.localSearchCustomStdR, nodes.localSearchCustomStdG, nodes.localSearchCustomStdB].map((node) => readNumber(node, 1)),
      inputName: nodes.localSearchCustomInputName.value.trim(),
      outputName: nodes.localSearchCustomOutputName.value.trim(),
      dimensions: readNumber(nodes.localSearchCustomDimensions, 0),
      normalizeOutput: nodes.localSearchCustomNormalize.checked,
      textInputName: nodes.localSearchCustomTextInputName.value.trim(),
      textOutputName: nodes.localSearchCustomTextOutputName.value.trim(),
    };
    if (preprocessing.width < 16 || preprocessing.height < 16) throw new Error("模型输入尺寸不得小于 16 × 16");
    if (preprocessing.std.some((value) => !Number.isFinite(value) || value <= 0)) throw new Error("标准差必须为大于 0 的数字");
    return preprocessing;
  }

  function applyCustomPixelDefaults() {
    const integerPixels = nodes.localSearchCustomPixelType.value === "uint8";
    nodes.localSearchCustomScale.value = integerPixels ? "1" : "0.003921568627451";
    [nodes.localSearchCustomMeanR, nodes.localSearchCustomMeanG, nodes.localSearchCustomMeanB]
      .forEach((node, index) => { node.value = integerPixels ? "0" : ["0.48145466", "0.4578275", "0.40821073"][index]; });
    [nodes.localSearchCustomStdR, nodes.localSearchCustomStdG, nodes.localSearchCustomStdB]
      .forEach((node, index) => { node.value = integerPixels ? "1" : ["0.26862954", "0.26130258", "0.27577711"][index]; });
    resetModelValidation(integerPixels
      ? "已切换为 Uint8：缩放系数、均值和标准差已恢复为整数像素默认值。"
      : "已切换为 Float32：已填入 CLIP 常用预处理默认值，请按模型清单核对。");
  }

  async function validateCustomModel() {
    const preprocessing = collectCustomPreprocessing();
    const type = nodes.localSearchCustomModelType.value;
    nodes.localSearchValidateModel.disabled = true;
    showModelManagerStatus(type === "image-text" ? "请依次选择图像 ONNX、文字 ONNX 和 tokenizer 目录…" : "请选择图像 ONNX 模型…", "working");
    try {
      const result = await bridge().validateModel({ source: "dialog", type, preprocessing });
      if (result?.canceled) return resetModelValidation("已取消文件选择，尚未导入任何内容。");
      if (!result?.validationId) throw new Error("模型已检查，但未生成可导入的验证凭证");
      state.modelValidation = { ...result, type, preprocessing };
      const inspection = result.inspection || {};
      const dimensions = inspection.dimensions || preprocessing.dimensions || "自动";
      const textLabel = inspection.supportsText || type === "image-text" ? "图文双塔" : "图像单塔";
      showModelManagerStatus(`验证通过：${textLabel} · ${dimensions} 维。验证凭证仅本次导入有效。`, "ready");
      nodes.localSearchModelValidationFiles.replaceChildren();
      (result.files || []).forEach((file) => {
        const item = document.createElement("span");
        item.textContent = `${file.role || "模型"}：${file.name || "已选择文件"}${file.size ? ` · ${formatBytes(file.size)}` : ""}${file.sha256 ? ` · ${String(file.sha256).slice(0, 12)}…` : ""}`;
        nodes.localSearchModelValidationFiles.appendChild(item);
      });
      nodes.localSearchModelValidationFiles.classList.toggle("hidden", !(result.files || []).length);
      nodes.localSearchCommitModel.disabled = false;
    } finally {
      nodes.localSearchValidateModel.disabled = false;
    }
  }

  async function importCustomModel(event) {
    event.preventDefault();
    if (!state.modelValidation?.validationId) return showModelManagerStatus("请先选择文件并完成验证。", "error");
    if (!nodes.localSearchModelWizard.reportValidity()) return;
    const currentPreprocessing = collectCustomPreprocessing();
    if (state.modelValidation.type !== nodes.localSearchCustomModelType.value
      || JSON.stringify(currentPreprocessing) !== JSON.stringify(state.modelValidation.preprocessing)) {
      return resetModelValidation("模型类型或预处理配置已变化，请重新验证模型。");
    }
    nodes.localSearchCommitModel.disabled = true;
    showModelManagerStatus("正在复制、校验并注册模型…", "working");
    try {
      const result = await bridge().importModel({
        kind: "custom",
        validationId: state.modelValidation.validationId,
        name: nodes.localSearchCustomModelName.value.trim(),
        license: nodes.localSearchCustomModelLicense.value.trim(),
        preprocessing: state.modelValidation.preprocessing,
      });
      if (result?.canceled) return showModelManagerStatus("已取消导入。", "");
      const importedModelId = result?.model?.id;
      hideModelWizard();
      await refreshModels();
      if (importedModelId) await activateModel(importedModelId);
      showStatus("自定义 ONNX 模型已导入并启用；首次搜索前请分析当前图库。", "ready");
    } catch (error) {
      nodes.localSearchCommitModel.disabled = false;
      showModelManagerStatus(friendlyError(error, "自定义模型导入失败"), "error");
    }
  }

  async function revalidateInstalledModel(model) {
    showModelManagerStatus(`正在重新验证“${model.name}”…`, "working");
    const result = await bridge().validateModel({ modelId: model.id });
    if (result?.canceled) return showModelManagerStatus("已取消重新验证。", "");
    await refreshModels();
    await refreshEngineStatus().catch(() => {});
    if (result?.valid !== true) {
      showModelManagerStatus(`“${model.name}”验证失败或模型文件缺失，已禁止启用。`, "error");
      return;
    }
    showModelManagerStatus(`“${model.name}”已通过完整性与运行检查。`, "ready");
  }

  async function removeManagedModel(model) {
    const vectorNotice = model.builtin ? "对应模型文件将被删除" : "该模型文件及其独立向量索引将被删除";
    if (!globalScope.confirm(`确定删除模型“${model.name}”吗？${vectorNotice}，不会删除任何图库原图。`)) return;
    await bridge().removeModel({ modelId: model.id });
    resetQueryAndBrowse({ refresh: false });
    await refreshModels();
    await Promise.all([refreshModelStatus(), refreshLibraries()]);
    await refreshEngineStatus().catch(() => {});
    showStatus(`模型“${model.name}”已删除，图库原图未做任何修改。`, "ready");
  }

  async function startModelDownload() {
    const expectedBytes = Number(state.packageStatus?.totalBytes || 0);
    const expectedSize = expectedBytes > 0 ? formatBytes(expectedBytes) : "约 190 MB";
    if (!globalScope.confirm(`首次使用需要下载 ${expectedSize} 的固定离线模型。下载完成后所有分析和搜索均离线运行，是否继续？`)) return;
    const modelId = getPackageModelId();
    await bridge().downloadModel(modelId ? { modelId } : undefined);
    showStatus("模型正在下载，可以继续浏览软件。", "working");
    await refreshModelStatus();
  }

  async function importOfflineModel() {
    showStatus("请选择从联网电脑导出的 .ngrmodel 离线模型包。", "working");
    const poll = setInterval(() => refreshModelStatus().catch(() => {}), 500);
    try {
      const result = await bridge().importModel({ kind: "package" });
      if (result.canceled) return showStatus("已取消导入。", "");
      await Promise.all([refreshModelStatus(), refreshModels()]);
      showStatus("离线模型包已通过完整校验；现在断开网络也能分析和搜索。", "ready");
    } finally {
      clearInterval(poll);
      await refreshModelStatus().catch(() => {});
    }
  }

  async function exportOfflineModel() {
    showStatus("正在生成可复制到纯离线电脑的模型包…", "working");
    const modelId = getPackageModelId();
    const result = await bridge().exportModel(modelId ? { modelId } : undefined);
    if (result.canceled) return showStatus("已取消导出。", "");
    showStatus("离线模型包已导出，可复制到其他电脑后直接导入。", "ready");
    await refreshModelStatus();
  }

  async function removeModel() {
    if (!globalScope.confirm("删除内置模型会同时删除该模型对应的向量索引，但不会删除任何图库原图。再次使用前需要重新下载或导入并重新分析，是否继续？")) return;
    const builtinModel = getActiveModel()?.builtin
      ? getActiveModel()
      : state.models.find((model) => model.builtin);
    await bridge().removeModel(builtinModel ? { modelId: builtinModel.id } : undefined);
    await refreshModels();
    await Promise.all([refreshModelStatus(), refreshLibraries()]);
    await refreshEngineStatus().catch(() => {});
    showStatus("内置模型及其向量索引已删除，图库原图未做任何修改。", "ready");
  }

  async function refreshLibraries(preferredId = null) {
    state.libraries = await bridge().listLibraries();

    const availableIds = new Set(state.libraries.map((item) => item.id));
    const savedId = getStoredActiveLibraryId();
    let nextActiveLibraryId = null;

    if (preferredId && availableIds.has(preferredId)) {
      nextActiveLibraryId = preferredId;
    } else if (savedId && availableIds.has(savedId)) {
      nextActiveLibraryId = savedId;
    } else if (state.activeLibraryId && availableIds.has(state.activeLibraryId)) {
      nextActiveLibraryId = state.activeLibraryId;
    } else if (state.libraries[0]) {
      nextActiveLibraryId = state.libraries[0].id;
    }

    state.activeLibraryId = nextActiveLibraryId;
    if (state.activeLibraryId) persistActiveLibraryId(state.activeLibraryId);
    else clearStoredActiveLibraryId();

    renderLibraries();
    renderActiveLibrary();
  }

  function setActiveLibrary(libraryId) {
    if (!libraryId || !state.libraries.some((item) => item.id === libraryId)) return;
    if (state.activeLibraryId === libraryId) return;
    state.activeLibraryId = libraryId;
    persistActiveLibraryId(libraryId);
    clearQueryInputs();
    renderLibraries();
    renderActiveLibrary();
  }

  function renderLibraries() {
    nodes.localSearchLibraryList.replaceChildren();
    nodes.localSearchLibraryEmpty.classList.toggle("hidden", state.libraries.length > 0);
    [nodes.localSearchLibrarySelect, nodes.localSearchQuickLibrarySelect].filter(Boolean).forEach((select) => {
      select.classList.toggle("hidden", select === nodes.localSearchLibrarySelect && state.libraries.length === 0);
      select.disabled = state.libraries.length === 0;
      select.replaceChildren();
      const placeholder = document.createElement("option");
      placeholder.value = "";
      placeholder.textContent = state.libraries.length ? "选择当前图库" : "尚未创建图库";
      select.appendChild(placeholder);
      state.libraries.forEach((library) => {
        const option = document.createElement("option");
        option.value = library.id;
        option.textContent = library.name;
        if (library.id === state.activeLibraryId) option.selected = true;
        select.appendChild(option);
      });
      select.value = state.activeLibraryId || "";
    });
    state.libraries.forEach((library) => {
      const card = document.createElement("article");
      card.className = `local-search-library${library.id === state.activeLibraryId ? " active" : ""}`;
      card.addEventListener("click", () => setActiveLibrary(library.id));

      const body = document.createElement("div");
      body.className = "local-search-library-body";
      const name = document.createElement("strong");
      const status = document.createElement("span");
      name.textContent = library.name;
      const libraryCatalogCount = Number(library.catalogItemCount ?? library.catalog_item_count ?? library.itemCount ?? 0) || 0;
      const catalogState = library.catalogStatus ?? library.catalog_status ?? library.status;
      status.textContent = `${libraryCatalogCount} 张素材 · ${Number(library.itemCount || 0)} 张当前模型向量 · ${catalogState === "ready" ? "目录已就绪" : catalogState === "indexing" ? "分析中" : catalogState === "paused" ? "分析已暂停" : "待分析"}`;
      body.append(name, status);

      const actions = document.createElement("div");
      actions.className = "local-search-library-actions";

      const switchButton = document.createElement("button");
      switchButton.type = "button";
      switchButton.className = "ghost-action";
      if (library.id === state.activeLibraryId) {
        switchButton.textContent = "当前图库";
        switchButton.disabled = true;
      } else {
        switchButton.textContent = "切换";
      }
      switchButton.addEventListener("click", (event) => {
        event.stopPropagation();
        setActiveLibrary(library.id);
      });

      const removeButton = document.createElement("button");
      removeButton.type = "button";
      removeButton.className = "danger-action";
      removeButton.textContent = library.id === state.activeLibraryId ? "删除当前图库" : "删除该图库";
      removeButton.disabled = Boolean(state.activeJobId);
      removeButton.addEventListener("click", (event) => {
        event.stopPropagation();
        removeSingleLibrary(library.id).catch((error) => showStatus(friendlyError(error, "删除图库失败"), "error"));
      });

      actions.append(switchButton, removeButton);
      card.append(body, actions);
      nodes.localSearchLibraryList.append(card);
    });
  }

  function renderActiveLibrary() {
    const library = getActiveLibrary();
    const activeModel = getActiveModel();
    const modelReady = !state.models.length || Boolean(activeModel && activeModel.ready !== false && activeModel.status !== "missing");
    const catalogCount = Number(library?.catalogItemCount ?? library?.catalog_item_count ?? library?.itemCount ?? 0) || 0;
    const modelItemCount = Number(library?.itemCount ?? 0) || 0;
    nodes.localSearchActiveLibraryName.textContent = library?.name || "尚未选择图库";
    nodes.localSearchLibraryMeta.textContent = library
      ? `${catalogCount} 张素材 · ${modelItemCount} 张当前模型向量${activeModel ? ` · 当前模型 ${activeModel.name}` : ""}${library.errorCount ? ` · ${library.errorCount} 个错误` : ""}${library.lastIndexedAt ? ` · ${new Date(library.lastIndexedAt).toLocaleString()}` : ""}`
      : "创建图库后开始分析";
    nodes.localSearchStartIndex.disabled = !library || !modelReady;
    nodes.localSearchRemoveLibrary.disabled = !library || Boolean(state.activeJobId);
    if (nodes.localSearchLibrarySelect) nodes.localSearchLibrarySelect.value = library?.id || "";
    if (nodes.localSearchQuickLibrarySelect) nodes.localSearchQuickLibrarySelect.value = library?.id || "";
    assetBrowser()?.setLibrary(library || null, { modelReady });
    renderTextCapability();
    if (isActiveLibrarySearchable()) showStatus(`图库已就绪，可以使用“${activeModel?.name || "内置模型"}”搜索。`, "ready");
    else if (library && !modelReady) showStatus("当前模型尚未就绪，请下载、导入或切换模型。", "error");
    else if (library?.status === "stale") showStatus("当前模型索引已过期；素材仍可浏览，重新分析后恢复 AI 搜索。", "error");
    else if (library && catalogCount > 0) showStatus("当前模型尚未分析此图库；素材仍可浏览，完成分析后启用 AI 搜索。", "");
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
    if (!globalScope.confirm(`仅删除“${library?.name || "此图库"}”的索引和缩略图，不会删除原始图片。是否继续？`)) return;
    await bridge().removeLibrary({ libraryId: state.activeLibraryId });
    state.activeLibraryId = null;
    clearStoredActiveLibraryId();
    clearQueryInputs();
    await refreshLibraries();
    showStatus("索引已删除，原图片未做任何修改。", "ready");
  }

  async function removeSingleLibrary(libraryId) {
    if (!libraryId) return;
    const library = state.libraries.find((item) => item.id === libraryId);
    if (!globalScope.confirm(`仅删除“${library?.name || "此图库"}”的索引和缩略图，不会删除原始图片。是否继续？`)) return;
    await bridge().removeLibrary({ libraryId });
    if (state.activeLibraryId === libraryId) {
      state.activeLibraryId = null;
      clearStoredActiveLibraryId();
    }
    clearQueryInputs();
    await refreshLibraries();
    showStatus("索引已删除，原图片未做任何修改。", "ready");
  }

  function renderEngineStatus(status = state.engineStatus || {}) {
    state.engineStatus = status;
    const visionProvider = status.visionProvider || status.executionProvider;
    const textProvider = status.textProvider || "cpu";
    const deviceName = status.deviceName || status.device || (Number.isInteger(status.deviceId) ? `设备 ${status.deviceId}` : "");
    const usingGpu = isDirectML(visionProvider);
    nodes.localSearchVisionProvider.textContent = formatProvider(visionProvider, usingGpu ? deviceName : "");
    nodes.localSearchTextProvider.textContent = formatProvider(textProvider);
    nodes.localSearchEngineBatch.textContent = Number(status.batchSize) > 0 ? String(status.batchSize) : "单张";
    nodes.localSearchEngineState.textContent = usingGpu ? "GPU 已启用" : visionProvider ? "CPU 回退" : "待检测";
    nodes.localSearchEngineState.dataset.state = usingGpu ? "ready" : visionProvider ? "warning" : "";
    nodes.localSearchEngineDetails.textContent = usingGpu
      ? `${deviceName || "DirectML 设备"}负责图库批量分析；文字和单图查询使用优化 CPU${getActiveModel()?.builtin ? "；内置量化模型为高速模式，跨设备排序可能轻微变化" : ""}`
      : visionProvider
        ? "当前模型或设备无法使用 DirectML，已自动切换 CPU 兼容模式"
        : "正在检测本机推理设备…";
    nodes.localSearchEngineFallback.textContent = status.fallbackReason ? `自动回退原因：${status.fallbackReason}` : "";
    nodes.localSearchEngineFallback.classList.toggle("hidden", !status.fallbackReason);
    if (bridge()?.isAvailable()) {
      nodes.localSearchRuntimeStatus.textContent = usingGpu ? "Windows 桌面版 · GPU DirectML" : visionProvider ? "Windows 桌面版 · CPU 兼容" : "Windows 桌面版 · 本机离线";
    }
    if (!state.activeJobId) {
      nodes.localSearchJobProvider.textContent = `推理设备 ${formatProvider(visionProvider)}${Number(status.batchSize) > 0 ? ` · 批量 ${status.batchSize}` : ""}`;
    }
  }

  async function refreshEngineStatus() {
    if (typeof bridge()?.getEngineStatus !== "function") {
      renderEngineStatus({});
      return;
    }
    const status = await bridge().getEngineStatus(state.activeModelId ? { modelId: state.activeModelId } : undefined);
    renderEngineStatus(status || {});
    const activeModel = getActiveModel();
    if (activeModel && status && status.fallbackReason !== "ENGINE_STATUS_UNAVAILABLE") {
      const provider = status.visionProvider || status.executionProvider || "cpu";
      activeModel.gpuCompatibility = {
        status: isDirectML(provider) ? "compatible" : "cpu-only",
        deviceId: Number.isInteger(status.deviceId) ? status.deviceId : null,
        deviceName: status.deviceName || null,
        batchSize: Number(status.batchSize) || 1,
        fallbackReason: status.fallbackReason || null,
      };
      renderModelStatus();
      renderManagedModels();
    }
  }

  function renderJobPerformance(job = {}) {
    const stage = MODEL_STAGE_LABELS[job.stage] || job.stage || (job.state === "indexing" ? "正在分析" : "等待开始分析");
    const speed = Number(job.imagesPerSecond);
    const provider = job.executionProvider || state.engineStatus?.visionProvider;
    nodes.localSearchJobStage.textContent = stage;
    nodes.localSearchJobSpeed.textContent = Number.isFinite(speed) && speed > 0 ? `${speed.toFixed(speed >= 10 ? 1 : 2)} 张/秒` : "— 张/秒";
    nodes.localSearchJobEta.textContent = formatEta(job.etaSeconds);
    nodes.localSearchJobProvider.textContent = `推理设备 ${formatProvider(provider)}${Number(job.batchSize) > 0 ? ` · 批量 ${job.batchSize}` : ""}`;
    if (provider || job.batchSize || job.fallbackReason) {
      renderEngineStatus({
        ...(state.engineStatus || {}),
        visionProvider: provider,
        batchSize: job.batchSize || state.engineStatus?.batchSize,
        fallbackReason: job.fallbackReason || state.engineStatus?.fallbackReason || "",
      });
    }
  }

  async function startIndex() {
    if (!state.activeLibraryId) return;
    try {
      const result = await bridge().startIndex({ libraryId: state.activeLibraryId, modelId: state.activeModelId || undefined });
      state.activeJobId = result.jobId;
      renderLibraries();
      renderActiveLibrary();
      nodes.localSearchStartIndex.classList.add("hidden");
      nodes.localSearchCancelIndex.classList.remove("hidden");
      showStatus("正在递归扫描和分析，关闭后下次可以继续增量更新。", "working");
      renderJobPerformance({ state: "indexing", stage: "scanning" });
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
    renderJobPerformance(job);
    if (job.state === "indexing") {
      const activeLibrary = getActiveLibrary();
      assetBrowser()?.refreshIfDue(activeLibrary ? { ...activeLibrary, catalogStatus: "indexing" } : null, 2000);
      return scheduleJobPoll();
    }
    nodes.localSearchStartIndex.classList.remove("hidden");
    nodes.localSearchCancelIndex.classList.add("hidden");
    state.activeJobId = null;
    await refreshLibraries(state.activeLibraryId);
    await refreshEngineStatus().catch(() => {});
    showStatus(job.state === "completed" ? `分析完成（${formatProvider(job.executionProvider)}）` : job.state === "canceled" ? "分析已停止，已完成部分会在下次复用。" : "分析失败，请重试。", job.state === "completed" ? "ready" : "error");
  }

  async function cancelIndex() {
    if (!state.activeJobId) return;
    await bridge().cancelJob({ jobId: state.activeJobId });
    showStatus("正在安全停止分析…", "working");
  }

  function setTab(tab) {
    if (tab === "text" && !modelSupportsText(getActiveModel())) {
      showStatus("当前模型仅支持图片搜索，请在模型管理中切换到图文模型。", "error");
      return;
    }
    const image = tab === "image";
    nodes.localSearchImageTab.classList.toggle("active", image);
    nodes.localSearchTextTab.classList.toggle("active", !image);
    nodes.localSearchImageTab.setAttribute("aria-selected", String(image));
    nodes.localSearchTextTab.setAttribute("aria-selected", String(!image));
    nodes.localSearchImagePanel.classList.toggle("hidden", !image);
    nodes.localSearchTextPanel.classList.toggle("hidden", image);
    if (!image) nodes.localSearchTextInput.focus();
  }

  function clearImageInput() {
    if (state.queryPreviewUrl) {
      URL.revokeObjectURL(state.queryPreviewUrl);
      state.queryPreviewUrl = "";
    }
    nodes.localSearchQueryPreview.src = "";
    nodes.localSearchQueryPreview.classList.add("hidden");
    if (nodes.localSearchImageInput) nodes.localSearchImageInput.value = "";
    if (nodes.localSearchClearImageQuery) nodes.localSearchClearImageQuery.disabled = true;
  }

  function clearTextInput() {
    if (nodes.localSearchTextInput) nodes.localSearchTextInput.value = "";
    if (nodes.localSearchClearTextQuery) nodes.localSearchClearTextQuery.disabled = true;
  }

  function clearQueryInputs() {
    clearImageInput();
    clearTextInput();
  }

  function resetQueryAndBrowse(options = {}) {
    clearQueryInputs();
    assetBrowser()?.resetAndBrowse(options);
    if (options.status !== false) showStatus("已清空查询，正在浏览当前图库素材。", "");
  }

  function clearImageQuery() {
    resetQueryAndBrowse();
  }

  function clearTextQuery() {
    resetQueryAndBrowse();
  }

  async function searchImage(file) {
    if (!file || !file.type.startsWith("image/")) return showStatus("请选择有效图片。", "error");
    if (file.size > 25 * 1024 * 1024) return showStatus("查询图片不得超过 25 MB。", "error");
    if (!isActiveLibrarySearchable()) return showStatus(searchUnavailableMessage(), "error");
    if (state.queryPreviewUrl) URL.revokeObjectURL(state.queryPreviewUrl);
    state.queryPreviewUrl = URL.createObjectURL(file);
    nodes.localSearchQueryPreview.src = state.queryPreviewUrl;
    nodes.localSearchQueryPreview.classList.remove("hidden");
    if (nodes.localSearchClearImageQuery) nodes.localSearchClearImageQuery.disabled = false;
    clearTextInput();
    const libraryId = state.activeLibraryId;
    const modelId = state.activeModelId || undefined;
    const context = assetBrowser()?.beginSearch(libraryId) || { libraryId, token: 0 };
    showStatus("正在本地计算图片向量并精确搜索…", "working");
    try {
      const result = await bridge().searchByImage({ libraryId, modelId, data: await file.arrayBuffer(), mimeType: file.type });
      const rendered = assetBrowser()?.renderSearchResults(result, {
        ...context,
        providerLabel: formatProvider(result?.executionProvider),
      });
      if (rendered !== false) showStatus("搜索完成，查询图片未保存。", "ready");
    } catch (error) {
      const message = friendlyError(error, "图片搜索失败");
      const rendered = assetBrowser()?.showSearchError(message, context);
      if (rendered !== false) showStatus(message, "error");
    }
  }

  async function searchText() {
    if (!modelSupportsText(getActiveModel())) return showStatus("当前模型仅支持图片搜索，请切换到图文模型。", "error");
    const text = nodes.localSearchTextInput.value.trim();
    if (!text) return showStatus("请输入要搜索的中文或英文描述。", "error");
    if (!isActiveLibrarySearchable()) return showStatus(searchUnavailableMessage(), "error");
    clearImageInput();
    const libraryId = state.activeLibraryId;
    const modelId = state.activeModelId || undefined;
    const context = assetBrowser()?.beginSearch(libraryId) || { libraryId, token: 0 };
    showStatus("正在本地计算文字向量并精确搜索…", "working");
    if (nodes.localSearchClearTextQuery) nodes.localSearchClearTextQuery.disabled = false;
    try {
      const result = await bridge().searchByText({ libraryId, modelId, text });
      const rendered = assetBrowser()?.renderSearchResults(result, {
        ...context,
        providerLabel: formatProvider(result?.executionProvider),
      });
      if (rendered !== false) showStatus("搜索完成，文字查询未保存。", "ready");
    } catch (error) {
      const message = friendlyError(error, "文字搜索失败");
      const rendered = assetBrowser()?.showSearchError(message, context);
      if (rendered !== false) showStatus(message, "error");
    }
  }

  function bindEvents() {
    nodes.localSearchDownloadModel.addEventListener("click", () => startModelDownload().catch((error) => showStatus(friendlyError(error), "error")));
    nodes.localSearchRetryDownload.addEventListener("click", () => startModelDownload().catch((error) => showStatus(friendlyError(error), "error")));
    nodes.localSearchCancelDownload.addEventListener("click", () => {
      const modelId = getPackageModelId();
      return bridge().cancelModelDownload(modelId ? { modelId } : undefined).then(refreshModelStatus);
    });
    nodes.localSearchImportModel.addEventListener("click", () => importOfflineModel().catch((error) => showStatus(friendlyError(error, "离线模型包导入失败"), "error")));
    nodes.localSearchExportModel.addEventListener("click", () => exportOfflineModel().catch((error) => showStatus(friendlyError(error, "离线模型包导出失败"), "error")));
    nodes.localSearchRemoveModel.addEventListener("click", () => removeModel().catch((error) => showStatus(friendlyError(error), "error")));
    nodes.localSearchModelSelect?.addEventListener("change", () => {
      const previousId = state.activeModelId;
      const modelId = nodes.localSearchModelSelect.value;
      activateModel(modelId).catch((error) => {
        nodes.localSearchModelSelect.value = previousId || "";
        showStatus(friendlyError(error, "模型切换失败"), "error");
      });
    });
    nodes.localSearchManageModels?.addEventListener("click", showModelManager);
    nodes.localSearchModelManagerClose?.addEventListener("click", hideModelManager);
    nodes.localSearchModelManagerOverlay?.addEventListener("click", (event) => {
      if (event.target === nodes.localSearchModelManagerOverlay) hideModelManager();
    });
    nodes.localSearchCustomImportStart?.addEventListener("click", showModelWizard);
    nodes.localSearchCancelModelWizard?.addEventListener("click", hideModelWizard);
    nodes.localSearchValidateModel?.addEventListener("click", () => validateCustomModel().catch((error) => showModelManagerStatus(friendlyError(error, "模型验证失败"), "error")));
    nodes.localSearchModelWizard?.addEventListener("submit", importCustomModel);
    nodes.localSearchCustomModelType?.addEventListener("change", () => {
      nodes.localSearchCustomTextFields.classList.toggle("hidden", nodes.localSearchCustomModelType.value !== "image-text");
      resetModelValidation("模型类型已变化，请重新选择并验证文件。");
    });
    nodes.localSearchCustomPixelType?.addEventListener("change", applyCustomPixelDefaults);
    nodes.localSearchModelWizard?.addEventListener("change", (event) => {
      if ([nodes.localSearchCustomModelName, nodes.localSearchCustomModelLicense, nodes.localSearchCustomModelType].includes(event.target)) return;
      if (state.modelValidation) resetModelValidation("预处理配置已变化，请重新验证模型。");
    });
    nodes.localSearchCreateLibrary.addEventListener("click", () => createLibrary().catch((error) => showStatus(friendlyError(error), "error")));
    nodes.localSearchRemoveLibrary.addEventListener("click", () => removeLibrary().catch((error) => showStatus(friendlyError(error), "error")));
    nodes.localSearchStartIndex.addEventListener("click", startIndex);
    nodes.localSearchCancelIndex.addEventListener("click", cancelIndex);
    nodes.localSearchImageTab.addEventListener("click", () => setTab("image"));
    nodes.localSearchTextTab.addEventListener("click", () => setTab("text"));
    nodes.localSearchTextSubmit.addEventListener("click", searchText);
    nodes.localSearchTextInput.addEventListener("keydown", (event) => { if (event.key === "Enter") searchText(); });
    nodes.localSearchLibrarySelect?.addEventListener("change", () => {
      const selectedId = nodes.localSearchLibrarySelect.value;
      if (selectedId) setActiveLibrary(selectedId);
    });
    nodes.localSearchQuickLibrarySelect?.addEventListener("change", () => {
      const selectedId = nodes.localSearchQuickLibrarySelect.value;
      if (selectedId) setActiveLibrary(selectedId);
    });
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
    nodes.localSearchClearImageQuery?.addEventListener("click", (event) => {
      event.stopPropagation();
      clearImageQuery();
    });
    nodes.localSearchClearTextQuery?.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      clearTextQuery();
    });
    nodes.localSearchTextInput?.addEventListener("input", () => {
      nodes.localSearchClearTextQuery.disabled = !(nodes.localSearchTextInput.value || "").trim();
      if (!nodes.localSearchTextInput.value) {
        nodes.localSearchQueryStatus.dataset.tone = "";
      }
    });
    document.addEventListener("paste", (event) => {
      if (!$("#localImageSearchView")?.classList.contains("active")) return;
      const item = Array.from(event.clipboardData?.items || []).find((candidate) => candidate.type.startsWith("image/"));
      if (item) {
        event.preventDefault();
        searchImage(item.getAsFile());
      }
    });
    nodes.localSearchGuideStart?.addEventListener("click", markGuideComplete);
    nodes.localSearchGuideClose?.addEventListener("click", markGuideComplete);
    nodes.localSearchGuideOverlay?.addEventListener("click", (event) => {
      if (event.target === nodes.localSearchGuideOverlay) markGuideComplete();
    });
    window.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && !nodes.localSearchModelManagerOverlay.classList.contains("hidden")) hideModelManager();
    });
  }

  async function initLocalImageSearch() {
    if (state.initialized) return;
    state.initialized = true;
    collectNodes();
    assetBrowser()?.init({ onStatus: showStatus });
    bindEvents();
    const available = Boolean(bridge()?.isAvailable());
    nodes.localSearchRuntimeStatus.textContent = available ? "Windows 桌面版 · 本机离线" : "桌面版专属";
    nodes.localSearchWebOnly.classList.toggle("hidden", available);
    nodes.localSearchDesktopContent.classList.toggle("hidden", !available);
    if (!available) return;
    await refreshModels();
    await Promise.all([refreshModelStatus(), refreshLibraries()]);
    await refreshEngineStatus().catch((error) => {
      renderEngineStatus({ fallbackReason: friendlyError(error, "推理设备检测失败") });
    });
  }

  globalScope.initLocalImageSearch = initLocalImageSearch;
  globalScope.showLocalImageSearchGuide = maybeShowGuide;
  globalScope.resetLocalImageSearchQuery = resetQueryAndBrowse;
})(window);
