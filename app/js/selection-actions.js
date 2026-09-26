(() => {
  const bar = document.createElement("div");
  bar.id = "floatingSelectionActions";
  bar.className = "selection-actions";
  bar.setAttribute("role", "region");
  bar.setAttribute("aria-label", "图片批量操作");
  bar.hidden = true;
  const count = document.createElement("span");
  count.className = "selection-count";
  const namingControls = document.createElement("div");
  namingControls.className = "selection-naming-controls";
  const prefixField = document.createElement("label");
  prefixField.className = "selection-batch-field selection-prefix-field";
  const prefixLabel = document.createElement("span");
  prefixLabel.textContent = "批量前缀名";
  const prefixPicker = NgrPrefixLibrary.createPrefixPicker({
    value: rules?.basePrefixId || rules?.basePrefix || "builtin:none",
    className: "selection-prefix-picker",
    onChange(prefixId, prefixValue) {
      applySelectedNaming("prefix", { prefixId, prefixValue });
    },
  });
  prefixField.append(prefixLabel, prefixPicker.root);
  function createTextField(labelText, kind) {
    const label = document.createElement("label");
    label.className = "selection-batch-field";
    const title = document.createElement("span");
    title.textContent = labelText;
    const row = document.createElement("div");
    const input = document.createElement("input");
    input.type = "text";
    input.maxLength = 120;
    input.dataset.batchKind = kind;
    const apply = document.createElement("button");
    apply.type = "button";
    apply.className = "selection-apply-button";
    apply.textContent = "应用";
    apply.addEventListener("click", () => applySelectedNaming(kind, input.value));
    input.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" || event.isComposing) return;
      event.preventDefault();
      apply.click();
    });
    row.append(input, apply);
    label.append(title, row);
    return { label, input };
  }
  const projectField = createTextField("批量工程名", "project");
  const viewField = createTextField("批量界面名", "view");
  namingControls.append(prefixField, projectField.label, viewField.label);
  const remove = document.createElement("button");
  remove.id = "floatingRemoveSelected";
  remove.type = "button";
  remove.className = "danger-action";
  remove.textContent = "删除选中图片";
  bar.append(count, namingControls, remove);
  document.body.append(bar);
  const detectionRemove = document.getElementById("removeDetectionSelected");
  const detectionSelect = document.getElementById("selectVisibleDetection");
  let frame = 0;
  let namingSelectionKey = "";
  function selectedNamingAssets() {
    return Array.isArray(assets) ? assets.filter((asset) => asset.checked) : [];
  }
  function commonValue(selected, read) {
    if (!selected.length) return { mixed: false, value: "" };
    const values = selected.map(read);
    return { mixed: values.some((value) => value !== values[0]), value: values[0] || "" };
  }
  function syncNamingControls(selected) {
    const key = selected.map((asset) => [asset.id, buildAssetBasePrefix(asset), buildAssetProjectName(asset), buildAssetViewName(asset)].join(":")).join("|");
    if (key === namingSelectionKey) return;
    namingSelectionKey = key;
    const prefix = commonValue(selected, (asset) => getPrefixEntryForValue(asset.customBasePrefixId || asset.customBasePrefix || buildAssetBasePrefix(asset)).id);
    prefixPicker.setValue(prefix.mixed ? "builtin:none" : prefix.value, false);
    const prefixText = prefixPicker.root.querySelector(".prefix-picker-trigger > span:first-child");
    if (prefix.mixed && prefixText) prefixText.textContent = "多种值";
    for (const [field, read] of [[projectField, buildAssetProjectName], [viewField, buildAssetViewName]]) {
      const value = commonValue(selected, read);
      if (document.activeElement !== field.input) field.input.value = value.mixed ? "" : value.value;
      field.input.placeholder = value.mixed ? "多种值" : "留空使用默认值";
    }
  }
  function applySelectedNaming(kind, value) {
    const selected = selectedNamingAssets();
    if (!selected.length) return;
    for (const asset of selected) {
      asset.customPrefix = "";
      if (kind === "prefix") {
        asset.customBasePrefixId = value.prefixId;
        asset.customBasePrefix = value.prefixId === "builtin:none" ? "__none" : value.prefixValue;
      } else if (kind === "project") asset.customProjectName = sanitizeName(value);
      else if (kind === "view") asset.customViewName = sanitizeName(value);
    }
    namingSelectionKey = "";
    saveCurrentNamingSession();
    renderAssetList();
    refresh();
    const labels = { prefix: "前缀名", project: "工程名", view: "界面名" };
    showToast(`已给 ${selected.length} 张图片应用${labels[kind]}`);
  }
  function refresh() {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      if (!Array.isArray(detectionAssets) || !Array.isArray(assets)) { bar.hidden = true; return; }
      const detectionChecked = detectionAssets.filter((asset) => asset.checked).length;
      const visible = getVisibleDetectionAssets();
      const checkedVisible = visible.filter((asset) => asset.checked).length;
      detectionRemove.disabled = !detectionChecked;
      document.getElementById("selectedDetectionCount").textContent = `已选 ${detectionChecked} 张`;
      detectionSelect.disabled = !visible.length;
      detectionSelect.checked = Boolean(visible.length && checkedVisible === visible.length);
      detectionSelect.indeterminate = checkedVisible > 0 && checkedVisible < visible.length;
      const detection = document.getElementById("detectView").classList.contains("active");
      const naming = document.getElementById("workView").classList.contains("active");
      const selected = detection ? detectionChecked : assets.filter((asset) => asset.checked).length;
      const topButton = detection ? detectionRemove : document.getElementById("removeSelected");
      bar.hidden = !(detection || naming) || !selected || (detection && topButton.getBoundingClientRect().bottom > 0);
      namingControls.hidden = !naming;
      remove.textContent = "删除选中图片";
      if (naming && selected) syncNamingControls(selectedNamingAssets());
      count.textContent = `已选 ${selected} 张`;
    });
  }
  detectionRemove.addEventListener("click", removeSelectedDetectionAssets);
  detectionSelect.addEventListener("change", () => {
    for (const asset of getVisibleDetectionAssets()) asset.checked = detectionSelect.checked;
    renderDetectionList();
  });
  remove.addEventListener("click", () => {
    if (document.getElementById("detectView").classList.contains("active")) removeSelectedDetectionAssets();
    else if (document.getElementById("workView").classList.contains("active") && assets.some((asset) => asset.checked)) removeSelectedAssets();
    refresh();
  });
  document.addEventListener("scroll", refresh, { passive: true, capture: true });
  document.addEventListener("change", refresh);
  window.addEventListener("resize", refresh);
  const observer = new MutationObserver(refresh);
  for (const id of ["assetList", "detectionList", "selectedAssetCount"]) observer.observe(document.getElementById(id), { childList: true, subtree: true });
  for (const view of document.querySelectorAll(".view")) observer.observe(view, { attributes: true, attributeFilter: ["class"] });
  window.NgrSelectionActions = { refresh };
  refresh();
})();
