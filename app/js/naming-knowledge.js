/* NGR AssetPilot V2.26 module: naming-knowledge.js */
let meaningQueue = [];
let meaningQueueActive = 0;

function makeRecommendations(asset, cachedKnowledge, translatedOverride = "") {
  const source = normalizeSourceName(asset.originalBase);
  const knowledge = cachedKnowledge || parseKnowledge();
  const mapped = inferMappedTerms(source, knowledge);
  const tags = parseTags(rules.tags);
  const translatedSource = translatedOverride || translateFilename(source, knowledge);
  const kind = mapped.component || inferKind(asset, source, tags, knowledge.componentTerms);
  const state = mapped.state || inferState(source, knowledge.stateTerms);
  const candidates = [
    compactParts([translatedSource || kind]),
    compactParts([kind, state]),
    compactParts([kind, pickTerm(knowledge.stateTerms, "Normal", tags.includes("Normal") ? "Normal" : "常态")]),
    ...mapped.direct,
  ];
  return [...new Set(candidates.map(removeProjectTermsFromName).map(formatNamingName).filter((name) => name && !containsChinese(name)))].slice(0, 5);
}

async function makeRecommendationsWithTranslation(asset, cachedKnowledge, options = {}) {
  const source = normalizeSourceName(asset.originalBase);
  const knowledge = cachedKnowledge || parseKnowledge();
  const translatedSource = await translateFilenameSmart(source, knowledge, options);
  return makeRecommendations(asset, knowledge, translatedSource);
}

function buildLexiconCategories() {
  const knowledge = parseKnowledge();
  const historicalMatch = getHistoricalModuleMatch();
  const dynamicCategories = [
    { title: "当前组件词库", terms: knowledge.componentTerms },
    { title: "当前状态词库", terms: knowledge.stateTerms },
    { title: "历史高频", terms: getHistoricalCommonTerms() },
  ];
  if (historicalMatch) dynamicCategories.unshift({ title: "当前工程历史", terms: historicalMatch.terms.map((item) => item.word) });
  return [...lexiconCategories, ...dynamicCategories]
    .map((category) => ({
      title: category.title,
      terms: uniqueCleanTerms(category.terms).slice(0, 32),
    }))
    .filter((category) => category.terms.length);
}

function uniqueCleanTerms(terms) {
  const seen = new Set();
  const result = [];
  (Array.isArray(terms) ? terms : parseList(terms)).forEach((term) => {
    const clean = formatNamingName(term);
    if (!clean) return;
    const key = clean.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    result.push(clean);
  });
  return result;
}

function appendLexiconTerm(currentName, term) {
  const cleanTerm = formatNamingName(term);
  if (!cleanTerm) return formatNamingName(currentName);
  const parts = formatNamingName(currentName).split(/_+/).filter(Boolean);
  if (parts.some((part) => part.toLowerCase() === cleanTerm.toLowerCase())) return parts.join("_");
  return [...parts, cleanTerm].join("_");
}

function toggleLexiconTerm(currentName, term) {
  const cleanTerm = formatNamingName(term);
  if (!cleanTerm) return formatNamingName(currentName);
  const parts = formatNamingName(currentName).split(/_+/).filter(Boolean);
  const nextParts = parts.filter((part) => part.toLowerCase() !== cleanTerm.toLowerCase());
  if (nextParts.length !== parts.length) return nextParts.join("_");
  return [...parts, cleanTerm].join("_");
}

function getHistoricalKnowledge() {
  return window.NGR_HISTORICAL_KNOWLEDGE || null;
}

function getHistoricalCommonTerms() {
  return (getHistoricalKnowledge()?.commonTerms || []).slice(0, 80).map((item) => item.word);
}

function normalizeHistoryKey(value) {
  return sanitizeName(value).replace(/UI$/i, "").replace(/[^A-Za-z0-9]/g, "").toLowerCase();
}

function getHistoricalModuleMatch() {
  const knowledge = getHistoricalKnowledge();
  if (!knowledge?.modules) return null;
  const candidates = [
    rules.projectName,
    els.workProjectName?.value,
    getActiveProject()?.name,
  ].map(normalizeHistoryKey).filter(Boolean);
  for (const candidate of candidates) {
    if (knowledge.modules[candidate]) return knowledge.modules[candidate];
  }
  return null;
}

