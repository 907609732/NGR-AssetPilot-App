/* NGR AssetPilot V2.25 module: ai-workflow.js */
async function runNaming() {
  return runNamingWorkflow({ useAi: true });
}

async function runLocalNaming() {
  return runNamingWorkflow({ useAi: false, useExternalTranslation: false });
}

async function runTranslateNaming() {
  return runNamingWorkflow({ useAi: false, useExternalTranslation: true });
}

async function runSelectedNaming() {
  const mode = els.namingModeSelect.value || "translate";
  if (mode === "ai") return runNaming();
  if (mode === "local") return runLocalNaming();
  return runTranslateNaming();
}

function updateNamingRunButton() {
  const labels = {
    translate: "运行百度翻译API命名",
    local: "运行本地知识库命名",
    ai: "运行AI视觉命名",
  };
  els.runSelectedNaming.textContent = labels[els.namingModeSelect.value] || labels.translate;
}

async function runNamingWorkflow({ useAi, useExternalTranslation = false }) {
  if (!assets.length) {
    showToast("请先上传切图文件");
    return;
  }
  const apiKey = aiSettings.apiKey.trim();
  const shouldUseAi = useAi && Boolean(apiKey);
  const shouldUseExternalTranslation = !shouldUseAi && useExternalTranslation && translationSettings.provider !== "local";
  const knowledge = parseKnowledge();
  const progressLabel = shouldUseAi ? "AI 命名中 " : shouldUseExternalTranslation ? "翻译命名中 " : "本地命名中 ";
  const progressStep = shouldUseAi ? 1 : shouldUseExternalTranslation ? 10 : 250;
  if (useExternalTranslation && translationSettings.provider === "local") {
    showToast("当前翻译方式为本地词库，将按离线本地知识库命名");
  }
  stopRequested = false;
  assets.forEach((asset) => {
    asset.namingStatus = "pending";
    asset.statusMessage = "";
  });
  setRunButtonLoading(true, progressLabel + "0/" + assets.length);
  renderAssetList();
  await yieldToBrowser();

  if (shouldUseExternalTranslation) {
    const processedAssets = await runExternalTranslationNamingQueue(assets, knowledge, progressLabel);
    namingController = null;
    applySemanticSequenceNumbers(processedAssets);
    setRunButtonLoading(false);
    saveCurrentNamingSession();
    renderAssetList();
    showToast(stopRequested ? "已终止命名" : "已使用翻译 API 生成推荐名称");
    return;
  }

  const processedAssets = [];
  for (let index = 0; index < assets.length; index += 1) {
    if (stopRequested) break;
    const asset = assets[index];
    const localRecommendations = shouldUseAi ? makeRecommendations(asset, knowledge) : await makeRecommendationsWithTranslation(asset, knowledge, { allowExternal: shouldUseExternalTranslation });
    let recommendations = localRecommendations;
    asset.namingStatus = "running";
    asset.statusMessage = "正在处理第 " + (index + 1) + " 张";
    setRunButtonLoading(true, progressLabel + index + "/" + assets.length);
    if (shouldUseAi || index % progressStep === 0) {
      renderAssetList();
      await yieldToBrowser();
    }

    try {
      if (shouldUseAi) {
        namingController = new AbortController();
        recommendations = await requestAiRecommendations(asset, localRecommendations, namingController.signal);
      }
      asset.recommendations = recommendations.length ? recommendations : localRecommendations;
      asset.finalBaseName = asset.finalBaseName || asset.recommendations[0];
      asset.namingStatus = "done";
      asset.statusMessage = shouldUseAi ? "AI 命名完成" : shouldUseExternalTranslation ? "翻译 API 命名完成" : "本地知识库完成";
      processedAssets.push(asset);
    } catch (error) {
      if (stopRequested || error.name === "AbortError") {
        asset.namingStatus = "pending";
        asset.statusMessage = "已终止，未完成命名";
        break;
      }
      asset.recommendations = localRecommendations;
      asset.finalBaseName = asset.finalBaseName || localRecommendations[0];
      asset.namingStatus = "failed";
      asset.statusMessage = shouldUseAi ? "AI 失败，已使用本地推荐" : "翻译 API 失败，已使用本地推荐";
      processedAssets.push(asset);
    }
    setRunButtonLoading(true, progressLabel + (index + 1) + "/" + assets.length);
    if (shouldUseAi || (index + 1) % progressStep === 0 || index === assets.length - 1) {
      renderAssetList();
      await yieldToBrowser();
    }
  }

  namingController = null;
  applySemanticSequenceNumbers(processedAssets);
  setRunButtonLoading(false);
  saveCurrentNamingSession();
  renderAssetList();
  showToast(stopRequested ? "已终止命名" : shouldUseAi ? "AI 推荐命名已完成" : shouldUseExternalTranslation ? "已使用翻译 API 生成推荐名称" : "已使用本地知识库生成推荐名称");
}

