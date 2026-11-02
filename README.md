# NGR AssetPilot｜功能与使用

NGR AssetPilot（AI资源领航）是面向游戏 UI 资源整理的 Windows 桌面工具。正式产品是 Electron 应用；根目录的 `点击启动服务.html` 仅供浏览器兼容使用，桌面专属功能以安装版为准。当前工程版本见 `package.json`。系统边界、模块位置和数据流见 [架构文档](docs/ARCHITECTURE.md)。

作者：五成（月财） · [项目仓库](https://github.com/907609732/NGR-AssetPilot-App) · [官网](https://ngr.lttlt.top)

## 功能

| 功能 | 主要操作与结果 |
| --- | --- |
| 切图命名 | 导入文件夹、单图和参考图；使用项目方案、词库、本地知识库、翻译或 AI 视觉推荐名称；逐张编辑、批量前缀/工程名/界面名、后缀和序号；重名时阻止误导出。导出只改文件名，不重编码图片。 |
| 进度与方案 | 命名记录、原图、参考图和编辑状态在本机保存；支持完整列表、紧凑列表、画册、项目方案及规则模板导入导出。清除浏览器站点数据会影响浏览器兼容模式的记录。 |
| UI 切图检测 | 检查格式、尺寸、奇数宽高、大图倍数、重复资源等规则；可筛选问题与警告。列表删除只移出当前工作区，不删除磁盘源图。具体阈值由当前项目方案决定。 |
| 本地 AI 搜图 | 将所选图库建立本地向量索引，按文件夹浏览，支持截图、图片和中英文文字搜索；源图库只读。支持 DirectML、CPU 回退、离线模型包和通过隔离验证的自定义 ONNX 模型。 |
| TAPD 周报与月报 | 选择周报/月报及日期范围，快捷选“本周”“上周”“今天”，登录 TAPD 后抓取；周报正文逐条显示 S 等级，可独立勾选添加日期和人天；支持复制周报、导出 Excel、草稿确认。月报 Excel 可勾选加入当前范围内已提取的 Bug 图片附件。 |
| TAPD Bug 媒体 | 从 Bug 描述、评论和附件提取可下载图片及视频，按单号保存；“Bug 媒体”页可搜索单号/标题、看原图、复制图片、播放视频和定位文件。图片预览会缩小显示，放大与复制使用保存的完整图片；视频不嵌入 Excel。 |
| 更多工具 | 应用内教程、网络与 API 诊断、ArtHub 工程文件夹只读查询、防止息屏、开机启动、版本更新、快速找界面扩展工作台。部分外部服务需用户自行配置。 |

### TAPD 使用顺序

1. 在“基地提单表与 TAPD 报表”选择周报或月报和日期，或使用快捷日期。
2. 登录 TAPD，抓取所选日期。日期超出已抓取范围时重新抓取。
3. 需要 Bug 媒体时执行“提取 Bug 图片和视频”，在“Bug 媒体”页按单号浏览。
4. 导出月报 Excel 时可勾选“包含 Bug 图片附件”；该选项使用已经提取并且属于当前报告范围的图片。

媒体详情最多并行读取 2 单，下载最多并行 4 项。支持可下载的 MP4、WebM、MOV/M4V；单视频限 250 MB，单图片限 50 MB。无法直接下载的 blob、HLS/DASH 播放列表会记入失败清单。播放器不支持的编码可通过“定位文件”交给本地播放器。

### 数据与隐私

- 源图库只读；索引、模型和缩略图位于对应版本的本机应用数据目录。
- 浏览器兼容模式的项目和命名记录使用当前 origin 的 localStorage/IndexedDB。桌面版凭据使用 Windows DPAPI 安全存储；API 配置不从 `app/API配置文件/local-config.js` 加载。
- 本地知识库命名、切图检测和模型就绪后的本地搜图不向外发送图片。百度文本翻译发送待译文本；AI 视觉命名会将用户选用的切图、参考图和相关命名上下文发送给所选服务。
- 图片 ZIP 导出在本地完成；目标目录由用户选择。备份和迁移应使用软件内的数据工具；删除本机应用数据目录前请先备份。
- ArtHub 文件夹查询只读，当前“打开 ArtHub 客户端定位”尚未完成真实协议验证。快速找界面使用独立扩展 ZIP 和自己的资料目录，不随宿主安装包附带模型。

## 开发、测试和构建

要求 Windows、Node.js `>=22.13.0`。使用项目锁文件安装依赖：

```powershell
npm.cmd ci
npm.cmd run env:check
npm.cmd run dev
npm.cmd test
```

`npm.cmd run dev:test` 启动隔离的测试版。三种身份分别为正式版 `NGR AssetPilot`、开发版 `NGR AssetPilot Dev` 和测试版 `NGR AssetPilot Test`，各有独立应用 ID、用户资料和安装产物目录。构建命令：

```powershell
npm.cmd run build:prod
npm.cmd run verify:packaged:prod
# 按需构建内部版本：npm.cmd run build:dev / build:test
```

正式版生成 Windows x64 Setup、更新清单、SHA-256、SBOM 和构建清单，输出到 `artifacts/prod`。打包包含 `LICENSE` 和 `THIRD-PARTY-NOTICES.md`。`docs/releases/v<package.json 版本>.md` 是 GitHub Release 工作流实际读取的发布说明，发布新版本时需同步更新。当前工作树的源码功能可能领先于已发布的安装包；确认功能应以对应源码构建及实际验收为准。

本地图库性能测试使用独立测试库，不修改正式版资料：

```powershell
npm.cmd run test:local-image-search:index -- --source "E:\path\to\library" --model-root "$env:APPDATA\NGR AssetPilot\local-image-search\models"
```

官网在 `website/`，使用独立锁文件和构建流程。下载链接需经安装包哈希、凭据扫描及 HTTPS 直链核对后按 `website/.env.example` 配置；配置不完整时网站构建会拒绝提供安装包下载。百度翻译 CFC 使用 Node.js 22，打包命令为 `npm.cmd run package:cfc`，密钥只能放在服务端环境变量中。

## 其他文件

- [架构文档](docs/ARCHITECTURE.md)：源码结构、数据流、安全边界和部署边界。
- [当前版本说明](docs/releases/v3.0.23.md)：GitHub Release 工作流读取的版本说明。旧版说明与旧教程可从 Git 历史和对应 tag 查阅。
- [许可证](LICENSE)与[第三方声明](THIRD-PARTY-NOTICES.md)：分发所需法律文本。