function getDuplicateStatus(asset, context = buildDuplicateStatusContext()) {
  if (!asset.finalBaseName) return { hasIssue: false, kind: "none", message: "待命名" };
  const exportName = buildExportName(asset).toLocaleLowerCase("en-US");
  const duplicateGroup = context.groups?.get(buildExportPathKey(asset)) || [];
  if (duplicateGroup.length > 1) {
    const otherAsset = duplicateGroup.find((item) => item.id !== asset.id) || duplicateGroup[0];
    const otherName = otherAsset ? otherAsset.originalBase + otherAsset.extension : "另一张图片";
    return {
      hasIssue: true,
      kind: "batch",
      count: duplicateGroup.length,
      message: `重复命名：与「${otherName}」等共 ${duplicateGroup.length} 张同名`,
    };
  }
  const historicalMatch = context.historicalMatch;
  if (context.historicalNames?.has(exportName)) {
    return { hasIssue: true, kind: "history", message: "历史重名：" + historicalMatch.name };
  }
  return historicalMatch
    ? { hasIssue: false, kind: "none", message: "未重名 / 已匹配 " + historicalMatch.name }
    : { hasIssue: false, kind: "none", message: "未匹配历史工程" };
}

function inferKind(asset, source, tags, componentTerms = []) {
  const lower = source.toLowerCase();
  const translated = translateTextByDictionary(source).toLowerCase();
  const { width, height } = asset.dimensions;
  if (/bg|background|背景/.test(lower)) return pickTerm(componentTerms, "BG", pickTag(tags, "BG", "背景"));
  if (/btn|button|按钮/.test(lower)) return pickTerm(componentTerms, "Button", pickTag(tags, "Button", "按钮"));
  if (/icon|ico|图标/.test(lower)) return pickTerm(componentTerms, "Icon", pickTag(tags, "Icon", "图标"));
  if (/line|divider|edgeline|线/.test(lower)) return pickTerm(componentTerms, "Line", "Line");
  if (/bar|progress|进度/.test(lower)) return pickTerm(componentTerms, "ProgressBar", "Bar");
  if (/mask|遮罩/.test(lower)) return pickTerm(componentTerms, "Mask", "Mask");
  if (/frame|border|边框/.test(lower)) return pickTerm(componentTerms, "Frame", "Frame");
  if (/light|glow|光/.test(lower)) return pickTerm(componentTerms, "Light", "Light");
  if (/card|卡片|卡带|卡/.test(lower)) return pickTerm(componentTerms, "Card", "Card");
  if (/ornament|deco|装饰品|装饰/.test(lower)) return pickTerm(componentTerms, "Ornament", "Ornament");
  if (/tab/.test(lower)) return pickTerm(componentTerms, "Tab", "Tab");
  if (/logo/.test(lower)) return pickTerm(componentTerms, "Logo", "Logo");
  if (/banner|横幅/.test(lower)) return pickTerm(componentTerms, "Banner", "Banner");
  if (/tab|nav|导航/.test(lower)) return pickTerm(componentTerms, "Nav", "Nav");
  if (/button/.test(translated)) return pickTerm(componentTerms, "Button", pickTag(tags, "Button", "Button"));
  if (/icon/.test(translated)) return pickTerm(componentTerms, "Icon", pickTag(tags, "Icon", "Icon"));
  if (width && height && width > height * 3 && height <= 160) return pickTerm(componentTerms, "Line", "Line");
  if (width && height && height > width * 3 && width <= 160) return pickTerm(componentTerms, "Line", "Line");
  if (width && height && width > height * 2.6) return pickTerm(componentTerms, "Banner", "Banner");
  if (width && height && Math.abs(width - height) < 8 && width <= 160) return pickTerm(componentTerms, "Icon", pickTag(tags, "Icon", "图标"));
  if (width && height && width >= 600 && height >= 300) return pickTerm(componentTerms, "BG", pickTag(tags, "BG", "背景"));
  return pickTerm(componentTerms, "Item", pickTag(tags, "Item", "Item"));
}

function inferPage(source, pageTerms = []) {
  const lower = source.toLowerCase();
  const matched = matchTerm(source, pageTerms);
  if (matched) return matched;
  if (/home|index|首页|主页/.test(lower)) return pickTerm(pageTerms, "Home", "Home");
  if (/login|signin|登录|登陆/.test(lower)) return pickTerm(pageTerms, "Login", "Login");
  if (/user|profile|mine|个人|我的/.test(lower)) return pickTerm(pageTerms, "Profile", "Profile");
  if (/setting|settings|设置/.test(lower)) return pickTerm(pageTerms, "Settings", "Settings");
  return "";
}

