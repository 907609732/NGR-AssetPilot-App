/* NGR AssetPilot V3.0.14 module: feature-tests.js */
(function initializeFeatureTestModule(globalScope) {
  "use strict";

  const state = {
    initialized: false,
    running: false,
    startedAt: performance.now(),
    completed: 0,
    total: 0,
    preview: { active: false, view: "", snapshot: null, testAssets: [], testDetectionAssets: [] },
  };
  const byId = (id) => document.getElementById(id);
  const waitForPaint = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

  function selectedText(select) {
    return select?.selectedOptions?.[0]?.textContent?.trim() || "未选择";
  }

  function refreshRuntimeStatus() {
    const desktop = Boolean(globalScope.NgrDesktopBridge?.isDesktopRuntime?.());
    const uptimeSeconds = Math.max(0, Math.floor((performance.now() - state.startedAt) / 1000));
    const hours = Math.floor(uptimeSeconds / 3600);
    const minutes = Math.floor((uptimeSeconds % 3600) / 60);
    const seconds = uptimeSeconds % 60;
    byId("featureRuntimeEnvironment").textContent = desktop ? "Electron 桌面版运行中" : "浏览器预览运行中";
    byId("featureRuntimeUptime").textContent = `本次已运行 ${hours ? `${hours}时` : ""}${minutes}分${seconds}秒`;
    byId("featureRuntimeNaming").textContent = selectedText(els.namingModeSelect);
    byId("featureRuntimeNamingAssets").textContent = `命名图片 ${Array.isArray(assets) ? assets.length : 0} 张`;
    const project = typeof getActiveProject === "function" ? getActiveProject() : null;
    byId("featureRuntimeProject").textContent = project?.name || "未命名项目";
    byId("featureRuntimeScheme").textContent = `方案：${selectedText(els.workSchemeSelect || els.schemeSelect)}`;
    const profile = typeof getActiveDetectionProfile === "function" ? getActiveDetectionProfile() : null;
    byId("featureRuntimeDetection").textContent = profile?.name || "默认检测方案";
    byId("featureRuntimeDetectionAssets").textContent = `检测图片 ${Array.isArray(detectionAssets) ? detectionAssets.length : 0} 张`;
  }

  function appendLog(message, tone = "info") {
    const log = byId("featureTestLog");
    if (!log) return;
    if (log.children.length === 1 && log.firstElementChild?.textContent === "等待运行测试…") log.textContent = "";
    const line = document.createElement("p");
    line.dataset.tone = tone;
    const time = document.createElement("time");
    time.textContent = new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(new Date());
    line.append(time, document.createTextNode(message));
    log.append(line);
    log.scrollTop = log.scrollHeight;
  }

  function setStep(id, nextState, detail) {
    const item = byId(id);
    if (!item) return;
    item.dataset.state = nextState;
    const small = item.querySelector("small");
    if (small) small.textContent = detail;
  }

  function setCard(id, nextState, label) {
    const card = byId(id);
    if (!card) return;
    card.dataset.state = nextState;
    card.querySelector(".feature-test-badge").textContent = label;
  }

  function resetCard(kind) {
    const naming = kind === "naming";
    const ids = naming
      ? ["featureNamingEnvironment", "featureNamingRules", "featureNamingService", "featureNamingOutput"]
      : ["featureDetectionProfile", "featureDetectionPng", "featureDetectionIssue", "featureDetectionOutput"];
    ids.forEach((id) => setStep(id, "idle", "等待测试"));
    setCard(naming ? "namingFeatureTestCard" : "detectionFeatureTestCard", "idle", "未测试");
  }

  function setBusy(busy) {
    state.running = busy;
    ["runAllFeatureTests", "runNamingFeatureTest", "runDetectionFeatureTest", "featureNamingTestMode"]
      .forEach((id) => { const node = byId(id); if (node) node.disabled = busy; });
  }

  function updateProgress() {
    const percent = state.total ? Math.round((state.completed / state.total) * 100) : 0;
    byId("featureTestProgressBar").style.width = `${percent}%`;
  }

  async function createImageFile(name, width = 32, height = 32, mimeType = "image/png", variant = 0) {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    const palettes = [
      ["#178994", "#ffffff"], ["#3454d1", "#dce7ff"], ["#8a4f9e", "#ffe7ff"],
      ["#d36b32", "#fff0d8"], ["#437a4b", "#e4f7df"], ["#9a394d", "#ffe5ea"],
    ];
    const palette = palettes[Math.abs(variant) % palettes.length];
    context.fillStyle = palette[0];
    context.fillRect(0, 0, width, height);
    context.fillStyle = palette[1];
    context.fillRect(Math.max(1, Math.floor(width * 0.25)), Math.max(1, Math.floor(height * 0.25)), Math.max(1, Math.floor(width * 0.5)), Math.max(1, Math.floor(height * 0.5)));
    context.strokeStyle = palette[1];
    context.lineWidth = Math.max(1, Math.round(Math.min(width, height) * 0.04));
    context.beginPath();
    context.moveTo(0, 0);
    context.lineTo(width, height);
    context.stroke();
    const blob = await new Promise((resolve, reject) => canvas.toBlob((value) => value ? resolve(value) : reject(new Error("无法生成测试图片")), mimeType, 0.9));
    return new File([blob], name, { type: mimeType, lastModified: Date.now() + variant });
  }

  const createPngFile = (name, width = 32, height = 32, variant = 0) => createImageFile(name, width, height, "image/png", variant);

  function ensurePreviewSnapshot() {
    if (state.preview.snapshot) return;
    state.preview.snapshot = {
      assets,
      detectionAssets,
      selectedId,
      showProblemOnly,
      showDetectionProblemOnly,
      showDetectionWarningOnly,
      listDisplayMode,
      assetRenderLimit,
      detectionRenderLimit,
      namingSessions,
      activeNamingSessionId,
    };
  }

  function removePreviewBanners() {
    document.querySelectorAll(".feature-preview-banner").forEach((banner) => banner.remove());
    els.views.work?.classList.remove("feature-test-preview-active");
    els.views.detect?.classList.remove("feature-test-preview-active");
  }

  function mountPreviewBanner(view, title, detail) {
    view.querySelector(":scope > .feature-preview-banner")?.remove();
    view.classList.add("feature-test-preview-active");
    const banner = document.createElement("div");
    banner.className = "feature-preview-banner";
    const copy = document.createElement("div");
    const strong = document.createElement("strong");
    strong.textContent = title;
    const small = document.createElement("small");
    small.textContent = detail;
    copy.append(strong, small);
    const actions = document.createElement("div");
    actions.className = "feature-preview-banner-actions";
    if (state.preview.testAssets.length && view !== els.views.work) {
      const naming = document.createElement("button");
      naming.type = "button";
      naming.className = "ghost-action";
      naming.textContent = "查看命名样本";
      naming.addEventListener("click", () => showView("work"));
      actions.append(naming);
    }
    if (state.preview.testDetectionAssets.length && view !== els.views.detect) {
      const detection = document.createElement("button");
      detection.type = "button";
      detection.className = "ghost-action";
      detection.textContent = "查看检测样本";
      detection.addEventListener("click", () => showView("detect"));
      actions.append(detection);
    }
    const back = document.createElement("button");
    back.type = "button";
    back.className = "primary-action";
    back.textContent = "退出测试并恢复数据";
    back.addEventListener("click", () => exitPreview());
    actions.append(back);
    banner.append(copy, actions);
    const toolbar = view.querySelector(":scope > .work-toolbar, :scope > .section-head");
    toolbar?.insertAdjacentElement("afterend", banner);
  }

  async function buildNamingPreviewAssets(primaryRecommendations) {
    const samples = [
      ["按钮_默认.png", 256, 96], ["按钮_悬停.png", 256, 96], ["按钮_禁用.png", 256, 96],
      ["登录背景.png", 1024, 768], ["首页背景.png", 3440, 1440], ["弹窗_遮罩.png", 512, 512],
      ["设置图标.png", 64, 64], ["关闭图标.png", 32, 32], ["搜索图标.png", 48, 48],
      ["左箭头.png", 64, 64], ["进度条.png", 512, 32], ["头像_圆形.png", 128, 128],
      ["卡片_选中.png", 512, 256], ["列表_空状态.png", 640, 360], ["标签_新.png", 96, 48],
      ["红色警告.png", 128, 128], ["提示气泡.png", 320, 160], ["分割线_横向.png", 512, 8],
      ["问题样本_图集单数尺寸.png", 381, 223, "dimension-error"],
      ["问题样本_大图非4倍数.png", 517, 514, "dimension-error"],
      ["问题样本_普通切图超限.png", 1280, 512, "dimension-error"],
      ["警告样本_2048风险尺寸.png", 2048, 512, "dimension-warning"],
      ["问题样本_重名A.png", 256, 128, "duplicate"],
      ["问题样本_重名B.png", 256, 128, "duplicate"],
      ["问题样本_命名服务失败.png", 256, 128, "naming-failed"],
      ["问题样本_等待用户命名.png", 256, 128, "unnamed"],
      ["大图样本_516正方形.png", 516, 516], ["大图样本_768横图.png", 768, 512],
      ["大图样本_800横图.png", 800, 600], ["大图样本_1024上限.png", 1024, 1024],
      ["大图样本_1200超限.png", 1200, 800, "dimension-error"], ["大图样本_1536超限.png", 1536, 1024, "dimension-error"],
      ["大图样本_2048风险.png", 2048, 1024, "dimension-warning"], ["大图样本_4096超大.png", 4096, 2048, "dimension-error"],
      ["背景图样本_3440x1440标准.png", 3440, 1440], ["背景图样本_1920x1080.png", 1920, 1080, "dimension-error"],
      ["背景图样本_3840x2160_4K.png", 3840, 2160, "dimension-error"], ["背景图样本_1080x1920竖屏.png", 1080, 1920, "dimension-error"],
      ["背景图样本_5120x1440超宽.png", 5120, 1440, "dimension-error"],
      ["效果图样本_PC_2560x1440.png", 2560, 1440, "dimension-warning"],
      ["效果图样本_移动端_2340x1080.png", 2340, 1080, "dimension-warning"],
      ["效果图样本_PC草稿_1920x1080.png", 1920, 1080, "dimension-error"],
      ["效果图样本_移动端竖屏_1080x1920.png", 1080, 1920, "dimension-error"],
      ["效果图样本_移动端_750x1334.png", 750, 1334, "dimension-error"],
      ["效果图样本_移动端_1242x2688.png", 1242, 2688, "dimension-error"],
      ["格式样本_PNG.png", 320, 180, "normal", "image/png"],
      ["格式样本_JPG.jpg", 320, 180, "normal", "image/jpeg"],
      ["格式样本_JPEG.jpeg", 320, 180, "normal", "image/jpeg"],
      ["格式样本_WebP.webp", 320, 180, "normal", "image/webp"],
      ["格式样本_GIF.gif", 320, 180, "normal", "image/gif"],
      ["格式样本_SVG.svg", 320, 180, "normal", "image/svg+xml"],
      ["格式样本_大图JPG.jpg", 1280, 720, "dimension-error", "image/jpeg"],
      ["格式样本_背景WebP.webp", 1920, 1080, "dimension-error", "image/webp"],
    ];
    const knowledge = parseKnowledge();
    const previewAssets = [];
    for (let index = 0; index < samples.length; index += 1) {
      const [name, width, height, sampleState = "normal", mimeType = "image/png"] = samples[index];
      const visualWidth = Math.min(width, 1024);
      const visualHeight = Math.min(height, 768);
      const asset = await fileToAsset(await createImageFile(name, visualWidth, visualHeight, mimeType, index));
      if (visualWidth !== width || visualHeight !== height) {
        asset.dimensions = { width, height };
        const validation = validateUploadDimensions(asset.dimensions);
        asset.sizeCategory = validation.category;
        asset.sizeCategoryLabel = validation.label;
        asset.dimensionIssue = Boolean(validation.problem);
        asset.dimensionWarning = Boolean(validation.warning);
        asset.dimensionIssueMessage = validation.reason || "";
        asset.dimensionInfoMessage = validation.info || "";
      }
      const recommendations = index === 0 && primaryRecommendations?.length
        ? primaryRecommendations
        : makeRecommendations(asset, knowledge);
      asset.recommendations = recommendations;
      asset.finalBaseName = recommendations[0] || "Test_Item";
      asset.namingStatus = "done";
      asset.statusMessage = "功能测试命名完成";
      if (sampleState === "duplicate") {
        asset.finalBaseName = "Test_Duplicate_Button";
        asset.statusMessage = "功能测试：模拟重名";
      } else if (sampleState === "naming-failed") {
        asset.finalBaseName = "";
        asset.namingStatus = "failed";
        asset.statusMessage = "功能测试：命名服务返回失败，请重试或手动命名";
      } else if (sampleState === "unnamed") {
        asset.finalBaseName = "";
        asset.namingStatus = "idle";
        asset.statusMessage = "功能测试：等待选择推荐名称或手动输入";
      } else if (sampleState === "dimension-error") {
        asset.statusMessage = `功能测试：${asset.dimensionIssueMessage || "分辨率不符合当前规则"}`;
      } else if (sampleState === "dimension-warning") {
        asset.statusMessage = `功能测试：${asset.dimensionIssueMessage || asset.dimensionInfoMessage || "分辨率需要确认"}`;
      }
      previewAssets.push(asset);
    }
    return previewAssets;
  }

  async function showNamingPreview(recommendations) {
    ensurePreviewSnapshot();
    state.preview.testAssets.forEach(revokeAssetPreviewUrl);
    state.preview.testAssets = await buildNamingPreviewAssets(recommendations);
    assets = state.preview.testAssets;
    selectedId = assets[0]?.id || null;
    showProblemOnly = false;
    listDisplayMode = "full";
    assetRenderLimit = ASSET_RENDER_BATCH_SIZE;
    if (els.listDisplayModeSelect) els.listDisplayModeSelect.value = "full";
    state.preview.active = true;
    state.preview.view = "work";
    byId("exitFeatureTestPreview")?.classList.remove("hidden");
    const testSession = createNamingSessionRecord("功能测试 · 全部命名样本");
    testSession.id = "feature-test-naming-session";
    testSession.assets = assets;
    testSession.selectedId = selectedId;
    testSession.assetRenderLimit = Math.max(ASSET_RENDER_BATCH_SIZE, assets.length);
    namingSessions = [testSession];
    activeNamingSessionId = testSession.id;
    renderNamingSessionList();
    renderAssetList();
    mountPreviewBanner(
      els.views.work,
      "开始命名 · 功能测试预览",
      `已载入 ${assets.length} 张完整命名样本。当前就是正式命名页面，可选择、编辑、批量命名、切换展示模式；测试修改不会写入真实进度。`,
    );
    await waitForPaint();
  }

  function nextMultiple(value, multiple) {
    const safeMultiple = Math.max(1, Number(multiple) || 1);
    return Math.ceil(Math.max(1, value) / safeMultiple) * safeMultiple;
  }

  async function createDetectionSample({ name, dimensions, profile, variant = 0, mimeType = "image/png", fileName = name, fileSize }) {
    const visualWidth = Math.max(8, Math.min(256, dimensions?.width || 96));
    const visualHeight = Math.max(8, Math.min(256, dimensions?.height || 96));
    const file = await createImageFile(fileName, visualWidth, visualHeight, mimeType, variant);
    const asset = await fileToDetectionAsset(file, { dimensions, profile, fileSize });
    asset.name = name;
    return asset;
  }

  async function buildCompleteDetectionSamples() {
    const active = normalizeDetectionProfile(getActiveDetectionProfile());
    const ngr = normalizeDetectionProfile({ ...active, mode: "ngr", duplicateSensitivity: "medium" });
    const planner = normalizeDetectionProfile({ ...active, mode: "planner" });
    const icon = normalizeDetectionProfile({ ...active, mode: "icon" });
    const samples = [];
    let variant = 0;
    const add = async (definition) => {
      const asset = await createDetectionSample({ ...definition, variant: variant++ });
      samples.push(asset);
      return asset;
    };

    const atlasWidth = nextMultiple(Math.max(128, ngr.minWidth), ngr.atlasMultiple);
    const atlasHeight = nextMultiple(Math.max(96, ngr.minHeight), ngr.atlasMultiple);
    await add({ name: "01_NGR_标准图集_通过.png", dimensions: { width: atlasWidth, height: atlasHeight }, profile: ngr });
    await add({ name: "02_NGR_背景图_规范提示.png", dimensions: { width: ngr.backgroundWidth, height: ngr.backgroundHeight }, profile: ngr });
    await add({ name: "03_NGR_PC效果图_警告.png", dimensions: { width: ngr.pcEffectWidth, height: ngr.pcEffectHeight }, profile: ngr });
    await add({ name: "04_NGR_移动端效果图_警告.png", dimensions: { width: ngr.mobileEffectWidth, height: ngr.mobileEffectHeight }, profile: ngr });

    if (ngr.atlasMultiple > 1) {
      await add({ name: "05_NGR_图集非倍数_报错.png", dimensions: { width: atlasWidth + 1, height: atlasHeight + 1 }, profile: ngr });
    }
    const validLargeWidth = nextMultiple(ngr.largeThreshold + 1, ngr.largeMultiple);
    const validLargeHeight = nextMultiple(Math.max(64, ngr.minHeight), ngr.largeMultiple);
    await add({ name: "06_NGR_大图倍数_通过.png", dimensions: { width: validLargeWidth, height: validLargeHeight }, profile: ngr });
    if (ngr.largeMultiple > 1) {
      await add({ name: "07_NGR_大图非倍数_报错.png", dimensions: { width: validLargeWidth + 1, height: validLargeHeight }, profile: ngr });
    }
    if (ngr.oversizeSeverity !== "off") {
      const oversize = nextMultiple(ngr.maxSide + ngr.largeMultiple, ngr.largeMultiple);
      await add({ name: `08_NGR_超过${ngr.maxSide}px_报错.png`, dimensions: { width: oversize, height: validLargeHeight }, profile: ngr });
    }
    if (ngr.riskSideSeverity !== "off") {
      const riskHeight = nextMultiple(Math.max(64, ngr.minHeight), ngr.largeMultiple);
      await add({ name: `09_NGR_${ngr.riskSide}px风险图_警告.png`, dimensions: { width: ngr.riskSide, height: riskHeight }, profile: ngr });
    }
    await add({ name: "09A_NGR_768x768大图_通过.png", dimensions: { width: 768, height: 768 }, profile: ngr });
    await add({ name: "09B_NGR_5120x1440超宽背景_报错.png", dimensions: { width: 5120, height: 1440 }, profile: ngr });
    await add({ name: "09C_NGR_1080x1920竖屏背景_报错.png", dimensions: { width: 1080, height: 1920 }, profile: ngr });
    await add({ name: "09D_NGR_1920x1080效果图草稿_报错.png", dimensions: { width: 1920, height: 1080 }, profile: ngr });
    if (ngr.minWidth > 1 || ngr.minHeight > 1) {
      await add({ name: "10_NGR_小于最小尺寸_报错.png", dimensions: { width: Math.max(1, ngr.minWidth - 1), height: Math.max(1, ngr.minHeight - 1) }, profile: ngr });
    }
    if (ngr.maxFileSizeMb > 0) {
      await add({
        name: `10_NGR_超过${ngr.maxFileSizeMb}MB文件上限_报错.png`,
        dimensions: { width: atlasWidth, height: atlasHeight },
        profile: ngr,
        fileSize: (ngr.maxFileSizeMb + 0.1) * 1024 * 1024,
      });
    }

    await add({ name: "11_策划配置_2次幂_通过.png", dimensions: { width: 256, height: 128 }, profile: planner });
    if (planner.plannerRequireEven) {
      await add({ name: "12_策划配置_单数尺寸_报错.png", dimensions: { width: 255, height: 127 }, profile: planner });
    }
    if (planner.plannerRequirePowerOfTwo) {
      await add({ name: "13_策划配置_非2次幂_报错.png", dimensions: { width: 300, height: 200 }, profile: planner });
    }

    const allowedIcon = icon.iconAllowedSizes.find((size) => size >= icon.minWidth && size >= icon.minHeight) || icon.iconAllowedSizes[0] || 64;
    await add({ name: "14_Icon_允许尺寸_通过.png", dimensions: { width: allowedIcon, height: allowedIcon }, profile: icon });
    if (icon.iconRequireSquare) {
      const otherAllowed = icon.iconAllowedSizes.find((size) => size !== allowedIcon) || allowedIcon * 2;
      await add({ name: "15_Icon_非正方形_报错.png", dimensions: { width: allowedIcon, height: otherAllowed }, profile: icon });
    }
    let disallowedIcon = Math.max(1, allowedIcon + 1);
    while (icon.iconAllowedSizes.includes(disallowedIcon)) disallowedIcon += 1;
    await add({ name: "16_Icon_非允许尺寸_报错.png", dimensions: { width: disallowedIcon, height: disallowedIcon }, profile: icon });

    const formatBase = await createPngFile("format-source.png", 64, 64, variant++);
    const wrongExtensionFile = new File([formatBase], "wrong-extension.jpg", { type: "image/jpeg", lastModified: Date.now() + variant++ });
    const wrongExtension = await fileToDetectionAsset(wrongExtensionFile, { profile: ngr });
    wrongExtension.name = "17_格式_PNG内容但扩展名错误.jpg";
    samples.push(wrongExtension);

    const jpegFile = await createImageFile("jpeg-as-png.png", 64, 64, "image/jpeg", variant++);
    const jpegAsset = await fileToDetectionAsset(jpegFile, { profile: ngr });
    jpegAsset.name = "18_格式_JPEG内容伪装PNG_报错.png";
    samples.push(jpegAsset);

    const svgFile = new File(['<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="#178994"/></svg>'], "svg-as-png.png", { type: "image/svg+xml", lastModified: Date.now() + variant++ });
    const svgAsset = await fileToDetectionAsset(svgFile, { profile: ngr });
    svgAsset.name = "19_格式_SVG内容伪装PNG_报错.png";
    samples.push(svgAsset);

    const brokenFile = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02])], "broken.png", { type: "image/png", lastModified: Date.now() + variant++ });
    const brokenAsset = await fileToDetectionAsset(brokenFile, { profile: ngr });
    brokenAsset.name = "20_文件_损坏PNG_报错.png";
    samples.push(brokenAsset);

    const unknownFile = new File([new TextEncoder().encode("not an image")], "unknown.png", { type: "application/octet-stream", lastModified: Date.now() + variant++ });
    const unknownAsset = await fileToDetectionAsset(unknownFile, { profile: ngr });
    unknownAsset.name = "21_文件_未知内容_报错.png";
    samples.push(unknownAsset);

    const addHeaderFormat = async (name, fileName, bytes, type) => {
      const file = new File([new Uint8Array(bytes)], fileName, { type, lastModified: Date.now() + variant++ });
      const asset = await fileToDetectionAsset(file, { profile: ngr });
      asset.name = name;
      samples.push(asset);
    };
    await addHeaderFormat("24_格式_GIF_报错.gif", "sample.gif", [0x47,0x49,0x46,0x38,0x39,0x61,0x01,0x00,0x01,0x00], "image/gif");
    const webpFile = await createImageFile("sample.webp", 64, 64, "image/webp", variant++);
    const webpAsset = await fileToDetectionAsset(webpFile, { profile: ngr });
    webpAsset.name = "25_格式_WebP_报错.webp";
    samples.push(webpAsset);
    await addHeaderFormat("26_格式_BMP_报错.bmp", "sample.bmp", [0x42,0x4d,0x36,0x00,0x00,0x00,0x00,0x00], "image/bmp");
    await addHeaderFormat("27_格式_TIFF_报错.tiff", "sample.tiff", [0x49,0x49,0x2a,0x00,0x08,0x00,0x00,0x00], "image/tiff");
    await addHeaderFormat("28_格式_ICO_报错.ico", "sample.ico", [0x00,0x00,0x01,0x00,0x01,0x00,0x10,0x10], "image/x-icon");
    await addHeaderFormat("29_格式_AVIF_报错.avif", "sample.avif", [0x00,0x00,0x00,0x18,0x66,0x74,0x79,0x70,0x61,0x76,0x69,0x66], "image/avif");
    await addHeaderFormat("30_格式_HEIC_报错.heic", "sample.heic", [0x00,0x00,0x00,0x18,0x66,0x74,0x79,0x70,0x68,0x65,0x69,0x63], "image/heic");

    const duplicateA = await add({ name: "22_重复资源_A.png", dimensions: { width: 128, height: 128 }, profile: ngr, variant: 5 });
    const duplicateFile = duplicateA.file;
    const duplicateBFile = new File([duplicateFile], "duplicate-b.png", { type: "image/png", lastModified: Date.now() + variant++ });
    const duplicateB = await fileToDetectionAsset(duplicateBFile, { dimensions: { width: 128, height: 128 }, profile: ngr });
    duplicateB.name = "23_重复资源_B_警告.png";
    duplicateA.similarNames = [duplicateB.name];
    duplicateB.similarNames = [duplicateA.name];
    duplicateA.warnings = [...(duplicateA.warnings || []), `疑似重复资源：${duplicateB.name}`];
    duplicateB.warnings = [...(duplicateB.warnings || []), `疑似重复资源：${duplicateA.name}`];
    duplicateA.hasWarning = true;
    duplicateB.hasWarning = true;
    samples.push(duplicateB);

    return samples;
  }

  async function showDetectionPreview(previewAssets) {
    ensurePreviewSnapshot();
    state.preview.testDetectionAssets.forEach(revokeAssetPreviewUrl);
    state.preview.testDetectionAssets = previewAssets;
    detectionAssets = previewAssets;
    showDetectionProblemOnly = false;
    showDetectionWarningOnly = false;
    detectionRenderLimit = DETECTION_RENDER_BATCH_SIZE;
    state.preview.active = true;
    state.preview.view = "detect";
    byId("exitFeatureTestPreview")?.classList.remove("hidden");
    renderDetectionList();
    mountPreviewBanner(
      els.views.detect,
      "UI 切图检测 · 完整测试环境",
      `已载入 ${previewAssets.length} 张完整规则样本。当前就是正式检测页面，可正常筛选、勾选、删除和查看每张图片的具体报错。`,
    );
    if (state.preview.testAssets.length) {
      mountPreviewBanner(
        els.views.work,
        "开始命名 · 完整测试环境",
        `已载入 ${state.preview.testAssets.length} 张完整命名样本。可按正式流程编辑和批量操作，退出测试后恢复真实数据。`,
      );
    }
    await waitForPaint();
  }

  function exitPreview(options = {}) {
    if (!state.preview.active && !state.preview.snapshot) {
      if (options.navigate !== false) showView("featureTest");
      return;
    }
    if (state.preview.testAssets.length) assets.forEach(revokeAssetPreviewUrl);
    if (state.preview.testDetectionAssets.length) detectionAssets.forEach(revokeAssetPreviewUrl);
    const snapshot = state.preview.snapshot;
    if (snapshot) {
      namingSessions = snapshot.namingSessions;
      activeNamingSessionId = snapshot.activeNamingSessionId;
      assets = snapshot.assets;
      detectionAssets = snapshot.detectionAssets;
      selectedId = snapshot.selectedId;
      showProblemOnly = snapshot.showProblemOnly;
      showDetectionProblemOnly = snapshot.showDetectionProblemOnly;
      showDetectionWarningOnly = snapshot.showDetectionWarningOnly;
      listDisplayMode = snapshot.listDisplayMode;
      assetRenderLimit = snapshot.assetRenderLimit;
      detectionRenderLimit = snapshot.detectionRenderLimit;
      if (els.listDisplayModeSelect) els.listDisplayModeSelect.value = listDisplayMode;
      const restoredSession = namingSessions.find((session) => session.id === activeNamingSessionId) || namingSessions[0];
      if (restoredSession) restoreNamingSession(restoredSession, { persist: false });
    }
    state.preview = { active: false, view: "", snapshot: null, testAssets: [], testDetectionAssets: [] };
    byId("exitFeatureTestPreview")?.classList.add("hidden");
    removePreviewBanners();
    renderAssetList();
    renderDetectionList();
    refreshRuntimeStatus();
    if (options.navigate !== false) showView("featureTest");
  }

  function shouldExitPreview(nextView) {
    return false;
  }

  async function runNamingTest() {
    const started = performance.now();
    resetCard("naming");
    setCard("namingFeatureTestCard", "running", "测试中");
    byId("featureNamingResult").textContent = "正在生成隔离测试名称…";
    try {
      setStep("featureNamingEnvironment", "running", "检查当前项目和方案");
      await waitForPaint();
      const project = getActiveProject();
      if (!project || !rules) throw new Error("当前项目或命名规则未加载");
      setStep("featureNamingEnvironment", "pass", `${project.name || "当前项目"} · ${selectedText(els.workSchemeSelect || els.schemeSelect)}`);

      setStep("featureNamingRules", "running", "解析命名规则和词库");
      await waitForPaint();
      const knowledge = parseKnowledge();
      const sample = { originalBase: "按钮_默认", dimensions: { width: 256, height: 96 }, extension: ".png", customProjectName: "", customViewName: "", customBasePrefix: "" };
      const coreRecommendations = makeRecommendations(sample, knowledge);
      if (!coreRecommendations.length || coreRecommendations.some((name) => containsChinese(name))) throw new Error("本地规则没有生成有效英文名称");
      setStep("featureNamingRules", "pass", `生成 ${coreRecommendations.length} 个推荐词`);

      const testMode = byId("featureNamingTestMode").value;
      const namingMode = els.namingModeSelect?.value || "local";
      let recommendations = coreRecommendations;
      setStep("featureNamingService", "running", testMode === "current" ? "正在调用当前服务" : "验证本地核心流程");
      await waitForPaint();
      if (testMode === "current" && namingMode.startsWith("translate:")) {
        const ready = await ensureTranslationProviderReady({ offerConfiguration: false });
        if (!ready) throw new Error("当前翻译服务尚未配置完成");
        recommendations = await makeRecommendationsWithTranslation(sample, knowledge, { allowExternal: true, forceExternal: true, requireExternal: true });
      } else if (testMode === "current" && namingMode === "ai") {
      const file = await createPngFile("按钮_默认.png", 256, 96);
        const testAsset = await fileToAsset(file);
        const credentialReady = Boolean(aiSettings?.apiKey?.trim() || (globalScope.NgrDesktopBridge?.isDesktopRuntime?.() && aiSettings?.hasSecret));
        if (!credentialReady) throw new Error("AI 视觉命名服务尚未配置密钥");
        recommendations = await requestAiRecommendations(testAsset, coreRecommendations, new AbortController().signal);
      }
      if (!recommendations?.length) throw new Error("命名服务没有返回推荐名称");
      setStep("featureNamingService", "pass", testMode === "current" ? selectedText(els.namingModeSelect) : "本地核心自检");

      const output = recommendations[0];
      if (!output || containsChinese(output)) throw new Error("测试名称不符合英文命名要求");
      setStep("featureNamingOutput", "pass", output);
      const elapsed = Math.round(performance.now() - started);
      byId("featureNamingResult").textContent = `输入：按钮_默认.png  →  输出：${output}  ·  ${elapsed} ms`;
      setCard("namingFeatureTestCard", "pass", "测试通过");
      await showNamingPreview(recommendations);
      appendLog(`开始命名测试通过：已在正式命名页面生成 ${state.preview.testAssets.length} 张样本（${elapsed} ms）`, "pass");
      return { ok: true, elapsed };
    } catch (error) {
      const runningStep = byId("namingFeatureTestCard").querySelector('li[data-state="running"]');
      if (runningStep) setStep(runningStep.id, "fail", error?.message || "测试失败");
      byId("featureNamingResult").textContent = `测试失败：${error?.message || "未知错误"}`;
      setCard("namingFeatureTestCard", "fail", "测试失败");
      appendLog(`开始命名测试失败：${error?.message || "未知错误"}`, "fail");
      return { ok: false, error };
    }
  }

  async function runDetectionTest() {
    const started = performance.now();
    resetCard("detection");
    setCard("detectionFeatureTestCard", "running", "测试中");
    byId("featureDetectionResult").textContent = "正在生成并检查隔离测试图片…";
    try {
      setStep("featureDetectionProfile", "running", "读取当前检测方案");
      await waitForPaint();
      const profile = getActiveDetectionProfile();
      if (!profile) throw new Error("当前检测方案未加载");
      setStep("featureDetectionProfile", "pass", profile.name || "当前检测方案");

      setStep("featureDetectionPng", "running", "读取标准 PNG 的格式和尺寸");
      const previewAssets = await buildCompleteDetectionSamples();
      const validAsset = previewAssets.find((asset) => asset.name.startsWith("01_"));
      if (!validAsset || validAsset.detectedFormat !== "PNG" || validAsset.hasIssue) throw new Error("标准 PNG 读取或规则判定不正确");
      setStep("featureDetectionPng", "pass", `PNG · ${validAsset.dimensions.width} × ${validAsset.dimensions.height}`);

      setStep("featureDetectionIssue", "running", "检查错误扩展名能否被识别");
      await waitForPaint();
      const wrongAsset = previewAssets.find((asset) => asset.name.startsWith("17_"));
      if (!wrongAsset.hasIssue || !wrongAsset.formatMessages?.length) throw new Error("未识别出 PNG 扩展名错误");
      setStep("featureDetectionIssue", "pass", wrongAsset.formatMessages[0]);

      const brokenAsset = previewAssets.find((asset) => asset.name.startsWith("20_"));
      if (!brokenAsset.hasIssue) throw new Error("未识别出损坏的 PNG 文件");

      const elapsed = Math.round(performance.now() - started);
      const issueCount = previewAssets.filter((asset) => asset.hasIssue).length;
      const warningCount = previewAssets.filter((asset) => asset.hasWarning).length;
      setStep("featureDetectionOutput", "pass", `${previewAssets.length} 张样本 · ${issueCount} 张问题 · ${warningCount} 张警告`);
      byId("featureDetectionResult").textContent = `完整样本：${previewAssets.length} 张 · 问题 ${issueCount} 张 · 警告 ${warningCount} 张 · ${elapsed} ms`;
      setCard("detectionFeatureTestCard", "pass", "测试通过");
      appendLog(`切图检测测试通过：已在正式检测页面生成 ${previewAssets.length} 张完整规则样本（${elapsed} ms）`, "pass");
      await showDetectionPreview(previewAssets);
      return { ok: true, elapsed };
    } catch (error) {
      const runningStep = byId("detectionFeatureTestCard").querySelector('li[data-state="running"]');
      if (runningStep) setStep(runningStep.id, "fail", error?.message || "测试失败");
      byId("featureDetectionResult").textContent = `测试失败：${error?.message || "未知错误"}`;
      setCard("detectionFeatureTestCard", "fail", "测试失败");
      appendLog(`切图检测测试失败：${error?.message || "未知错误"}`, "fail");
      return { ok: false, error };
    }
  }

  async function execute(kinds) {
    if (state.running) return;
    setBusy(true);
    state.completed = 0;
    state.total = kinds.length;
    updateProgress();
    byId("featureTestSummary").textContent = `正在运行 0/${state.total} 项测试…`;
    appendLog(`开始运行：${kinds.map((kind) => kind === "naming" ? "开始命名" : "切图检测").join("、")}`);
    const results = [];
    for (const kind of kinds) {
      results.push(await (kind === "naming" ? runNamingTest() : runDetectionTest()));
      state.completed += 1;
      updateProgress();
      byId("featureTestSummary").textContent = `正在运行 ${state.completed}/${state.total} 项测试…`;
      if (kinds.length > 1 && state.completed < state.total) await wait(900);
    }
    const passed = results.filter((result) => result.ok).length;
    const elapsed = results.reduce((sum, result) => sum + (result.elapsed || 0), 0);
    byId("featureTestSummary").textContent = passed === results.length
      ? `全部通过 · ${passed}/${results.length} 项 · 共 ${elapsed} ms · 测试数据已生成，请返回首页进入对应功能查看`
      : `测试完成 · ${passed}/${results.length} 项通过，请查看失败详情`;
    setBusy(false);
    refreshRuntimeStatus();
  }

  function init() {
    if (state.initialized || !byId("featureTestView")) return;
    state.initialized = true;
    byId("runAllFeatureTests").addEventListener("click", () => execute(["naming", "detection"]));
    byId("runNamingFeatureTest").addEventListener("click", () => execute(["naming"]));
    byId("runDetectionFeatureTest").addEventListener("click", () => execute(["detection"]));
    byId("exitFeatureTestPreview").addEventListener("click", () => exitPreview());
    byId("clearFeatureTestLog").addEventListener("click", () => { byId("featureTestLog").innerHTML = "<p>等待运行测试…</p>"; });
    setInterval(refreshRuntimeStatus, 1000);
    refreshRuntimeStatus();
  }

  globalScope.NgrFeatureTests = {
    init,
    refresh: refreshRuntimeStatus,
    runAll: () => execute(["naming", "detection"]),
    exitPreview,
    shouldExitPreview,
    isPreviewActive: () => state.preview.active,
  };
})(window);
