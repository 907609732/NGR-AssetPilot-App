import test from "node:test";
import assert from "node:assert/strict";
import { AutoStartService } from "../desktop/services/auto-start.mjs";

test("开机自启动读取系统状态，默认不写启动项，开关可撤销", () => {
  let enabled = false;
  let blocked = false;
  const calls = [];
  const app = { isPackaged: true, getName: () => "NGR AssetPilot",
    getLoginItemSettings: (options) => {
      assert.equal(options.path, '"C:\\Program Files\\NGR AssetPilot\\NGR AssetPilot.exe"');
      return { openAtLogin: false, launchItems: enabled ? [{ name: "NGR AssetPilot", scope: "user", args: [], enabled: !blocked }] : [] };
    },
    setLoginItemSettings: (settings) => { calls.push(settings); enabled = settings.openAtLogin; blocked = false; } };
  const service = new AutoStartService({ app, platform: "win32", executable: "C:\\Program Files\\NGR AssetPilot\\NGR AssetPilot.exe" });
  assert.equal(service.getState().enabled, false);
  assert.equal(calls.length, 0);
  assert.equal(service.setSettings({ enabled: true }).enabled, true);
  assert.equal(calls[0].path, "C:\\Program Files\\NGR AssetPilot\\NGR AssetPilot.exe");
  blocked = true;
  assert.deepEqual(service.getState(), { supported: true, enabled: false, blocked: true });
  assert.equal(service.setSettings({ enabled: true }).enabled, true);
  assert.equal(service.setSettings({ enabled: false }).enabled, false);
  assert.throws(() => service.setSettings({ enabled: true, path: "other.exe" }), { code: "AUTO_START_INVALID" });
  assert.throws(() => service.setSettings({ enabled: "true" }), { code: "AUTO_START_INVALID" });
});

test("开发环境不会注册自启动", () => {
  const service = new AutoStartService({ app: { isPackaged: false, getName: () => "Dev" }, platform: "win32" });
  assert.equal(service.getState().supported, false);
  assert.throws(() => service.setSettings({ enabled: true }), { code: "AUTO_START_UNSUPPORTED" });
});
