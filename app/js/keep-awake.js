(() => {
  const toggle = document.getElementById("keepAwakeEnabled");
  const mode = document.getElementById("keepAwakeMode");
  const status = document.getElementById("keepAwakeStatus");
  const description = document.getElementById("keepAwakeDescription");
  const api = window.ngrDesktop?.keepAwake;
  if (!api) { status.textContent = "请在桌面 APP 中使用防止息屏功能。"; return; }
  let busy = false;
  let saved;
  const descriptions = {
    system: "保持屏幕和系统唤醒，不移动鼠标。",
    mouse: "空闲至少 10 秒后，每隔约 30 秒左右交替微移 1 像素；操作中或按住鼠标时暂停。实际位移受系统指针设置影响，不能保证完全不可见。",
    combined: "系统保活与鼠标微动同时运行，降低单一方案失效的影响。鼠标仅空闲时每隔约 30 秒交替微移 1 像素，操作时暂停。",
  };
  function render(state) {
    saved = state;
    toggle.checked = state.enabled;
    mode.value = state.mode;
    toggle.disabled = busy;
    mode.disabled = busy;
    for (const option of mode.options) option.disabled = option.value !== "system" && !state.mouseSupported;
    description.textContent = descriptions[state.mode];
    const details = [];
    if (state.systemActive) details.push("系统保活运行中");
    if (state.mouseState === "running") details.push("鼠标微动待命（空闲时移动）");
    if (state.mouseState === "starting") details.push("鼠标微动正在启动…");
    status.textContent = state.errors.length ? state.errors.join(" ") : !state.enabled ? "已关闭 · 设置自动保存" : state.paused ? "已开启 · 锁屏或休眠期间暂停" : `已开启 · ${details.join("；") || "等待启动"}`;
  }
  async function refresh() {
    if (busy) return;
    busy = true;
    try { const state = await api.getState(); busy = false; render(state); }
    catch { status.textContent = "防止息屏状态读取失败，请重新打开软件。"; }
    finally { busy = false; }
  }
  async function save() {
    if (busy) return;
    busy = true;
    toggle.disabled = mode.disabled = true;
    try { const state = await api.setSettings({ enabled: toggle.checked, mode: mode.value }); busy = false; render(state); }
    catch {
      busy = false;
      if (saved) render(saved);
      status.textContent = "保存失败，未更改设置，请重试。";
    } finally { busy = false; }
  }
  toggle.addEventListener("change", save);
  mode.addEventListener("change", save);
  void refresh();
  setInterval(() => { if (document.getElementById("generalSettingsView")?.classList.contains("active")) void refresh(); }, 3000);
})();
