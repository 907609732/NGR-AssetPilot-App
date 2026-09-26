(() => {
  const toggle = document.getElementById("autoStartEnabled");
  const status = document.getElementById("autoStartStatus");
  const api = window.ngrDesktop?.autoStart;
  if (!api) { status.textContent = "请在 Windows 安装版中设置开机自启动。"; return; }
  let busy = false;
  function render(state) {
    toggle.checked = state.enabled;
    toggle.disabled = !state.supported;
    status.textContent = !state.supported ? "请在 Windows 安装版中设置开机自启动。" : state.blocked ? "已被 Windows 禁用，可重新开启。" : state.enabled ? "已开启 · 登录 Windows 时自动打开软件" : "已关闭 · 不随 Windows 启动";
  }
  async function refresh() {
    if (busy) return;
    busy = true;
    try { render(await api.getState()); }
    catch { toggle.disabled = true; status.textContent = "状态读取失败，请重新打开设置。"; }
    finally { busy = false; }
  }
  toggle.addEventListener("change", async () => {
    if (busy) return;
    busy = true;
    toggle.disabled = true;
    try { render(await api.setSettings({ enabled: toggle.checked })); }
    catch {
      try { render(await api.getState()); } catch { toggle.disabled = true; }
      status.textContent = "设置未保存，请重试或检查 Windows 启动应用设置。";
    } finally { busy = false; }
  });
  window.addEventListener("focus", refresh);
  void refresh();
})();