async function runExternalTranslationNamingQueue(targetAssets, knowledge, progressLabel) {
  const processedAssets = [];
  let nextIndex = 0;
  let completed = 0;
  const workerCount = Math.min(BAIDU_NAMING_CONCURRENCY, targetAssets.length);
  const runWorker = async () => {
    while (!stopRequested) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= targetAssets.length) return;
      const asset = targetAssets[index];
      asset.namingStatus = "running";
      asset.statusMessage = "正在处理第 " + (index + 1) + " 张";
      try {
        const recommendations = await makeRecommendationsWithTranslation(asset, knowledge, { allowExternal: true });
        asset.recommendations = recommendations.length ? recommendations : makeRecommendations(asset, knowledge);
        asset.finalBaseName = asset.finalBaseName || asset.recommendations[0];
        asset.namingStatus = "done";
        asset.statusMessage = "翻译 API 命名完成";
      } catch {
        const fallback = makeRecommendations(asset, knowledge);
        asset.recommendations = fallback;
        asset.finalBaseName = asset.finalBaseName || fallback[0];
        asset.namingStatus = "failed";
        asset.statusMessage = "翻译 API 失败，已使用本地推荐";
      }
      processedAssets.push(asset);
      completed += 1;
      setRunButtonLoading(true, progressLabel + completed + "/" + targetAssets.length);
      if (completed % 10 === 0 || completed === targetAssets.length) {
        renderAssetList();
        await yieldToBrowser();
      }
    }
  };
  await Promise.all(Array.from({ length: workerCount }, runWorker));
  return processedAssets;
}

function yieldToBrowser() {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

function setRunButtonLoading(isLoading, label = "") {
  els.namingModeSelect.disabled = isLoading;
  els.runSelectedNaming.disabled = isLoading;
  if (isLoading) els.runSelectedNaming.textContent = label;
  else updateNamingRunButton();
  els.stopNaming.disabled = false;
  els.stopNaming.textContent = "终止命名";
  els.stopNaming.classList.toggle("hidden", !isLoading);
}

function stopNaming() {
  stopRequested = true;
  if (namingController) namingController.abort();
  els.stopNaming.disabled = true;
  els.stopNaming.textContent = "终止中";
  showToast("正在终止命名");
}

async function requestAiRecommendations(asset, localRecommendations, signal) {
  const cutImageUrl = await imageFileToDataUrl(asset.file, 768);
  const referenceImageUrl = referenceFile && isRasterImage(referenceFile) ? await imageFileToDataUrl(referenceFile, 960) : "";
  const prompt = buildAiPrompt(asset, localRecommendations);
  const apiFormat = aiSettings.apiFormat || "responses";
  const response = await ngrFetch(buildAiEndpoint(apiFormat), {
    service: "ai",
    method: "POST",
    signal,
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + aiSettings.apiKey.trim(),
    },
    body: JSON.stringify(apiFormat === "chat" ? buildChatPayload(prompt, cutImageUrl, referenceImageUrl) : buildResponsesPayload(prompt, cutImageUrl, referenceImageUrl)),
  });

  if (!response.ok) {
    throw new Error("AI request failed");
  }
  const data = await response.json();
  const text = extractResponseText(data);
  return normalizeAiNames(parseAiNames(text), localRecommendations);
}

function buildResponsesPayload(prompt, cutImageUrl, referenceImageUrl) {
  const content = [
    {
      type: "input_text",
      text: prompt,
    },
    {
      type: "input_image",
      image_url: cutImageUrl,
      detail: "low",
    },
  ];
  if (referenceImageUrl) {
    content.push({
      type: "input_image",
      image_url: referenceImageUrl,
      detail: "low",
    });
  }
  return {
    model: aiSettings.model.trim() || "gpt-4.1-mini",
    input: [
      {
        role: "user",
        content,
      },
    ],
  };
}