function inferState(source, stateTerms = []) {
  const lower = source.toLowerCase();
  const matched = matchTokenTerm(source, stateTerms);
  if (matched) return matched;
  if (/hover|悬浮/.test(lower)) return pickTerm(stateTerms, "Hover", "Hover");
  if (/active|selected|pressed|选中|点击/.test(lower)) return pickTerm(stateTerms, "Active", "Active");
  if (/disabled|disable|禁用|不可用/.test(lower)) return pickTerm(stateTerms, "Disabled", "Disabled");
  if (/normal|default|常态|默认/.test(lower)) return pickTerm(stateTerms, "Normal", "Normal");
  return "";
}

function pickTag(tags, preferred, fallback) {
  return tags.find((tag) => tag.toLowerCase() === preferred.toLowerCase()) || fallback;
}

function pickTerm(terms, preferred, fallback) {
  return terms.find((term) => term.toLowerCase() === String(preferred).toLowerCase()) || fallback;
}

function matchTerm(source, terms) {
  const lower = source.toLowerCase();
  return terms.find((term) => lower.includes(term.toLowerCase())) || "";
}

function matchTokenTerm(source, terms) {
  const tokens = getSourceTokens(source);
  return terms.find((term) => tokens.includes(term.toLowerCase())) || "";
}

function keywordMatchesSource(keyword, source, lowerSource = source.toLowerCase()) {
  const cleanKeyword = String(keyword || "").trim();
  if (!cleanKeyword) return false;
  if (/^[A-Za-z0-9]+$/.test(cleanKeyword)) return getSourceTokens(source).includes(cleanKeyword.toLowerCase());
  return lowerSource.includes(cleanKeyword.toLowerCase());
}

function getSourceTokens(source) {
  return source
    .replace(/([a-z])([A-Z])/g, "$1_$2")
    .split(/_+/)
    .map((token) => token.toLowerCase())
    .filter(Boolean);
}

function parseKnowledge() {
  const cacheKey = [rules.pageTerms, rules.componentTerms, rules.stateTerms, rules.filenameRules].join("\u001f");
  if (knowledgeCacheKey === cacheKey && knowledgeCacheValue) return knowledgeCacheValue;
  knowledgeCacheKey = cacheKey;
  knowledgeCacheValue = {
    pageTerms: parseList(rules.pageTerms),
    componentTerms: parseList(rules.componentTerms),
    stateTerms: parseList(rules.stateTerms),
    filenameRules: parseFilenameRules(rules.filenameRules),
  };
  return knowledgeCacheValue;
}

function inferMappedTerms(source, knowledge) {
  const lower = source.toLowerCase();
  const direct = [];
  let page = "";
  let component = "";
  let state = "";
  knowledge.filenameRules.forEach((rule) => {
    if (!keywordMatchesSource(rule.keyword, source, lower)) return;
    const translatedValue = translateRuleValue(rule.value);
    direct.push(translatedValue);
    if (!page && knowledge.pageTerms.some((term) => sameTerm(term, translatedValue) || sameTerm(term, rule.value))) page = translatedValue;
    if (!component && knowledge.componentTerms.some((term) => sameTerm(term, translatedValue) || sameTerm(term, rule.value))) component = translatedValue;
    if (!state && knowledge.stateTerms.some((term) => sameTerm(term, translatedValue) || sameTerm(term, rule.value))) state = translatedValue;
  });
  return { page, component, state, direct };
}

function translateFilename(source, knowledge, options = {}) {
  const dictionaryName = cleanNamingName(translateTextByDictionary(source, options)
    .replace(/[^A-Za-z0-9_]+/g, "_"));
  if (dictionaryName) return dictionaryName;
  const mappedValues = [];
  const lower = source.toLowerCase();
  knowledge.filenameRules.forEach((rule) => {
    if (keywordMatchesSource(rule.keyword, source, lower)) mappedValues.push(translateRuleValue(rule.value, knowledge));
  });
  if (mappedValues.length) return compactParts([...new Set(mappedValues)]);
  return "";
}

async function translateFilenameSmart(source, knowledge, options = {}) {
  const strictName = translateFilename(source, knowledge, { allowPinyin: false });
  const pinyinName = translateFilename(source, knowledge, { allowPinyin: true });
  if (options.allowExternal === false || !containsChinese(source) || translationSettings.provider === "local" || strictName === pinyinName) {
    return formatNamingName(pinyinName || strictName);
  }
  try {
    const externalName = await translateFilenameByConfiguredProvider(source);
    return formatNamingName(externalName || pinyinName || strictName);
  } catch {
    return formatNamingName(pinyinName || strictName);
  }
}

function translateRuleValue(value) {
  return builtinTranslations[value] || value;
}

