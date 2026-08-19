/* NGR AssetPilot V2.26 module: rendering.js */
function renderAssetList() {
  const duplicateContext = buildDuplicateStatusContext();
  const problemCount = assets.filter((asset) => isNamingAssetProblem(asset, duplicateContext)).length;
  const duplicateCount = assets.filter((asset) => getDuplicateStatus(asset, duplicateContext).kind === "batch").length;
  els.fileCount.textContent = assets.length + " 张" + (problemCount ? " / " + problemCount + " 张问题" : "") + (duplicateCount ? " / " + duplicateCount + " 张重名" : "");
  renderNamingSessionList();
  syncSelectAllControl();
  syncAssetWorkspaceMode();
  if (!assets.length) {
    els.assetList.className = "asset-list-body empty-state";
    els.assetList.textContent = "请先上传切图文件夹";
    renderAlbumEditorPanel();
    return;
  }
  const visibleAssets = getVisibleAssets(duplicateContext);
  if (!visibleAssets.length) {
    els.assetList.className = "asset-list-body empty-state";
    els.assetList.textContent = "当前没有问题图片";
    syncSelectAllControl();
    renderAlbumEditorPanel();
    return;
  }

  if (listDisplayMode === "album") {
    renderAlbumAssetList(visibleAssets, duplicateContext);
    renderAlbumEditorPanel();
    protectEditableShortcuts(els.albumEditorPanel);
    return;
  }

  els.assetList.className = "asset-list-body" + (listDisplayMode === "compact" ? " compact-list-mode" : "");
  els.assetList.innerHTML = "";
  const renderLimit = Math.min(Math.max(assetRenderLimit || ASSET_RENDER_BATCH_SIZE, ASSET_RENDER_BATCH_SIZE), visibleAssets.length);
  const renderedAssets = visibleAssets.slice(0, renderLimit);
  if (visibleAssets.length > renderLimit) {
    els.fileCount.textContent += " / 已显示 " + renderLimit + " 张";
  }
  renderedAssets.forEach((asset) => {
    const row = document.createElement("div");
    const duplicateStatus = getDuplicateStatus(asset, duplicateContext);
    row.className = "asset-item" + (asset.dimensionIssue ? " has-issue" : duplicateStatus.hasIssue ? " has-duplicate" : asset.dimensionWarning ? " has-warning" : "") + (asset.id === selectedId ? " active" : "");
    row.dataset.assetId = asset.id;
    row.addEventListener("click", (event) => {
      if (event.target.closest(".asset-meta") && window.getSelection?.().toString().trim()) return;
      selectedId = asset.id;
      saveCurrentNamingSession();
      renderAssetList();
    });

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = asset.checked;
    checkbox.addEventListener("click", (event) => event.stopPropagation());
    checkbox.addEventListener("change", (event) => {
      event.stopPropagation();
      asset.checked = checkbox.checked;
      saveCurrentNamingSession();
      syncSelectAllControl();
      renderNamingSessionList();
    });

    const img = document.createElement("img");
    img.src = getAssetPreviewUrl(asset);
    img.alt = asset.originalBase;
    img.loading = "lazy";
    img.decoding = "async";

    const text = document.createElement("div");
    text.className = "asset-meta";
    const beforeName = createMetaLine("修改前名称", asset.originalBase + asset.extension);
    const afterName = createMetaLine("修改后名称", asset.finalBaseName ? buildExportName(asset) : "待命名");
    beforeName.classList.add("full-line");
    afterName.classList.add("full-line", "after-name-line");
    const resolution = createMetaLine("分辨率", formatResolution(asset.dimensions));
    const sizeCategory = createMetaLine("规格", asset.sizeCategoryLabel || getSizeCategoryLabel(asset.dimensions));
    const dimensionCheck = createMetaLine("分辨率检查", asset.dimensionIssue || asset.dimensionWarning ? asset.dimensionIssueMessage : asset.dimensionInfoMessage || "通过");
    dimensionCheck.classList.add("full-line");
    dimensionCheck.classList.toggle("warning-line", asset.dimensionIssue || asset.dimensionWarning);
    const duplicateCheck = createMetaLine("重名检测", duplicateStatus.message);
    duplicateCheck.classList.add("duplicate-check-line");
    duplicateCheck.classList.toggle("warning-line", duplicateStatus.hasIssue);
    const historyMatch = duplicateContext.historicalMatch;
    const historyLine = createMetaLine("历史工程", historyMatch ? historyMatch.name + " / " + historyMatch.fileCount + " 张" : "未匹配");
    const status = document.createElement("span");
    applyNamingStatusBadge(status, asset, duplicateStatus);
    const statusHint = document.createElement("em");
    statusHint.textContent = asset.statusMessage || "";
    text.append(beforeName, afterName, resolution, sizeCategory, dimensionCheck, duplicateCheck, historyLine, status, statusHint);

    const editor = document.createElement("div");
    editor.className = "inline-editor";
    editor.addEventListener("click", (event) => event.stopPropagation());

    const nameRow = document.createElement("div");
    nameRow.className = "inline-name-row";

    const prefix = document.createElement("label");
    prefix.className = "inline-prefix inline-prefix-choice";
    const prefixLabel = document.createElement("span");
    prefixLabel.textContent = "前缀名";
    const currentPrefixEntry = getPrefixEntryForValue(asset.customBasePrefixId || asset.customBasePrefix || buildAssetBasePrefix(asset));
    const prefixPicker = NgrPrefixLibrary.createPrefixPicker({
      value: currentPrefixEntry.id,
      className: "inline-prefix-picker",
      onChange(prefixId, prefixValue) {
      asset.customPrefix = "";
      asset.customBasePrefixId = prefixId;
      asset.customBasePrefix = prefixId === "builtin:none" ? "__none" : prefixValue;
      afterName.querySelector("strong").textContent = asset.finalBaseName ? buildExportName(asset) : "待命名";
      saveCurrentNamingSession();
      syncDuplicateNameIndicators();
      },
    });
    prefix.append(prefixLabel, prefixPicker.root);

    const project = document.createElement("label");
    project.className = "inline-prefix";
    const projectLabel = document.createElement("span");
    projectLabel.textContent = "工程名";
    const projectInput = document.createElement("input");
    projectInput.type = "text";
    projectInput.value = buildAssetProjectName(asset);
    projectInput.placeholder = "可不填";
    projectInput.addEventListener("input", () => {
      asset.customPrefix = "";
      asset.customProjectName = sanitizeName(projectInput.value);
      afterName.querySelector("strong").textContent = asset.finalBaseName ? buildExportName(asset) : "待命名";
      saveCurrentNamingSession();
      syncDuplicateNameIndicators();
    });
    project.append(projectLabel, projectInput);

    const view = document.createElement("label");
    view.className = "inline-prefix";
    const viewLabel = document.createElement("span");
    viewLabel.textContent = "界面名";
    const viewInput = document.createElement("input");
    viewInput.type = "text";
    viewInput.value = buildAssetViewName(asset);
    viewInput.placeholder = rules.viewName || "可不填";
    viewInput.addEventListener("input", () => {
      asset.customPrefix = "";
      asset.customViewName = sanitizeName(viewInput.value);
      afterName.querySelector("strong").textContent = asset.finalBaseName ? buildExportName(asset) : "待命名";
      saveCurrentNamingSession();
      syncDuplicateNameIndicators();
    });
    view.append(viewLabel, viewInput);

    const recommendationWrap = document.createElement("div");
    recommendationWrap.className = "inline-recommendations";
    const recommendationLabel = document.createElement("span");
    recommendationLabel.textContent = "AI 推荐命名";
    const recommendationButtons = document.createElement("div");
    recommendationButtons.className = "recommendations compact";
    const recommendations = asset.recommendations.length ? asset.recommendations : makeRecommendations(asset);
    recommendations.forEach((name) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "recommendation";
      const nameText = document.createElement("span");
      nameText.className = "recommendation-name";
      nameText.textContent = name;
      const meaningText = document.createElement("span");
      meaningText.className = "recommendation-meaning";
      meaningText.dataset.meaningKey = getMeaningKey(name);
      meaningText.textContent = "中文含义：" + getDisplayMeaning(name);
      button.append(nameText, meaningText);
      button.addEventListener("click", () => {
        asset.finalBaseName = formatNamingName(name);
        saveCurrentNamingSession();
        renderAssetList();
        showToast("已填入推荐名称");
      });
      recommendationButtons.appendChild(button);
    });
    recommendationWrap.append(recommendationLabel, recommendationButtons);

    const finalLabel = document.createElement("label");
    finalLabel.className = "inline-final-name";
    finalLabel.classList.add("inline-final-compact");
    const finalText = document.createElement("span");
    finalText.textContent = "最终名称";
    const finalField = document.createElement("div");
    finalField.className = "inline-final-field";
    const finalInput = document.createElement("input");
    finalInput.type = "text";
    finalInput.value = asset.finalBaseName;
    finalInput.placeholder = "请选择推荐名称或手动输入";
    const finalMeaning = document.createElement("span");
    finalMeaning.className = "name-meaning";
    finalMeaning.dataset.meaningKey = getMeaningKey(asset.finalBaseName);
    finalMeaning.textContent = "中文含义：" + getDisplayMeaning(asset.finalBaseName);
    finalInput.addEventListener("input", () => {
      asset.finalBaseName = formatNamingName(finalInput.value);
      afterName.querySelector("strong").textContent = asset.finalBaseName ? buildExportName(asset) : "待命名";
      finalMeaning.dataset.meaningKey = getMeaningKey(asset.finalBaseName);
      finalMeaning.textContent = "中文含义：" + getDisplayMeaning(asset.finalBaseName);
      saveCurrentNamingSession();
      syncDuplicateNameIndicators();
    });
    finalInput.addEventListener("blur", () => {
      if (showProblemOnly) renderAssetList();
    });
    finalField.append(finalInput, finalMeaning);
    finalLabel.append(finalText, finalField);

    const lexiconWrap = document.createElement("details");
    lexiconWrap.className = "inline-lexicon";
    lexiconWrap.open = Boolean(asset.lexiconOpen);
    lexiconWrap.addEventListener("toggle", () => {
      asset.lexiconOpen = lexiconWrap.open;
      saveCurrentNamingSession();
    });
    const lexiconSummary = document.createElement("summary");
    lexiconSummary.textContent = "词库";
    const lexiconContent = document.createElement("div");
    lexiconContent.className = "lexicon-content";
    const categories = buildLexiconCategories();
    if (!categories.some((category) => category.title === activeLexiconCategory)) activeLexiconCategory = categories[0]?.title || "";
    const tabs = document.createElement("div");
    tabs.className = "lexicon-tabs";
    const chips = document.createElement("div");
    chips.className = "lexicon-chips";
    const renderLexiconTerms = () => {
      chips.innerHTML = "";
      const currentParts = new Set(cleanNamingName(asset.finalBaseName).split(/_+/).map((part) => part.toLowerCase()).filter(Boolean));
      const category = categories.find((item) => item.title === activeLexiconCategory) || categories[0];
      (category?.terms || []).forEach((term) => {
        const selected = currentParts.has(term.toLowerCase());
        const chip = document.createElement("button");
        chip.type = "button";
        chip.className = "lexicon-chip" + (selected ? " selected" : "");
        chip.textContent = term;
        chip.title = selected ? "再次点击移除：" + explainEnglishName(term) : explainEnglishName(term);
        chip.addEventListener("click", () => {
          asset.finalBaseName = toggleLexiconTerm(asset.finalBaseName, term);
          finalInput.value = asset.finalBaseName;
          afterName.querySelector("strong").textContent = asset.finalBaseName ? buildExportName(asset) : "待命名";
          finalMeaning.dataset.meaningKey = getMeaningKey(asset.finalBaseName);
          finalMeaning.textContent = "中文含义：" + getDisplayMeaning(asset.finalBaseName);
          const nextDuplicateStatus = getDuplicateStatus(asset);
          duplicateCheck.querySelector("strong").textContent = nextDuplicateStatus.message;
          duplicateCheck.classList.toggle("warning-line", nextDuplicateStatus.hasIssue);
          saveCurrentNamingSession();
          syncDuplicateNameIndicators();
          renderLexiconTerms();
        });
        chips.appendChild(chip);
      });
    };
    categories.forEach((category) => {
      const tab = document.createElement("button");
      tab.type = "button";
      tab.className = "lexicon-tab" + (category.title === activeLexiconCategory ? " active" : "");
      tab.textContent = category.title;
      tab.addEventListener("click", () => {
        activeLexiconCategory = category.title;
        tabs.querySelectorAll(".lexicon-tab").forEach((node) => node.classList.toggle("active", node === tab));
        renderLexiconTerms();
      });
      tabs.appendChild(tab);
    });
    renderLexiconTerms();
    lexiconContent.append(tabs, chips);
    lexiconWrap.append(lexiconSummary, lexiconContent);

    nameRow.append(prefix, project, view, finalLabel);
    editor.append(nameRow);
    if (listDisplayMode !== "compact") editor.append(recommendationWrap, lexiconWrap);
    row.append(checkbox, img, text, editor);
    els.assetList.appendChild(row);
  });
  renderListPager(els.assetList, renderLimit, visibleAssets.length, () => {
    assetRenderLimit = Math.min((assetRenderLimit || ASSET_RENDER_BATCH_SIZE) + ASSET_RENDER_BATCH_SIZE, visibleAssets.length);
    renderAssetList();
  });
  protectEditableShortcuts(els.assetList);
}

