(() => {
  const button = document.getElementById("openProjectFolder");
  const input = document.getElementById("workProjectName");
  const bridge = window.NgrDesktopBridge.externalApps;
  const dialog = document.createElement("dialog");
  dialog.className = "arthub-folder-dialog";
  dialog.setAttribute("aria-labelledby", "arthubFolderTitle");
  dialog.innerHTML = `<header><h2 id="arthubFolderTitle">ArtHub 工程文件夹</h2><button type="button" data-close aria-label="关闭">×</button></header>
    <p class="arthub-client-notice">当前可配置目录查询；客户端精确定位协议尚未验证，暂不能自动打开文件夹。</p>
    <p data-message role="status" aria-live="polite"></p>
    <form data-connection>
      <label>服务环境<select name="environment"><option value="qq">外网 · arthub.qq.com</option><option value="woa">内网 · arthub.woa.com</option><option value="tencent">内网 · arthub.tencent.com</option></select></label>
      <label>资源库名称<input name="assetHub" required maxlength="100" placeholder="资源库标识，如 trial" autocomplete="off"></label>
      <label>搜索根目录（选填）<input name="rootPath" maxlength="2048" placeholder="相对于资源库的目录，留空搜索整个库" autocomplete="off"></label>
      <label>查询授权 Token<input name="token" type="password" maxlength="8192" autocomplete="new-password" placeholder="首次连接必填；已连接时留空保留"></label>
      <small>授权加密保存在本机，不会显示已保存的 Token。</small>
      <button type="submit" class="primary-action">验证并保存连接</button>
    </form>
    <div data-results class="arthub-folder-results"></div>
    <footer><button type="button" data-settings>连接设置</button><button type="button" data-search class="primary-action">重新查找</button></footer>`;
  document.body.append(dialog);
  const form = dialog.querySelector("form");
  const message = dialog.querySelector("[data-message]");
  const results = dialog.querySelector("[data-results]");
  let configured = false, busy = false, revision = 0;
  function sync() {
    button.disabled = busy || !input.value.trim() || !window.NgrDesktopBridge.hasCapability("externalApps.searchFolders");
    const label = busy ? "正在查找…" : "打开文件夹";
    if (button.lastChild.textContent !== label) button.lastChild.textContent = label;
    dialog.querySelector("[data-search]").disabled = busy || !configured || !input.value.trim();
    for (const field of form.elements) field.disabled = busy;
  }
  function error(error) { message.textContent = error?.message || "ArtHub 操作失败，请重试"; }
  async function status() {
    const value = await bridge.folderStatus();
    configured = value.configured;
    for (const key of ["environment", "assetHub", "rootPath"]) form.elements[key].value = value[key];
    form.elements.token.value = "";
    form.hidden = configured;
    sync();
  }
  async function search() {
    if (busy || !configured || !input.value.trim()) return;
    const name = input.value.trim(), captured = ++revision;
    busy = true; sync(); results.replaceChildren();
    message.textContent = `正在查找 ${name}…`;
    try {
      const response = await bridge.searchFolders({ projectName: name });
      if (captured !== revision || name !== input.value.trim() || !dialog.open) return;
      message.textContent = response.matches.length ? `找到 ${response.matches.length} 个匹配文件夹。${response.clientReady ? "" : response.clientReason}` : `未找到与“${name}”同名的文件夹，请检查工程名和搜索范围。`;
      for (const match of response.matches) {
        const row = document.createElement("button");
        row.type = "button"; row.className = "arthub-folder-result";
        const title = document.createElement("strong"), detail = document.createElement("span");
        title.textContent = match.name;
        detail.textContent = `${match.assetHub} / ${match.path}`;
        row.append(title, detail);
        row.disabled = !response.clientReady;
        row.title = response.clientReady ? "在 ArtHub 客户端打开" : response.clientReason;
        row.addEventListener("click", async () => {
          if (name !== input.value.trim() || captured !== revision) return;
          row.disabled = true;
          try { await bridge.openFolder({ resultId: match.resultId }); dialog.close(); }
          catch (e) { error(e); row.disabled = false; }
        });
        results.append(row);
      }
      if (response.matches.length === 1 && response.clientReady) results.firstChild.click();
    } catch (e) { if (captured === revision && dialog.open) error(e); }
    finally { busy = false; sync(); }
  }
  button.addEventListener("click", async () => {
    if (busy) return;
    dialog.showModal(); message.textContent = "正在读取连接设置…";
    try { await status(); if (configured) await search(); else message.textContent = "首次使用，请连接 ArtHub 并指定搜索资源库。"; }
    catch (e) { error(e); }
  });
  form.addEventListener("submit", async (event) => {
    event.preventDefault(); if (busy) return;
    const payload = Object.fromEntries(new FormData(form));
    busy = true; sync(); message.textContent = "正在验证连接…";
    try {
      await bridge.configureFolders(payload);
      configured = true; form.hidden = true;
      message.textContent = "连接已保存，点击“重新查找”搜索当前工程。";
    } catch (e) { error(e); }
    finally { payload.token = ""; form.elements.token.value = ""; busy = false; sync(); }
  });
  dialog.querySelector("[data-close]").onclick = () => dialog.close();
  dialog.querySelector("[data-search]").onclick = search;
  dialog.querySelector("[data-settings]").onclick = () => { form.hidden = !form.hidden; };
  dialog.addEventListener("close", () => { revision++; form.elements.token.value = ""; button.focus({ preventScroll: true }); });
  input.addEventListener("input", () => { revision++; results.replaceChildren(); if (dialog.open) message.textContent = "工程名已变化，请重新查找。"; sync(); });
  // Existing session restoration assigns input.value without emitting input events.
  new MutationObserver(sync).observe(document.getElementById("workView"), { childList: true, subtree: true, attributes: true, attributeFilter: ["class"] });
  sync();
})();
