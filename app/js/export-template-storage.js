/* NGR AssetPilot V2.26 module: export-template-storage.js */
function resetAppLocalStorageOnVersionChange() {
  const savedVersion = localStorage.getItem(APP_VERSION_KEY);
  if (savedVersion === APP_VERSION) return;
  localStorage.setItem(APP_VERSION_KEY, APP_VERSION);
}

async function exportRenamedFiles() {
  closeCompactActionMenu(els.exportMenu);
  if (!assets.length) {
    showToast("没有可导出的图片");
    return;
  }
  const incomplete = assets.find((asset) => !asset.finalBaseName);
  if (incomplete) {
    selectedId = incomplete.id;
    renderAssetList();
    showToast("还有图片没有最终名称，请先确认");
    return;
  }
  const duplicate = findDuplicateExportAsset();
  if (duplicate) {
    selectedId = duplicate.id;
    renderAssetList();
    showToast("同一工程文件夹内存在重复文件名，请修改后再导出");
    return;
  }

  const exportMode = els.exportModeSelect?.value || "folder";
  els.exportFiles.disabled = true;

  try {
    if (exportMode === "zip") {
      await exportAssetsAsZip();
      return;
    }

    if (window.NgrDesktopBridge?.hasCapability("files.selectExportDirectory")
      && window.NgrDesktopBridge?.hasCapability("files.writeFile")) {
      const projectCount = await exportAssetsToDesktopProjectFolders();
      showToast(projectCount > 1 ? `导出完成，已创建 ${projectCount} 个工程文件夹` : `导出完成，已创建工程文件夹：${buildExportProjectFolderName(assets[0])}`);
      return;
    }

    if (!("showDirectoryPicker" in window)) {
      await exportAssetsAsZip();
      showToast("当前浏览器不支持创建文件夹，已自动下载工程 ZIP 压缩包");
      return;
    }

    const projectCount = await exportAssetsToProjectFolders();
    showToast(projectCount > 1 ? `导出完成，已创建 ${projectCount} 个工程文件夹` : `导出完成，已创建工程文件夹：${buildExportProjectFolderName(assets[0])}`);
  } catch (error) {
    if (error.name !== "AbortError") {
      console.error("导出命名图片失败", error);
      showToast("导出失败，请检查浏览器权限或剩余磁盘空间");
    }
  } finally {
    els.exportFiles.disabled = false;
  }
}

async function exportAssetsToDesktopProjectFolders() {
  const selected = await window.NgrDesktopBridge.selectExportDirectory();
  if (!selected?.token) throw new DOMException("用户取消选择导出目录", "AbortError");
  const projectFolderNames = new Set();
  for (const asset of assets) {
    const projectFolderName = buildExportProjectFolderName(asset);
    projectFolderNames.add(projectFolderName);
    await window.NgrDesktopBridge.writeFileInChunks(
      selected.token,
      `${projectFolderName}/${buildExportName(asset)}`,
      asset.file,
    );
  }
  return projectFolderNames.size;
}

