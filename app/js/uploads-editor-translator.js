/* NGR AssetPilot V2.25 module: uploads-editor-translator.js */
function bindUploads() {
  bindCompactActionMenus();
  els.folderInput.addEventListener("change", async (event) => {
    closeCompactActionMenu(els.uploadSourceMenu);
    await addFiles([...event.target.files]);
    event.target.value = "";
  });
  els.singleInput.addEventListener("change", async (event) => {
    closeCompactActionMenu(els.uploadSourceMenu);
    await addFiles([...event.target.files]);
    event.target.value = "";
  });
  ["dragenter", "dragover"].forEach((eventName) => {
    els.uploadDropZone.addEventListener(eventName, (event) => {
      event.preventDefault();
      els.uploadDropZone.classList.add("drag-over");
    });
  });
  ["dragleave", "drop"].forEach((eventName) => {
    els.uploadDropZone.addEventListener(eventName, (event) => {
      event.preventDefault();
      if (eventName === "drop") return;
      els.uploadDropZone.classList.remove("drag-over");
    });
  });
  els.uploadDropZone.addEventListener("drop", async (event) => {
    els.uploadDropZone.classList.remove("drag-over");
    const files = await collectDroppedFiles(event.dataTransfer);
    addFiles(files);
  });
  els.referenceInput.addEventListener("change", (event) => {
    const file = event.target.files[0];
    if (!file) return;
    referenceFile = file;
    syncReferencePreview();
    saveCurrentNamingSession();
    markCurrentReferenceFileDirty();
    showToast("参考效果图已载入");
  });
}

function bindCompactActionMenus() {
  const menus = [els.uploadSourceMenu, els.exportMenu].filter(Boolean);
  menus.forEach((menu) => {
    menu.addEventListener("toggle", () => {
      if (!menu.open) return;
      menus.forEach((otherMenu) => {
        if (otherMenu !== menu) otherMenu.removeAttribute("open");
      });
    });
  });
  document.addEventListener("click", (event) => {
    menus.forEach((menu) => {
      if (menu.open && !menu.contains(event.target)) menu.removeAttribute("open");
    });
  });
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    menus.forEach(closeCompactActionMenu);
  });
}

function closeCompactActionMenu(menu) {
  menu?.removeAttribute("open");
}

function syncReferencePreview() {
  if (referencePreviewUrl) {
    URL.revokeObjectURL(referencePreviewUrl);
    referencePreviewUrl = "";
  }
  if (!referenceFile) {
    els.referencePreview.removeAttribute("src");
    els.referenceName.textContent = "";
    els.referencePreviewWrap.classList.add("hidden");
    return;
  }
  referencePreviewUrl = URL.createObjectURL(referenceFile);
  els.referencePreview.src = referencePreviewUrl;
  els.referenceName.textContent = referenceFile.name;
  els.referencePreviewWrap.classList.remove("hidden");
}