function translateTextByDictionary(value, options = {}) {
  const allowPinyin = options.allowPinyin !== false;
  let result = String(value || "");
  Object.entries(builtinTranslations)
    .sort((a, b) => b[0].length - a[0].length)
    .forEach(([zh, en]) => {
      result = result.split(zh).join("_" + en + "_");
    });
  return allowPinyin ? transliterateChineseChunks(result) : result;
}

async function translateFilenameByConfiguredProvider(source) {
  if (translationSettings.provider === "baidu") {
    const apiText = await translateTextByApi(source, "zh", "en");
    return cleanNamingName(String(apiText || "").replace(/([a-z])([A-Z])/g, "$1_$2").replace(/[^A-Za-z0-9_]+/g, "_"));
  }
  if (translationSettings.provider === "model") {
    const apiText = await translateTextByModel(source);
    return cleanNamingName(String(apiText || "").replace(/([a-z])([A-Z])/g, "$1_$2").replace(/[^A-Za-z0-9_]+/g, "_"));
  }
  return "";
}

async function translateTextByApi(text, from, to) {
  if (translationSettings.provider !== "baidu") return "";
  if (!translationSettings.baiduAppId || !translationSettings.baiduSecret) {
    throw new Error("请先填写百度翻译 App ID 和密钥");
  }
  const query = String(text || "").trim();
  if (!query) return "";
  const cacheKey = ["baidu", from, to, query].join("\u001f").toLowerCase();
  if (baiduTextCache.has(cacheKey)) return baiduTextCache.get(cacheKey);
  const request = requestBaiduTranslate(query, from, to).catch((error) => {
    baiduTextCache.delete(cacheKey);
    throw error;
  });
  baiduTextCache.set(cacheKey, request);
  return request;
}

async function requestBaiduTranslate(query, from, to) {
  const salt = String(Date.now());
  const sign = md5(translationSettings.baiduAppId + query + salt + translationSettings.baiduSecret);
  const params = new URLSearchParams({
    q: query,
    from,
    to,
    appid: translationSettings.baiduAppId,
    salt,
    sign,
  });
  let data;
  try {
    const response = await ngrFetch(translationSettings.baiduEndpoint + "?" + params.toString(), { service: "translation" });
    if (!response.ok) throw new Error("接口请求失败：" + response.status);
    data = await response.json();
  } catch (error) {
    data = await translateTextByBaiduJsonp(params);
  }
  if (data.error_code) throw new Error((data.error_code || "") + " " + (data.error_msg || "百度翻译返回错误"));
  return (data.trans_result || []).map((item) => item.dst).join(" ").trim();
}

function translateTextByBaiduJsonp(params) {
  return new Promise((resolve, reject) => {
    const callbackName = "ngrBaiduTranslateCallback_" + Date.now() + "_" + Math.random().toString(16).slice(2);
    const script = document.createElement("script");
    const timeout = window.setTimeout(() => {
      cleanup();
      reject(new Error("百度翻译 JSONP 请求超时，可能需要确认 API 服务是否已开通"));
    }, 10000);
    const cleanup = () => {
      window.clearTimeout(timeout);
      delete window[callbackName];
      script.remove();
    };
    window[callbackName] = (data) => {
      cleanup();
      resolve(data);
    };
    script.onerror = () => {
      cleanup();
      reject(new Error("百度翻译请求失败，可能是网络、签名或接口权限问题"));
    };
    const jsonpParams = new URLSearchParams(params);
    jsonpParams.set("callback", callbackName);
    script.src = translationSettings.baiduEndpoint + "?" + jsonpParams.toString();
    document.body.appendChild(script);
  });
}

async function translateTextByModel(text) {
  if (translationSettings.provider !== "model") return "";
  if (!translationSettings.textApiKey) throw new Error("请先填写文本翻译模型 API Key");
  const endpoint = buildTextModelEndpoint(translationSettings.textBaseUrl);
  const prompt = [
    "你是 UI 切图命名翻译助手。",
    "请把中文文件名翻译成简洁英文 UI 命名词，只返回名称本身。",
    "要求：PascalCase 英文词组，用下划线连接；不要包含文件扩展名、图片尺寸、固定前缀或工程名。",
    "如果背景/底/底图出现，使用 BG；如果中文无法准确翻译，可以使用拼音但仍保持 PascalCase。",
    "用户自定义提示文本：" + (rules.aiPromptText || "无"),
    "原始文件名：" + String(text || "").trim(),
  ].join("\n");
  const response = await ngrFetch(endpoint, {
    service: "ai",
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + translationSettings.textApiKey,
    },
    body: JSON.stringify({
      model: translationSettings.textModel || "gpt-4.1-mini",
      messages: [
        {
          role: "user",
          content: prompt,
        },
      ],
      temperature: 0.2,
    }),
  });
  if (!response.ok) throw new Error("文本模型请求失败：" + response.status);
  const data = await response.json();
  return extractTextModelResponse(data);
}