function syncAssetWorkspaceMode() {
  if (!els.workspace) return;
  const albumMode = listDisplayMode === "album";
  const hasEditor = albumMode && albumEditorOpen && assets.some((asset) => asset.id === selectedId);
  els.workspace.classList.toggle("album-mode", albumMode);
  els.workspace.classList.toggle("album-editor-open", hasEditor);
  els.albumEditorPanel?.classList.toggle("hidden", !hasEditor);
}

function renderAlbumAssetList(visibleAssets, duplicateContext = buildDuplicateStatusContext()) {
  const settings = normalizeAlbumSettings(albumSettings);
  albumSettings = settings;
  const pageSize = settings.columns * settings.rows;
  const pageCount = Math.max(1, Math.ceil(visibleAssets.length / pageSize));
  albumPage = Math.min(normalizeAlbumPage(albumPage), pageCount);
  const start = (albumPage - 1) * pageSize;
  const pageAssets = visibleAssets.slice(start, start + pageSize);
  els.assetList.className = "asset-list-body album-grid-mode";
  els.assetList.innerHTML = "";
  els.assetList.style.setProperty("--album-columns", settings.columns);
  els.assetList.style.setProperty("--album-column-gap", settings.columnGap + "px");
  els.assetList.style.setProperty("--album-row-gap", settings.rowGap + "px");
  pageAssets.forEach((asset) => els.assetList.appendChild(createAlbumAssetCard(asset, duplicateContext)));
  els.fileCount.textContent += ` / 第 ${albumPage}/${pageCount} 页·本页 ${pageAssets.length} 张`;
  renderAlbumPager(pageCount);
  saveCurrentNamingSession({ persist: false });
}