function bindDetection() {
  els.detectionFolderInput.addEventListener("change", (event) => addDetectionFiles([...event.target.files]));
  els.detectionSingleInput.addEventListener("change", (event) => addDetectionFiles([...event.target.files]));
  ["dragenter", "dragover"].forEach((eventName) => {
    els.detectionDropZone.addEventListener(eventName, (event) => {
      event.preventDefault();
      els.detectionDropZone.classList.add("drag-over");
    });
  });
  ["dragleave", "drop"].forEach((eventName) => {
    els.detectionDropZone.addEventListener(eventName, (event) => {
      event.preventDefault();
      if (eventName === "drop") return;
      els.detectionDropZone.classList.remove("drag-over");
    });
  });
  els.detectionDropZone.addEventListener("drop", async (event) => {
    els.detectionDropZone.classList.remove("drag-over");
    const files = await collectDroppedFiles(event.dataTransfer);
    addDetectionFiles(files);
  });
  els.detectionProfileSelect.addEventListener("change", () => {
    switchDetectionProfile(els.detectionProfileSelect.value);
  });
  els.detectionModeSelect.addEventListener("change", () => {
    updateActiveDetectionProfile({ ...getActiveDetectionProfile(), mode: els.detectionModeSelect.value }, true);
    fillDetectionProfileForm();
    revalidateDetectionAssets();
    showToast("检测模式已切换");
  });
  els.duplicateSensitivitySelect.addEventListener("change", () => {
    updateActiveDetectionProfile({ ...getActiveDetectionProfile(), duplicateSensitivity: els.duplicateSensitivitySelect.value }, true);
    fillDetectionProfileForm();
    revalidateDetectionAssets();
    showToast("重复检测灵敏度已切换");
  });
  els.detectionSettingsProfileSelect.addEventListener("change", () => {
    switchDetectionProfile(els.detectionSettingsProfileSelect.value);
  });
  [els.detectionProfileName, els.detectionProfileMode, els.duplicateSensitivityProfile, els.detectionMaxSide, els.detectionBgWidth, els.detectionBgHeight, els.detectionLargeThreshold, els.detectionLargeMultiple, els.detectionAtlasMultiple].forEach((input) => {
    input.addEventListener("input", () => {
      updateActiveDetectionProfile(collectDetectionProfileForm(), false);
      revalidateDetectionAssets();
    });
  });
  els.saveDetectionProfile.addEventListener("click", () => {
    updateActiveDetectionProfile(collectDetectionProfileForm(), true);
    showToast("检测参数已保存");
  });
  els.newDetectionProfile.addEventListener("click", createDetectionProfile);
  els.deleteDetectionProfile.addEventListener("click", deleteDetectionProfile);
  els.detectionProblemFilter.addEventListener("click", toggleDetectionProblemFilter);
  els.detectionWarningFilter.addEventListener("click", toggleDetectionWarningFilter);
  els.detectionRulesToggle.addEventListener("click", () => {
    const isHidden = els.detectionRulesPanel.classList.toggle("hidden");
    els.detectionRulesToggle.textContent = isHidden ? "查看检测规范" : "收起检测规范";
    els.detectionRulesToggle.setAttribute("aria-expanded", String(!isHidden));
  });
  els.clearDetectionAssets.addEventListener("click", () => {
    clearDetectionAssetList();
    renderDetectionList();
    showToast("检测列表已清空");
  });
}

function bindTranslator() {
  bindTranslatorDragging();
  els.translatorToggle.addEventListener("click", openTranslatorPanel);
  els.translatorClose.addEventListener("click", closeTranslatorPanel);
  els.translatorSettingsToggle.addEventListener("click", () => {
    const isHidden = els.translatorSettings.classList.toggle("hidden");
    els.translatorSettingsToggle.setAttribute("aria-expanded", String(!isHidden));
    requestAnimationFrame(constrainTranslatorPanelToViewport);
  });
  els.translatorProvider.addEventListener("change", syncTranslatorProviderFields);
  els.saveTranslatorSettings.addEventListener("click", () => {
    translationSettings = collectTranslationSettings();
    saveTranslationSettings(translationSettings);
    showToast("翻译 API 设置已保存");
  });
  els.testTranslatorSettings.addEventListener("click", testTranslationSettings);
  els.translatorToName.addEventListener("click", async () => {
    const source = normalizeSourceName(els.translatorInput.value);
    if (!source) {
      els.translatorOutput.textContent = "请输入中文文件名、英文命名或单词";
      return;
    }
    els.translatorOutput.textContent = "翻译中...";
    const translated = await translateToNamingWord(source);
    els.translatorOutput.textContent = translated ? "命名词：" + translated + "\n中文含义：" + await explainNameWithTranslation(translated) : "没有匹配到可用命名词";
  });
  els.translatorApplyName.addEventListener("click", applyTranslatorNameToSelectedAsset);
  els.translatorExplain.addEventListener("click", async () => {
    const source = cleanNamingName(els.translatorInput.value);
    els.translatorOutput.textContent = source ? "翻译中..." : "请输入需要解释的英文命名";
    if (source) els.translatorOutput.textContent = await explainNameWithTranslation(source);
  });
  syncTranslatorProviderFields();
}

