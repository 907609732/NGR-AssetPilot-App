# NGR AssetPilot V3 桌面版

工程保留两个明确隔离的版本，不设正式版：

- 开发版 `NGR AssetPilot Dev`：日常开发与调试，数据位于 `%APPDATA%\NGR AssetPilot Dev`，产物位于 `artifacts/dev`。
- 测试版 `NGR AssetPilot Test`：安装与功能验收，数据位于 `%APPDATA%\NGR AssetPilot Test`，产物位于 `artifacts/test`。

两版拥有不同应用 ID、进程名、快捷方式和数据目录，设置、图库索引、模型与缩略图不会互相覆盖。首次启动时，如果各自目录尚无本地搜图数据，会从现有 `NGR AssetPilot`/旧测试目录复制迁移；来源目录不会删除。

## 开发与测试

```powershell
npm ci
npm run dev
npm run dev:test
npm test
```

`npm run dev` 启动开发版，`npm run dev:test` 启动测试版。界面顶部会分别显示 `DEV 开发版` 和 `TEST 测试版`。

## 构建

```powershell
npm run build:dev
npm run build:test
# 或依次构建两版
npm run build
```

两版都会生成 Setup 与 portable x64 EXE、SBOM、SHA-256 和构建清单，均不内置平台 API 凭据。

## 本地 AI 搜图与纯离线使用

模型就绪后，图库分析、截图/图片搜索和中英文文字搜索全部在本机运行。纯离线电脑可点击“导入离线包”导入 `.ngrmodel`；软件会校验模型版本、文件清单、大小与 SHA-256，全部通过后才原子启用。

- 源图片目录只读；删除图库只删除索引和缩略图。
- 支持 JPEG、PNG、WebP、BMP、GIF 首帧和 TIFF。
- 查询图只在内存使用，不保存文字、截图或搜索历史。
- DirectML 不兼容时自动回退 CPU，模型加载后禁用远程模型访问。
