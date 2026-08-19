# Third-party notices

NGR AssetPilot 的“本地 AI 搜图”模块使用以下开源运行时。完整许可证文本随各 npm 软件包提供，并记录在发布 SBOM 中。

- `@huggingface/transformers` 4.2.0 — Apache License 2.0
- `onnxruntime-node` 1.24.3 — MIT License
- `sharp` 0.35.3 — Apache License 2.0
- `adm-zip` 0.6.0 — MIT License（仅用于生成和读取经严格清单校验的 `.ngrmodel` 离线模型包）

首次使用时，应用会在用户明确确认后从 Hugging Face 下载模型，不将模型文件打入安装包，也不自动升级模型：

- `Xenova/clip-vit-base-patch32`，revision `d15189d7028b43f1d3e65039190477f6af591c2a`
- `aurantium/clip-ViT-B-32-multilingual-v1`，revision `143c7bc5489174177859c03641bcf69a4622b42c`

模型的来源、模型卡和适用许可分别见：

- https://huggingface.co/Xenova/clip-vit-base-patch32
- https://huggingface.co/aurantium/clip-ViT-B-32-multilingual-v1

增量索引结构参考了 MIT 许可项目 rclip 的公开设计思路；本模块未复制或捆绑 rclip 源代码：

- https://github.com/yurijmikhalevich/rclip