function createAlbumAssetCard(asset, duplicateContext = buildDuplicateStatusContext()) {
  const card = document.createElement("article");
  const duplicateStatus = getDuplicateStatus(asset, duplicateContext);
  card.className = "album-card" + (asset.id === selectedId ? " active" : "") + (asset.dimensionIssue ? " has-issue" : duplicateStatus.hasIssue ? " has-duplicate" : asset.dimensionWarning ? " has-warning" : "");
  card.dataset.assetId = asset.id;
  card.tabIndex = 0;
  const select = document.createElement("input");
  select.type = "checkbox";
  select.className = "album-card-check";
  select.checked = Boolean(asset.checked);
  select.setAttribute("aria-label", `选中 ${asset.originalBase}${asset.extension}`);
  select.addEventListener("click", (event) => event.stopPropagation());
  select.addEventListener("change", () => {
    asset.checked = select.checked;
    saveCurrentNamingSession();
    syncSelectAllControl();
    renderNamingSessionList();
  });
  const media = document.createElement("div");
  media.className = "album-card-media";
  const image = document.createElement("img");
  image.src = getAssetPreviewUrl(asset);
  image.alt = asset.originalBase;
  image.loading = "lazy";
  image.decoding = "async";
  media.appendChild(image);
  const body = document.createElement("div");
  body.className = "album-card-body";
  const original = document.createElement("strong");
  original.className = "album-original-name";
  original.textContent = asset.originalBase + asset.extension;
  original.title = original.textContent;
  const exportName = document.createElement("span");
  exportName.className = "album-export-name";
  exportName.textContent = asset.finalBaseName ? buildExportName(asset) : "待命名";
  exportName.title = exportName.textContent;
  const status = document.createElement("span");
  status.classList.add("album-card-status");
  applyNamingStatusBadge(status, asset, duplicateStatus);
  const duplicateHint = document.createElement("span");
  duplicateHint.className = "album-duplicate-hint";
  duplicateHint.textContent = duplicateStatus.hasIssue ? duplicateStatus.message : "";
  duplicateHint.hidden = !duplicateStatus.hasIssue;
  body.append(original, exportName, status, duplicateHint);
  const open = () => {
    selectedId = asset.id;
    albumEditorOpen = true;
    saveCurrentNamingSession();
    renderAssetList();
  };
  card.addEventListener("click", open);
  card.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    open();
  });
  card.append(select, media, body);
  return card;
}

