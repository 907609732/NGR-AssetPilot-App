# 防止息屏

入口：设置 → 数据与关于 → 防止息屏。

- 新用户默认关闭；主开关和模式立即保存到当前用户、当前版本的数据目录 `keep-awake.json`。重新启动 APP 自动恢复，不设置开机启动。
- 系统保活：Electron `powerSaveBlocker` 的 `prevent-display-sleep`，保持屏幕和系统唤醒。
- 鼠标微动：Windows `SendInput`，空闲至少 10 秒且距离上次微动至少 30 秒时发送左右交替的单单位相对移动。按住鼠标或修饰键时跳过。通常约 1 像素，实际位移受系统指针设置影响，不保证完全不可见。
- 双重保活：同时运行上述两种机制；鼠标进程失败不会撤销系统保活。失败显示在设置页，每 30 秒尝试恢复。
- 最小化期间有效；退出软件释放保活请求并终止鼠标进程。辅助进程也监控标准输入 EOF，APP 异常退出时停止。锁屏、休眠时暂停，解锁和恢复后继续。
- 不能覆盖系统强制策略、手动锁屏、关机、合盖或强制休眠。未修改 Windows 电源方案或 PowerShell 执行策略。

固定的内置 PowerShell/C# 命令仅调用 Windows API，无额外下载、管理员权限或原生 npm 编译依赖。通过编码参数传入，兼容打包后的 ASAR 路径；不接受渲染进程传入命令。读写设置使用受信任主窗口的窄 IPC，并校验布尔值及模式枚举。

参考现成方案与官方 API：

- [Electron powerSaveBlocker](https://www.electronjs.org/docs/latest/api/power-save-blocker)
- [Microsoft PowerToys Awake](https://learn.microsoft.com/windows/powertoys/awake)
- [Windows MOUSEINPUT](https://learn.microsoft.com/windows/win32/api/winuser/ns-winuser-mouseinput)

验证：`node --test tests/keep-awake.test.mjs tests/keep-awake-electron.test.mjs`。Electron 测试使用独立测试数据目录，覆盖默认关闭、切换、真实辅助进程启动、重启恢复及关闭；截图位于 `artifacts/keep-awake/settings.png`。长时间空闲不息屏仍受目标机器电源和组织策略影响，测试不会修改用户的屏幕超时设置。
