# NGR AssetPilot 百度翻译 CFC

该函数把百度翻译 APPID/密钥保存在 CFC 环境变量中，桌面安装包只访问 CFC HTTP 触发器，不包含百度翻译密钥。

## CFC 配置

- 运行时：Node.js 20
- 处理程序：`index.handler`
- 内存：128 MiB
- 超时：30 秒
- 环境变量：
  - `BAIDU_TRANSLATE_APP_ID`
  - `BAIDU_TRANSLATE_SECRET`
  - `RATE_LIMIT_PER_MINUTE=30`
  - `UPSTREAM_TIMEOUT_MS=15000`
- HTTP 触发器：`GET,POST`
- 路径：`/ngr-assetpilot/translate`
- 认证：Bearer / Opaque Token
- 协议：只使用控制台生成的 HTTPS 地址

执行 `npm run package:cfc` 会生成 `artifacts/cfc/NGR-AssetPilot-Baidu-CFC.zip`，上传该 ZIP 后无需安装依赖。

## 健康检查

```text
GET https://<id>.cfc-execute.<region>.baidubce.com/ngr-assetpilot/translate
Authorization: Bearer <token>
```

返回 `ok: true` 且 `configured: true` 才能进入软件打包阶段。

## 安全边界

- 百度 APPID/密钥不得写入源码、GitHub、安装包或日志。
- Bearer Token 会随安装包分发，只能作为轻量级防滥用手段；应配合 CFC 并发上限、费用告警和定期轮换。
- 函数只接受 1–200 字符翻译，不接受文件、图片、提示词或任意上游地址。
