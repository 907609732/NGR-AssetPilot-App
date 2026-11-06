# NGR AssetPilot 官方网站

官网用于介绍 NGR AssetPilot Windows 桌面应用，并提供通过下载配置校验的正式版安装器入口。当前正式产品的安装方式与功能见 [项目首页](../README.md)，下载见 [GitHub Releases](https://github.com/907609732/NGR-AssetPilot-App/releases/latest)。官网本身不是资源处理应用，用户应安装桌面版。

本目录是独立的网站工程，具有自己的依赖与构建流程。本次只更新文档，没有部署官网或变更线上下载配置；开发对应 v3.0.24 的官网时，请先获取 [该标签源码](https://github.com/907609732/NGR-AssetPilot-App/tree/v3.0.24/website)。

## 下载安全门

安装包完成凭据扫描、上传并验证 HTTPS 直链后，按 `.env.example` 配置：

- `NGR_RELEASE_EXE_URL`：官方 GitHub Release 的 Setup EXE 地址。
- `NGR_RELEASE_VERSION`：标准版本号，例如 `3.0.24`，并须出现在文件名和 Release 标签中。
- `NGR_RELEASE_SHA256`：已验收安装包的 64 位 SHA-256。
- `NGR_RELEASE_VERIFIED=1`：确认远程文件和本地验收包一致。
- `NGR_RELEASE_CREDENTIAL_SCAN_PASSED=1`：确认安装包不含内置平台凭据。

全部留空时网站显示“Windows 版准备中”。部分配置或校验失败会直接中止构建。官网 canonical 为 `https://ngr.lttlt.top`。

## 本地命令

```powershell
npm ci
npm run dev
npm run lint
npm test
```

官网依赖与输出仅位于 `website/`，不会进入桌面安装包。
