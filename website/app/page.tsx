import { getDesktopRelease } from "../lib/desktop-release.mjs";
import { MotionController } from "./motion";

export const dynamic = "force-dynamic";

const githubUrl = "https://github.com/907609732/NGR-AssetPilot-App";
const latestReleaseUrl = githubUrl + "/releases/latest";
const tutorialUrl = githubUrl + "/blob/main/docs/NGRAI辅助UI切图命名工具-使用教程脚本与图文教程.md";
const securityUrl = githubUrl + "/blob/main/docs/安全性说明.md";
const releaseNotesUrl = githubUrl + "/releases/tag/v3.0.24";

const features = [
  {
    code: "AI",
    title: "六种方式，按需命名",
    description: "内置离线 AI、NGR 云翻译、自有百度、OpenAI 兼容文本、本地知识库和 AI 视觉，按文件名、图片或规则生成名称。",
  },
  {
    code: "KB",
    title: "项目规则与知识库",
    description: "按项目维护前缀、页面、组件、状态和关键词规则；保存多套方案、上下文与提示词，让团队复用统一规范。",
  },
  {
    code: "QC",
    title: "UI 切图规范检测",
    description: "检查 PNG 格式、分辨率、大图、图标尺寸和疑似重复资源。按项目调整规则，集中处理问题与警告。",
  },
  {
    code: "EX",
    title: "批量导出，保留原图",
    description: "逐张确认名称，批量追加后缀与序号，拦截重名冲突；导出工程文件夹或 ZIP，只改文件名，不重新编码图片。",
  },
  {
    code: "WS",
    title: "进度保存与工作区迁移",
    description: "命名记录、切图、参考图和编辑状态自动保存在本机。支持画册浏览与 .ngrap 备份，随时继续上一批工作。",
  },
  {
    code: "IMG",
    title: "本地 AI 搜图",
    description: "为本机图库建立索引，用截图、图片或中英文文字查找相似素材。模型就绪后离线运行，源图库保持只读。",
  },
  {
    code: "TAB",
    title: "基地提单表",
    description: "粘贴日报，在本机整理日期、分类、S 等级与工时；核对编辑后复制表格或导出 Excel，无需登录 TAPD。",
  },
  {
    code: "TAPD",
    title: "周月报与 Bug 媒体",
    description: "登录 TAPD，按日期采集并确认等级，生成周报和月报；提取 Bug 图片与视频，已提取图片可附入月报 Excel。",
  },
  {
    code: "EXT",
    title: "快速找界面扩展",
    description: "导入兼容的官方扩展 ZIP，在独立工作台查找界面。扩展与模型单独交付，使用前需另行准备。",
  },
];

const steps = [
  {
    number: "01",
    title: "下载 Windows 安装包",
    description: "点击下载，获取 Windows x64 Setup 安装器。首次使用直接安装即可。",
  },
  {
    number: "02",
    title: "按向导完成安装",
    description: "选择安装目录，完成后从桌面或开始菜单打开 NGR AssetPilot。",
  },
  {
    number: "03",
    title: "开始整理你的资源",
    description: "选择项目规则、导入切图即可命名。需要搜图时准备模型，需要报表时登录 TAPD。",
  },
];

const releaseHighlights = [
  {
    label: "扩展启动",
    title: "日常打开少等一步",
    description: "快速找界面复用持久校验记录；首次导入、主动重新检查或文件变化时，再进行完整校验。",
  },
  {
    label: "TAPD 报表",
    title: "等级与采集时间更清楚",
    description: "标题缺少 S 等级时读取修复分支，新增“上周”“今天”快捷日期，并展示上次采集时间。",
  },
  {
    label: "Bug 媒体",
    title: "原图可看，也可附进月报",
    description: "已提取图片可导入月报的独立工作表；图片放大与复制使用完整图片，并过滤全局推广图。",
  },
];

