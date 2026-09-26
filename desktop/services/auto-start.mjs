import { DesktopError, isPlainRecord } from "../shared/core.mjs";

export class AutoStartService {
  constructor({ app, platform = process.platform, executable = process.execPath }) {
    this.app = app;
    this.supported = platform === "win32" && app.isPackaged;
    this.options = { path: executable, args: [], name: app.getName() };
  }

  getState() {
    if (!this.supported) return { supported: false, enabled: false, blocked: false };
    // openAtLogin only checks the AppUserModelId entry, ignoring custom names.
    // Quote the lookup path so Windows correctly parses paths containing spaces.
    const state = this.app.getLoginItemSettings({ path: `"${this.options.path}"`, args: [] });
    const item = state.launchItems?.find((entry) => entry.name === this.options.name && entry.scope === "user" && !entry.args?.length);
    return {
      supported: true,
      enabled: Boolean(item?.enabled),
      blocked: Boolean(item && !item.enabled),
    };
  }

  setSettings(request) {
    if (!isPlainRecord(request) || typeof request.enabled !== "boolean" || Object.keys(request).some((key) => key !== "enabled")) {
      throw new DesktopError("AUTO_START_INVALID", "开机自启动设置无效");
    }
    if (!this.supported) throw new DesktopError("AUTO_START_UNSUPPORTED", "请在 Windows 安装版中设置开机自启动");
    this.app.setLoginItemSettings({ ...this.options, openAtLogin: request.enabled, enabled: request.enabled });
    const state = this.getState();
    if (state.enabled !== request.enabled) throw new DesktopError("AUTO_START_SAVE_FAILED", "开机自启动设置未生效，请检查 Windows 启动应用设置");
    return state;
  }
}