function buildTextModelEndpoint(baseUrl) {
  const cleanBase = normalizeBaseUrl(baseUrl || "https://api.openai.com/v1");
  return /\/chat\/completions$/i.test(cleanBase) ? cleanBase : cleanBase + "/chat/completions";
}

function extractTextModelResponse(data) {
  const chatText = data.choices?.[0]?.message?.content;
  if (Array.isArray(chatText)) return chatText.map((part) => part.text || "").join("\n").trim();
  if (typeof chatText === "string") return chatText.trim();
  return "";
}

function explainEnglishName(name) {
  const clean = sanitizeName(name);
  if (!clean) return "待填写";
  const dictionary = buildChineseMeaningDictionary();
  const phraseDictionary = buildChinesePhraseDictionary();
  const words = clean
    .replace(/([a-z])([A-Z])/g, "$1_$2")
    .split(/_+/)
    .map((word) => word.trim())
    .filter(Boolean);
  const fullPhrase = phraseDictionary[words.join("_").toLowerCase()];
  if (fullPhrase) return fullPhrase;
  const meanings = [];
  for (let index = 0; index < words.length; index += 1) {
    let matched = "";
    let matchedLength = 0;
    for (let length = Math.min(4, words.length - index); length > 1; length -= 1) {
      const key = words.slice(index, index + length).join("_").toLowerCase();
      if (phraseDictionary[key]) {
        matched = phraseDictionary[key];
        matchedLength = length;
        break;
      }
    }
    if (matched) {
      meanings.push(matched);
      index += matchedLength - 1;
    } else {
      const word = words[index];
      meanings.push(dictionary[word.toLowerCase()] || word);
    }
  }
  return meanings.join(" / ");
}

function getDisplayMeaning(name) {
  const key = getMeaningKey(name);
  if (!key) return "待填写";
  if (meaningCache[key]) return meaningCache[key];
  const localMeaning = explainEnglishName(name);
  scheduleBaiduMeaningTranslation(name, key);
  return localMeaning;
}

function getMeaningKey(name) {
  return cleanNamingName(name).toLowerCase();
}

function scheduleBaiduMeaningTranslation(name, key = getMeaningKey(name)) {
  if (!key || meaningCache[key] || pendingMeaningNames.has(key)) return;
  if (translationSettings.provider !== "baidu" || !translationSettings.baiduAppId || !translationSettings.baiduSecret) return;
  pendingMeaningNames.add(key);
  meaningQueue.push({ name, key });
  runMeaningQueue();
}

function runMeaningQueue() {
  while (meaningQueueActive < 2 && meaningQueue.length) {
    const item = meaningQueue.shift();
    meaningQueueActive += 1;
    translateMeaningItem(item)
      .catch(() => {
        pendingMeaningNames.delete(item.key);
      })
      .finally(() => {
        meaningQueueActive -= 1;
        runMeaningQueue();
      });
  }
}

async function translateMeaningItem(item) {
  const readable = cleanNamingName(item.name).replace(/_/g, " ");
  const translated = await translateTextByApi(readable, "en", "zh");
  if (!translated) {
    pendingMeaningNames.delete(item.key);
    return;
  }
  meaningCache[item.key] = translated;
  saveMeaningCache();
  pendingMeaningNames.delete(item.key);
  updateMeaningElements(item.key, translated);
}

function updateMeaningElements(key, translated) {
  document.querySelectorAll('[data-meaning-key="' + key + '"]').forEach((node) => {
    node.textContent = "中文含义：" + translated;
  });
}

function buildChinesePhraseDictionary() {
  return {
    home_scene_bg: "主页场景底图",
    home_shop_bg: "主页商店底图",
    home_forest_bg: "主页森林底图",
    home_market_bg: "主页市场底图",
    business_record_page_mask: "营业记录页遮罩",
    business_record_page_top_left_control_mask_bg: "营业记录页左上控件遮罩底图",
    business_record_page: "营业记录页",
    record_page_mask: "记录页遮罩",
    page_mask_bottom: "页面底部遮罩",
    top_left: "左上",
    top_right: "右上",
    bottom_left: "左下",
    bottom_right: "右下",
    control_overlay: "控件覆盖层",
    overlay_mask: "覆盖层遮罩",
    travel_journal_title: "外出游历标题",
    travel_journal: "外出游历",
    adventure_note_banner: "冒险记录横幅",
    journey_note_icon: "旅程记录图标",
    white_chrysanthemum_icon: "白菊图标",
    chrysanthemum_white_icon: "白菊图标",
    flower_white_chrysanthemum_icon: "白色菊花图标",
  };
}

