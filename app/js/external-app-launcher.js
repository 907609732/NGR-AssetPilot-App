/* NGR AssetPilot desktop quick app launcher */
(function initializeExternalAppLauncher(globalScope) {
  "use strict";

  const state = { apps: [], defaultAppId: "arthub", busy: false };

  function elements() {
    return {
      menu: document.querySelector("#externalAppMenu"),
      primary: document.querySelector("#externalAppPrimary"),
      primaryLabel: document.querySelector("#externalAppPrimaryLabel"),
      add: document.querySelector("#externalAppAdd"),
      list: document.querySelector("#externalAppList"),
      status: document.querySelector("#externalAppStatus"),
    };
  }

  function setStatus(message, error = false) {
    const { status } = elements();
    if (!status) return;
    status.textContent = String(message || "");
    status.classList.toggle("is-error", error);
  }

  function displayError(error) {
    return String(error?.message || error || "操作失败");
  }

  function render() {
    const dom = elements();
    if (!dom.menu) return;
    const defaultApp = state.apps.find((app) => app.id === state.defaultAppId) || state.apps[0];
    dom.primaryLabel.textContent = defaultApp?.available ? `打开 ${defaultApp.name}` : "配置 ArtHub";
    dom.primary.dataset.appId = defaultApp?.id || "arthub";
    dom.list.replaceChildren();
    for (const app of state.apps) {
      const row = document.createElement("div");
      row.className = "external-app-row";
      row.setAttribute("role", "listitem");
      const launch = document.createElement("button");
      launch.type = "button";
      launch.className = "external-app-launch";
      launch.dataset.appId = app.id;
      const name = document.createElement("span");
      name.textContent = app.name;
      const availability = document.createElement("small");
      availability.textContent = app.available ? "已就绪 · 点击打开" : "路径未配置或已失效";
      launch.append(name, availability);
      const configure = document.createElement("button");
      configure.type = "button";
      configure.className = "external-app-configure";
      configure.dataset.configureAppId = app.id;
      configure.textContent = app.available ? "重选" : "配置";
      configure.setAttribute("aria-label", `重新选择 ${app.name}`);
      row.append(launch, configure);
      if (!app.builtin) {
        const remove = document.createElement("button");
        remove.type = "button";
        remove.className = "external-app-remove";
        remove.dataset.removeAppId = app.id;
        remove.textContent = "×";
        remove.setAttribute("aria-label", `移除 ${app.name} 快捷入口`);
        row.append(remove);
      }
      dom.list.append(row);
    }
  }

  async function refresh() {
    const result = await globalScope.NgrDesktopBridge.externalApps.list();
    state.apps = Array.isArray(result?.apps) ? result.apps : [];
    state.defaultAppId = result?.defaultAppId || "arthub";
    render();
  }

  async function choose(appId) {
    if (state.busy) return;
    state.busy = true;
    setStatus("请选择电脑中的 EXE 应用程序…");
    try {
      const result = await globalScope.NgrDesktopBridge.externalApps.choose(appId ? { appId } : {});
      if (!result?.canceled) {
        state.apps = result.apps || [];
        state.defaultAppId = result.defaultAppId || state.defaultAppId;
        render();
        setStatus("快捷应用已保存");
      } else setStatus("");
    } catch (error) {
      setStatus(displayError(error), true);
    } finally {
      state.busy = false;
    }
  }

  async function launch(appId) {
    const app = state.apps.find((item) => item.id === appId);
    if (!app?.available) return choose(app?.id || appId);
    if (state.busy) return;
    state.busy = true;
    setStatus(`正在打开 ${app.name}…`);
    try {
      await globalScope.NgrDesktopBridge.externalApps.launch({ appId: app.id });
      setStatus(`${app.name} 已打开`);
      elements().menu.open = false;
    } catch (error) {
      setStatus(displayError(error), true);
    } finally {
      state.busy = false;
    }
  }

  async function remove(appId) {
    if (state.busy || !globalScope.confirm("仅移除快捷入口，不会卸载电脑软件。确定继续吗？")) return;
    state.busy = true;
    try {
      const result = await globalScope.NgrDesktopBridge.externalApps.remove({ appId });
      state.apps = result.apps || [];
      render();
      setStatus("快捷入口已移除");
    } catch (error) {
      setStatus(displayError(error), true);
    } finally {
      state.busy = false;
    }
  }

  async function init() {
    const dom = elements();
    if (!dom.menu) return;
    if (!globalScope.NgrDesktopBridge?.externalApps?.isAvailable()) {
      dom.menu.classList.add("hidden");
      return;
    }
    dom.primary.addEventListener("click", (event) => {
      if (event.target.closest(".menu-chevron")) return;
      event.preventDefault();
      void launch(dom.primary.dataset.appId || state.defaultAppId);
    });
    dom.add.addEventListener("click", () => void choose());
    dom.list.addEventListener("click", (event) => {
      const launchButton = event.target.closest("[data-app-id]");
      const configureButton = event.target.closest("[data-configure-app-id]");
      const removeButton = event.target.closest("[data-remove-app-id]");
      if (configureButton) void choose(configureButton.dataset.configureAppId);
      else if (removeButton) void remove(removeButton.dataset.removeAppId);
      else if (launchButton) void launch(launchButton.dataset.appId);
    });
    try {
      await refresh();
    } catch (error) {
      setStatus(displayError(error), true);
    }
  }

  globalScope.NgrExternalAppLauncher = Object.freeze({ init });
})(window);
