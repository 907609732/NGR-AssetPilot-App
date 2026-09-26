(() => {
  const TUTORIAL_RELEASE = "3.0.14";
  const modules = [
    {
      id: "quick-start",
      icon: "①",
      title: "第一次使用",
      summary: "从上传图片到下载结果，先走一遍最短流程。",
      purpose: "适合第一次打开软件的人。你会知道三个主入口分别做什么，并完成一次图片命名。",
      steps: [
        ["进入“开始命名”", "在首页点击“开始命名”。需要检查图片规范时再进入“UI切图检测”，需要找相似素材时进入“本地 AI 搜图”。"],
        ["填写工程和界面", "工程名填写项目名称，界面名填写当前页面名称。暂时不知道可以留空，稍后仍能修改。"],
        ["上传图片", "把图片或整个文件夹拖进上传区，也可以点击上传按钮选择文件。"],
        ["选择命名方式", "一般先用“内置离线翻译”；需要识别图片内容时使用“AI 视觉命名”。"],
        ["确认并下载", "检查每张图片的最终名称，确认无重名后点击“下载命名完成的图片”。"],
      ],
      tips: ["不确定从哪里开始时，点击上方“开始新手引导”，软件会逐步指出按钮位置。"],
      action: { label: "去开始命名", view: "work" },
      keywords: "新手 入门 上传 导出 下载 第一次",
    },
    {
      id: "naming",
      icon: "名",
      title: "图片命名",
      summary: "给 UI 图片生成统一、清楚、可追踪的英文名称。",
      purpose: "把杂乱的原文件名整理为“前缀 + 工程 + 界面 + 最终名称”，并实时检查重名和命名规则。",
      steps: [
        ["选择前缀", "使用团队规定的前缀；没有前缀时选择“无前缀”。自定义前缀可在前缀选择器里新建。"],
        ["填写工程名和界面名", "例如工程名 ActivityMiniWinter，界面名 Home。软件会自动按当前方案拼接。"],
        ["上传切图和参考图", "切图用于命名；参考图帮助 AI 理解整张界面，但不会作为待导出的切图。"],
        ["运行命名", "勾选要处理的图片，选择命名方式，然后点击运行。推荐结果会显示在图片旁。"],
        ["逐张确认", "点击推荐词或直接编辑“最终名称”。红色重名提示必须处理后再下载。"],
      ],
      tips: ["最终名称只填图片本身含义，前缀、工程名和界面名由软件自动拼接。", "修改会自动保存到当前命名记录。"],
      action: { label: "打开开始命名", view: "work" },
      keywords: "图片 改名 AI 视觉 推荐词 最终名称 重名 前缀 工程名 界面名",
    },
    {
      id: "batch-naming",
      icon: "批",
      title: "多选与批量命名",
      summary: "一次修改多张图片的前缀、工程名或界面名。",
      purpose: "当一批图片属于同一个工程或页面时，不必逐张重复填写。",
      steps: [
        ["勾选图片", "在图片左侧勾选两张或更多图片，窗口底部会自动出现批量工具栏。"],
        ["批量选择前缀", "点击“批量前缀名”，选中的前缀会立即应用到所有已勾选图片。"],
        ["批量填写工程或界面", "输入工程名或界面名，点击“应用”；按 Enter 也可以。"],
        ["检查结果", "每张图片原有的最终名称会保留，只统一你刚修改的字段。"],
      ],
      tips: ["显示“多种值”表示勾选图片当前内容不一致。", "底部删除按钮只删除已勾选图片，不会删除磁盘原图。"],
      action: { label: "打开命名列表", view: "work" },
      keywords: "批量 多选 前缀名 工程名 界面名 底部工具栏 删除选中",
    },
    {
      id: "lexicon-translation",
      icon: "译",
      title: "词库与翻译",
      summary: "查找命名词、查看中文意思，并把中文转换成英文名称。",
      purpose: "词库用于复用规范词；翻译用于处理临时中文。两个入口固定在屏幕左侧，打开一个会自动收起另一个。",
      steps: [
        ["选择目标图片", "先在命名列表点击正在编辑的图片。顶部会显示当前目标。"],
        ["使用词库", "点击左侧“词库”，可按状态、类型、颜色等分类浏览，也可用中文或英文搜索。"],
        ["添加或移除词", "点击词条会追加到当前图片名称；再次点击同一词条会移除。"],
        ["使用翻译", "点击左侧“翻译”，输入中文，选择转换为命名词或解释现有名称。"],
      ],
      tips: ["词库点击只修改当前正在编辑的图片，不会批量修改勾选图片。", "云翻译不可用时可先使用内置离线翻译，或到“设置 → API”检查服务。"],
      action: { label: "打开命名页面", view: "work" },
      keywords: "词库 中文释义 中文搜索 别名 翻译 云翻译 百度 离线 当前图片",
    },
    {
      id: "detection",
      icon: "检",
      title: "UI 切图检测",
      summary: "检查 PNG 格式、分辨率、尺寸、重名和大图规范。",
      purpose: "在交付资源前自动找出不符合项目组规则的图片，减少人工逐张检查。",
      steps: [
        ["选择检测模式", "先选择对应项目组或规范。不同模式的尺寸和文件规则可能不同。"],
        ["上传文件夹", "拖入整个切图文件夹，软件会递归读取并开始检测。"],
        ["查看问题", "红色项目是必须处理的问题，警告项目需要结合项目要求判断。可用筛选只看问题图片。"],
        ["批量处理", "勾选图片后可用固定在底部的删除按钮从检测列表移除；不会删除磁盘文件。"],
        ["调整规则", "点击页面里的检测设置，可修改分辨率、图集倍数、大图阈值等规则。"],
      ],
      tips: ["扩展名是 .png 但实际内容是 JPEG 的伪装文件也会被识别。"],
      action: { label: "打开 UI 切图检测", view: "detect" },
      secondaryAction: { label: "查看 10 页图文教程", type: "detection-slides" },
      keywords: "切图 检测 PNG 分辨率 大图 图集 问题图片 文件夹 规则",
    },
    {
      id: "local-search",
      icon: "搜",
      title: "本地 AI 搜图",
      summary: "用截图、图片或中英文文字查找本机相似素材。",
      purpose: "在大量素材文件夹中快速找到相似图片。原图和搜索内容都留在本机。",
      steps: [
        ["准备模型", "首次使用先下载内置模型，或导入经过验证的本地 ONNX 模型。"],
        ["创建图库", "选择本机图片文件夹并给图库起一个容易识别的名称。"],
        ["分析图片", "点击开始分析，等待软件生成本地向量索引。新增图片后可增量更新。"],
        ["开始搜索", "粘贴截图、选择图片，或直接输入中文/英文描述。点击结果可定位原文件。"],
      ],
      tips: ["图像单塔模型只能以图搜图；图文模型才支持文字搜图。", "图库首次分析时间取决于图片数量和电脑性能。"],
      action: { label: "打开本地 AI 搜图", view: "localImageSearch" },
      keywords: "本地 AI 搜图 相似图 截图 文字搜索 模型 图库 ONNX 索引",
    },
    {
      id: "rules",
      icon: "规",
      title: "命名规则与方案",
      summary: "保存团队词库、命名结构和不同项目的配置。",
      purpose: "让不同项目使用自己的前缀、分隔符、页面词、组件词和 AI 提示，避免互相污染。",
      steps: [
        ["创建或选择项目", "项目用于隔离配置和历史。先选择现有项目，或新建一个项目。"],
        ["配置方案", "一个项目可以有多套方案，例如 PC、移动端或不同团队规范。"],
        ["填写知识库", "页面词、组件词、状态词会参与本地推荐和 AI 命名。每行填写一个词。"],
        ["补充文件名规则", "按“中文关键词=英文词”填写，例如“按钮=Button”。"],
        ["保存并使用", "保存后回到命名页选择该项目和方案，新上传图片会使用最新规则。"],
      ],
      tips: ["项目上下文写清业务背景，AI 识别会更准确。", "导出提示文本可以交给团队复用和审阅。"],
      action: { label: "打开命名规则", view: "rules" },
      keywords: "设置 项目 配置方案 页面词 组件词 状态词 文件名匹配 AI提示 前缀 分隔符",
    },
    {
      id: "apps-arthub",
      icon: "夹",
      title: "快捷应用与 ArtHub",
      summary: "从顶部快速打开常用软件，并按工程名查找 ArtHub 文件夹。",
      purpose: "减少在 NGR、ArtHub、Figma 和在线工具之间来回查找的步骤。",
      steps: [
        ["配置快捷应用", "点击顶部四宫格按钮，可添加本机软件或网站，并为自定义软件选择图标。"],
        ["打开常用软件", "顶部的 ArtHub、Figma 等图标用于直接启动对应软件或网站。"],
        ["查找工程文件夹", "在命名页填写“当前界面工程名”，点击标题旁的“打开文件夹”。"],
        ["首次连接 ArtHub", "填写服务环境、查询 Token、资源库和可选根目录，然后按工程名查询。"],
        ["选择同名结果", "只有一个匹配时直接处理；有多个同名目录时，根据资源库和完整路径选择。"],
      ],
      tips: ["当前 ArtHub 客户端若不支持精确定位，软件会保留搜索结果并说明原因，不会跳到浏览器。"],
      action: { label: "打开命名页面", view: "work" },
      keywords: "ArtHub 打开文件夹 工程名 路径 Token Figma 快捷应用 自定义图标",
    },
    {
      id: "api",
      icon: "云",
      title: "AI、云翻译与网络诊断",
      summary: "配置命名模型、翻译服务，并检查网络连接问题。",
      purpose: "需要 AI 视觉命名、自有百度翻译或兼容模型时，在这里安全保存凭据并测试服务。",
      steps: [
        ["选择服务", "根据用途选择视觉命名或翻译服务。普通中文转英文可先使用无需配置的内置离线翻译。"],
        ["填写凭据", "按服务商后台信息填写 App ID、密钥或接口地址，然后保存。凭据保存在 Windows 安全存储中。"],
        ["运行测试", "点击对应测试按钮，确认真实请求成功后再回到命名页使用。"],
        ["网络体检", "连接失败时在网络诊断里选择服务，运行体检，查看 DNS、代理、TLS 和 HTTP 结果。"],
      ],
      tips: ["不要把 API 密钥写进项目文件或截图。", "HTTP 成功只代表网络可达；翻译测试成功才代表该服务真正可用。"],
      action: { label: "打开 API 设置", view: "apiSettings" },
      keywords: "API AI 视觉命名 百度 云翻译 Token 密钥 代理 DNS TLS 网络诊断",
    },
    {
      id: "settings-data",
      icon: "设",
      title: "开机启动、防止息屏与备份",
      summary: "管理 Windows 启动、屏幕保活和工作区数据。",
      purpose: "控制软件随 Windows 启动、长任务期间保持屏幕唤醒，并备份历史记录和配置。",
      steps: [
        ["开机自启动", "进入“设置 → 数据与关于”，打开开关。该功能默认关闭，开启后下次登录 Windows 自动启动。"],
        ["防止息屏", "打开防止息屏，再选择系统保活、鼠标微动或双重保活。设置会长期保存。"],
        ["选择保活模式", "系统保活最稳定；鼠标微动以极小距离移动；双重保活同时使用两种方式。"],
        ["导出备份", "在工作区迁移区域导出 .ngrap 文件。包含凭据时必须设置迁移密码。"],
        ["恢复备份", "导入 .ngrap，先完成校验和预览，再确认恢复，避免覆盖错误工作区。"],
      ],
      tips: ["防止息屏只在软件运行时有效，不会阻止你手动锁屏或关机。", "重要项目建议定期把备份放到另一个磁盘。"],
      action: { label: "打开数据与关于", view: "generalSettings" },
      keywords: "开机 自动启动 防止息屏 鼠标微动 系统保活 双重保活 备份 恢复 ngrap 迁移",
    },
    {
      id: "updates-download",
      icon: "更",
      title: "下载、更新与历史版本",
      summary: "下载命名结果，检查软件更新或回到历史版本。",
      purpose: "把命名后的图片保存到本地，并管理 NGR AssetPilot 的安装版本。",
      steps: [
        ["下载命名图片", "在命名页点击下载按钮即可使用当前下载设置；按钮右侧齿轮用于修改目录结构和导出方式。"],
        ["检查更新", "进入“设置 → 数据与关于”，点击“检查更新”。有新版本时会显示更新内容。"],
        ["查看下载进度", "开始更新后，进度固定显示在弹窗底部，无需滚到最下面。"],
        ["查看历史版本", "设置页和更新弹窗都列出全部可用历史版本，可查看发布日期和更新内容。"],
      ],
      tips: ["更新前保存正在编辑的名称。下载完成后软件会进入安装流程。"],
      action: { label: "打开版本设置", view: "generalSettings" },
      keywords: "下载 导出 齿轮 设置 更新 进度条 历史版本 安装 正式版",
    },
  ];

  const overlay = document.querySelector("#tutorialCenterOverlay");
  const entry = document.querySelector("#tutorialCenterEntry");
  const closeButton = document.querySelector("#tutorialCenterClose");
  const search = document.querySelector("#tutorialCenterSearch");
  const nav = document.querySelector("#tutorialCenterNav");
  const content = document.querySelector("#tutorialCenterContent");
  const status = document.querySelector("#tutorialCenterStatus");
  const version = document.querySelector("#tutorialCenterVersion");
  const quickTour = document.querySelector("#tutorialCenterQuickTour");
  let activeId = modules[0].id;

  function normalized(value) {
    return String(value || "").toLocaleLowerCase("zh-CN").replace(/\s+/g, "");
  }

  function matches(module, query) {
    if (!query) return true;
    const haystack = [module.title, module.summary, module.purpose, module.keywords, ...module.tips, ...module.steps.flat()].join(" ");
    return normalized(haystack).includes(query);
  }

  function renderNav() {
    const query = normalized(search.value);
    const visible = modules.filter((module) => matches(module, query));
    nav.replaceChildren();
    if (!visible.length) {
      const empty = document.createElement("p");
      empty.className = "tutorial-center-empty";
      empty.textContent = "没有找到相关教程，请换一个简单的关键词。";
      nav.append(empty);
      content.innerHTML = '<div class="tutorial-center-welcome"><span>⌕</span><h3>没有搜索结果</h3><p>可以搜索“命名”“翻译”“检测”“备份”等词。</p></div>';
      status.textContent = "找到 0 个模块";
      return;
    }
    if (!visible.some((module) => module.id === activeId)) activeId = visible[0].id;
    for (const module of visible) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "tutorial-center-nav-item";
      button.classList.toggle("active", module.id === activeId);
      if (module.id === activeId) button.setAttribute("aria-current", "page");
      const icon = document.createElement("span");
      icon.className = "tutorial-center-nav-icon";
      icon.textContent = module.icon;
      const text = document.createElement("span");
      text.innerHTML = `<strong>${module.title}</strong><small>${module.summary}</small>`;
      button.append(icon, text);
      button.addEventListener("click", () => {
        activeId = module.id;
        renderNav();
      });
      nav.append(button);
    }
    status.textContent = query ? `找到 ${visible.length} 个相关模块` : `共 ${modules.length} 个功能模块`;
    renderModule(modules.find((module) => module.id === activeId));
  }

  function renderModule(module) {
    if (!module) return;
    content.innerHTML = `
      <div class="tutorial-module-head">
        <span class="tutorial-module-icon">${module.icon}</span>
        <div><span class="tutorial-module-version">V${TUTORIAL_RELEASE} 最新教程</span><h3>${module.title}</h3><p>${module.summary}</p></div>
      </div>
      <section class="tutorial-purpose"><strong>这个功能是干什么的？</strong><p>${module.purpose}</p></section>
      <section class="tutorial-steps"><h4>照着下面做</h4><ol>${module.steps.map(([title, text]) => `<li><span></span><div><strong>${title}</strong><p>${text}</p></div></li>`).join("")}</ol></section>
      <section class="tutorial-tips"><h4>使用时注意</h4><ul>${module.tips.map((tip) => `<li>${tip}</li>`).join("")}</ul></section>
      <div class="tutorial-module-actions"></div>`;
    const actions = content.querySelector(".tutorial-module-actions");
    if (module.action) actions.append(createAction(module.action, "primary-action"));
    if (module.secondaryAction) actions.append(createAction(module.secondaryAction, "ghost-action"));
    content.scrollTop = 0;
  }

  function createAction(action, className) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = className;
    button.textContent = action.label;
    button.addEventListener("click", () => {
      close();
      if (action.type === "detection-slides") window.NgrTutorialActions?.openDetectionTutorial();
      else if (action.view) window.NgrTutorialActions?.showView(action.view);
    });
    return button;
  }

  function open() {
    overlay.classList.remove("hidden");
    overlay.setAttribute("aria-hidden", "false");
    renderNav();
    window.setTimeout(() => search.focus(), 0);
  }

  function close() {
    overlay.classList.add("hidden");
    overlay.setAttribute("aria-hidden", "true");
    entry.focus();
  }

  entry.addEventListener("click", open);
  closeButton.addEventListener("click", close);
  overlay.addEventListener("click", (event) => {
    if (event.target === overlay) close();
  });
  search.addEventListener("input", renderNav);
  quickTour.addEventListener("click", () => {
    close();
    window.NgrTutorialActions?.startGuideTour();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || overlay.classList.contains("hidden")) return;
    event.preventDefault();
    close();
  }, true);

  version.textContent = `适用于 V${TUTORIAL_RELEASE}`;
  window.NgrTutorialCenter = { open, close, modules };
})();