function buildChatPayload(prompt, cutImageUrl, referenceImageUrl) {
  const content = [
    {
      type: "text",
      text: prompt,
    },
    {
      type: "image_url",
      image_url: { url: cutImageUrl, detail: "low" },
    },
  ];
  if (referenceImageUrl) {
    content.push({
      type: "image_url",
      image_url: { url: referenceImageUrl, detail: "low" },
    });
  }
  return {
    model: aiSettings.model.trim() || "gpt-4.1-mini",
    messages: [
      {
        role: "user",
        content,
      },
    ],
  };
}

function buildAiEndpoint(apiFormat) {
  const baseUrl = normalizeBaseUrl(aiSettings.baseUrl || "https://api.openai.com/v1");
  if (/\/(responses|chat\/completions)$/i.test(baseUrl)) return baseUrl;
  return baseUrl + (apiFormat === "chat" ? "/chat/completions" : "/responses");
}

function normalizeBaseUrl(value) {
  return String(value || "").trim().replace(/\/+$/, "");
}

function applyProviderPreset() {
  const provider = els.aiProvider.value;
  if (provider === "openai") {
    els.aiBaseUrl.value = "https://api.openai.com/v1";
    els.aiApiFormat.value = "responses";
    if (!els.openaiModel.value.trim()) els.openaiModel.value = "gpt-4.1-mini";
    return;
  }
  if (provider === "compatible") {
    els.aiApiFormat.value = "chat";
    if (!els.aiBaseUrl.value.trim() || els.aiBaseUrl.value.includes("api.openai.com")) els.aiBaseUrl.value = "https://你的模型服务地址/v1";
    return;
  }
  if (provider === "kimi") {
    els.aiBaseUrl.value = "https://api.moonshot.cn/v1";
    els.aiApiFormat.value = "chat";
    els.openaiModel.value = "moonshot-v1-8k-vision-preview";
    els.aiProviderNote.value = "Kimi / Moonshot 视觉模型";
  }
}

async function testAiSettings() {
  aiSettings = collectAiSettings();
  saveAiSettings(aiSettings);
  if (!aiSettings.apiKey) {
    showToast("请先填写 API Key");
    return;
  }
  els.testAiSettings.disabled = true;
  els.testAiSettings.textContent = "测试中";
  try {
    const endpoint = buildAiEndpoint(aiSettings.apiFormat || "responses");
    const response = await ngrFetch(endpoint, {
      service: "ai",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + aiSettings.apiKey,
      },
      body: JSON.stringify(buildAiTestPayload()),
    });
    showToast(response.ok ? "API 测试通过，配置已保存" : "API 测试失败，请检查地址、Key 和模型");
  } catch {
    showToast("API 测试失败，请检查网络或接口地址");
  } finally {
    els.testAiSettings.disabled = false;
    els.testAiSettings.textContent = "测试 API";
  }
}