function buildChineseMeaningDictionary() {
  const dictionary = {};
  Object.entries(builtinTranslations).forEach(([zh, en]) => {
    dictionary[String(en).toLowerCase()] = zh;
  });
  parseFilenameRules(rules.filenameRules).forEach((rule) => {
    const key = sanitizeName(rule.value).toLowerCase();
    if (key && (!dictionary[key] || /[\u4e00-\u9fa5]/.test(rule.keyword))) dictionary[key] = rule.keyword;
  });
  return {
    ...dictionary,
    bg: dictionary.bg || "背景",
    button: dictionary.button || "按钮",
    icon: dictionary.icon || "图标",
    line: dictionary.line || "线条",
    frame: dictionary.frame || "边框",
    mask: dictionary.mask || "遮罩",
    scene: dictionary.scene || "场景",
    business: dictionary.business || "营业",
    record: dictionary.record || "记录",
    page: dictionary.page || "页面",
    control: dictionary.control || "控件",
    overlay: dictionary.overlay || "覆盖层",
    travel: dictionary.travel || "旅行",
    journal: dictionary.journal || "日志",
    title: dictionary.title || "标题",
    shop: dictionary.shop || "商店",
    forest: dictionary.forest || "森林",
    market: dictionary.market || "市场",
    adventure: dictionary.adventure || "冒险",
    note: dictionary.note || "记录",
    journey: dictionary.journey || "旅程",
    flower: dictionary.flower || "花",
    chrysanthemum: dictionary.chrysanthemum || "菊花",
    card: dictionary.card || "卡片",
    tab: dictionary.tab || "标签",
    panel: dictionary.panel || "面板",
    item: dictionary.item || "通用元素",
    nav: dictionary.nav || "导航",
    cta: "主按钮",
    popup: "弹窗",
    illustration: dictionary.illustration || "插图",
    character: dictionary.character || "角色",
    weapon: dictionary.weapon || "武器",
    rewards: dictionary.rewards || "奖励",
    reward: dictionary.reward || "奖励",
    gift: dictionary.gift || "礼物",
    badge: dictionary.badge || "徽章",
    logo: dictionary.logo || "标识",
    avatar: dictionary.avatar || "头像",
    light: dictionary.light || "光效",
    shadow: dictionary.shadow || "阴影",
    pattern: dictionary.pattern || "纹理",
    ornament: dictionary.ornament || "装饰",
    deco: dictionary.deco || "装饰",
    glow: dictionary.glow || "发光",
    spark: dictionary.spark || "闪光",
    ribbon: dictionary.ribbon || "飘带",
    left: dictionary.left || "左",
    right: dictionary.right || "右",
    top: dictionary.top || "上",
    bottom: dictionary.bottom || "下",
    center: dictionary.center || "中",
    front: dictionary.front || "前",
    back: dictionary.back || "后",
    corner: dictionary.corner || "角",
    red: dictionary.red || "红色",
    blue: dictionary.blue || "蓝色",
    yellow: dictionary.yellow || "黄色",
    green: dictionary.green || "绿色",
    black: dictionary.black || "黑色",
    white: dictionary.white || "白色",
    gold: dictionary.gold || "金色",
    purple: dictionary.purple || "紫色",
    normal: dictionary.normal || "常态",
    hover: dictionary.hover || "悬浮",
    pressed: dictionary.pressed || "按下态",
    selected: dictionary.selected || "选中态",
    unselected: dictionary.unselected || "未选中",
    lock: dictionary.lock || "锁定",
    unlock: dictionary.unlock || "解锁",
    active: dictionary.active || "选中",
    disabled: dictionary.disabled || "禁用",
  };
}

function sameTerm(a, b) {
  return String(a).toLowerCase() === String(b).toLowerCase();
}

function normalizeSourceName(name) {
  return stripProjectTermsFromSource(name
    .replace(/^T_UI_(Img|Icon|Bg|Btn)?_?/i, "")
    .replace(/^T_(Img|Icon|Bg|Btn)_?/i, "")
    .replace(/^(@\d+x|icon-|img-|image-|切图_|切图-)/i, "")
    .replace(/[\s-]+/g, "_")
    .replace(/_{2,}/g, "_")
    .replace(/^_+|_+$/g, ""));
}

