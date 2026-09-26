(() => {
  const panel = document.getElementById("lexiconPanel");
  const toggle = document.getElementById("lexiconToggle");
  const searchInput = document.getElementById("lexiconSearch");
  const clear = document.getElementById("lexiconClear");
  const categoriesNode = document.getElementById("lexiconCategories");
  const resultsNode = document.getElementById("lexiconResults");
  const count = document.getElementById("lexiconResultCount");
  const targetName = document.getElementById("lexiconTargetName");
  const targetValue = document.getElementById("lexiconTargetValue");
  const targetImage = document.getElementById("lexiconTargetImage");
  const batchSize = 80;
  let category = "全部", limit = batchSize, entries = [], dataKey = "", resultKey = "", revision = 0;
  let historySource, frame = 0, composing = false;
  let resultScroll = 0, categoryScroll = 0;
  function currentAsset() {
    return document.getElementById("workView").classList.contains("active") ? assets.find((asset) => asset.id === selectedId) : null;
  }
  function text(node, value) { if (node.textContent !== value) node.textContent = value; }
  function loadIndex() {
    const key = JSON.stringify([rules.pageTerms, rules.componentTerms, rules.stateTerms, rules.filenameRules,
      rules.projectName, getActiveProject()?.name, els.workProjectName?.value]);
    if (key === dataKey && historySource === getHistoricalKnowledge()) return;
    dataKey = key;
    historySource = getHistoricalKnowledge();
    const categories = buildLexiconCategories();
    entries = NgrLexiconData.buildIndex({ categories, dictionary: buildChineseMeaningDictionary(), phrases: buildChinesePhraseDictionary(),
      mappings: [...Object.entries(builtinTranslations).map(([keyword, value]) => ({ keyword, value })), ...parseFilenameRules(rules.filenameRules)] });
    const titles = ["全部", ...categories.map((entry) => entry.title)];
    if (!titles.includes(category)) category = "全部";
    const scroll = categoriesNode.scrollTop;
    categoriesNode.replaceChildren();
    for (const title of titles) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "lexicon-category";
      button.dataset.category = title;
      button.textContent = title;
      button.addEventListener("click", () => {
        category = title;
        limit = batchSize;
        resultScroll = resultsNode.scrollTop = 0;
        refresh();
      });
      categoriesNode.append(button);
    }
    categoriesNode.scrollTop = scroll;
    revision++;
  }
  function updateTarget(asset) {
    const name = asset ? asset.file?.name || asset.originalBase + asset.extension : "请在命名页面选择图片";
    text(targetName, name);
    targetName.title = name;
    text(targetValue, asset ? (asset.finalBaseName ? buildExportName(asset) : "当前名称：待命名") : "浏览词库后，选择图片即可加入名称");
    targetImage.hidden = !asset;
    if (asset) {
      const src = getAssetPreviewUrl(asset);
      if (targetImage.getAttribute("src") !== src) targetImage.src = src;
    } else targetImage.removeAttribute("src");
  }
  function applyTerm(term) {
    const asset = currentAsset();
    if (!asset) return;
    const next = formatNamingName(NgrLexiconData.toggle(asset.finalBaseName, term));
    const row = [...document.querySelectorAll("#assetList [data-asset-id]")].find((node) => node.dataset.assetId === asset.id);
    const album = document.getElementById("albumEditorPanel");
    const input = row?.querySelector(".inline-final-name input") || (album.dataset.assetId === asset.id ? album.querySelector(".album-final-field input") : null);
    const x = window.scrollX, y = window.scrollY;
    if (input) {
      input.value = next;
      input.dispatchEvent(new Event("input", { bubbles: true }));
    } else {
      asset.finalBaseName = next;
      saveCurrentNamingSession();
      renderAssetList();
    }
    window.scrollTo(x, y);
    refresh();
  }
  function renderResults(asset) {
    const filtered = NgrLexiconData.search(entries, searchInput.value, category);
    const key = JSON.stringify([revision, searchInput.value, category, limit]);
    text(count, `${category} · ${filtered.length} 个词条`);
    clear.disabled = !searchInput.value;
    for (const button of categoriesNode.children) {
      const selected = button.dataset.category === category;
      button.classList.toggle("active", selected);
      button.setAttribute("aria-pressed", String(selected));
    }
    if (key !== resultKey) {
      resultKey = key;
      const scroll = resultsNode.scrollTop;
      resultsNode.replaceChildren();
      if (!filtered.length) {
        const empty = document.createElement("p");
        empty.className = "lexicon-empty";
        empty.textContent = "没有找到词条，试试其他中文或英文，或切换到“全部”。";
        resultsNode.append(empty);
      }
      for (const entry of filtered.slice(0, limit)) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "lexicon-entry";
        button.dataset.term = entry.term;
        button.setAttribute("aria-label", `${entry.term} · ${entry.meaning}`);
        const term = document.createElement("strong");
        term.textContent = entry.term;
        const meaning = document.createElement("span");
        meaning.textContent = entry.meaning;
        button.append(term, meaning);
        button.addEventListener("click", () => applyTerm(entry.term));
        resultsNode.append(button);
      }
      if (filtered.length > limit) {
        const more = document.createElement("button");
        more.type = "button";
        more.className = "ghost-action lexicon-more";
        more.textContent = `继续显示（${Math.min(limit, filtered.length)} / ${filtered.length}）`;
        more.addEventListener("click", () => {
          limit += batchSize;
          refresh();
          const firstNew = resultsNode.querySelectorAll(".lexicon-entry")[limit - batchSize];
          firstNew?.focus({ preventScroll: true });
        });
        resultsNode.append(more);
      }
      resultsNode.scrollTop = scroll;
    }
    for (const button of resultsNode.querySelectorAll(".lexicon-entry")) {
      const selected = Boolean(asset && NgrLexiconData.hasTerm(asset.finalBaseName, button.dataset.term));
      button.disabled = !asset;
      button.classList.toggle("selected", selected);
      button.setAttribute("aria-pressed", String(selected));
      button.title = !asset ? "请在命名页面选择图片" : selected ? "点击从当前名称移除" : "点击加入当前图片名称";
    }
  }
  function refresh() {
    if (panel.hidden) return;
    loadIndex();
    const asset = currentAsset();
    updateTarget(asset);
    renderResults(asset);
  }
  function schedule() {
    if (panel.hidden || frame) return;
    frame = requestAnimationFrame(() => { frame = 0; refresh(); });
  }
  function open() {
    closeTranslatorPanel({ restoreFocus: false });
    panel.hidden = false;
    toggle.setAttribute("aria-expanded", "true");
    refresh();
    resultsNode.scrollTop = resultScroll;
    categoriesNode.scrollTop = categoryScroll;
    searchInput.focus({ preventScroll: true });
  }
  function close({ restoreFocus = true } = {}) {
    if (panel.hidden) return;
    resultScroll = resultsNode.scrollTop;
    categoryScroll = categoriesNode.scrollTop;
    panel.hidden = true;
    toggle.setAttribute("aria-expanded", "false");
    if (restoreFocus) toggle.focus({ preventScroll: true });
  }
  function searchChanged() {
    if (composing) return;
    limit = batchSize;
    resultScroll = resultsNode.scrollTop = 0;
    refresh();
  }
  toggle.addEventListener("click", () => panel.hidden ? open() : close());
  document.getElementById("lexiconClose").addEventListener("click", () => close());
  searchInput.addEventListener("compositionstart", () => { composing = true; });
  searchInput.addEventListener("compositionend", () => { composing = false; searchChanged(); });
  searchInput.addEventListener("input", searchChanged);
  clear.addEventListener("click", () => { searchInput.value = ""; searchChanged(); searchInput.focus(); });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !event.isComposing && !panel.hidden) { event.preventDefault(); close(); }
  }, true);
  function trackTarget(event) {
    if (event.target.matches?.('input[type="checkbox"]')) return;
    const row = event.target.closest?.("#assetList [data-asset-id]");
    if (row && selectedId !== row.dataset.assetId) {
      selectedId = row.dataset.assetId;
      for (const item of document.querySelectorAll("#assetList [data-asset-id]")) item.classList.toggle("active", item.dataset.assetId === selectedId);
      saveCurrentNamingSession();
    }
    schedule();
  }
  document.addEventListener("focusin", trackTarget);
  document.addEventListener("click", trackTarget, true);
  document.addEventListener("input", schedule, true);
  document.addEventListener("change", schedule, true);
  const observer = new MutationObserver(schedule);
  for (const id of ["assetList", "albumEditorPanel", "workProjectName", "workViewName", "projectSelect", "schemeSelect"]) {
    const node = document.getElementById(id);
    if (node) observer.observe(node, { childList: true, subtree: true, characterData: true });
  }
  for (const view of document.querySelectorAll(".view")) observer.observe(view, { attributes: true, attributeFilter: ["class"] });
  window.NgrLexiconPanel = { open, close, refresh: schedule };
})();