async function exportAssetsToProjectFolders() {
  const exportRoot = await window.showDirectoryPicker({ mode: "readwrite" });
  const projectDirectories = new Map();

  for (const asset of assets) {
    const projectFolderName = buildExportProjectFolderName(asset);
    let projectDirectory = projectDirectories.get(projectFolderName);
    if (!projectDirectory) {
      projectDirectory = await exportRoot.getDirectoryHandle(projectFolderName, { create: true });
      projectDirectories.set(projectFolderName, projectDirectory);
    }

    const fileHandle = await projectDirectory.getFileHandle(buildExportName(asset), { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(asset.file);
    await writable.close();
  }

  return projectDirectories.size;
}

async function exportAssetsAsZip() {
  if (!window.fflate?.zipSync) throw new Error("ZIP 压缩组件未加载");

  showToast("正在生成工程 ZIP 压缩包，请稍候");
  const zipEntries = Object.create(null);
  const projectFolderNames = new Set();

  for (const asset of assets) {
    const projectFolderName = buildExportProjectFolderName(asset);
    projectFolderNames.add(projectFolderName);
    zipEntries[`${projectFolderName}/${buildExportName(asset)}`] = new Uint8Array(await asset.file.arrayBuffer());
  }

  const zipBytes = window.fflate.zipSync(zipEntries, { level: 0 });
  const blob = new Blob([zipBytes], { type: "application/zip" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = buildExportArchiveName([...projectFolderNames]);
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  showToast(projectFolderNames.size > 1 ? `ZIP 已生成，包含 ${projectFolderNames.size} 个工程文件夹` : `ZIP 已生成：${link.download}`);
}

function buildExportProjectFolderName(asset) {
  const projectName = buildAssetProjectName(asset)
    .replace(/[. ]+$/g, "")
    .slice(0, 120);
  const safeName = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(projectName) ? `_${projectName}` : projectName;
  return safeName || "未命名工程";
}

function buildExportArchiveName(projectFolderNames) {
  if (projectFolderNames.length === 1) return `${projectFolderNames[0]}.zip`;
  const archiveProjectName = sanitizeName(currentWorkProjectName).replace(/[. ]+$/g, "");
  return `${archiveProjectName || "NGR_AssetPilot"}_多工程导出.zip`;
}

function findDuplicateExportAsset() {
  const duplicateGroup = [...buildDuplicateExportGroups().values()].find((group) => group.length > 1);
  return duplicateGroup?.[1] || null;
}

function buildExportPathKey(asset) {
  if (!asset?.finalBaseName) return "";
  return `${buildExportProjectFolderName(asset)}/${buildExportName(asset)}`.toLocaleLowerCase("en-US");
}

function buildDuplicateExportGroups(assetList = assets) {
  const groups = new Map();
  assetList.forEach((asset) => {
    const exportPath = buildExportPathKey(asset);
    if (!exportPath) return;
    const group = groups.get(exportPath) || [];
    group.push(asset);
    groups.set(exportPath, group);
  });
  return groups;
}

function buildExportName(asset) {
  return buildAssetPrefix(asset) + formatNamingName(asset.finalBaseName) + asset.extension;
}

function buildAssetPrefix(asset) {
  const legacyPrefix = sanitizePrefix(asset?.customPrefix);
  if (legacyPrefix) return legacyPrefix.endsWith("_") ? legacyPrefix : legacyPrefix + "_";
  const separator = rules.separator || "_";
  const parts = [
    buildAssetBasePrefix(asset),
    buildAssetProjectName(asset),
    buildAssetViewName(asset),
  ].filter(Boolean);
  return parts.join(separator) + separator;
}

function buildAssetBasePrefix(asset) {
  if (asset?.customBasePrefix === "__none" || asset?.customBasePrefixId === "builtin:none") return "";
  if (asset?.customBasePrefixId) return resolveStoredPrefixValue(asset.customBasePrefixId);
  if (asset?.customBasePrefix !== "" && asset?.customBasePrefix != null) {
    const entry = ensurePrefixEntryForValue(asset.customBasePrefix);
    asset.customBasePrefixId = entry.id;
    return entry.value;
  }
  return resolveStoredPrefixValue(rules.basePrefixId || rules.basePrefix);
}

function buildAssetProjectName(asset) {
  return sanitizeName(asset?.customProjectName || currentWorkProjectName || "");
}

function buildAssetViewName(asset) {
  return sanitizeName(asset?.customViewName || rules.viewName);
}

function getExtension(name) {
  const match = name.match(/\.[^.]+$/);
  return match ? match[0].toLowerCase() : ".png";
}

function collectRulesForm() {
  const prefixEntry = getPrefixEntryForValue(els.basePrefix.value);
  return {
    schemeName: els.schemeName.value.trim() || defaultRules.schemeName,
    basePrefix: prefixEntry.value,
    basePrefixId: prefixEntry.id,
    projectName: sanitizeName(els.projectName.value),
    viewName: sanitizeName(els.workViewName.value),
    separator: els.separator.value || defaultRules.separator,
    tags: els.tags.value.trim() || defaultRules.tags,
    pageTerms: els.pageTerms.value.trim() || defaultRules.pageTerms,
    componentTerms: els.componentTerms.value.trim() || defaultRules.componentTerms,
    stateTerms: els.stateTerms.value.trim() || defaultRules.stateTerms,
    filenameRules: els.filenameRules.value.trim() || defaultRules.filenameRules,
    contextDocs: els.contextDocs.value.trim(),
    aiPromptText: els.aiPromptText.value.trim(),
  };
}

function fillRulesForm() {
  const project = getActiveProject();
  els.projectConfigName.value = project.name;
  els.projectConfigDescription.value = project.description || "";
  els.schemeName.value = rules.schemeName;
  els.basePrefix.value = rules.basePrefix;
  if (els.workBasePrefix?.prefixPicker) els.workBasePrefix.value = rules.basePrefixId || getPrefixPresetValue(rules.basePrefix);
  renderPrefixPresetOptions(rules.basePrefixId || rules.basePrefix);
  els.projectName.value = rules.projectName;
  els.workProjectName.value = currentWorkProjectName;
  els.workViewName.value = rules.viewName || "";
  els.separator.value = rules.separator;
  els.tags.value = rules.tags;
  els.pageTerms.value = rules.pageTerms;
  els.componentTerms.value = rules.componentTerms;
  els.stateTerms.value = rules.stateTerms;
  els.filenameRules.value = rules.filenameRules;
  els.contextDocs.value = rules.contextDocs || "";
  els.aiPromptText.value = rules.aiPromptText || "";
}

function fillAiSettings() {
  els.aiProvider.value = aiSettings.provider;
  els.aiApiFormat.value = aiSettings.apiFormat;
  els.aiBaseUrl.value = aiSettings.baseUrl;
  els.openaiApiKey.value = aiSettings.apiKey;
  els.openaiModel.value = aiSettings.model;
  els.aiProviderNote.value = aiSettings.providerNote;
}

function exportSchemeTemplate() {
  const current = collectRulesForm();
  const workbook = buildExcelTemplate(current);
  const blob = new Blob([workbook], { type: "application/vnd.ms-excel;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = sanitizeName(current.schemeName) + "_命名方案模板.xls";
  link.click();
  URL.revokeObjectURL(url);
  showToast("已导出多页签方案模板");
}

function exportPromptText() {
  const current = collectRulesForm();
  const payload = {
    type: "ngr-ai-autoname-prompt-text",
    version: APP_VERSION,
    schemeName: current.schemeName,
    exportedAt: new Date().toISOString(),
    aiPromptText: current.aiPromptText || "",
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = sanitizeName(current.schemeName) + "_AI提示文本.json";
  link.click();
  URL.revokeObjectURL(url);
  showToast("AI 提示文本已导出");
}

async function importPromptText(event) {
  const file = event.target.files[0];
  if (!file) return;
  try {
    const text = await file.text();
    let promptText = text.trim();
    if (/\.json$/i.test(file.name) || text.trim().startsWith("{")) {
      const payload = JSON.parse(text);
      promptText = String(payload.aiPromptText || payload.promptText || payload.prompt || "").trim();
    }
    if (!promptText) {
      showToast("导入失败，文件里没有可用的提示文本");
      return;
    }
    els.aiPromptText.value = promptText;
    rules = collectRulesForm();
    saveRules(rules);
    upsertScheme(rules);
    showToast("AI 提示文本已导入并保存到当前方案");
  } catch (error) {
    showToast("导入失败，请检查提示文本文件格式");
  } finally {
    event.target.value = "";
  }
}

async function importSchemeTemplate(event) {
  const file = event.target.files[0];
  if (!file) return;
  try {
    const text = await file.text();
    const imported = parseSchemeTemplate(text, file.name);
    rules = normalizeLoadedRules({ ...defaultRules, ...imported });
    saveRules(rules);
    upsertScheme(rules);
    fillRulesForm();
    renderSchemeSelect();
    updateRulePreview();
    updateActiveRuleText();
    renderAssetList();
    showToast("已导入方案模板：" + rules.schemeName);
  } catch (error) {
    showToast("导入失败，请检查模板格式");
  } finally {
    event.target.value = "";
  }
}

function buildExcelTemplate(current) {
  const pageRows = parseList(current.pageTerms).map((value, index) => [index + 1, value, "页面英文名，用于生成 Home_BG 等名称"]);
  const componentRows = parseList(current.componentTerms).map((value, index) => [index + 1, value, "组件英文名，用于识别按钮、背景、图标等"]);
  const stateRows = parseList(current.stateTerms).map((value, index) => [index + 1, value, "状态英文名，用于 Normal、Hover 等交互状态"]);
  const ruleRows = parseFilenameRules(current.filenameRules).map((rule) => [rule.keyword, rule.value, "原始文件名包含关键词时，自动转换为英文名"]);
  const sheets = [
    {
      name: "使用说明",
      rows: [
        ["NGR AssetPilot｜AI资源领航 - 方案模板"],
        ["请在各页签中修改“值”或词库内容，保存后回到网页导入。"],
        ["基础配置页：维护方案名称、固定前缀、工程名、分隔符、常用标签。"],
        ["页面词库/组件词库/状态词库：每行填写一个英文命名词。"],
        ["文件名匹配规则：第一列填写中文或英文关键词，第二列填写转换后的英文名。"],
        ["上下文文档：填写项目背景、页面结构和特殊命名约定，AI 会参考这些内容。"],
        ["AI提示文本：填写当前方案专用提示词，会追加到视觉 AI 命名和文本模型翻译请求中。"],
        ["不要修改页签名称和表头，否则可能无法导入。"],
      ],
    },
    {
      name: "基础配置",
      rows: [
        ["字段", "值", "说明"],
        ["方案名称", current.schemeName, "自定义方案名称，会显示在网页的选择方案下拉框中"],
        ["固定前缀", current.basePrefix, "例如 T_UI"],
        ["工程名", current.projectName, "当前项目或界面工程名，也可在开始命名页临时修改"],
        ["分隔符", current.separator, "推荐使用 _"],
        ["常用标签", current.tags, "多个标签可用英文逗号分隔"],
      ],
    },
    {
      name: "页面词库",
      rows: [["序号", "页面英文名", "说明"], ...pageRows],
    },
    {
      name: "组件词库",
      rows: [["序号", "组件英文名", "说明"], ...componentRows],
    },
    {
      name: "状态词库",
      rows: [["序号", "状态英文名", "说明"], ...stateRows],
    },
    {
      name: "文件名匹配规则",
      rows: [["原始文件名关键词", "转换后的英文名", "说明"], ...ruleRows],
    },
    {
      name: "上下文文档",
      rows: [["字段", "内容"], ["项目上下文文档", current.contextDocs || ""]],
    },
    {
      name: "AI提示文本",
      rows: [["字段", "内容"], ["AI提示文本", current.aiPromptText || ""]],
    },
  ];
  return [
    '<?xml version="1.0"?>',
    '<?mso-application progid="Excel.Sheet"?>',
    '<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">',
    '<Styles><Style ss:ID="Header"><Font ss:Bold="1"/><Interior ss:Color="#DCEEEF" ss:Pattern="Solid"/></Style></Styles>',
    sheets.map((sheet) => buildWorksheet(sheet.name, sheet.rows)).join(""),
    "</Workbook>",
  ].join("");
}

function buildWorksheet(name, rows) {
  return [
    '<Worksheet ss:Name="' + xmlEscape(name) + '"><Table>',
    rows.map((row, rowIndex) => {
      const style = rowIndex === 0 ? ' ss:StyleID="Header"' : "";
      return "<Row>" + row.map((cell) => '<Cell' + style + '><Data ss:Type="String">' + xmlEscape(cell) + "</Data></Cell>").join("") + "</Row>";
    }).join(""),
    "</Table></Worksheet>",
  ].join("");
}

function parseSchemeTemplate(text, fileName) {
  if (/\.csv$/i.test(fileName) || !text.trim().startsWith("<")) {
    return parseSchemeTemplateCsv(text);
  }
  return parseSchemeTemplateWorkbook(text);
}

function parseSchemeTemplateWorkbook(text) {
  const xml = new DOMParser().parseFromString(text, "text/xml");
  if (xml.querySelector("parsererror")) throw new Error("Invalid Excel XML");
  const next = { ...defaultRules };
  const pageTerms = readWorksheetValues(xml, "页面词库", 1);
  const componentTerms = readWorksheetValues(xml, "组件词库", 1);
  const stateTerms = readWorksheetValues(xml, "状态词库", 1);
  const rulesRows = readWorksheetRows(xml, "文件名匹配规则").slice(1);
  const contextDocs = readWorksheetLongText(xml, "上下文文档");
  const aiPromptText = readWorksheetLongText(xml, "AI提示文本");
  const baseRows = readWorksheetRows(xml, "基础配置").slice(1);
  baseRows.forEach(([field, value]) => {
    const cleanField = String(field || "").trim();
    const cleanValue = String(value || "").trim();
    if (cleanField === "方案名称") next.schemeName = cleanValue || defaultRules.schemeName;
    if (cleanField === "固定前缀") next.basePrefix = cleanValue || defaultRules.basePrefix;
    if (cleanField === "工程名") next.projectName = cleanValue || defaultRules.projectName;
    if (cleanField === "分隔符") next.separator = cleanValue || defaultRules.separator;
    if (cleanField === "常用标签") next.tags = cleanValue || defaultRules.tags;
  });
  if (pageTerms.length) next.pageTerms = pageTerms.join("\n");
  if (componentTerms.length) next.componentTerms = componentTerms.join("\n");
  if (stateTerms.length) next.stateTerms = stateTerms.join("\n");
  const filenameRules = rulesRows
    .map(([keyword, value]) => [String(keyword || "").trim(), String(value || "").trim()])
    .filter(([keyword, value]) => keyword && value)
    .map(([keyword, value]) => keyword + "=" + value);
  if (filenameRules.length) next.filenameRules = filenameRules.join("\n");
  if (contextDocs) next.contextDocs = contextDocs;
  if (aiPromptText) next.aiPromptText = aiPromptText;
  return next;
}

function readWorksheetLongText(xml, sheetName) {
  const rows = readWorksheetRows(xml, sheetName).filter((row) => row.some((cell) => String(cell || "").trim()));
  if (!rows.length) return "";
  if (rows.length === 1) return rows[0].slice(1).join("\n").trim() || rows[0].join("\n").trim();
  return rows.slice(1).map((row) => row.slice(1).join("\n").trim() || row.join("\n").trim()).filter(Boolean).join("\n");
}

function readWorksheetValues(xml, sheetName, columnIndex) {
  return readWorksheetRows(xml, sheetName)
    .slice(1)
    .map((row) => String(row[columnIndex] || "").trim())
    .filter(Boolean);
}

function readWorksheetRows(xml, sheetName) {
  const worksheet = [...xml.getElementsByTagName("Worksheet")].find((sheet) => sheet.getAttribute("ss:Name") === sheetName || sheet.getAttribute("Name") === sheetName);
  if (!worksheet) return [];
  return [...worksheet.getElementsByTagName("Row")].map((row) => [...row.getElementsByTagName("Cell")].map((cell) => {
    const data = cell.getElementsByTagName("Data")[0];
    return data ? data.textContent : "";
  }));
}

function parseSchemeTemplateCsv(text) {
  const rows = parseCsv(text.replace(/^\ufeff/, ""));
  const next = { ...defaultRules };
  const pageTerms = [];
  const componentTerms = [];
  const stateTerms = [];
  const filenameRules = [];
  rows.slice(1).forEach(([moduleName, field, value]) => {
    const cleanModule = String(moduleName || "").trim();
    const cleanField = String(field || "").trim();
    const cleanValue = String(value || "").trim();
    if (!cleanModule || !cleanField) return;
    if (cleanModule === "基础配置") {
      if (cleanField === "方案名称") next.schemeName = cleanValue || defaultRules.schemeName;
      if (cleanField === "固定前缀") next.basePrefix = cleanValue || defaultRules.basePrefix;
      if (cleanField === "工程名") next.projectName = cleanValue || defaultRules.projectName;
      if (cleanField === "分隔符") next.separator = cleanValue || defaultRules.separator;
      if (cleanField === "常用标签") next.tags = cleanValue || defaultRules.tags;
    }
    if (cleanModule === "页面词库" && cleanValue) pageTerms.push(cleanValue);
    if (cleanModule === "组件词库" && cleanValue) componentTerms.push(cleanValue);
    if (cleanModule === "状态词库" && cleanValue) stateTerms.push(cleanValue);
    if (cleanModule === "文件名匹配规则" && cleanField && cleanValue) filenameRules.push(cleanField + "=" + cleanValue);
    if (cleanModule === "上下文文档" && cleanValue) next.contextDocs = [next.contextDocs, cleanValue].filter(Boolean).join("\n");
    if (cleanModule === "AI提示文本" && cleanValue) next.aiPromptText = [next.aiPromptText, cleanValue].filter(Boolean).join("\n");
  });
  if (pageTerms.length) next.pageTerms = pageTerms.join("\n");
  if (componentTerms.length) next.componentTerms = componentTerms.join("\n");
  if (stateTerms.length) next.stateTerms = stateTerms.join("\n");
  if (filenameRules.length) next.filenameRules = filenameRules.join("\n");
  return next;
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    if (quoted && char === '"' && next === '"') {
      cell += '"';
      index += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (!quoted && char === ",") {
      row.push(cell);
      cell = "";
    } else if (!quoted && (char === "\n" || char === "\r")) {
      if (char === "\r" && next === "\n") index += 1;
      row.push(cell);
      if (row.some((item) => item.trim())) rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += char;
    }
  }
  row.push(cell);
  if (row.some((item) => item.trim())) rows.push(row);
  return rows;
}

function csvCell(value) {
  const text = String(value || "");
  return '"' + text.replace(/"/g, '""') + '"';
}

function xmlEscape(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderSchemeSelect() {
  els.schemeSelect.innerHTML = "";
  els.workSchemeSelect.innerHTML = "";
  schemes.forEach((scheme) => {
    const option = document.createElement("option");
    option.value = scheme.schemeName;
    option.textContent = scheme.schemeName;
    option.selected = scheme.schemeName === rules.schemeName;
    els.schemeSelect.appendChild(option);
    const workOption = document.createElement("option");
    workOption.value = scheme.schemeName;
    workOption.textContent = scheme.schemeName;
    workOption.selected = scheme.schemeName === rules.schemeName;
    els.workSchemeSelect.appendChild(workOption);
  });
  els.schemeSelect.value = rules.schemeName;
  els.workSchemeSelect.value = rules.schemeName;
}

function renderProjectSelect() {
  els.projectSelect.innerHTML = "";
  projects.forEach((project) => {
    const option = document.createElement("option");
    option.value = project.id;
    option.textContent = project.name;
    option.selected = project.id === activeProjectId;
    els.projectSelect.appendChild(option);
  });
}

function renderDetectionProfileSelect() {
  els.detectionProfileSelect.innerHTML = "";
  els.detectionSettingsProfileSelect.innerHTML = "";
  detectionProfiles.forEach((profile) => {
    const option = document.createElement("option");
    option.value = profile.id;
    option.textContent = profile.name;
    option.selected = profile.id === activeDetectionProfileId;
    els.detectionProfileSelect.appendChild(option);
    const settingsOption = document.createElement("option");
    settingsOption.value = profile.id;
    settingsOption.textContent = profile.name;
    settingsOption.selected = profile.id === activeDetectionProfileId;
    els.detectionSettingsProfileSelect.appendChild(settingsOption);
  });
  els.detectionProfileSelect.value = activeDetectionProfileId;
  els.detectionSettingsProfileSelect.value = activeDetectionProfileId;
  els.detectionModeSelect.value = getActiveDetectionProfile().mode;
  els.duplicateSensitivitySelect.value = getActiveDetectionProfile().duplicateSensitivity;
}

function fillDetectionProfileForm() {
  const profile = getActiveDetectionProfile();
  els.detectionProfileName.value = profile.name;
  els.detectionProfileMode.value = profile.mode;
  els.duplicateSensitivityProfile.value = profile.duplicateSensitivity;
  els.detectionMaxSide.value = profile.maxSide;
  els.detectionBgWidth.value = profile.backgroundWidth;
  els.detectionBgHeight.value = profile.backgroundHeight;
  els.detectionLargeThreshold.value = profile.largeThreshold;
  els.detectionLargeMultiple.value = profile.largeMultiple;
  els.detectionAtlasMultiple.value = profile.atlasMultiple;
}

function collectDetectionProfileForm() {
  const current = getActiveDetectionProfile();
  return normalizeDetectionProfile({
    ...current,
    name: els.detectionProfileName.value,
    mode: els.detectionProfileMode.value,
    duplicateSensitivity: els.duplicateSensitivityProfile.value,
    maxSide: els.detectionMaxSide.value,
    backgroundWidth: els.detectionBgWidth.value,
    backgroundHeight: els.detectionBgHeight.value,
    largeThreshold: els.detectionLargeThreshold.value,
    largeMultiple: els.detectionLargeMultiple.value,
    atlasMultiple: els.detectionAtlasMultiple.value,
  });
}

function updateActiveDetectionProfile(nextProfile, shouldSave) {
  const index = detectionProfiles.findIndex((profile) => profile.id === activeDetectionProfileId);
  if (index >= 0) detectionProfiles[index] = normalizeDetectionProfile(nextProfile);
  if (shouldSave) {
    saveDetectionProfiles();
    renderDetectionProfileSelect();
  }
}

function createDetectionProfile() {
  const base = normalizeDetectionProfile(getActiveDetectionProfile());
  const next = {
    ...base,
    id: "detect-" + Date.now(),
    name: base.name + " 副本",
  };
  detectionProfiles.push(next);
  activeDetectionProfileId = next.id;
  saveDetectionProfiles();
  renderDetectionProfileSelect();
  fillDetectionProfileForm();
  revalidateDetectionAssets();
  showToast("已新增检测项目组");
}

function deleteDetectionProfile() {
  if (detectionProfiles.length <= 1) {
    showToast("至少保留一个检测项目组");
    return;
  }
  detectionProfiles = detectionProfiles.filter((profile) => profile.id !== activeDetectionProfileId);
  activeDetectionProfileId = detectionProfiles[0].id;
  saveDetectionProfiles();
  renderDetectionProfileSelect();
  fillDetectionProfileForm();
  revalidateDetectionAssets();
  showToast("已删除检测项目组");
}

function revalidateDetectionAssets() {
  const profile = getActiveDetectionProfile();
  detectionAssets = detectionAssets.map((asset) => ({
    ...asset,
    ...validateDetectionDimensions(asset.dimensions, profile),
  }));
  updateSimilarResourceWarnings();
  renderDetectionList();
}

function syncWorkProjectFields() {
  const project = getActiveProject();
  if (els.projectSelect.value !== activeProjectId) els.projectSelect.value = activeProjectId;
  els.projectConfigName.value = project.name;
  els.projectConfigDescription.value = project.description || "";
  if (els.workBasePrefix?.prefixPicker) els.workBasePrefix.value = rules.basePrefixId || getPrefixPresetValue(rules.basePrefix);
  els.workProjectName.value = currentWorkProjectName;
  els.workViewName.value = rules.viewName || "";
}

function buildPrefix() {
  const separator = rules.separator || "_";
  const parts = [resolveStoredPrefixValue(rules.basePrefixId || rules.basePrefix), sanitizeName(currentWorkProjectName), sanitizeName(rules.viewName)].filter(Boolean);
  return parts.length ? `${parts.join(separator)}${separator}` : "";
}

function updateRulePreview() {
  els.prefixPreview.textContent = buildPrefix() + "AI自动生成名称";
}

function updateActiveRuleText() {
  els.activeRuleText.textContent = "当前规则：" + buildPrefix();
}

function getPrefixPresetValue(prefix) {
  return getPrefixEntryForValue(prefix).id;
}

function collectLegacyPrefixValues() {
  const values = [];
  const append = (value) => {
    const clean = NgrPrefixLibrary.sanitizePrefixValue(value);
    if (clean) values.push(clean);
  };
  try { append(JSON.parse(localStorage.getItem(STORAGE_KEY) || "null")?.basePrefix); } catch {}
  for (const key of [SCHEME_KEY, PROJECTS_KEY]) {
    try {
      const payload = JSON.parse(localStorage.getItem(key) || "null");
      const visit = (value) => {
        if (!value || typeof value !== "object") return;
        if (typeof value.basePrefix === "string") append(value.basePrefix);
        Object.values(value).forEach((child) => {
          if (child && typeof child === "object") visit(child);
        });
      };
      visit(payload);
    } catch {}
  }
  return values;
}

function loadPrefixLibrary() {
  const entries = NgrPrefixLibrary.normalizePrefixLibrary(localStorage.getItem(PREFIX_LIBRARY_KEY), collectLegacyPrefixValues());
  localStorage.setItem(PREFIX_LIBRARY_KEY, JSON.stringify({ schemaVersion: 1, entries }));
  return entries;
}

function savePrefixLibrary() {
  prefixLibrary = NgrPrefixLibrary.normalizePrefixLibrary({ entries: prefixLibrary });
  localStorage.setItem(PREFIX_LIBRARY_KEY, JSON.stringify({ schemaVersion: 1, entries: prefixLibrary }));
}

function getPrefixEntryForValue(idOrValue) {
  const existing = NgrPrefixLibrary.getPrefixEntry(prefixLibrary, idOrValue);
  if (existing) return existing;
  const entry = NgrPrefixLibrary.ensurePrefixEntry(prefixLibrary, idOrValue);
  savePrefixLibrary();
  return entry;
}

function ensurePrefixEntryForValue(value) {
  return getPrefixEntryForValue(value);
}

function resolveStoredPrefixValue(idOrValue) {
  return NgrPrefixLibrary.resolvePrefixValue(prefixLibrary, idOrValue);
}

function renderPrefixPresetOptions(selected = rules?.basePrefixId || rules?.basePrefix) {
  if (!els.prefixPreset) return;
  const selectedEntry = getPrefixEntryForValue(selected);
  els.prefixPreset.innerHTML = "";
  prefixLibrary.forEach((entry) => {
    const option = document.createElement("option");
    option.value = entry.id;
    option.textContent = entry.label;
    option.selected = entry.id === selectedEntry.id;
    els.prefixPreset.appendChild(option);
  });
  const manage = document.createElement("option");
  manage.value = "__manage";
  manage.textContent = "＋ 新建/编辑前缀…";
  els.prefixPreset.appendChild(manage);
}

function parseTags(value) {
  return parseList(value);
}

function parseList(value) {
  return String(value || "")
    .split(/[\n,，、]/)
    .map((item) => sanitizeName(item))
    .filter(Boolean);
}

function parseFilenameRules(value) {
  return String(value || "")
    .split(/\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const parts = line.split("=");
      return {
        keyword: sanitizeName(parts[0]),
        value: sanitizeName(parts.slice(1).join("=") || parts[0]),
      };
    })
    .filter((rule) => rule.keyword && rule.value);
}

function loadRules() {
  try {
    return normalizeLoadedRules({ ...defaultRules, ...JSON.parse(localStorage.getItem(STORAGE_KEY)) });
  } catch {
    return { ...defaultRules };
  }
}

function saveRules(nextRules) {
  const entry = getPrefixEntryForValue(nextRules.basePrefixId || nextRules.basePrefix);
  nextRules.basePrefixId = entry.id;
  nextRules.basePrefix = entry.value;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(nextRules));
}

function collectAiSettings() {
  return {
    provider: els.aiProvider.value || "openai",
    apiFormat: els.aiApiFormat.value || "responses",
    baseUrl: normalizeBaseUrl(els.aiBaseUrl.value) || "https://api.openai.com/v1",
    apiKey: els.openaiApiKey.value.trim(),
    model: els.openaiModel.value.trim() || "gpt-4.1-mini",
    providerNote: els.aiProviderNote.value.trim(),
  };
}

function loadAiSettings() {
  try {
    return normalizeAiSettings(JSON.parse(localStorage.getItem(AI_SETTINGS_KEY)) || {});
  } catch {
    return normalizeAiSettings();
  }
}

function saveAiSettings(nextSettings) {
  const storedSettings = window.NgrDesktopBridge?.isDesktopRuntime()
    ? { ...nextSettings, apiKey: "" }
    : nextSettings;
  localStorage.setItem(AI_SETTINGS_KEY, JSON.stringify(storedSettings));
  if (window.NgrDesktopBridge?.isDesktopRuntime()) queueDesktopCredentialSave();
}

function collectTranslationSettings() {
  return normalizeTranslationSettings({
    provider: els.translatorProvider.value || "local",
    baiduAppId: els.baiduTranslateAppId.value.trim(),
    baiduSecret: els.baiduTranslateSecret.value.trim(),
    baiduEndpoint: normalizeTranslateEndpoint(els.baiduTranslateEndpoint.value),
    textBaseUrl: normalizeBaseUrl(els.textTranslateBaseUrl.value),
    textApiKey: els.textTranslateApiKey.value.trim(),
    textModel: els.textTranslateModel.value.trim(),
  });
}

function fillTranslationSettings() {
  els.translatorProvider.value = translationSettings.provider;
  els.baiduTranslateAppId.value = translationSettings.baiduAppId;
  els.baiduTranslateSecret.value = translationSettings.baiduSecret;
  els.baiduTranslateEndpoint.value = translationSettings.baiduEndpoint;
  els.textTranslateBaseUrl.value = translationSettings.textBaseUrl;
  els.textTranslateApiKey.value = translationSettings.textApiKey;
  els.textTranslateModel.value = translationSettings.textModel;
  if (typeof syncTranslatorProviderFields === "function") syncTranslatorProviderFields();
}

function loadTranslationSettings() {
  try {
    const savedConfig = JSON.parse(localStorage.getItem(TRANSLATION_SETTINGS_KEY)) || {};
    return normalizeTranslationSettings(savedConfig);
  } catch {
    return normalizeTranslationSettings();
  }
}

function saveTranslationSettings(nextSettings) {
  const storedSettings = window.NgrDesktopBridge?.isDesktopRuntime()
    ? { ...nextSettings, baiduAppId: "", baiduSecret: "", textApiKey: "" }
    : nextSettings;
  localStorage.setItem(TRANSLATION_SETTINGS_KEY, JSON.stringify(storedSettings));
  if (window.NgrDesktopBridge?.isDesktopRuntime()) queueDesktopCredentialSave();
}

function loadMeaningCache() {
  try {
    const saved = JSON.parse(localStorage.getItem(MEANING_CACHE_KEY));
    return saved && typeof saved === "object" ? saved : {};
  } catch {
    return {};
  }
}

function saveMeaningCache() {
  localStorage.setItem(MEANING_CACHE_KEY, JSON.stringify(meaningCache || {}));
}

function normalizeTranslationSettings(nextSettings = {}) {
  nextSettings = nextSettings || {};
  const provider = ["local", "baidu", "model"].includes(nextSettings.provider) ? nextSettings.provider : "local";
  return {
    provider,
    baiduAppId: nextSettings.baiduAppId || "",
    baiduSecret: nextSettings.baiduSecret || "",
    baiduEndpoint: normalizeTranslateEndpoint(nextSettings.baiduEndpoint || "https://fanyi-api.baidu.com/api/trans/vip/translate"),
    textBaseUrl: normalizeBaseUrl(nextSettings.textBaseUrl || "https://api.openai.com/v1"),
    textApiKey: nextSettings.textApiKey || "",
    textModel: nextSettings.textModel || "gpt-4.1-mini",
  };
}

function normalizeTranslateEndpoint(value) {
  return String(value || "").trim().replace(/\/+$/, "") || "https://fanyi-api.baidu.com/api/trans/vip/translate";
}

function normalizeAiSettings(nextSettings = {}) {
  return {
    provider: nextSettings.provider || "openai",
    apiFormat: nextSettings.apiFormat || "responses",
    baseUrl: normalizeBaseUrl(nextSettings.baseUrl || "https://api.openai.com/v1"),
    apiKey: nextSettings.apiKey || "",
    model: nextSettings.model || "gpt-4.1-mini",
    providerNote: nextSettings.providerNote || "",
  };
}

function loadSchemes() {
  try {
    const saved = JSON.parse(localStorage.getItem(SCHEME_KEY));
    if (Array.isArray(saved) && saved.length) return ensureBuiltinSchemes(saved.map((scheme) => normalizeLoadedRules(scheme)));
  } catch {
    // Ignore invalid local scheme data and rebuild with the default scheme.
  }
  return ensureBuiltinSchemes([normalizeLoadedRules({ ...defaultRules })]);
}

function saveSchemes(nextSchemes) {
  localStorage.setItem(SCHEME_KEY, JSON.stringify(nextSchemes));
}

function loadProjects() {
  try {
    const saved = JSON.parse(localStorage.getItem(PROJECTS_KEY));
    if (Array.isArray(saved) && saved.length) {
      const savedProjects = normalizeProjects(saved);
      return savedProjects.length ? savedProjects : normalizeProjects(buildBuiltinProjects());
    }
  } catch {
    // Rebuild projects below.
  }
  return normalizeProjects(buildBuiltinProjects());
}

function getDefaultDetectionProfiles() {
  return [
    {
      id: "ngr-detection",
      name: "NGR",
      mode: "ngr",
      maxSide: 1024,
      backgroundWidth: 3440,
      backgroundHeight: 1440,
      largeThreshold: 512,
      largeMultiple: 4,
      atlasMultiple: 2,
      duplicateSensitivity: "off",
      duplicateSensitivityMigrated: true,
    },
    {
      id: "more-detection",
      name: "更多项目组正在开发中",
      mode: "ngr",
      maxSide: 1024,
      backgroundWidth: 3440,
      backgroundHeight: 1440,
      largeThreshold: 512,
      largeMultiple: 4,
      atlasMultiple: 2,
      duplicateSensitivity: "off",
      duplicateSensitivityMigrated: true,
    },
  ];
}

function loadDetectionProfiles() {
  try {
    const saved = JSON.parse(localStorage.getItem(DETECTION_PROFILES_KEY));
    if (Array.isArray(saved) && saved.length) return ensureDefaultDetectionProfiles(saved.map(normalizeDetectionProfile));
  } catch {
    // Rebuild below.
  }
  return getDefaultDetectionProfiles().map(normalizeDetectionProfile);
}

function ensureDefaultDetectionProfiles(nextProfiles) {
  const profiles = nextProfiles.map((profile) => {
    if (profile.id === "ngr-detection" || profile.name === "NGR切图检测规范") {
      const shouldMigrateDuplicateDefault = !profile.duplicateSensitivityMigrated && (!profile.duplicateSensitivity || profile.duplicateSensitivity === "low");
      return {
        ...profile,
        id: "ngr-detection",
        name: "NGR",
        duplicateSensitivity: shouldMigrateDuplicateDefault ? "off" : profile.duplicateSensitivity,
        duplicateSensitivityMigrated: true,
      };
    }
    return profile;
  });
  getDefaultDetectionProfiles().forEach((defaultProfile) => {
    if (!profiles.some((profile) => profile.id === defaultProfile.id)) profiles.push(normalizeDetectionProfile(defaultProfile));
  });
  return profiles;
}

function loadActiveDetectionProfileId(nextProfiles) {
  const saved = localStorage.getItem(ACTIVE_DETECTION_PROFILE_KEY);
  if (saved && nextProfiles.some((profile) => profile.id === saved)) return saved;
  return nextProfiles[0].id;
}

function normalizeDetectionProfile(profile = {}) {
  const defaults = getDefaultDetectionProfiles()[0];
  return {
    id: profile.id || "detect-" + Date.now() + "-" + Math.random().toString(16).slice(2),
    name: String(profile.name || defaults.name).trim() || defaults.name,
    mode: ["ngr", "planner", "icon"].includes(profile.mode) ? profile.mode : defaults.mode,
    duplicateSensitivity: ["off", "low", "medium", "high"].includes(profile.duplicateSensitivity) ? profile.duplicateSensitivity : defaults.duplicateSensitivity,
    duplicateSensitivityMigrated: profile.duplicateSensitivityMigrated === true,
    maxSide: toPositiveInt(profile.maxSide, defaults.maxSide),
    backgroundWidth: toPositiveInt(profile.backgroundWidth, defaults.backgroundWidth),
    backgroundHeight: toPositiveInt(profile.backgroundHeight, defaults.backgroundHeight),
    largeThreshold: toPositiveInt(profile.largeThreshold, defaults.largeThreshold),
    largeMultiple: toPositiveInt(profile.largeMultiple, defaults.largeMultiple),
    atlasMultiple: toPositiveInt(profile.atlasMultiple, defaults.atlasMultiple),
  };
}

function toPositiveInt(value, fallback) {
  const number = Number.parseInt(value, 10);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function getActiveDetectionProfile() {
  return detectionProfiles.find((profile) => profile.id === activeDetectionProfileId) || detectionProfiles[0];
}

function saveDetectionProfiles() {
  localStorage.setItem(DETECTION_PROFILES_KEY, JSON.stringify(detectionProfiles));
  localStorage.setItem(ACTIVE_DETECTION_PROFILE_KEY, activeDetectionProfileId);
}

function normalizeProjects(nextProjects) {
  return nextProjects
    .filter((project) => project && project.id !== "default" && project.name !== "默认项目")
    .map((project, index) => {
      const schemesForProject = normalizeProjectSchemes(project.name, (project.schemes || []).map((scheme) => normalizeLoadedRules(scheme)));
      const activeSchemeName = schemesForProject.some((scheme) => scheme.schemeName === project.activeSchemeName) ? project.activeSchemeName : schemesForProject[0].schemeName;
      return enrichProjectWithTraining({
        id: project.id || "project-" + index + "-" + Date.now(),
        name: project.name || "未命名项目",
        description: project.description || "",
        activeSchemeName,
        trainingVersion: project.trainingVersion || 0,
        schemes: schemesForProject,
      });
    });
}

function enrichProjectWithTraining(project) {
  if (isYyslsProject(project)) return enrichYyslsProject(project);
  if (!isNgrProject(project)) return project;
  if (project.trainingVersion >= NGR_TRAINING_VERSION && isExactNgrTemplateProject(project)) return project;
  const activeSchemeName = ngrTemplateSchemeNames.includes(project.activeSchemeName) ? project.activeSchemeName : "NGR图集命名规范";
  return {
    ...project,
    activeSchemeName,
    trainingVersion: NGR_TRAINING_VERSION,
    schemes: getNgrTemplateSchemes(),
  };
}

function isNgrProject(project) {
  return project.id === "ngr" || /NGR/i.test(project.name || "");
}

function isYyslsProject(project) {
  return project.id === "yysls" || /yysls|燕云|十六声/i.test(project.name || "");
}

function enrichYyslsProject(project) {
  if (project.trainingVersion >= YYSLS_TRAINING_VERSION) return project;
  return {
    ...project,
    trainingVersion: YYSLS_TRAINING_VERSION,
    schemes: project.schemes.map(enrichSchemeWithYyslsTraining),
  };
}

function isExactNgrTemplateProject(project) {
  const schemeNames = (project.schemes || []).map((scheme) => scheme.schemeName);
  return schemeNames.length === ngrTemplateSchemeNames.length && ngrTemplateSchemeNames.every((name) => schemeNames.includes(name));
}

function getNgrTemplateSchemes() {
  return ngrTemplateSchemes.map((scheme) => normalizeLoadedRules({ ...scheme }));
}

function enrichSchemeWithNgrTraining(scheme) {
  return normalizeLoadedRules({
    ...scheme,
    tags: mergeListText(scheme.tags, "Line, Bar, ProgressBar, Frame, Mask, Light, Pattern, Tab, Card, Selected, Forbidden, Lock, Unlock"),
    pageTerms: removeLineText(scheme.pageTerms, ngrTrainingKnowledge.projectTerms.join("\n")),
    componentTerms: mergeLineText(scheme.componentTerms, ngrTrainingKnowledge.componentTerms),
    stateTerms: mergeLineText(scheme.stateTerms, ngrTrainingKnowledge.stateTerms),
    filenameRules: removeRuleText(mergeRuleText(scheme.filenameRules, ngrTrainingKnowledge.filenameRules), ngrTrainingKnowledge.projectTerms.join("\n")),
    contextDocs: mergeContextText(scheme.contextDocs, ngrTrainingKnowledge.contextDocs),
  });
}

function enrichSchemeWithYyslsTraining(scheme) {
  return normalizeLoadedRules({
    ...scheme,
    tags: mergeListText(scheme.tags, yyslsTrainingKnowledge.tags),
    pageTerms: mergeLineText(scheme.pageTerms, yyslsTrainingKnowledge.pageTerms),
    componentTerms: mergeLineText(scheme.componentTerms, yyslsTrainingKnowledge.componentTerms),
    stateTerms: mergeLineText(scheme.stateTerms, yyslsTrainingKnowledge.stateTerms),
    filenameRules: mergeRuleText(scheme.filenameRules, yyslsTrainingKnowledge.filenameRules),
    contextDocs: mergeContextText(scheme.contextDocs, yyslsTrainingKnowledge.contextDocs),
  });
}

function mergeLineText(currentText, incomingText) {
  const lines = [];
  const seen = new Set();
  String(currentText || "")
    .split(/\n/)
    .concat(String(incomingText || "").split(/\n/))
    .map((line) => line.trim())
    .filter(Boolean)
    .forEach((line) => {
      const key = line.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      lines.push(line);
    });
  return lines.join("\n");
}

function mergeListText(currentText, incomingText) {
  const items = [];
  const seen = new Set();
  String(currentText || "")
    .split(/[\n,，、]/)
    .concat(String(incomingText || "").split(/[\n,，、]/))
    .map((item) => item.trim())
    .filter(Boolean)
    .forEach((item) => {
      const key = item.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      items.push(item);
    });
  return items.join(", ");
}

function removeLineText(currentText, removeText) {
  const blocked = new Set(String(removeText || "").split(/\n/).map((line) => line.trim().toLowerCase()).filter(Boolean));
  return String(currentText || "")
    .split(/\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !blocked.has(line.toLowerCase()))
    .join("\n");
}

function removeRuleText(currentText, removeText) {
  const blocked = new Set(String(removeText || "").split(/\n/).map((line) => line.trim().toLowerCase()).filter(Boolean));
  return String(currentText || "")
    .split(/\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !blocked.has(line.split("=")[0].trim().toLowerCase()))
    .join("\n");
}

function mergeContextText(currentText, incomingText) {
  const current = String(currentText || "").trim();
  const incoming = String(incomingText || "").trim();
  if (!current) return incoming;
  if (current.includes("命名结构固定为：T_UI_用户填写工程名_AI生成语义名")) return current;
  return current + "\n\n" + incoming;
}

function normalizeProjectSchemes(projectName, nextSchemes) {
  const defaultProjectName = getDefaultProjectName(projectName);
  const projectSchemes = nextSchemes.length ? nextSchemes : [normalizeLoadedRules({ ...defaultRules, projectName: defaultProjectName })];
  return projectSchemes.map((scheme) => ({
    ...scheme,
    projectName: scheme.projectName === defaultRules.projectName ? defaultProjectName : scheme.projectName,
  }));
}

function getDefaultProjectName(projectName) {
  if (projectName.includes("NGR")) return "NGR";
  if (projectName.includes("yysls")) return "yysls";
  if (projectName.includes("更多")) return "More";
  return sanitizeName(projectName) || defaultRules.projectName;
}

function buildBuiltinProjects() {
  return [
    {
      id: "ngr",
      name: "NGR",
      description: "NGR 项目",
      activeSchemeName: "NGR图集命名规范",
      trainingVersion: NGR_TRAINING_VERSION,
      schemes: getNgrTemplateSchemes(),
    },
    {
      id: "yysls",
      name: "yysls",
      description: "yysls 项目",
      activeSchemeName: "yysls命名规范",
      trainingVersion: YYSLS_TRAINING_VERSION,
      schemes: [
        builtinSchemes[1],
        { ...builtinSchemes[1], schemeName: "yysls拼音混合规范", contextDocs: builtinSchemes[1].contextDocs + "\n优先保留历史拼音词，例如 nielian、jianbian、huawen、zhuangshi、xuanze、yulan。" },
        { ...builtinSchemes[1], schemeName: "yysls通用UI规范", contextDocs: builtinSchemes[1].contextDocs + "\n适合通用 UI 切图，仍需保持全小写 snake_case 和短词/拼音习惯。" },
      ],
    },
    {
      id: "more",
      name: "更多项目正在持续开发中",
      description: "更多项目正在持续开发中",
      activeSchemeName: "更多项目正在持续开发中",
      schemes: [builtinSchemes[2]],
    },
  ];
}

function loadActiveProjectId(nextProjects) {
  const saved = localStorage.getItem(ACTIVE_PROJECT_KEY);
  if (saved && saved !== "default" && nextProjects.some((project) => project.id === saved)) return saved;
  const ngrProject = nextProjects.find((project) => project.id === "ngr" || project.name === "NGR");
  return ngrProject ? ngrProject.id : nextProjects[0].id;
}

function getActiveProject() {
  return projects.find((project) => project.id === activeProjectId) || projects[0];
}

function getProjectActiveScheme(project) {
  return project.schemes.find((scheme) => scheme.schemeName === project.activeSchemeName) || project.schemes[0] || normalizeLoadedRules({ ...defaultRules });
}

function saveProjects() {
  const project = getActiveProject();
  project.schemes = schemes;
  project.activeSchemeName = rules.schemeName;
  localStorage.setItem(PROJECTS_KEY, JSON.stringify(projects));
  localStorage.setItem(ACTIVE_PROJECT_KEY, activeProjectId);
}

function ensureBuiltinSchemes(nextSchemes) {
  const merged = [...nextSchemes];
  builtinSchemes.forEach((scheme) => {
    if (!merged.some((item) => item.schemeName === scheme.schemeName)) {
      merged.push(normalizeLoadedRules(scheme));
    }
  });
  return merged;
}

function upsertScheme(nextRules, shouldSave = true) {
  const clean = normalizeLoadedRules({
    ...defaultRules,
    ...nextRules,
    schemeName: nextRules.schemeName || defaultRules.schemeName,
  });
  const index = schemes.findIndex((scheme) => scheme.schemeName === clean.schemeName);
  if (index >= 0) {
    schemes[index] = clean;
  } else {
    schemes.push(clean);
  }
  schemes.sort((a, b) => a.schemeName.localeCompare(b.schemeName, "zh-Hans-CN"));
  const project = getActiveProject();
  project.schemes = schemes;
  project.activeSchemeName = clean.schemeName;
  if (shouldSave) saveProjects();
}

function normalizeLoadedRules(nextRules) {
  const merged = { ...defaultRules, ...nextRules };
  const prefixEntry = getPrefixEntryForValue(merged.basePrefixId || merged.basePrefix);
  merged.basePrefixId = prefixEntry.id;
  merged.basePrefix = prefixEntry.value;
  merged.filenameRules = mergeRuleText(defaultRules.filenameRules, merged.filenameRules);
  merged.filenameRules = enforceNamingRuleAliases(merged.filenameRules);
  return merged;
}

function enforceNamingRuleAliases(ruleText) {
  const overrides = {
    bg: "BG",
    background: "BG",
    backgrounds: "BG",
    reward: "Rewards",
    rewards: "Rewards",
    gloryreward: "GloryRewards",
    gloryrewards: "GloryRewards",
    "底": "BG",
    "背景图": "BG",
  };
  return String(ruleText || "")
    .split("\n")
    .map((line) => {
      const parts = line.split("=");
      const keyword = parts[0]?.trim();
      if (!keyword) return "";
      const key = keyword.toLowerCase();
      const value = overrides[key] || overrides[keyword] || parts.slice(1).join("=").trim() || keyword;
      return keyword + "=" + value;
    })
    .filter(Boolean)
    .join("\n");
}

function mergeRuleText(defaultText, savedText) {
  const savedLines = String(savedText || "").split("\n").filter(Boolean);
  const savedKeys = new Set(savedLines.map((line) => line.split("=")[0].trim().toLowerCase()));
  const missingDefaults = String(defaultText || "")
    .split("\n")
    .filter(Boolean)
    .filter((line) => !savedKeys.has(line.split("=")[0].trim().toLowerCase()));
  return [...savedLines, ...missingDefaults].join("\n");
}
