export class TrayController {
  constructor({ app, Tray, Menu, iconPath, applicationName, getWindow, shouldHideOnClose }) {
    if (!app || typeof Tray !== "function" || !Menu || typeof Menu.buildFromTemplate !== "function") {
      throw new TypeError("tray controller requires Electron app, Tray and Menu");
    }
    this.app = app;
    this.Tray = Tray;
    this.Menu = Menu;
    this.iconPath = iconPath;
    this.applicationName = applicationName;
    this.getWindow = getWindow;
    this.shouldHideOnClose = shouldHideOnClose;
    this.tray = null;
    this.window = null;
    this.hasShownHideNotice = false;
    this.onWindowClose = (event) => this.#hideOnClose(event);
    this.showMainWindow = this.showMainWindow.bind(this);
  }

  initialize() {
    if (this.tray && !this.tray.isDestroyed?.()) return this.tray;
    const tray = new this.Tray(this.iconPath);
    try {
      tray.setToolTip(`${this.applicationName} · 点击打开主界面`);
      tray.setContextMenu(this.Menu.buildFromTemplate([
        { label: "打开主界面", click: this.showMainWindow },
        { type: "separator" },
        { label: "退出软件", click: () => this.app.quit() },
      ]));
      tray.on("click", this.showMainWindow);
      tray.on("double-click", this.showMainWindow);
      this.tray = tray;
      return tray;
    } catch (error) {
      tray.destroy?.();
      throw error;
    }
  }

  attachWindow(window) {
    if (this.window && !this.window.isDestroyed()) {
      this.window.removeListener("close", this.onWindowClose);
    }
    this.window = window;
    window.on("close", this.onWindowClose);
  }

  #hideOnClose(event) {
    const window = this.getWindow?.() || this.window;
    if (!window || window.isDestroyed() || !this.shouldHideOnClose?.()) return;
    event.preventDefault();
    window.setSkipTaskbar?.(true);
    window.hide();
    if (!this.hasShownHideNotice && typeof this.tray?.displayBalloon === "function") {
      this.hasShownHideNotice = true;
      this.tray.displayBalloon({
        iconType: "info",
        title: this.applicationName,
        content: "软件仍在后台运行，点击右下角托盘图标可重新打开。",
      });
    }
  }

  showMainWindow() {
    const window = this.getWindow?.() || this.window;
    if (!window || window.isDestroyed()) return false;
    window.setSkipTaskbar?.(false);
    if (window.isMinimized?.()) window.restore();
    window.show();
    window.focus();
    return true;
  }

  dispose() {
    if (this.window && !this.window.isDestroyed()) {
      this.window.removeListener("close", this.onWindowClose);
    }
    this.window = null;
    if (this.tray && !this.tray.isDestroyed?.()) {
      this.tray.removeListener?.("click", this.showMainWindow);
      this.tray.removeListener?.("double-click", this.showMainWindow);
      this.tray.destroy();
    }
    this.tray = null;
  }
}
