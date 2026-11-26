# NGR AssetPilot 桌面版安装、开发与数据说明

本文按 **2026-11-26 的主干源码 v3.0.29** 核对。下载安装请查看公开 Release；主干的功能可能尚未包含在公开安装器中。

## 下载与安装

1. 打开 [最新正式版 Release](https://github.com/907609732/NGR-AssetPilot-App/releases/latest)。
2. 在 **Assets** 下载 `NGR-AssetPilot-<版本号>-Setup-x64.exe`。
3. 运行安装器，按向导选择安装位置，完成后从桌面或开始菜单打开 **NGR AssetPilot**。
4. 在设置的“数据与关于”中查看版本；正式版不显示 `DEV 开发版` 或 `TEST 测试版` 徽标。

Release 下的 `Source code (zip)` / `Source code (tar.gz)` 是源码，`.blockmap` 和 `latest.yml` 是更新元数据，都不是普通用户的安装入口。安装正式版无需自行安装 Node.js、Python 或 CUDA。TAPD 采集需要另行安装 **Google Chrome**，并在软件打开的专用 Chrome 窗口中登录 TAPD。

可使用同一 Release 中提供的 SHA-256 清单核对下载文件，以下命令使用文件名示例：

```powershell
Get-FileHash .\NGR-AssetPilot-3.0.25-Setup-x64.exe -Algorithm SHA256
```

日常操作见[桌面版使用教程](docs/NGRAI辅助UI切图命名工具-使用教程脚本与图文教程.md)。

## 正式版更新

打开 **设置 → 数据与关于 → 检查更新**，查看版本说明后点击“下载更新”。当前正式版的更新流程在下载及完整性检查完成后，会进入保存工作区、自动关闭、静默安装和重新打开流程，不需要再手动点击“安装”。请在当前采集、导出等任务完成后发起更新。

应用内正式更新面向已安装的正式版。源码开发版、测试版、内部 portable 包以及浏览器兼容模式不使用该正式更新流程；更新失败时可从 Release 下载 Setup 安装器。

## 正式版、开发版与测试版

| 版本 | 应用名称 | 主应用数据目录 | 构建输出 |
| --- | --- | --- | --- |
| 正式版 | `NGR AssetPilot` | `%APPDATA%\NGR AssetPilot` | `artifacts/prod` |
| 开发版 | `NGR AssetPilot Dev` | `%APPDATA%\NGR AssetPilot Dev` | `artifacts/dev` |
| 测试版 | `NGR AssetPilot Test` | `%APPDATA%\NGR AssetPilot Test` | `artifacts/test` |

三版拥有不同应用 ID 和主数据目录，命名工作区、项目设置、API 凭据、图库索引、模型与缩略图分别管理。首次启动且目标目录尚无搜图资料时，程序可能从兼容的旧版目录复制本地搜图资料，原目录保留；这不是持续同步。

TAPD 报表与专用 Chrome 登录资料使用 `%APPDATA%\TAPD月报工具`，可能在三种身份间共享。Finder 使用各宿主自己的扩展资料和缓存目录，旧手工安装的扩展载荷保存在 `%APPDATA%\NGR\extensions`。

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

### 快速找界面与统一离线包

主干版本从首页直接打开内置「快速找界面」。首次打开选择已有资料库或新建资料库。ArtHub 同步的项目应选择已经同步至本机的目录。右键首页入口可重置 Finder 本机设置，之后需重新选择目录。

在 Finder 的「设置与本地 AI → AI 搜图与媒体」导入统一离线 AI ZIP，一次安装 RTX 图搜模型、运行环境、媒体工具和宿主的离线中译英组件。该 ZIP 需要支持此格式的宿主。主干本地验收包约 1254.22 MiB，公开附件及完整性校验以实际交付为准。主安装器只内置工作台基础程序。

导入成功且共享 RTX 模型就绪后，宿主「本地 AI 搜图」会使用它建立新索引。已有 ONNX 索引保留，可在模型管理中切换回原模型。没有可用 RTX 时，仍可按本节原有方法安装 ONNX 权重。实现细节见[系统架构](docs/ARCHITECTURE.md)。

## 获取源码并开发

开发环境要求 **Windows、Git、Node.js `>=22.13.0` 和 npm**；对应发布工作流使用 Node.js 24。开发主干使用 `main`，复现公开安装器时检出相应发布标签：

```powershell
git clone https://github.com/907609732/NGR-AssetPilot-App.git
cd NGR-AssetPilot-App
git switch -c work/desktop
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


## 测试与发布构建

根据改动范围运行验证：

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

构建前，准备与 [组件锁](build/finder-builtin.lock.json) 匹配的 Finder 基础组件，运行 `node scripts/stage-builtin-finder.mjs "<Finder 基础组件目录>"`。云端工作流从 Finder 私有仓库检出组件锁的 `artifactCommit`，比对其中 `component.json` 的源码提交、字节数和 SHA-256，再校验实际 ASAR。公开仓库的发布环境用只读部署密钥 `NGR_FINDER_READ_KEY` 获取组件。测试包由私有 Finder 仓库手动启动同一套正式构建，输入宿主主干完整提交号，并在该次私有 Actions 运行下载产物。手动运行用于构建和验收；推送符合规则的版本 tag 会触发公开 Release，应仅在明确准备发布时执行。发布前同步 `package.json`、相关版本信息与 `docs/releases/v<版本号>.md`；工作流实际读取该 Markdown 并追加扩展版本检查结果。源码测试通过不能替代安装器、自动更新和打包资源验收。

需要测量图库分析性能时，可使用独立测试库：

```powershell
npm.cmd run test:local-image-search:index -- --source "E:\path\to\library" --model-root "$env:APPDATA\NGR AssetPilot\local-image-search\models"
```

## 对应版本参考

- [v3.0.25 源码与开发说明](https://github.com/907609732/NGR-AssetPilot-App/tree/v3.0.25)
- [v3.0.25 package.json](https://github.com/907609732/NGR-AssetPilot-App/blob/v3.0.25/package.json)
- [v3.0.25 Release 与实际附件](https://github.com/907609732/NGR-AssetPilot-App/releases/tag/v3.0.25)
- [v3.0.25 更新实现](https://github.com/907609732/NGR-AssetPilot-App/blob/v3.0.25/desktop/services/updater-controller.mjs)
- [v3.0.25 TAPD 数据目录](https://github.com/907609732/NGR-AssetPilot-App/blob/v3.0.25/desktop/services/tapd-report-window.mjs)