function stripProjectTermsFromSource(source) {
  let result = sanitizeName(source);
  const projectTerms = getProjectTerms();
  let changed = true;
  while (changed) {
    changed = false;
    projectTerms.forEach((term) => {
      const cleanTerm = sanitizeName(term);
      if (!cleanTerm) return;
      const pattern = new RegExp("^" + escapeRegExp(cleanTerm) + "(_|$)", "i");
      if (pattern.test(result)) {
        result = result.replace(pattern, "").replace(/^_+/, "");
        changed = true;
      }
    });
  }
  return result;
}

function removeProjectTermsFromName(name) {
  const projectTerms = new Set(getProjectTerms().map((term) => sanitizeName(term).toLowerCase()).filter(Boolean));
  return sanitizeName(name)
    .split(/_+/)
    .filter((part) => !projectTerms.has(part.toLowerCase()))
    .join("_");
}

function getProjectTerms() {
  return [
    "Modules",
    "Module",
    rules.projectName,
    getActiveProject()?.name,
    ...(ngrTrainingKnowledge.projectTerms || []),
  ].filter(Boolean);
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function compactParts(parts) {
  return parts.filter(Boolean).join("_");
}

function sanitizeName(name) {
  return String(name || "")
    .trim()
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/\s+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function cleanNamingName(name) {
  return stripDimensionTokens(sanitizeName(name))
    .split(/_+/)
    .map(normalizeNamingPart)
    .filter((part) => part && !FORBIDDEN_NAMING_TERMS.includes(part.toLowerCase()))
    .join("_");
}

function stripDimensionTokens(name) {
  const parts = sanitizeName(name).split(/_+/).filter(Boolean);
  const nextParts = [];
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    const next = parts[index + 1] || "";
    if (/^\d{2,5}x\d{2,5}$/i.test(part)) continue;
    if (/^w\d{2,5}$/i.test(part) && /^h\d{2,5}$/i.test(next)) {
      index += 1;
      continue;
    }
    if (/^h\d{2,5}$/i.test(part) && /^w\d{2,5}$/i.test(next)) {
      index += 1;
      continue;
    }
    if (isDimensionNumber(part) && isDimensionNumber(next)) {
      index += 1;
      continue;
    }
    nextParts.push(part);
  }
  return nextParts.join("_");
}

function isDimensionNumber(value) {
  return /^\d{2,5}$/.test(value) && Number(value) > 31;
}

function normalizeNamingPart(part) {
  const aliases = {
    bg: "BG",
    background: "BG",
    backgrounds: "BG",
    mainbg: "MainBG",
    panelbg: "PanelBG",
    iconbg: "IconBG",
  };
  const clean = sanitizeName(part);
  return aliases[clean.toLowerCase()] || clean;
}

function shouldUseLowercaseNaming() {
  return isYyslsProject(getActiveProject()) || /yysls|燕云|十六声/i.test(rules.projectName || "");
}

function formatNamingName(name) {
  const clean = cleanNamingName(name);
  if (shouldUseLowercaseNaming()) return clean.toLowerCase();
  return clean.split(/_+/).map(formatNamingPart).filter(Boolean).join("_");
}

function formatNamingPart(part) {
  const clean = sanitizeName(part);
  if (!clean) return "";
  const lower = clean.toLowerCase();
  const acronyms = {
    bg: "BG",
    ui: "UI",
    ngr: "NGR",
    id: "ID",
    npc: "NPC",
    pvp: "PVP",
    pve: "PVE",
    rpg: "RPG",
    hp: "HP",
    mp: "MP",
  };
  if (acronyms[lower]) return acronyms[lower];
  if (/^\d+$/.test(clean)) return clean;
  if (/[A-Z]/.test(clean.slice(1))) return clean.charAt(0).toUpperCase() + clean.slice(1);
  return clean.charAt(0).toUpperCase() + clean.slice(1).toLowerCase();
}

function sanitizePrefix(prefix) {
  return String(prefix || "")
    .trim()
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/\s+/g, "_")
    .replace(/_+/g, "_");
}

function appendPart(base, part) {
  const cleanBase = formatNamingName(base);
  const cleanPart = formatNamingName(part);
  if (!cleanBase) return cleanPart;
  if (!cleanPart || cleanBase.endsWith("_" + cleanPart)) return cleanBase;
  return cleanBase + "_" + cleanPart;
}

function removeTrailingSequence(base) {
  return formatNamingName(base).replace(/_\d{2,4}$/, "");
}

function formatSequenceNumber(value) {
  return String(value).padStart(2, "0");
}

