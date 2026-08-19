# API 配置安全说明

V3 不再加载 `local-config.js`。请直接在 NGR AssetPilot 的 AI 配置或翻译设置界面填写并保存自己的 API 配置。

- 严禁把 API Key、App ID、密钥、令牌或密码提交到 Git、GitHub、安装包或共享文件夹。
- `local-config.example.js` 只用于说明字段格式，必须始终保留占位值。
- `local-config.js` 是被忽略的兼容文件，只能保留空对象，不再作为运行时配置来源。
- 网页版配置位于当前浏览器 origin 的 localStorage，不属于系统级加密存储。
- Windows 桌面版通过 Electron safeStorage / Windows DPAPI 保存凭据。
- `.ngrap` 只有主动勾选“携带加密凭据”时才包含凭据，并要求至少 12 位迁移密码。

任何曾提交到版本历史或分发过的凭据都应在服务商控制台撤销并轮换；从当前文件删除并不能清除 Git 历史。