function renderAlbumPager(pageCount) {
  const pager = document.createElement("div");
  pager.className = "album-pager";
  const previous = document.createElement("button");
  previous.type = "button";
  previous.className = "ghost-action";
  previous.textContent = "上一页";
  previous.disabled = albumPage <= 1;
  const label = document.createElement("span");
  label.textContent = `第 ${albumPage} / ${pageCount} 页`;
  const next = document.createElement("button");
  next.type = "button";
  next.className = "ghost-action";
  next.textContent = "下一页";
  next.disabled = albumPage >= pageCount;
  const changePage = (nextPage) => {
    albumPage = Math.max(1, Math.min(nextPage, pageCount));
    saveCurrentNamingSession();
    renderAssetList();
    els.assetList.scrollIntoView({ block: "start" });
  };
  previous.addEventListener("click", () => changePage(albumPage - 1));
  next.addEventListener("click", () => changePage(albumPage + 1));
  pager.append(previous, label, next);
  els.assetList.appendChild(pager);
}

function renderAlbumEditorPanel() {
  if (!els.albumEditorPanel) return;
  const asset = assets.find((item) => item.id === selectedId);
  if (listDisplayMode !== "album" || !albumEditorOpen || !asset) {
    els.albumEditorPanel.innerHTML = "";
    els.albumEditorPanel.classList.add("hidden");
    syncAssetWorkspaceMode();
    return;
  }
  els.albumEditorPanel.classList.remove("hidden");
  els.albumEditorPanel.innerHTML = "";
  els.albumEditorPanel.dataset.assetId = asset.id;
  const head = document.createElement("div");
  head.className = "album-editor-head";
  const heading = document.createElement("div");
  const eyebrow = document.createElement("span");
  eyebrow.textContent = "画册图片编辑";
  const title = document.createElement("strong");
  title.textContent = asset.originalBase + asset.extension;
  heading.append(eyebrow, title);
  const close = document.createElement("button");
  close.type = "button";
  close.className = "settings-button";
  close.textContent = "×";
  close.title = "关闭编辑栏";
  close.addEventListener("click", () => {
    albumEditorOpen = false;
    saveCurrentNamingSession();
    renderAlbumEditorPanel();
  });
  head.append(heading, close);
  const preview = document.createElement("div");
  preview.className = "album-editor-preview";
  const image = document.createElement("img");
  image.src = getAssetPreviewUrl(asset);
  image.alt = asset.originalBase;
  const info = document.createElement("div");
  info.className = "album-editor-info";
  const output = document.createElement("strong");
  output.className = "album-editor-export-name";
  output.textContent = asset.finalBaseName ? buildExportName(asset) : "待命名";
  const meta = document.createElement("span");
  meta.textContent = `${formatResolution(asset.dimensions)} · ${asset.sizeCategoryLabel || getSizeCategoryLabel(asset.dimensions)}`;
  const status = document.createElement("span");
  const duplicateStatus = getDuplicateStatus(asset);
  applyNamingStatusBadge(status, asset, duplicateStatus);
  const duplicateNotice = document.createElement("span");
  duplicateNotice.className = "album-duplicate-hint album-editor-duplicate-hint";
  duplicateNotice.textContent = duplicateStatus.hasIssue ? duplicateStatus.message : "";
  duplicateNotice.hidden = !duplicateStatus.hasIssue;
  info.append(output, meta, status, duplicateNotice);
  preview.append(image, info);
  els.albumEditorPanel.append(head, preview, createAlbumNamingEditor(asset, output));
  syncAssetWorkspaceMode();
}