function openTranslatorPanel(options = {}) {
  const shouldFocus = options.focusInput !== false;
  els.translatorPanel.classList.remove("collapsed");
  els.translatorToggle.setAttribute("aria-expanded", "true");
  requestAnimationFrame(() => {
    constrainTranslatorPanelToViewport();
    if (shouldFocus) els.translatorInput.focus();
  });
}

function closeTranslatorPanel() {
  finishTranslatorDrag();
  els.translatorPanel.classList.add("collapsed");
  els.translatorToggle.setAttribute("aria-expanded", "false");
  requestAnimationFrame(() => els.translatorToggle.focus());
}

function bindTranslatorDragging() {
  els.translatorDragHandle.addEventListener("pointerdown", startTranslatorDrag);
  els.translatorDragHandle.addEventListener("keydown", moveTranslatorWithKeyboard);
  window.addEventListener("pointermove", moveTranslatorDrag, { passive: false });
  window.addEventListener("pointerup", finishTranslatorDrag);
  window.addEventListener("pointercancel", finishTranslatorDrag);
  window.addEventListener("resize", () => {
    if (!els.translatorPanel.classList.contains("collapsed")) {
      requestAnimationFrame(constrainTranslatorPanelToViewport);
    }
  });
  window.visualViewport?.addEventListener("resize", constrainTranslatorPanelToViewport);
  window.visualViewport?.addEventListener("scroll", constrainTranslatorPanelToViewport);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !els.translatorPanel.classList.contains("collapsed")) {
      closeTranslatorPanel();
    }
  });
}

function startTranslatorDrag(event) {
  if (event.button !== 0 || els.translatorPanel.classList.contains("collapsed")) return;
  const rect = els.translatorPanel.getBoundingClientRect();
  translatorDragState = {
    pointerId: event.pointerId,
    offsetX: event.clientX - rect.left,
    offsetY: event.clientY - rect.top,
  };
  els.translatorPanel.classList.add("dragging");
  if (event.pointerId != null) els.translatorDragHandle.setPointerCapture?.(event.pointerId);
  event.preventDefault();
}

function moveTranslatorDrag(event) {
  if (!translatorDragState || event.pointerId !== translatorDragState.pointerId) return;
  positionTranslatorPanel(event.clientX - translatorDragState.offsetX, event.clientY - translatorDragState.offsetY);
  event.preventDefault();
}

function finishTranslatorDrag(event) {
  if (!translatorDragState || (event?.pointerId != null && event.pointerId !== translatorDragState.pointerId)) return;
  const pointerId = translatorDragState.pointerId;
  translatorDragState = null;
  els.translatorPanel.classList.remove("dragging");
  if (pointerId != null && els.translatorDragHandle.hasPointerCapture?.(pointerId)) {
    els.translatorDragHandle.releasePointerCapture(pointerId);
  }
}