function containsChinese(value) {
  return /[\u4e00-\u9fff]/.test(String(value || ""));
}

function transliterateChineseChunks(value) {
  return String(value || "").replace(/[\u4e00-\u9fff]+/g, (chunk) => "_" + chineseToPinyinPascal(chunk) + "_");
}

function chineseToPinyinPascal(value) {
  return [...String(value || "")]
    .map((char) => COMMON_PINYIN_MAP[char] || "Han")
    .join("");
}

const COMMON_PINYIN_MAP = {
  一: "Yi", 二: "Er", 三: "San", 四: "Si", 五: "Wu", 六: "Liu", 七: "Qi", 八: "Ba", 九: "Jiu", 十: "Shi", 百: "Bai", 千: "Qian", 万: "Wan",
  上: "Shang", 下: "Xia", 左: "Zuo", 右: "You", 中: "Zhong", 前: "Qian", 后: "Hou", 内: "Nei", 外: "Wai", 大: "Da", 小: "Xiao", 长: "Chang", 短: "Duan",
  新: "Xin", 旧: "Jiu", 热: "Re", 冷: "Leng", 明: "Ming", 暗: "An", 亮: "Liang", 黑: "Hei", 白: "Bai", 红: "Hong", 蓝: "Lan", 黄: "Huang", 绿: "Lv", 紫: "Zi", 金: "Jin", 银: "Yin", 灰: "Hui",
  奇: "Qi", 珍: "Zhen", 宝: "Bao", 物: "Wu", 品: "Pin", 道: "Dao", 具: "Ju", 材: "Cai", 料: "Liao", 资: "Zi", 源: "Yuan",
  卡: "Ka", 片: "Pian", 带: "Dai", 牌: "Pai", 按: "An", 钮: "Niu", 键: "Jian", 往: "Wang", 去: "Qu", 来: "Lai", 返: "Fan", 回: "Hui",
  装: "Zhuang", 饰: "Shi", 角: "Jiao", 边: "Bian", 框: "Kuang", 底: "Di", 背: "Bei", 景: "Jing", 图: "Tu", 标: "Biao", 题: "Ti", 文: "Wen", 字: "Zi",
  常: "Chang", 态: "Tai", 普: "Pu", 通: "Tong", 悬: "Xuan", 浮: "Fu", 按: "An", 压: "Ya", 选: "Xuan", 未: "Wei", 禁: "Jin", 用: "Yong", 锁: "Suo", 定: "Ding",
  开: "Kai", 关: "Guan", 闭: "Bi", 激: "Ji", 活: "Huo", 焦: "Jiao", 点: "Dian", 勾: "Gou",
  首: "Shou", 主: "Zhu", 页: "Ye", 界: "Jie", 面: "Mian", 个: "Ge", 人: "Ren", 我: "Wo", 的: "De", 设: "She", 置: "Zhi",
  登: "Deng", 录: "Lu", 陆: "Lu", 商: "Shang", 店: "Dian", 城: "Cheng", 市: "Shi", 场: "Chang", 森: "Sen", 林: "Lin",
  营: "Ying", 业: "Ye", 经: "Jing", 记: "Ji", 录: "Lu", 控: "Kong", 件: "Jian", 遮: "Zhe", 罩: "Zhao", 覆: "Fu", 盖: "Gai", 层: "Ceng",
  游: "You", 历: "Li", 日: "Ri", 志: "Zhi", 手: "Shou", 札: "Zha", 笔: "Bi", 冒: "Mao", 险: "Xian", 旅: "Lv", 程: "Cheng",
  菊: "Ju", 花: "Hua", 奖: "Jiang", 励: "Li", 礼: "Li", 包: "Bao", 货: "Huo", 币: "Bi", 钻: "Zuan", 石: "Shi", 任: "Ren", 务: "Wu",
  邮: "You", 件: "Jian", 背: "Bei", 包: "Bao", 地: "Di", 技: "Ji", 能: "Neng", 排: "Pai", 名: "Ming", 提: "Ti", 示: "Shi", 公: "Gong", 告: "Gao",
  输: "Shu", 入: "Ru", 滑: "Hua", 条: "Tiao", 弹: "Tan", 窗: "Chuang", 对: "Dui", 话: "Hua", 线: "Xian", 分: "Fen", 割: "Ge", 进: "Jin", 度: "Du",
  光: "Guang", 效: "Xiao", 阴: "Yin", 影: "Ying", 纹: "Wen", 理: "Li", 头: "Tou", 像: "Xiang", 立: "Li", 绘: "Hui",
};
