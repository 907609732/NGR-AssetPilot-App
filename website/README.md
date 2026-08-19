# NGR AssetPilot 官方网站

官网介绍 NGR AssetPilot V3，并只向用户提供已验收的 Windows 测试版下载；开发版保留在本地开发流程中。默认不提供 EXE 链接，避免指向尚未完成验收的产物。

## 下载安全门

安装包完成凭据扫描、上传并验证 HTTPS 直链后，按 `.env.example` 配置：

- `NGR_RELEASE_EXE_URL`：官方 GitHub Release 的 Setup EXE 地址。
- `NGR_RELEASE_VERSION`：标准版本号，例如 `3.0.0`，并须出现在文件名和 Release 标签中。
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