function createAlbumNamingEditor(asset, outputNode) {
  const editor = document.createElement("div");
  editor.className = "album-naming-editor";
  const updateOutput = () => {
    const outputName = asset.finalBaseName ? buildExportName(asset) : "待命名";
    outputNode.textContent = outputName;
    const card = els.assetList.querySelector(`[data-asset-id="${CSS.escape(String(asset.id))}"]`);
    if (card) {
      card.querySelector(".album-export-name").textContent = outputName;
      const badge = card.querySelector(".album-card-status");
      applyNamingStatusBadge(badge, asset, getDuplicateStatus(asset));
    }
    saveCurrentNamingSession();
    renderNamingSessionList();
    syncDuplicateNameIndicators();
  };
  const fields = document.createElement("div");
  fields.className = "album-editor-fields";
  const prefix = createAlbumPrefixPicker("前缀名", asset.customBasePrefixId || asset.customBasePrefix || buildAssetBasePrefix(asset), (prefixId, prefixValue) => {
    asset.customPrefix = "";
    asset.customBasePrefixId = prefixId;
    asset.customBasePrefix = prefixId === "builtin:none" ? "__none" : prefixValue;
    updateOutput();
  });
  const project = createAlbumEditorInput("工程名", buildAssetProjectName(asset), "可不填", (value) => {
    asset.customPrefix = "";
    asset.customProjectName = sanitizeName(value);
    updateOutput();
  });
  const view = createAlbumEditorInput("界面名", buildAssetViewName(asset), rules.viewName || "可不填", (value) => {
    asset.customPrefix = "";
    asset.customViewName = sanitizeName(value);
    updateOutput();
  });
  const finalField = createAlbumEditorInput("最终名称", asset.finalBaseName, "请选择推荐名称或手动输入", (value, input) => {
    asset.finalBaseName = formatNamingName(value);
    input.value = asset.finalBaseName;
    meaning.dataset.meaningKey = getMeaningKey(asset.finalBaseName);
    meaning.textContent = "中文含义：" + getDisplayMeaning(asset.finalBaseName);
    updateOutput();
  });
  finalField.classList.add("album-final-field");
  const finalInput = finalField.querySelector("input");
  const meaning = document.createElement("span");
  meaning.className = "name-meaning";
  meaning.dataset.meaningKey = getMeaningKey(asset.finalBaseName);
  meaning.textContent = "中文含义：" + getDisplayMeaning(asset.finalBaseName);
  finalField.appendChild(meaning);
  fields.append(prefix, project, view, finalField);

  const recommendations = document.createElement("section");
  recommendations.className = "album-editor-recommendations";
  const recommendationTitle = document.createElement("strong");
  recommendationTitle.textContent = "AI 推荐命名";
  const recommendationButtons = document.createElement("div");
  recommendationButtons.className = "recommendations compact";
  (asset.recommendations.length ? asset.recommendations : makeRecommendations(asset)).forEach((name) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "recommendation";
    button.innerHTML = `<span class="recommendation-name"></span><span class="recommendation-meaning"></span>`;
    button.querySelector(".recommendation-name").textContent = name;
    button.querySelector(".recommendation-meaning").textContent = "中文含义：" + getDisplayMeaning(name);
    button.addEventListener("click", () => {
      asset.finalBaseName = formatNamingName(name);
      finalInput.value = asset.finalBaseName;
      meaning.textContent = "中文含义：" + getDisplayMeaning(asset.finalBaseName);
      updateOutput();
      showToast("已填入推荐名称");
    });
    recommendationButtons.appendChild(button);
  });
  recommendations.append(recommendationTitle, recommendationButtons);

  const lexicon = document.createElement("details");
  lexicon.className = "inline-lexicon album-editor-lexicon";
  lexicon.open = Boolean(asset.lexiconOpen);
  const summary = document.createElement("summary");
  summary.textContent = "词库";
  const content = document.createElement("div");
  content.className = "lexicon-content";
  const tabs = document.createElement("div");
  tabs.className = "lexicon-tabs";
  const chips = document.createElement("div");
  chips.className = "lexicon-chips";
  const categories = buildLexiconCategories();
  if (!categories.some((category) => category.title === activeLexiconCategory)) activeLexiconCategory = categories[0]?.title || "";
  const renderTerms = () => {
    chips.innerHTML = "";
    const current = new Set(cleanNamingName(asset.finalBaseName).split(/_+/).map((part) => part.toLowerCase()).filter(Boolean));
    const category = categories.find((item) => item.title === activeLexiconCategory) || categories[0];
    (category?.terms || []).forEach((term) => {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "lexicon-chip" + (current.has(term.toLowerCase()) ? " selected" : "");
      chip.textContent = term;
      chip.addEventListener("click", () => {
        asset.finalBaseName = toggleLexiconTerm(asset.finalBaseName, term);
        finalInput.value = asset.finalBaseName;
        meaning.textContent = "中文含义：" + getDisplayMeaning(asset.finalBaseName);
        updateOutput();
        renderTerms();
      });
      chips.appendChild(chip);
    });
  };
  categories.forEach((category) => {
    const tab = document.createElement("button");
    tab.type = "button";
    tab.className = "lexicon-tab" + (category.title === activeLexiconCategory ? " active" : "");
    tab.textContent = category.title;
    tab.addEventListener("click", () => {
      activeLexiconCategory = category.title;
      tabs.querySelectorAll(".lexicon-tab").forEach((node) => node.classList.toggle("active", node === tab));
      renderTerms();
    });
    tabs.appendChild(tab);
  });
  lexicon.addEventListener("toggle", () => {
    asset.lexiconOpen = lexicon.open;
    saveCurrentNamingSession();
  });
  renderTerms();
  content.append(tabs, chips);
  lexicon.append(summary, content);
  editor.append(fields, recommendations, lexicon);
  return editor;
}

