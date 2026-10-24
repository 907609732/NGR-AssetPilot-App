(() => {
  const root = document.getElementById("figmaGuideRoot");
  const entry = document.getElementById("figmaVariantsEntry");
  const imageDialog = document.getElementById("figmaGuideImageDialog");
  const image = document.getElementById("figmaGuideImage");
  let mounted = false;

  const picture = (file, description, narrow = false) => `<figure class="figma-guide-figure${narrow ? " is-narrow" : ""}"><button type="button" data-guide-image="${file}" aria-label="放大图片：${description}"><img src="tutorials/figma/${file}" alt="${description}" loading="lazy" /><span>点击图片放大 ↗</span></button><figcaption>${description}</figcaption></figure>`;

  const videoCard = (id, url, title, thumbnail) => `<a id="${id}" class="figma-guide-video" href="${url}" target="_blank" rel="noopener noreferrer" data-guide-external aria-label="观看${title}，在浏览器打开哔哩哔哩"><span class="figma-guide-video-thumb"><img src="tutorials/figma/${thumbnail}" alt="" /><span class="play-circle" aria-hidden="true">▶</span></span><span class="video-copy"><span class="bili-brand"><img src="tutorials/figma/icons/bilibili.svg" alt="" />哔哩哔哩视频教程</span><strong>${title}</strong><small>在浏览器观看 <span aria-hidden="true">↗</span></small></span><span class="video-arrow" aria-hidden="true">↗</span></a>`;
  const downloadUrl = "https://github.com/907609732/NGR-Figma-UI-Forge/releases/latest";

  function mount() {
    if (mounted) return;
    mounted = true;
    root.innerHTML = `
      <aside class="figma-guide-sidebar">
        <p class="figma-guide-nav-label">学习指南</p>
        <div class="figma-guide-tabs" role="tablist" aria-label="图文教程章节" aria-orientation="vertical">
          <button id="figmaGuideInstallTab" role="tab" type="button" data-guide-tab="install" aria-selected="true" aria-controls="figmaGuideInstall"><span class="figma-guide-nav-number">01</span><span><strong>下载安装</strong><small>从零开始，装好插件</small></span></button>
          <button id="figmaGuideUseTab" role="tab" type="button" data-guide-tab="use" aria-selected="false" aria-controls="figmaGuideUse" tabindex="-1"><span class="figma-guide-nav-number">02</span><span><strong>一键变体</strong><small>一个按钮，四种状态</small></span></button>
          <button id="figmaGuideHelpTab" role="tab" type="button" data-guide-tab="help" aria-selected="false" aria-controls="figmaGuideHelp" tabindex="-1"><span class="figma-guide-nav-number">?</span><span><strong>常见问题</strong><small>卡住了，来这里找答案</small></span></button>
        </div>
        <div class="figma-guide-sidebar-tip"><span aria-hidden="true">⌕</span><p>看不清？点击图片放大<br />图文教程支持离线阅读</p><a href="${downloadUrl}" target="_blank" rel="noopener noreferrer" data-guide-external>插件下载 ↗</a></div>
      </aside>
      <div class="figma-guide-main">
        <div class="figma-guide-chapterbar">
          <div class="figma-guide-chapter" data-guide-chapter="install">
            <div class="figma-guide-chapter-copy"><span>CHAPTER 01 · 开始使用</span><h3>下载安装插件</h3><p>只需安装一次，下次直接打开。</p><a id="figmaVariantsDownload" class="figma-guide-download" href="${downloadUrl}" target="_blank" rel="noopener noreferrer" data-guide-external><span aria-hidden="true">↓</span> 下载插件 <span aria-hidden="true">↗</span></a></div>
            ${videoCard("figmaVariantsInstallTutorial", "https://www.bilibili.com/video/BV1kmn865Eio/", "第一集 · 下载安装", "run-plugin.png")}
          </div>
          <div class="figma-guide-chapter" data-guide-chapter="use" hidden>
            <div class="figma-guide-chapter-copy"><span>CHAPTER 02 · 跟着练习</span><h3>一键生成按钮变体</h3><p>从一个按钮开始，做出普通、悬停、按下和禁用状态。</p></div>
            ${videoCard("figmaVariantsTutorial", "https://www.bilibili.com/video/BV1jxHK6KEs4/", "第二集 · 一键变体", "four-options.png")}
          </div>
          <div class="figma-guide-chapter" data-guide-chapter="help" hidden>
            <div class="figma-guide-chapter-copy"><span>HELP · 遇到问题</span><h3>常见问题与解答</h3><p>先对照检查，通常不用重新安装。</p></div>
          </div>
        </div>
      <div class="figma-guide-scroll">
        <section id="figmaGuideInstall" role="tabpanel" aria-labelledby="figmaGuideInstallTab" data-guide-panel="install" tabindex="0">
          <article class="figma-guide-step"><h3><b>1</b> 下载插件 ZIP 压缩包</h3>
            <p>点上方“下载插件”，打开下载页后找到 <strong>Assets（下载文件）</strong>。点名称以 <strong>NGR-Figma-UI-Forge</strong> 开头、以 <strong>.zip</strong> 结尾的文件。</p>
            ${picture("download.png", "下载带插件名字的 ZIP；下面两个 Source code 是源码，不用下载。")}
            <p class="figma-guide-check">✓ 下载完成后，你会得到一个 ZIP 文件。截图里的版本号是示例，以下载页为准。</p>
          </article>
          <article class="figma-guide-step"><h3><b>2</b> 把 ZIP 完整解压</h3>
            <p>在下载文件夹里找到 ZIP，右键点 <strong>全部解压缩</strong>，再点 <strong>提取</strong>。也可以用你常用的解压软件。</p>
            ${picture("extract.png", "选一个固定位置，再点右下角“提取”。")}
            <p class="figma-guide-check">✓ 解压后是一个普通文件夹，里面能找到 <code>manifest.json</code>。这个文件夹安装后要保留。</p>
          </article>
          <article class="figma-guide-step"><h3><b>3</b> 在 Figma 里导入插件</h3>
            <p>在 Figma 设计文件的左上角打开菜单，依次点下面这条路径：</p>
            <div class="figma-guide-path">Plugins（插件） → Development（开发） → Import plugin from manifest…（从 manifest 导入）</div>
            ${picture("import-menu.png", "沿着这三个菜单，一直找到 Import plugin from manifest…。")}
            <p>在弹出的选文件窗口中，进入<strong>刚才解压的文件夹</strong>，选中 <code>manifest.json</code>，再点“打开”。不用双击这个 JSON 文件。</p>
            ${picture("manifest.png", "选这个 manifest.json 文件，不是 ZIP，也不是 code.js 或 ui.html。")}
          </article>
          <article class="figma-guide-step"><h3><b>4</b> 打开“UI 锻造台”</h3>
            <p>再打开 <strong>Plugins → Development</strong>，找到 <strong>NGR Figma UI 锻造台</strong>，点击运行。</p>
            ${picture("run-plugin.png", "找到带“NGR Figma UI 锻造台”名字的插件并运行。")}
            <p class="figma-guide-check">✓ 看到插件窗口，就装好了。下次直接从开发插件列表运行，不用重新导入。</p>
            <button class="primary-action" type="button" data-guide-next="use">装好了，开始做按钮 →</button>
          </article>
        </section>
        <section id="figmaGuideUse" role="tabpanel" aria-labelledby="figmaGuideUseTab" data-guide-panel="use" tabindex="0" hidden>
          <article class="figma-guide-step"><h3><b>1</b> 先准备一个完整按钮</h3>
            <p>把按钮的底板、文字、图标放进同一个 <strong>Frame（框架）</strong>，也可以用一个独立组件。<strong>不要只选一行文字或一张图片。</strong></p>
            <div class="figma-guide-tree" role="img" aria-label="按钮图层结构示意：一个 Frame 内有 Normal、Hover、Pressed、Disabled 四个状态图层">
              <div>▣ 按钮外框 <small>Frame（框架）</small></div>
              <p>├─ <code>Normal</code><span>基础外观：底板、图标、文字</span></p>
              <p>├─ <code>Hover</code><span>鼠标放上去时的高亮</span></p>
              <p>├─ <code>Pressed</code><span>按下时的反馈</span></p>
              <p>└─ <code>Disabled</code><span>不能点击时的遮罩</span></p>
            </div>
            <p>需要自动切换外观时，把对应图层按图中的英文命名。图层不一定要全部有，但<strong>不同外观需要先自己准备好</strong>；插件负责组合和切换。</p>
            <p class="figma-guide-note">名字直接用 <code>Normal</code>、<code>Hover</code>、<code>Pressed</code>、<code>Disabled</code>；不要写成 Icon_Hover 或“普通状态”。Normal 基础层会一直保留。</p>
          </article>
          <article class="figma-guide-step"><h3><b>2</b> 在画布里选中整个按钮</h3>
            <p>在左侧图层列表中，点<strong>包含全部按钮图层的最外层 Frame</strong>。按钮四周出现选中边框，就对了。</p>
            ${picture("select-frame.png", "左侧选中最外层按钮，画布上会出现一圈选中边框。")}
            <p class="figma-guide-check">✓ 只选 1 个按钮。插件显示的选中数量不对时，点插件右上角“刷新”。</p>
          </article>
          <article class="figma-guide-step"><h3><b>3</b> 打开“变体”，照着选这 4 项</h3>
            <div class="figma-guide-options"><div>${picture("four-options.png", "右侧四状态选项亮起后，再点击底部蓝色生成按钮。", true)}</div>
              <ol><li>点插件顶部的 <strong>变体</strong>。</li><li>基础状态选 <strong>跳转按钮带禁用态 · 4状态</strong>。</li><li>附加 Style 选 <strong>不添加 Style</strong>。勾选 <strong>按节点名切换状态层</strong>，以及 <strong>生成标准按钮结构</strong>。</li><li>点底部蓝色 <strong>生成变体</strong> 按钮；有些版本会显示 <strong>生成 4 个变体</strong>。</li></ol>
            </div>
            <p class="figma-guide-note">“生成标准按钮结构”会自动整理 Content（内容）和 HotZone（点击区域），初次使用跟着勾选即可。</p>
          </article>
          <article class="figma-guide-step"><h3><b>4</b> 看到 4 个按钮，就是成功了</h3>
            <p>画布会生成一组按钮，对应下面这 4 种状态：</p>
            <figure class="figma-guide-result"><img src="tutorials/figma/four-states.png" alt="生成结果：普通、悬停、按下和禁用四种按钮外观" loading="lazy" /><figcaption><span>普通 Normal</span><span>悬停 Hover</span><span>按下 Pressed</span><span>禁用 Disabled</span></figcaption></figure>
            <p class="figma-guide-check">✓ 选中某个变体检查外观。做错了按 <kbd>Ctrl</kbd> + <kbd>Z</kbd> 撤销，重新选源按钮再试。</p>
            <p>以后需要“选中 / 未选中”的开关按钮，再尝试 <strong>选择按钮带禁用态 · 8状态</strong>，并准备名为 <code>Checked</code> 的选中标记层。先学会四状态就够了。</p>
          </article>
        </section>
        <section id="figmaGuideHelp" role="tabpanel" aria-labelledby="figmaGuideHelpTab" data-guide-panel="help" tabindex="0" hidden>
          <dl class="figma-guide-faq"><dt>找不到 manifest.json？</dt><dd>先把 ZIP 完整解压，再打开解压后的普通文件夹。不要在压缩包里面直接安装。</dd><dt>Figma 里没有开发菜单？</dt><dd>使用 Figma 桌面版，打开一个有编辑权限的设计文件，再点左上角菜单。英文路径是 Plugins → Development。</dd><dt>生成按钮不能点，或提示选区不对？</dt><dd>回到画布，只选一个最外层 Frame 或独立组件，然后点插件“刷新”。只选文字、图片、Group 或已有变体集时，不属于本教程的入门流程。</dd><dt>生成了 4 个按钮，但看起来一样？</dt><dd>插件不会自动画高亮或禁用效果。先准备对应外观图层，检查英文名字，并勾选“按节点名切换状态层”。</dd><dt>图片里的版本号和我的不一样？</dt><dd>这些是真实教学录屏的截图，版本号可能不同。以你看到的按钮文字为准，下载安装用下载页的最新版。</dd><dt>操作错了怎么办？</dt><dd>按 Ctrl + Z 撤销。第一次练习请先复制按钮，避免直接修改正式设计。</dd></dl>
        </section>
        <p class="figma-guide-footnote">图片来自实际教学录屏；图文可离线查看，下载插件和观看 B 站视频需要联网。</p>
      </div></div>`;

    root.addEventListener("click", async (event) => {
      const tab = event.target.closest("[data-guide-tab], [data-guide-next]");
      if (tab) selectTab(tab.dataset.guideTab || tab.dataset.guideNext, true);
      const zoom = event.target.closest("[data-guide-image]");
      if (zoom) {
        const source = zoom.querySelector("img");
        image.src = source.src; image.alt = source.alt;
        document.getElementById("figmaGuideImageTitle").textContent = source.alt;
        imageDialog.showModal();
      }
      const link = event.target.closest("[data-guide-external]");
      if (link && window.NgrDesktopBridge) {
        event.preventDefault();
        try { await window.NgrDesktopBridge.openExternal(link.href); }
        catch (error) { window.alert(`打开${link.href.includes("bilibili.com") ? "视频教程" : "下载页"}失败：${error?.message || error}`); }
      }
    });
    const compactLayout = window.matchMedia("(max-width: 900px)");
    const updateOrientation = () => root.querySelector("[role=tablist]").setAttribute("aria-orientation", compactLayout.matches ? "horizontal" : "vertical");
    updateOrientation();
    compactLayout.addEventListener("change", updateOrientation);
    root.querySelector("[role=tablist]").addEventListener("keydown", (event) => {
      if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
      const tabs = [...root.querySelectorAll("[data-guide-tab]")];
      const index = tabs.indexOf(event.target);
      if (index < 0) return;
      event.preventDefault();
      const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : (index + (["ArrowRight", "ArrowDown"].includes(event.key) ? 1 : -1) + tabs.length) % tabs.length;
      selectTab(tabs[next].dataset.guideTab, true);
    });
  }
  function selectTab(name, focus = false) {
    for (const tab of root.querySelectorAll("[data-guide-tab]")) {
      const selected = tab.dataset.guideTab === name;
      tab.setAttribute("aria-selected", String(selected)); tab.tabIndex = selected ? 0 : -1;
      if (selected && focus) tab.focus({ preventScroll: true });
    }
    for (const panel of root.querySelectorAll("[data-guide-panel]")) panel.hidden = panel.dataset.guidePanel !== name;
    for (const chapter of root.querySelectorAll("[data-guide-chapter]")) chapter.hidden = chapter.dataset.guideChapter !== name;
    root.querySelector(".figma-guide-scroll").scrollTop = 0;
    root.querySelector(".figma-guide-main").scrollTop = 0;
  }
  entry.addEventListener("click", () => { mount(); selectTab("install"); });
  document.getElementById("figmaGuideImageClose").addEventListener("click", () => imageDialog.close());
})();