function moveTranslatorWithKeyboard(event) {
  if (els.translatorPanel.classList.contains("collapsed") || !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
  const step = event.shiftKey ? 40 : 12;
  const rect = els.translatorPanel.getBoundingClientRect();
  const horizontal = event.key === "ArrowLeft" ? -step : event.key === "ArrowRight" ? step : 0;
  const vertical = event.key === "ArrowUp" ? -step : event.key === "ArrowDown" ? step : 0;
  positionTranslatorPanel(rect.left + horizontal, rect.top + vertical);
  event.preventDefault();
}

function constrainTranslatorPanelToViewport() {
  if (els.translatorPanel.classList.contains("collapsed")) return;
  const rect = els.translatorPanel.getBoundingClientRect();
  positionTranslatorPanel(rect.left, rect.top);
}

function positionTranslatorPanel(left, top) {
  const margin = 8;
  const viewport = window.visualViewport;
  const viewportLeft = viewport?.offsetLeft || 0;
  const viewportTop = viewport?.offsetTop || 0;
  const viewportWidth = viewport?.width || window.innerWidth;
  const viewportHeight = viewport?.height || window.innerHeight;
  const minLeft = viewportLeft + margin;
  const minTop = viewportTop + margin;
  const maxLeft = Math.max(minLeft, viewportLeft + viewportWidth - els.translatorPanel.offsetWidth - margin);
  const maxTop = Math.max(minTop, viewportTop + viewportHeight - els.translatorPanel.offsetHeight - margin);
  els.translatorPanel.style.left = Math.min(Math.max(minLeft, left), maxLeft) + "px";
  els.translatorPanel.style.top = Math.min(Math.max(minTop, top), maxTop) + "px";
  els.translatorPanel.style.right = "auto";
  els.translatorPanel.style.transform = "none";
}

function syncTranslatorProviderFields() {
  const provider = els.translatorProvider.value || "local";
  els.translatorProviderGroups.forEach((node) => {
    const group = node.dataset.providerGroup;
    node.classList.toggle("hidden", group !== provider);
  });
  els.testTranslatorSettings.classList.toggle("hidden", provider === "local");
}

async function applyTranslatorNameToSelectedAsset() {
  const asset = getTranslatorTargetAsset();
  if (!asset) {
    els.translatorOutput.textContent = "请先在待处理图片列表中选择一张图片";
    showToast("请先选择一张图片");
    return;
  }
  const source = normalizeSourceName(els.translatorInput.value || asset.originalBase);
  if (!source) {
    els.translatorOutput.textContent = "请输入中文文件名、英文命名或单词";
    return;
  }
  els.translatorOutput.textContent = "翻译并填入中...";
  const translated = await translateToNamingWord(source);
  if (!translated) {
    els.translatorOutput.textContent = "没有匹配到可用命名词";
    showToast("没有可填入的命名词");
    return;
  }
  asset.finalBaseName = formatNamingName(translated);
  if (!asset.recommendations.some((name) => name.toLowerCase() === asset.finalBaseName.toLowerCase())) {
    asset.recommendations.unshift(asset.finalBaseName);
    asset.recommendations = [...new Set(asset.recommendations)].slice(0, 5);
  }
  selectedId = asset.id;
  saveCurrentNamingSession();
  renderAssetList();
  els.translatorOutput.textContent = "已填入最终名称：" + asset.finalBaseName + "\n中文含义：" + await explainNameWithTranslation(asset.finalBaseName);
  showToast("已填入选中图片的最终名称");
}

function getTranslatorTargetAsset() {
  if (!assets.length) return null;
  return assets.find((asset) => asset.id === selectedId) || assets.find((asset) => asset.checked) || assets[0];
}

async function translateToNamingWord(source) {
  return translateFilenameSmart(source, parseKnowledge());
}

async function explainNameWithTranslation(name) {
  const localMeaning = explainEnglishName(name);
  if (translationSettings.provider === "local") return localMeaning;
  try {
    const readable = cleanNamingName(name).replace(/_/g, " ");
    const apiText = translationSettings.provider === "baidu" ? await translateTextByApi(readable, "en", "zh") : "";
    return apiText || localMeaning;
  } catch (error) {
    return localMeaning + "\n提示：翻译 API 调用失败，已使用本地词库解释。";
  }
}

async function testTranslationSettings() {
  translationSettings = collectTranslationSettings();
  saveTranslationSettings(translationSettings);
  els.translatorOutput.textContent = "正在测试翻译 API...";
  if (translationSettings.provider === "local") {
    els.translatorOutput.textContent = "当前使用本地词库，不需要测试 API。";
    showToast("当前使用本地词库");
    return;
  }
  try {
    const result = translationSettings.provider === "baidu" ? await translateTextByApi("测试", "zh", "en") : await translateTextByModel("测试");
    els.translatorOutput.textContent = "测试成功：测试 -> " + result;
    showToast("翻译 API 测试成功");
  } catch (error) {
    els.translatorOutput.textContent = "测试失败：" + error.message;
    showToast("翻译 API 测试失败");
  }
}

function switchDetectionProfile(profileId) {
  activeDetectionProfileId = profileId;
  localStorage.setItem(ACTIVE_DETECTION_PROFILE_KEY, activeDetectionProfileId);
  renderDetectionProfileSelect();
  fillDetectionProfileForm();
  revalidateDetectionAssets();
}

async function collectDroppedFiles(dataTransfer) {
  const items = [...(dataTransfer.items || [])];
  const fallbackFiles = [...(dataTransfer.files || [])];
  if (!items.length) return fallbackFiles;
  const files = (await Promise.all(items.map(readDroppedItem))).flat().filter(Boolean);
  return files.length ? files : fallbackFiles;
}

async function readDroppedItem(item) {
  if (item.getAsFileSystemHandle) {
    const handle = await item.getAsFileSystemHandle().catch(() => null);
    if (handle) return readFileSystemHandleFiles(handle);
  }
  const entry = item.webkitGetAsEntry?.();
  if (entry) return readEntryFiles(entry);
  const file = item.getAsFile?.();
  return file ? [file] : [];
}

async function readFileSystemHandleFiles(handle) {
  if (handle.kind === "file") {
    const file = await handle.getFile().catch(() => null);
    return file ? [file] : [];
  }
  if (handle.kind !== "directory") return [];
  const files = [];
  for await (const child of handle.values()) {
    files.push(...await readFileSystemHandleFiles(child));
  }
  return files;
}

function readEntryFiles(entry) {
  if (entry.isFile) {
    return new Promise((resolve) => entry.file((file) => resolve([file]), () => resolve([])));
  }
  if (!entry.isDirectory) return Promise.resolve([]);
  const reader = entry.createReader();
  const entries = [];
  return new Promise((resolve) => {
    const readBatch = () => {
      reader.readEntries(async (batch) => {
        if (!batch.length) {
          const nestedFiles = await Promise.all(entries.map(readEntryFiles));
          resolve(nestedFiles.flat());
          return;
        }
        entries.push(...batch);
        readBatch();
      }, () => resolve([]));
    };
    readBatch();
  });
}

function bindEditor() {
  els.namingModeSelect.addEventListener("change", updateNamingRunButton);
  els.runSelectedNaming.addEventListener("click", runSelectedNaming);
  els.stopNaming.addEventListener("click", stopNaming);
  els.newNamingSession.addEventListener("click", createNamingSession);
  els.selectVisibleAssets.addEventListener("change", toggleVisibleAssetSelection);
  els.batchOperationMode.addEventListener("change", syncBatchOperationMode);
  els.applyBatchOperation.addEventListener("click", applyBatchOperation);
  els.problemFilter.addEventListener("click", toggleProblemFilter);
  els.removeSelected.addEventListener("click", removeSelectedAssets);
  els.exportFiles.addEventListener("click", exportRenamedFiles);
  els.listDisplayModeSelect.addEventListener("change", () => {
    listDisplayMode = normalizeListDisplayMode(els.listDisplayModeSelect.value);
    albumPage = 1;
    albumEditorOpen = listDisplayMode === "album" && Boolean(selectedId);
    assetRenderLimit = ASSET_RENDER_BATCH_SIZE;
    localStorage.setItem(LIST_DISPLAY_MODE_KEY, listDisplayMode);
    fillListDisplayControls();
    saveCurrentNamingSession();
    renderAssetList();
  });
  els.listSortModeSelect.addEventListener("change", () => {
    listSortMode = normalizeListSortMode(els.listSortModeSelect.value);
    albumPage = 1;
    assetRenderLimit = ASSET_RENDER_BATCH_SIZE;
    localStorage.setItem(LIST_SORT_MODE_KEY, listSortMode);
    saveCurrentNamingSession();
    renderAssetList();
  });
  [els.albumColumns, els.albumRows, els.albumColumnGap, els.albumRowGap].forEach((input) => {
    const updateAlbumSettings = () => {
      albumSettings = normalizeAlbumSettings({
        columns: els.albumColumns.value,
        rows: els.albumRows.value,
        columnGap: els.albumColumnGap.value,
        rowGap: els.albumRowGap.value,
      });
      albumPage = 1;
      fillListDisplayControls();
      saveCurrentNamingSession();
      renderAssetList();
    };
    input.addEventListener("input", updateAlbumSettings);
    input.addEventListener("change", updateAlbumSettings);
  });
  updateNamingRunButton();
  syncBatchOperationMode();
}