function createAlbumEditorInput(labelText, value, placeholder, onInput) {
  const label = document.createElement("label");
  const span = document.createElement("span");
  span.textContent = labelText;
  const input = document.createElement("input");
  input.type = "text";
  input.value = value || "";
  input.placeholder = placeholder || "";
  input.addEventListener("input", () => onInput(input.value, input));
  label.append(span, input);
  return label;
}

function createAlbumEditorSelect(labelText, items, value, onChange) {
  const label = document.createElement("label");
  const span = document.createElement("span");
  span.textContent = labelText;
  const select = document.createElement("select");
  items.forEach((item) => {
    const option = document.createElement("option");
    option.value = item.value;
    option.textContent = item.label;
    option.selected = item.value === value;
    select.appendChild(option);
  });
  select.addEventListener("change", () => onChange(select.value));
  label.append(span, select);
  return label;
}

function createAlbumPrefixPicker(labelText, value, onChange) {
  const label = document.createElement("label");
  const span = document.createElement("span");
  span.textContent = labelText;
  const entry = getPrefixEntryForValue(value);
  const picker = NgrPrefixLibrary.createPrefixPicker({
    value: entry.id,
    className: "album-prefix-picker",
    onChange,
  });
  label.append(span, picker.root);
  return label;
}

function renderNamingSessionList() {
  if (!els.namingSessionList) return;
  if (!namingSessions.length) {
    els.namingSessionList.innerHTML = "";
    return;
  }
  els.namingSessionList.innerHTML = "";
  namingSessions.forEach((session) => {
    const sessionAssets = session.id === activeNamingSessionId ? assets : session.assets || [];
    const doneCount = sessionAssets.filter((asset) => asset.finalBaseName).length;
    const sessionDuplicateContext = buildDuplicateStatusContext(sessionAssets);
    const issueCount = sessionAssets.filter((asset) => isNamingAssetProblem(asset, sessionDuplicateContext)).length;
    const duplicateCount = sessionAssets.filter((asset) => getDuplicateStatus(asset, sessionDuplicateContext).kind === "batch").length;
    const button = document.createElement("div");
    button.setAttribute("role", "button");
    button.tabIndex = 0;
    button.className = "naming-session-item" + (session.id === activeNamingSessionId ? " active" : "");
    button.dataset.sessionId = session.id;
    const name = document.createElement("strong");
    name.textContent = session.name;
    name.title = "双击修改记录名称";
    name.addEventListener("dblclick", (event) => {
      event.stopPropagation();
      renameNamingSession(session.id);
    });
    const meta = document.createElement("span");
    meta.textContent = sessionAssets.length + " 张 / 完成 " + doneCount + (issueCount ? " / 问题 " + issueCount : "") + (duplicateCount ? " / 重名 " + duplicateCount : "");
    const deleteButton = document.createElement("button");
    deleteButton.type = "button";
    deleteButton.className = "session-delete";
    deleteButton.textContent = "×";
    deleteButton.title = "删除这条记录";
    deleteButton.setAttribute("aria-label", "删除命名记录：" + session.name);
    deleteButton.addEventListener("click", (event) => {
      event.stopPropagation();
      deleteNamingSession(session.id);
    });
    button.append(name, meta, deleteButton);
    button.addEventListener("click", () => switchNamingSession(session.id));
    button.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      switchNamingSession(session.id);
    });
    els.namingSessionList.appendChild(button);
  });
}

function buildDuplicateStatusContext(assetList = assets) {
  const groups = buildDuplicateExportGroups(assetList);
  const historicalMatch = getHistoricalModuleMatch();
  const historicalNames = new Set((historicalMatch?.filenames || []).map((name) => String(name).toLowerCase()));
  return { groups, historicalMatch, historicalNames };
}

function loadListDisplayMode() {
  return normalizeListDisplayMode(localStorage.getItem(LIST_DISPLAY_MODE_KEY));
}

function normalizeListDisplayMode(mode) {
  return ["full", "compact", "album"].includes(mode) ? mode : "full";
}

function normalizeAlbumSettingValue(value, fallback, min, max) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback;
}

function normalizeAlbumSettings(settings = {}) {
  return {
    columns: normalizeAlbumSettingValue(settings.columns, DEFAULT_ALBUM_SETTINGS.columns, 1, 12),
    rows: normalizeAlbumSettingValue(settings.rows, DEFAULT_ALBUM_SETTINGS.rows, 1, 20),
    columnGap: normalizeAlbumSettingValue(settings.columnGap, DEFAULT_ALBUM_SETTINGS.columnGap, 0, 200),
    rowGap: normalizeAlbumSettingValue(settings.rowGap, DEFAULT_ALBUM_SETTINGS.rowGap, 0, 200),
  };
}

function normalizeAlbumPage(value) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

