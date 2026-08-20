# NGR AssetPilot V3 桌面版

工程提供三个明确隔离的版本：

- 正式版 `NGR AssetPilot`：面向最终用户，数据位于 `%APPDATA%\NGR AssetPilot`，产物位于 `artifacts/prod`。
- 开发版 `NGR AssetPilot Dev`：日常开发与调试，数据位于 `%APPDATA%\NGR AssetPilot Dev`，产物位于 `artifacts/dev`。
- 测试版 `NGR AssetPilot Test`：安装与功能验收，数据位于 `%APPDATA%\NGR AssetPilot Test`，产物位于 `artifacts/test`。

三版拥有不同应用 ID、进程名、快捷方式和数据目录，设置、图库索引、模型与缩略图不会互相覆盖。正式版首次启动时，如果目录尚无本地搜图数据，可从已有开发版数据复制迁移；来源目录不会删除。

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
# 默认只构建正式版
npm run build
# 或分别构建
npm run build:prod
npm run build:dev
npm run build:test
# 依次构建全部版本
npm run build:all
```

正式版只生成支持应用内自动更新的 Setup x64 安装包；开发版和测试版额外生成 portable x64 EXE 供内部调试。三版都会生成 SBOM、SHA-256 和构建清单，均不内置平台 API 凭据。正式版不显示 DEV/TEST 徽标。

## 本地 AI 搜图与纯离线使用

模型就绪后，图库分析、截图/图片搜索和中英文文字搜索全部在本机运行。纯离线电脑可点击“导入离线包”导入 `.ngrmodel`；软件会校验模型版本、文件清单、大小与 SHA-256，全部通过后才原子启用。

- 源图片目录只读；删除图库只删除索引和缩略图。
- 支持 JPEG、PNG、WebP、BMP、GIF 首帧和 TIFF。
- 查询图只在内存使用，不保存文字、截图或搜索历史。
- Windows 图库分析自动使用 DirectML 批量推理；显存不足时降低批量，DirectML 不兼容时自动回退 CPU。
- V3.0.4 使用新的批量索引配置；首次升级会保留路径、哈希和尺寸信息，但旧版单张 CPU 向量必须重新分析，避免与 GPU 向量静默混用。执行设备或批量配置变化时也会自动重建该模型索引。
- 内置量化模型追求检索速度，批量内容会带来轻微向量漂移；本机 100 图验证同图 Top 5 命中为 100%，但 CPU/GPU Top 5 列表重合约 83.4%，不承诺严格跨设备一致。对此有硬性要求时，请导入经验证的 FP16/FP32 embedding 模型并重新建立独立索引。
- 模型管理器支持从本机导入图像单塔或图文双塔 ONNX embedding 模型；每个模型使用独立向量索引，切换模型不会覆盖其他索引。
- 自定义模型在隔离进程内验证，只允许 ONNX 与声明的外部权重/tokenizer 数据，不加载脚本或自定义算子 DLL。
- 图像单塔只提供图片相似搜索；只有通过维度与 tokenizer 校验的图文双塔才开放文字搜索。
- 模型加载后禁用远程模型访问。

完整索引性能验收使用独立临时数据库，不会修改正式版数据或源图库：

```powershell
npm run test:local-image-search:index -- --source "E:\path\to\library" --model-root "$env:APPDATA\NGR AssetPilot\local-image-search\models"
```
