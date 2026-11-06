# NGR AssetPilot 桌面版安装、开发与数据说明

本文按 **v3.0.24（2026-11-04 发布）**核对。普通用户安装 Windows x64 正式版即可；开发命令需要该版本的源码。

**源码版本提醒：**2026-11-06 核对时，默认分支 `main` 的 `package.json` 仍为 `3.0.11`，最新正式发布对应 `v3.0.24` 标签。本次文档更新不替换程序源码；请按下方步骤获取 `v3.0.24` 后再使用新版启动入口。

## 下载与安装

1. 打开 [最新正式版 Release](https://github.com/907609732/NGR-AssetPilot-App/releases/latest)。
2. 在 **Assets** 下载 `NGR-AssetPilot-<版本号>-Setup-x64.exe`。本文对应 [v3.0.24 安装包](https://github.com/907609732/NGR-AssetPilot-App/releases/download/v3.0.24/NGR-AssetPilot-3.0.24-Setup-x64.exe)。
3. 运行安装器，按向导选择安装位置，完成后从桌面或开始菜单打开 **NGR AssetPilot**。
4. 在设置的“数据与关于”中查看版本；正式版不显示 `DEV 开发版` 或 `TEST 测试版` 徽标。

Release 下的 `Source code (zip)` / `Source code (tar.gz)` 是源码，`.blockmap` 和 `latest.yml` 是更新元数据，都不是普通用户的安装入口。安装正式版无需自行安装 Node.js、Python 或 CUDA。TAPD 采集需要另行安装 **Google Chrome**，并在软件打开的专用 Chrome 窗口中登录 TAPD。

v3.0.24 沿用未签名构建，Windows 可能显示“未知发布者”。可使用同一 Release 的 `NGR-AssetPilot-3.0.24-SHA256SUMS.txt` 核对下载文件：

```powershell
Get-FileHash .\NGR-AssetPilot-3.0.24-Setup-x64.exe -Algorithm SHA256
```

日常操作见[桌面版使用教程](docs/NGRAI辅助UI切图命名工具-使用教程脚本与图文教程.md)。

## 正式版更新

打开 **设置 → 数据与关于 → 检查更新**，查看版本说明后点击“下载更新”。v3.0.24 的更新流程在下载及完整性检查完成后，会进入保存工作区、自动关闭、静默安装和重新打开流程，不需要再手动点击“安装”。请在当前采集、导出等任务完成后发起更新。

应用内正式更新面向已安装的正式版。源码开发版、测试版、内部 portable 包以及浏览器兼容模式不使用该正式更新流程；更新失败时可从 Release 下载 Setup 安装器。

## 正式版、开发版与测试版

| 版本 | 应用名称 | 主应用数据目录 | 构建输出 |
| --- | --- | --- | --- |
| 正式版 | `NGR AssetPilot` | `%APPDATA%\NGR AssetPilot` | `artifacts/prod` |
| 开发版 | `NGR AssetPilot Dev` | `%APPDATA%\NGR AssetPilot Dev` | `artifacts/dev` |
| 测试版 | `NGR AssetPilot Test` | `%APPDATA%\NGR AssetPilot Test` | `artifacts/test` |

三版拥有不同应用 ID 和主数据目录，命名工作区、项目设置、API 凭据、图库索引、模型与缩略图分别管理。首次启动且目标目录尚无搜图资料时，程序可能从兼容的旧版目录复制本地搜图资料，原目录保留；这不是持续同步。

**v3.0.24 的两个例外：**TAPD 报表与专用 Chrome 登录资料使用 `%APPDATA%\TAPD月报工具`，不按上述三版划分；快速找界面的扩展安装目录位于 `%APPDATA%\NGR\extensions`，扩展项目资料和缓存才放在对应宿主的主数据目录内。调试这些功能时应留意现有资料。

## 工作区保存、备份与迁移

桌面版会将命名记录、导入图片、参考图和编辑状态保存到本机应用资料中，不依赖用户日常使用的 Chrome/Edge 浏览器。使用同一 Windows 用户和同一应用版本身份重新打开软件，可以继续已有工作区。

在“数据与关于”中导出或导入 `.ngrap` 迁移包，迁移内容包括设置、命名进度、切图和参考图。该文件不是整个应用数据目录的完整备份：

- 桌面版新导出的 `.ngrap` **不包含 Windows 安全存储中的 API 密钥**；在新设备上需重新填写。旧版含加密凭据的迁移包仍可使用原迁移密码导入。
- 本地搜图的源图库、向量索引、模型及缩略图独立管理；模型可使用 `.ngrmodel` 离线包迁移。
- TAPD 报表、专用 Chrome 登录资料、媒体导出目录和快速找界面扩展资料也不属于命名工作区迁移包。

从旧 Web 版迁移时，先在原浏览器、原工具地址导出 `.ngrap`，再到桌面版导入。仅安装桌面程序不会自动读取另一浏览器的站点数据。详细边界见[数据与安全说明](docs/安全性说明.md)。

## 本地 AI 搜图与离线模型

在“本地 AI 搜图”中选择本机图片文件夹并建立索引；模型就绪后，图库分析、截图/图片搜索和中英文文字搜索均在本机运行。首次准备模型可联网下载；离线电脑可在模型管理中使用“导入离线包”导入 `.ngrmodel`，校验版本、文件清单、大小和 SHA-256 后启用。

- 支持 JPEG、PNG、WebP、BMP、GIF 首帧和 TIFF。源图片目录保持只读，删除图库只清理对应索引和缩略图。
- 查询图在内存中处理，不保存搜索文字、查询截图或搜索历史。
- Windows 图库分析可使用 DirectML 批量推理，设备不可用或不兼容时回退 CPU；无需自行安装 CUDA 或 Python。
- 模型、执行设备或索引配置变化时，软件可能要求重新分析。不同模型的向量索引独立，不能混用旧向量。
- 支持经过隔离验证的自定义 ONNX embedding 模型。图像单塔提供图片搜索；图文双塔通过维度与 tokenizer 校验后才提供文字搜索。
- 自定义模型仅接受规定的模型及数据文件，不加载脚本或自定义算子 DLL；推理阶段关闭远程模型访问。

“本地 AI 搜图”与“快速找界面”是两个入口。后者使用独立扩展 ZIP，不随宿主安装包附带扩展模型。v3.0.24 Release 记录已验证扩展 `0.7.0`，公开旧独立版 `0.5.7` 不能作为扩展导入；兼容扩展包当时尚未公开下载，需单独交付。首次导入或点击“重新检查”会完整校验；日常打开复用持久校验记录，发现文件变化再完整检查。

## 获取 v3.0.24 源码并开发

开发环境要求 **Windows、Git、Node.js `>=22.13.0` 和 npm**；对应发布工作流使用 Node.js 24。下面在新目录检出已发布标签，避免把旧 `main` 误当成最新版：

```powershell
git clone --branch v3.0.24 --single-branch https://github.com/907609732/NGR-AssetPilot-App.git NGR-AssetPilot-v3.0.24
cd NGR-AssetPilot-v3.0.24
git switch -c work/desktop-v3.0.24
npm.cmd ci
npm.cmd run env:check
npm.cmd start
```

完成首次依赖安装后，也可双击该源码目录中的 **`AI资源领航 开发版（打开或重启）.cmd`**。

- 新版启动入口会先编译 TAPD 的 TypeScript/React 运行文件，再打开开发版；这是源码准备，不生成安装包。
- 同目录开发版已运行时，再次使用该入口会先保存并清理服务，再重启以加载修改；编译失败不会重启旧实例。
- 另一个工作树的开发版运行时会提示源码目录。退出旧工作树的开发版后再启动目标目录，避免验证到旧代码。
- 没有后台自动刷新或自动重启；修改后需再次启动入口。`npm.cmd run dev` 仍可直接打开开发版，但重复执行保留原有唤醒行为。
- `npm.cmd ci` 只在首次准备、锁文件变化或依赖缺失时需要执行。启动入口不会自动安装依赖。

只运行默认分支的旧源码时，应以该工作树的 `package.json` 为准；`3.0.11` 可用 `npm.cmd run dev`，没有本节新增的 `npm.cmd start` 和“打开或重启”入口，也不含 v3.0.24 的全部功能。

## 测试与发布构建

在 v3.0.24 源码中，根据改动范围运行验证：

```powershell
# 隔离的测试版主工作区
npm.cmd run dev:test
# 自动化测试（先准备 TAPD 运行文件）
npm.cmd test
```

仅修改文档时检查格式、链接和事实即可；日常功能修改使用源码开发版验证，不必为了查看界面而生成安装包。准备正式发布时，再进行构建、安装器和自动更新验收：

```powershell
npm.cmd run build:prod
npm.cmd run verify:packaged:prod
# 内部版本按需构建
npm.cmd run build:dev
npm.cmd run build:test
```

正式版生成 Windows x64 Setup；开发版和测试版另外生成 portable x64 EXE。发布流程还生成 SHA-256、SBOM、构建清单和更新元数据，并检查扩展版本。产物包含 `LICENSE` 和 `THIRD-PARTY-NOTICES.md`，不内置用户 API 凭据。

优先使用 GitHub 的 **Desktop Production Release** 工作流。手动运行用于构建和验收；推送符合规则的版本 tag 会触发公开 Release，应仅在明确准备发布时执行。发布前同步 `package.json`、相关版本信息与 `docs/releases/v<版本号>.md`；工作流实际读取该 Markdown 并追加扩展版本检查结果。源码测试通过不能替代安装器、自动更新和打包资源验收。

需要测量图库分析性能时，可使用独立测试库：

```powershell
npm.cmd run test:local-image-search:index -- --source "E:\path\to\library" --model-root "$env:APPDATA\NGR AssetPilot\local-image-search\models"
```

## 对应版本参考

- [v3.0.24 源码与开发说明](https://github.com/907609732/NGR-AssetPilot-App/tree/v3.0.24)
- [v3.0.24 package.json](https://github.com/907609732/NGR-AssetPilot-App/blob/v3.0.24/package.json)
- [v3.0.24 Release 与实际附件](https://github.com/907609732/NGR-AssetPilot-App/releases/tag/v3.0.24)
- [v3.0.24 更新实现](https://github.com/907609732/NGR-AssetPilot-App/blob/v3.0.24/desktop/services/updater-controller.mjs)
- [v3.0.24 TAPD 数据目录](https://github.com/907609732/NGR-AssetPilot-App/blob/v3.0.24/desktop/services/tapd-report-window.mjs)