const faqs = [
  {
    question: "适合什么电脑？需要先搭建运行环境吗？",
    answer: "正式安装包面向 Windows 10/11 x64。下载安装器、完成向导后即可使用，无需先准备开发环境。TAPD 报表需要另外安装 Google Chrome。",
  },
  {
    question: "没有 API Key，也能使用吗？",
    answer: "可以。内置离线 AI 翻译、本地知识库命名和切图检测不要求填写 API Key。本地 AI 搜图独立准备模型；使用自有在线翻译或视觉 AI 时，再配置对应接口。",
  },
  {
    question: "本地 AI 搜图需要下载模型吗？",
    answer: "需要先下载内置模型，或导入 .ngrmodel 离线包、经过校验的 ONNX 特征模型，再分析本机图库。模型就绪后可离线搜索；同时使用图片与文字搜索需要图文模型，图像单塔模型只支持图片搜索。",
  },
  {
    question: "TAPD 周报、月报怎么开始？",
    answer: "先安装 Google Chrome，从“更多功能 → 自动生成TAPD周报”打开报表，在软件启动的专用 Chrome 窗口中登录。选择日期并抓取后，确认 S 等级与分类再导出。旧快照需要重新采集，才会补齐新的详情字段。",
  },
  {
    question: "快速找界面扩展包含在安装包里吗？",
    answer: "扩展及其模型独立分发，需要单独取得兼容的官方扩展 ZIP，再通过软件里的扩展管理导入。目前兼容扩展 ZIP 尚未公开下载；公开旧独立版的安装器不能作为扩展导入。",
  },
  {
    question: "图片和工作资料会上传到哪里？",
    answer: "本地知识库、离线翻译、切图检测和模型就绪后的本地搜图在本机处理。在线文本翻译发送待译文字；AI 视觉命名发送选用的图片和相关命名上下文；TAPD 采集会访问登录账号可见的对应服务。联网范围取决于你使用的功能。",
  },
  {
    question: "Windows 提示“未知发布者”是怎么回事？",
    answer: "v3.0.24 安装包沿用未签名构建，因此 Windows 可能显示“未知发布者”。请核对官方 Release 来源及同页提供的 SHA-256 校验文件，再决定是否安装。",
  },
  {
    question: "换电脑时，备份会一起带走 API Key 吗？",
    answer: ".ngrap 可迁移设置、命名记录、切图和参考图，桌面版 API Key 不会随包导出，换电脑后需要重新填写。搜图模型、TAPD 资料和扩展需要分别处理；主工作区迁移包不等于整机备份。",
  },
  {
    question: "已经安装了旧桌面版，怎么更新？",
    answer: "进入“设置 → 数据与关于 → 检查更新”。完成当前任务后点击“下载更新”，下载完成会自动保存工作区、退出、安装并重新打开。无法在线更新时，可从官方 Release 手动下载安装器。",
  },
];

function LogoMark({ compact = false }: { compact?: boolean }) {
  return (
    <span className={"logo-mark" + (compact ? " logo-mark-compact" : "")} aria-hidden="true">
      <span className="logo-ring" />
      <span className="logo-needle" />
      <span className="logo-core" />
    </span>
  );
}

function formatReleaseDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