function exportAiSettings() {
  aiSettings = collectAiSettings();
  saveAiSettings(aiSettings);
  const payload = {
    type: "NGR_AI_API_CONFIG",
    version: 1,
    exportedAt: new Date().toISOString(),
    settings: aiSettings,
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "ngr-ai-api-config.json";
  link.click();
  URL.revokeObjectURL(url);
  showToast("API 配置已导出，请妥善保管文件中的 API Key");
}

async function importAiSettings(event) {
  const file = event.target.files?.[0];
  event.target.value = "";
  if (!file) return;
  try {
    const payload = JSON.parse(await file.text());
    const importedSettings = payload.settings || payload;
    aiSettings = normalizeAiSettings(importedSettings);
    saveAiSettings(aiSettings);
    fillAiSettings();
    showToast("API 配置已导入并保存");
  } catch {
    showToast("API 配置导入失败，请确认文件是 JSON 配置");
  }
}

function buildAiTestPayload() {
  const prompt = "请只返回 JSON：{\"names\":[\"Test_Name\"]}";
  if ((aiSettings.apiFormat || "responses") === "chat") {
    return {
      model: aiSettings.model,
      messages: [
        {
          role: "user",
          content: prompt,
        },
      ],
    };
  }
  return {
    model: aiSettings.model,
    input: prompt,
  };
}

function buildAiPrompt(asset, localRecommendations) {
  return [
    "你是 UI 切图命名助手。请根据切图图片、参考效果图、原始文件名和团队命名知识库，生成 2 到 5 个英文语义名称。",
    "只返回 JSON，格式为：{\"names\":[\"Login_Button_Hover\",\"Home_BG\"]}。",
    "不要包含固定前缀、工程名、文件扩展名。名称只允许英文字母、数字和下划线，使用 Pascal/Title 英文词组并以下划线连接。",
    "禁止把图片分辨率或尺寸写进命名，例如 292x292、256X128、1024_512、w292_h292 都不能出现。",
    "只有同语义相似图片排序时，才允许在末尾使用 01、02、03、04 这类两位序号。",
    "命名单词禁止出现 Module 或 Modules；如果需要表达通用元素，请使用 Item、Panel、Card、Icon、BG 等更具体词。",
    "命名单词禁止出现 Background；凡是背景、底图、底、background、Background，都必须使用短词 BG。",
    "原始文件名：" + asset.originalBase + asset.extension,
    "当前前缀：" + buildAssetPrefix(asset),
    "本地候选：" + localRecommendations.join(", "),
    "页面词库：" + parseList(rules.pageTerms).join(", "),
    "组件词库：" + parseList(rules.componentTerms).join(", "),
    "状态词库：" + parseList(rules.stateTerms).join(", "),
    "文件名匹配规则：" + parseFilenameRules(rules.filenameRules).map((rule) => rule.keyword + "=" + rule.value).join(", "),
    "项目上下文文档：" + (rules.contextDocs || "无"),
    "用户自定义提示文本：" + (rules.aiPromptText || "无"),
  ].join("\n");
}

function extractResponseText(data) {
  if (data.output_text) return data.output_text;
  const chatText = data.choices?.[0]?.message?.content;
  if (Array.isArray(chatText)) return chatText.map((part) => part.text || "").join("\n");
  if (typeof chatText === "string") return chatText;
  return (data.output || [])
    .flatMap((item) => item.content || [])
    .map((part) => part.text || "")
    .join("\n");
}

function parseAiNames(text) {
  const raw = String(text || "").trim();
  try {
    const parsed = JSON.parse(raw.replace(/^```json\s*/i, "").replace(/```$/i, "").trim());
    if (Array.isArray(parsed.names)) return parsed.names;
  } catch {
    // Fall through to line-based parsing.
  }
  return raw
    .split(/[\n,，]/)
    .map((item) => item.replace(/^[-*\d.]+/, "").trim())
    .filter(Boolean);
}

function normalizeAiNames(names, fallback) {
  const normalized = names
    .map((name) => formatNamingName(name))
    .filter(Boolean)
    .filter((name) => /^[A-Za-z0-9_]+$/.test(name));
  return [...new Set(normalized)].slice(0, 5).length ? [...new Set(normalized)].slice(0, 5) : fallback;
}

function applySemanticSequenceNumbers(targetAssets) {
  const groups = new Map();
  targetAssets.forEach((asset) => {
    const base = removeTrailingSequence(asset.recommendations?.[0] || asset.finalBaseName || "");
    if (!base) return;
    const key = base.toLowerCase();
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(asset);
  });
  groups.forEach((group) => {
    if (group.length < 2) return;
    group.forEach((asset, index) => {
      const sequence = formatSequenceNumber(index + 1);
      const firstBase = removeTrailingSequence(asset.recommendations?.[0] || asset.finalBaseName || "");
      const nextFirst = appendPart(firstBase, sequence);
      asset.recommendations = (asset.recommendations || [])
        .map((name) => appendPart(removeTrailingSequence(name), sequence))
        .filter(Boolean);
      if (!asset.recommendations.length) asset.recommendations = [nextFirst];
      asset.finalBaseName = appendPart(removeTrailingSequence(asset.finalBaseName || firstBase), sequence);
    });
  });
}

async function imageFileToDataUrl(file, maxSide) {
  if (!isRasterImage(file)) {
    throw new Error("Unsupported image type for AI");
  }
  const originalUrl = URL.createObjectURL(file);
  try {
    const image = await loadImage(originalUrl);
    const scale = Math.min(1, maxSide / Math.max(image.naturalWidth, image.naturalHeight));
    const width = Math.max(1, Math.round(image.naturalWidth * scale));
    const height = Math.max(1, Math.round(image.naturalHeight * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    context.drawImage(image, 0, 0, width, height);
    return canvas.toDataURL("image/jpeg", 0.82);
  } finally {
    URL.revokeObjectURL(originalUrl);
  }
}

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = reject;
    image.src = url;
  });
}

function isRasterImage(file) {
  return /image\/(png|jpeg|jpg|webp)/i.test(file.type) || /\.(png|jpe?g|webp)$/i.test(file.name);
}
