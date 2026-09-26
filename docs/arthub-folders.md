# ArtHub 工程文件夹查询

“当前界面工程名”标题右侧提供入口。首次配置固定服务环境、资源库、可选根目录及 public token，通过目录查询验证后才保存；Token 使用 Electron CredentialStore 加密存入独立的 `arthub-connection.v2.json`，不返回渲染层。该独立连接配置暂不参与现有工作区备份迁移，换机需重新连接。

接口参考 ArtHub 官方 `arthub-api` SDK（https://pypi.org/project/arthub-api/）的 `open_api.py` 和 `storage.py`，使用 `publictoken` 请求头以及 `/data/openapi/v2/core/` 的只读查询方法。目录查询按 500 条分页，完整读取后先按名称完全相等筛选，再回退忽略大小写；不创建或更改远程文件。

## 当前交付边界

本机 ArtHub 1.20.2 的注册表与随附 source map 确认了 `arthub://` 和 `--protocol-launcher`。内部 `jumpToNode(assetHub, id)` 构造 `/{assetHub}/pan?node={id}`，但没有证据证明这个网页路径可直接作为协议消息。因此没有猜测协议 URL，也没有提供任意命令、浏览器回退或修改 ArtHub 安装文件的能力。

`open` 只接受本次查询返回的随机结果 ID，并明确返回 `ARTHUB_CLIENT_UNVERIFIED`。界面显示尚未验证说明，保留匹配目录和完整路径，禁用自动打开。真实云端查询及客户端已启动/未启动的定位验收仍需用户配置查询授权与资源库，并进一步核实客户端支持的准确消息格式；仅能启动 EXE 不算验收通过。

## 验证

- `tests/arthub-folders.test.mjs`：完整分页、精确匹配、大小写回退、同名路径、无结果、权限、分页变化、配置验证及结果 ID 限制。
- `tests/arthub-folders-electron.test.mjs`：真实 Electron 下入口和连接表单、小窗口、Token 清空、模拟查询结果展示、失效查询及 Esc。查询结果使用测试夹具，不代表真实 ArtHub 返回。
- 截图位于 `artifacts/arthub-folders/`；带 `fixture` 的文件是模拟数据。

本次不更新版本号或发布安装包。