function fillListDisplayControls() {
  if (!els.listDisplayModeSelect) return;
  albumSettings = normalizeAlbumSettings(albumSettings);
  els.listDisplayModeSelect.value = normalizeListDisplayMode(listDisplayMode);
  els.listSortModeSelect.value = normalizeListSortMode(listSortMode);
  els.albumGridSettings.classList.toggle("hidden", listDisplayMode !== "album");
  els.albumColumns.value = albumSettings.columns;
  els.albumRows.value = albumSettings.rows;
  els.albumColumnGap.value = albumSettings.columnGap;
  els.albumRowGap.value = albumSettings.rowGap;
  const summary = els.albumGridSettings.querySelector(".album-grid-summary");
  if (summary) summary.textContent = `${albumSettings.columns} × ${albumSettings.rows}，单页 ${albumSettings.columns * albumSettings.rows} 张`;
}

function loadListSortMode() {
  return normalizeListSortMode(localStorage.getItem(LIST_SORT_MODE_KEY));
}

function normalizeListSortMode(mode) {
  return ["upload", "name-asc", "name-desc"].includes(mode) ? mode : "name-asc";
}

function getVisibleAssets(duplicateContext = buildDuplicateStatusContext()) {
  const visibleAssets = showProblemOnly ? assets.filter((asset) => isNamingAssetProblem(asset, duplicateContext)) : [...assets];
  if (listSortMode === "upload") return visibleAssets;
  return [...visibleAssets].sort((left, right) => {
    const leftName = (left.originalBase + left.extension).trim();
    const rightName = (right.originalBase + right.extension).trim();
    const result = leftName.localeCompare(rightName, "zh-Hans-CN", { numeric: true, sensitivity: "base" });
    return listSortMode === "name-desc" ? -result : result;
  });
}

function isNamingAssetProblem(asset, duplicateContext = buildDuplicateStatusContext()) {
  return Boolean(asset.dimensionIssue || getDuplicateStatus(asset, duplicateContext).hasIssue);
}

function applyNamingStatusBadge(badge, asset, duplicateStatus = getDuplicateStatus(asset)) {
  const hasDuplicate = duplicateStatus.kind === "batch";
  badge.className = `${badge.classList.contains("album-card-status") ? "status-badge album-card-status" : "status-badge"} status-${hasDuplicate ? "duplicate" : getAssetStatus(asset)}`;
  badge.textContent = hasDuplicate ? "重复命名" : getAssetStatusText(asset);
  badge.title = hasDuplicate ? duplicateStatus.message : "";
}

function syncDuplicateNameIndicators() {
  const duplicateContext = buildDuplicateStatusContext();
  const problemCount = assets.filter((asset) => isNamingAssetProblem(asset, duplicateContext)).length;
  const duplicateCount = assets.filter((asset) => getDuplicateStatus(asset, duplicateContext).kind === "batch").length;
  els.fileCount.textContent = assets.length + " 张" + (problemCount ? " / " + problemCount + " 张问题" : "") + (duplicateCount ? " / " + duplicateCount + " 张重名" : "");
  els.assetList.querySelectorAll("[data-asset-id]").forEach((node) => {
    const asset = assets.find((item) => String(item.id) === node.dataset.assetId);
    if (!asset) return;
    const duplicateStatus = getDuplicateStatus(asset, duplicateContext);
    node.classList.toggle("has-duplicate", duplicateStatus.hasIssue && !asset.dimensionIssue);
    const duplicateLine = node.querySelector(".duplicate-check-line");
    if (duplicateLine) {
      duplicateLine.querySelector("strong").textContent = duplicateStatus.message;
      duplicateLine.classList.toggle("warning-line", duplicateStatus.hasIssue);
    }
    const hint = node.querySelector(".album-duplicate-hint");
    if (hint) {
      hint.textContent = duplicateStatus.hasIssue ? duplicateStatus.message : "";
      hint.hidden = !duplicateStatus.hasIssue;
    }
    const badge = node.querySelector(".status-badge");
    if (badge) applyNamingStatusBadge(badge, asset, duplicateStatus);
  });
  const editorAsset = assets.find((item) => String(item.id) === els.albumEditorPanel?.dataset.assetId);
  if (editorAsset) {
    const editorStatus = getDuplicateStatus(editorAsset, duplicateContext);
    const editorBadge = els.albumEditorPanel.querySelector(".status-badge");
    if (editorBadge) applyNamingStatusBadge(editorBadge, editorAsset, editorStatus);
    const editorHint = els.albumEditorPanel.querySelector(".album-editor-duplicate-hint");
    if (editorHint) {
      editorHint.textContent = editorStatus.hasIssue ? editorStatus.message : "";
      editorHint.hidden = !editorStatus.hasIssue;
    }
  }
  renderNamingSessionList();
}