export default async function Home() {
  const release = await getDesktopRelease();
  const releaseDate = formatReleaseDate(release.publishedAt);
  const downloadSize = release.sizeBytes > 0
    ? "约 " + Math.round(release.sizeBytes / (1024 * 1024)) + " MB"
    : "Windows x64 安装包";

  return (
    <main>
      <MotionController />
      <header className="site-header" data-site-header>
        <a className="brand" href="#top" aria-label="NGR AssetPilot 首页">
          <LogoMark compact />
          <span className="brand-copy">
            <strong>NGR AssetPilot</strong>
            <small>AI资源领航</small>
          </span>
        </a>
        <nav className="main-nav" aria-label="主导航">
          <a href="#features">核心能力</a>
          <a href="#workflow">安装上手</a>
          <a href="#updates">版本更新</a>
          <a href="#faq">常见问题</a>
        </nav>
        <a className="header-cta" href={release.url}>
          下载 Windows 版
        </a>
      </header>

      <section className="hero" id="top">
        <div className="hero-glow hero-glow-one" />
        <div className="hero-glow hero-glow-two" />
        <div className="hero-copy">
          <div className="eyebrow"><span /> {release.tag} · WINDOWS 桌面工作台</div>
          <h1>让 UI 资源，<br /><em><span className="hero-title-group">更好找，</span><wbr /><span className="hero-title-group">更好交付。</span></em></h1>
          <p>
            把切图命名、规范检测、本地 AI 搜图和工作报表放进一个 Windows 桌面工作台。
            整理素材、查找资源、生成报告，在同一处继续。
          </p>
          <div className="hero-actions">
            <a className="primary-button" href={release.url} aria-label={"下载 NGR AssetPilot " + release.tag + " Windows x64 安装器"}>
              下载 Windows 版 <span aria-hidden="true">↓</span>
            </a>
            <a className="secondary-button" href={tutorialUrl} target="_blank" rel="noreferrer">
              查看使用教程 <span aria-hidden="true">↗</span>
            </a>
          </div>
          <div className="hero-release-meta">
            <span>Windows 10/11 x64 · {downloadSize}</span>
            <a href={latestReleaseUrl} target="_blank" rel="noreferrer">最新发布说明 <span aria-hidden="true">↗</span></a>
          </div>
          <ul className="hero-notes" aria-label="产品特性">
            <li><span>✓</span> 本地优先</li>
            <li><span>✓</span> 六种命名方式</li>
            <li><span>✓</span> 团队规范可复用</li>
          </ul>
        </div>

        <div className="product-stage" aria-label="NGR AssetPilot 命名流程示意，非软件截图">
          <div className="orbit orbit-one" />
          <div className="orbit orbit-two" />
          <p className="product-caption">命名流程示意 · 非软件截图</p>
          <div className="product-window">
            <div className="window-bar">
              <div className="window-brand"><LogoMark compact /><strong>NGR AssetPilot</strong></div>
              <span className="window-version">{release.tag}</span>
            </div>
            <div className="window-body">
              <aside className="window-sidebar">
                <span className="side-item active"><i>01</i> 开始命名</span>
                <span className="side-item"><i>02</i> 切图检测</span>
                <span className="side-item"><i>03</i> 本地 AI 搜图</span>
                <span className="side-item"><i>04</i> TAPD 报表</span>
              </aside>
              <div className="window-content">
                <div className="content-heading">
                  <div><small>示例项目</small><strong>NGR / Home</strong></div>
                  <span className="mock-action">生成推荐名称</span>
                </div>
                <div className="asset-row">
                  <span className="asset-thumb thumb-one" />
                  <span className="asset-origin">首页按钮.png</span>
                  <span className="asset-arrow">→</span>
                  <strong>T_UI_NGR_Home_Button</strong>
                  <span className="pass-pill">已确认</span>
                </div>
                <div className="asset-row">
                  <span className="asset-thumb thumb-two" />
                  <span className="asset-origin">商城背景.png</span>
                  <span className="asset-arrow">→</span>
                  <strong>T_UI_NGR_Shop_BG</strong>
                  <span className="pass-pill">已确认</span>
                </div>
                <div className="asset-row">
                  <span className="asset-thumb thumb-three" />
                  <span className="asset-origin">背包图标.png</span>
                  <span className="asset-arrow">→</span>
                  <strong>T_UI_Icon_NGR_Bag</strong>
                  <span className="review-pill">待确认</span>
                </div>
                <div className="progress-card">
                  <div><span>示例命名进度</span><strong>18 / 20</strong></div>
                  <div className="progress-track"><span /></div>
                </div>
              </div>
            </div>
          </div>
          <div className="floating-status"><span>✓</span><div><small>导出方式</small><strong>工程文件夹 / ZIP</strong></div></div>
        </div>
      </section>

      <section className="signal-strip" aria-label="产品特点概览">
        <div><strong>6 种</strong><span>命名方式，按场景选择</span></div>
        <div><strong>本地 AI</strong><span>模型就绪后离线搜图</span></div>
        <div><strong>周报 / 月报</strong><span>TAPD 采集与媒体整理</span></div>
        <div><strong>原图无损</strong><span>命名导出只修改文件名</span></div>
      </section>

      <section className="section features-section" id="features">
        <div className="section-heading">
          <span className="section-label">CORE CAPABILITIES</span>
          <h2>从素材整理到工作报表，<br />把日常步骤接起来</h2>
          <p>为游戏 UI 美术、技术美术和项目团队准备。命名、检测、查找、记录与交付，各自清楚，也能接着做。</p>
        </div>
        <div className="feature-grid">
          {features.map((feature, index) => (
            <article className="feature-card" key={feature.code}>
              <div className="feature-top">
                <span className="feature-code">{feature.code}</span>
                <span className="feature-index">{String(index + 1).padStart(2, "0")}</span>
              </div>
              <h3>{feature.title}</h3>
              <p>{feature.description}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="section workflow-section" id="workflow">
        <div className="workflow-intro">
          <span className="section-label light">GET STARTED</span>
          <h2>安装桌面版，<br />三步开始工作</h2>
          <p>先用一小批图片跑通命名和导出，再按需要开启本地搜图、报表与扩展工具。</p>
          <a className="workflow-guide" href={tutorialUrl} target="_blank" rel="noreferrer">打开完整使用教程 <span aria-hidden="true">↗</span></a>
        </div>
        <div className="steps-list">
          {steps.map((step) => (
            <article className="step-card" key={step.number}>
              <span>{step.number}</span>
              <div><h3>{step.title}</h3><p>{step.description}</p></div>
              <i aria-hidden="true">↗</i>
            </article>
          ))}
        </div>
      </section>

      <section className="section release-section" id="updates">
        <div className="section-heading release-heading">
          <div>
            <span className="section-label">RELEASE NOTES · 2026.11.04</span>
            <h2>v3.0.24 更新重点</h2>
            <p>这次更新集中在扩展打开速度、TAPD 等级识别与 Bug 媒体。历史快照需要重新采集，才能补齐新的详情字段。</p>
          </div>
          <a className="text-link" href={releaseNotesUrl} target="_blank" rel="noreferrer">查看本版完整说明 <span aria-hidden="true">↗</span></a>
        </div>
        <div className="release-grid">
          {releaseHighlights.map((highlight) => (
            <article className="release-card" key={highlight.label}>
              <span className="release-card-label">{highlight.label}</span>
              <h3>{highlight.title}</h3>
              <p>{highlight.description}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="section security-section" id="security">
        <div className="security-visual">
          <div className="security-rings"><LogoMark /></div>
          <span className="local-chip chip-one">LOCAL</span>
          <span className="local-chip chip-two">PNG</span>
          <span className="local-chip chip-three">RULES</span>
        </div>
        <div className="security-copy">
          <span className="section-label">LOCAL FIRST</span>
          <h2>本地处理，<br />联网能力按需使用</h2>
          <p>本地知识库、离线翻译、切图检测，以及模型就绪后的本地搜图在本机运行。在线翻译、视觉 AI 与 TAPD 会连接对应服务。</p>
          <ul>
            <li><span>01</span><div><strong>源图库保持只读</strong><small>索引与缩略图保存在本机，搜索不改动原图</small></div></li>
            <li><span>02</span><div><strong>发送什么，由功能决定</strong><small>文本翻译发送待译文字，视觉命名发送选用图片与相关上下文</small></div></li>
            <li><span>03</span><div><strong>备份范围清楚</strong><small>主工作区支持 .ngrap 迁移，桌面密钥不随包导出</small></div></li>
          </ul>
          <a className="text-link security-link" href={securityUrl} target="_blank" rel="noreferrer">查看数据与安全性说明 <span aria-hidden="true">↗</span></a>
        </div>
      </section>

      <section className="section faq-section" id="faq">
        <div className="section-heading">
          <span className="section-label">QUESTIONS &amp; ANSWERS</span>
          <h2>开始之前，<br />你可能还想知道</h2>
          <p>安装、模型、TAPD、扩展和资料迁移，常见问题都在这里。</p>
        </div>
        <div className="faq-list">
          {faqs.map((faq) => (
            <details className="faq-item" key={faq.question}>
              <summary><span>{faq.question}</span><span className="faq-toggle" aria-hidden="true">+</span></summary>
              <div className="faq-answer"><p>{faq.answer}</p></div>
            </details>
          ))}
        </div>
        <p className="faq-help">需要逐步操作说明？<a href={tutorialUrl} target="_blank" rel="noreferrer">查看桌面版使用教程 <span aria-hidden="true">↗</span></a></p>
      </section>

      <section className="download-section" id="download">
        <div className="download-logo"><LogoMark /></div>
        <span className="section-label light">READY TO START</span>
        <h2>把重复整理的时间，<br />留给下一次创作。</h2>
        <p>从一批切图开始，让命名、检测、搜图与报表进入你的桌面工作流。</p>
        <a className="primary-button lime" href={release.url} aria-label={"下载 " + release.filename}>
          下载 Windows 版 <span aria-hidden="true">↓</span>
        </a>
        <div className="download-meta">
          <span>{release.tag} · Windows 10/11 x64 · {downloadSize}</span>
          {releaseDate && <span>发布于 {releaseDate}</span>}
        </div>
        {release.isFallback && (
          <p className="download-status">
            当前显示最近核验的版本信息，最新版本请以<a href={latestReleaseUrl} target="_blank" rel="noreferrer"> GitHub 发布页 </a>为准。
          </p>
        )}
        <div className="download-links">
          <a href={release.releaseUrl} target="_blank" rel="noreferrer">本版发布说明 <span aria-hidden="true">↗</span></a>
          <a href={release.checksumUrl} target="_blank" rel="noreferrer">SHA-256 校验文件 <span aria-hidden="true">↗</span></a>
          <a href={latestReleaseUrl} target="_blank" rel="noreferrer">GitHub 下载 <span aria-hidden="true">↗</span></a>
        </div>
        <small className="download-filename">{release.filename}</small>
      </section>

      <footer>
        <div className="footer-brand"><LogoMark compact /><div><strong>NGR AssetPilot</strong><small>AI资源领航</small></div></div>
        <p>面向游戏 UI 团队的 Windows 资源与报表工作台。</p>
        <div className="footer-links">
          <a href={githubUrl} target="_blank" rel="noreferrer">GitHub</a>
          <a href={tutorialUrl} target="_blank" rel="noreferrer">使用教程</a>
          <a href="mailto:907609732@qq.com">联系作者</a>
        </div>
        <span>© 2026 by 五成（月财）</span>
      </footer>
    </main>
  );
}
