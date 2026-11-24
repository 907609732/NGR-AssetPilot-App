# NGR AssetPilot 官网

官网：<https://ngr.lttlt.top/>

应用仓库：<https://github.com/907609732/NGR-AssetPilot-App>

正式下载：<https://github.com/907609732/NGR-AssetPilot-App/releases/latest>

本目录是 Windows 桌面应用的产品介绍与下载网站，使用 Vinext、React 和 Cloudflare Worker。它不是应用本体，也不在浏览器中处理用户的资源文件。

## 本地开发与验证

要求 Node.js 22.13.0 或更高版本。进入本目录后运行：

```sh
npm ci
npm run dev
```

```sh
npm test
```

`npm test` 构建网站，并验证 Release 元数据、失败兜底和服务端渲染的产品说明及下载入口。仅构建时运行 `npm run build`。生成文件位于 `dist/`，不提交到源码仓库。

## 下载版本如何同步

`lib/desktop-release.mjs` 在服务端读取官方仓库的公开 GitHub Releases API：

```text
https://api.github.com/repos/907609732/NGR-AssetPilot-App/releases/latest
```

只有正式发布且非预发布的 `vMAJOR.MINOR.PATCH` 版本可以成为下载入口。安装器须为同版本的 `NGR-AssetPilot-MAJOR.MINOR.PATCH-Setup-x64.exe`，同时核对官方仓库地址、已上传状态、文件大小、GitHub 提供的 SHA-256 摘要与校验文件附件。

成功结果在单个服务实例中缓存 5 分钟；请求失败时保留最近一次有效结果，并在 30 秒后允许重试。请求与 JSON 读取总超时为 3 秒。没有历史结果时使用已核对的 v3.0.24 安装器，页面会标注备用下载信息。API 暂时不可用不会移除下载按钮。

不需要 GitHub Token，也不再使用 `NGR_RELEASE_*` 环境变量。API 获取的是发行元数据，安装器和校验文件由用户直接从 GitHub 下载。

## 新版本发布后

1. 按应用仓库的发行流程发布正式 Release、Setup x64 安装器和 `SHA256SUMS.txt`。
2. 官网下载版本会在重新获取成功后更新；确认下载文件、文件名、版本号与哈希对应。
3. 新功能介绍、安装步骤和更新摘要仍需按已发布版本人工核实，不能仅靠版本号自动生成。同步 `app/page.tsx`、`app/layout.tsx` 以及必要的图片。
4. 定期把 `FALLBACK_RELEASE` 更新为已经核验的稳定版本，同时保留测试。失败兜底不代表能在无法访问 GitHub 时得知最新发行。
5. 运行构建与测试，再发布网站，并核对正式域名。仅推送应用仓库中的 `website/` 代码不等于官网已经部署。

## 网站维护范围

- `app/page.tsx`：产品介绍、安装说明、功能边界、更新摘要和下载入口。
- `app/layout.tsx`：中文页面元数据与分享信息。
- `app/globals.css`：自适应页面样式。
- `public/`：图标及分享图片。
- `.openai/hosting.json`：现有官网身份；维护时保留其 `project_id`。
- `tests/`：发行数据与页面输出验证。

官网不需要登录、数据库或用户上传功能。页面中的桌面窗口为界面示意，实际使用请安装客户端。代码与依赖许可继续以各自现行许可证为准；官网内容更新不改变应用的许可。