function renderDetectionList() {
  const issueCount = detectionAssets.filter((asset) => asset.hasIssue).length;
  const warningCount = detectionAssets.filter((asset) => asset.hasWarning).length;
  els.detectionCount.textContent = detectionAssets.length + " 张" + (issueCount ? " / " + issueCount + " 张问题" : "") + (warningCount ? " / " + warningCount + " 张警告" : "");
  syncDetectionFilterButtons();

  if (!detectionAssets.length) {
    els.detectionList.className = "asset-list-body empty-state";
    els.detectionList.textContent = "请先上传需要检测的切图文件夹";
    return;
  }

  const visibleAssets = showDetectionProblemOnly
    ? detectionAssets.filter((asset) => asset.hasIssue)
    : showDetectionWarningOnly
      ? detectionAssets.filter((asset) => asset.hasWarning && !asset.hasIssue).sort(compareDetectionWarnings)
      : detectionAssets;
  if (!visibleAssets.length) {
    els.detectionList.className = "asset-list-body empty-state";
    els.detectionList.textContent = showDetectionWarningOnly ? "当前没有警告图片" : "当前没有问题图片";
    return;
  }

  els.detectionList.className = "asset-list-body detection-list";
  els.detectionList.innerHTML = "";
  const renderLimit = Math.min(Math.max(detectionRenderLimit || DETECTION_RENDER_BATCH_SIZE, DETECTION_RENDER_BATCH_SIZE), visibleAssets.length);
  const renderedAssets = visibleAssets.slice(0, renderLimit);
  if (visibleAssets.length > renderLimit) {
    els.detectionCount.textContent += " / 已显示 " + renderLimit + " 张";
  }
  renderedAssets.forEach((asset) => {
    const row = document.createElement("div");
    row.className = "asset-item detection-item" + (asset.hasIssue ? " has-issue" : asset.hasWarning ? " has-warning" : " passed");

    const img = document.createElement("img");
    img.src = getAssetPreviewUrl(asset);
    img.alt = asset.name;
    img.loading = "lazy";
    img.decoding = "async";

    const meta = document.createElement("div");
    meta.className = "asset-meta";
    const status = document.createElement("span");
    status.className = "status-badge " + (asset.hasIssue ? "status-failed" : asset.hasWarning ? "status-running" : "status-done");
    status.textContent = asset.hasIssue ? "有问题" : asset.hasWarning ? "警告" : "通过";
    meta.append(
      createMetaLine("文件名称", asset.name),
      createMetaLine("分辨率", formatResolution(asset.dimensions)),
      createMetaLine("规格标注", asset.label),
      createMetaLine("检测结果", asset.hasIssue ? asset.messages.join("；") : asset.hasWarning ? asset.warnings.join("；") : (asset.notes || []).join("；") || "通过"),
      status
    );

    row.append(img, meta);
    els.detectionList.appendChild(row);
  });
  renderListPager(els.detectionList, renderLimit, visibleAssets.length, () => {
    detectionRenderLimit = Math.min((detectionRenderLimit || DETECTION_RENDER_BATCH_SIZE) + DETECTION_RENDER_BATCH_SIZE, visibleAssets.length);
    renderDetectionList();
  });
}

function renderListPager(container, renderedCount, totalCount, onMore) {
  if (renderedCount >= totalCount) return;
  const pager = document.createElement("div");
  pager.className = "list-pager";
  const text = document.createElement("span");
  text.textContent = "已显示 " + renderedCount + " / " + totalCount + " 张";
  const more = document.createElement("button");
  more.type = "button";
  more.className = "ghost-action";
  more.textContent = "继续显示";
  more.addEventListener("click", onMore);
  pager.append(text, more);
  container.appendChild(pager);
}

function compareDetectionWarnings(left, right) {
  return getDetectionWarningSortKey(left).localeCompare(getDetectionWarningSortKey(right), "zh-Hans-CN", {
    numeric: true,
    sensitivity: "base",
  });
}

function getDetectionWarningSortKey(asset) {
  const warningType = getDetectionWarningType(asset);
  const warningText = (asset.warnings || []).join("；");
  const width = String(asset.dimensions?.width || 0).padStart(5, "0");
  const height = String(asset.dimensions?.height || 0).padStart(5, "0");
  return [warningType, warningText, asset.label || "", width, height, asset.name || ""].join("|");
}

function getDetectionWarningType(asset) {
  const warnings = asset.warnings || [];
  if (warnings.some((message) => message.startsWith("疑似重复资源"))) return "01-疑似重复资源";
  if (warnings.some((message) => message.includes("单边2048") || message.includes("白名单审批"))) return "02-2048白名单风险";
  if (warnings.some((message) => message.includes("效果图尺寸"))) return "03-效果图尺寸提示";
  if (warnings.some((message) => message.includes("1024"))) return "04-1024以上提示";
  return "99-其他警告";
}

function createMetaLine(label, value) {
  const line = document.createElement("div");
  line.className = "meta-line";
  const labelNode = document.createElement("span");
  labelNode.textContent = label;
  const valueNode = document.createElement("strong");
  valueNode.textContent = value;
  line.append(labelNode, valueNode);
  return line;
}

function formatResolution(dimensions) {
  if (!dimensions?.width || !dimensions?.height) return "无法读取";
  return dimensions.width + " x " + dimensions.height;
}

function getSizeCategoryLabel(dimensions) {
  const validation = validateUploadDimensions(dimensions);
  return validation.label || "通用";
}

function getAssetStatus(asset) {
  if (asset.namingStatus && asset.namingStatus !== "idle") return asset.namingStatus;
  return asset.finalBaseName ? "done" : "pending";
}

function getAssetStatusText(asset) {
  const status = getAssetStatus(asset);
  const labels = {
    pending: "待命名",
    running: "命名中",
    done: "已完成",
    failed: "失败",
  };
  return labels[status] || "待命名";
}
