# NGR AssetPilot 百度翻译 CFC

该函数把百度翻译 APPID/密钥保存在 CFC 环境变量中，桌面安装包只访问 CFC HTTP 触发器，不包含百度翻译密钥。

## CFC 配置

- 运行时：Node.js 22
- 处理程序：`index.handler`
- 内存：128 MiB
- 超时：30 秒
- 环境变量：
  - `BAIDU_TRANSLATE_APP_ID`
  - `BAIDU_TRANSLATE_SECRET`
  - `UPSTREAM_TIMEOUT_MS=15000`
- HTTP 触发器：`GET,POST`
- 路径：`/ngr-assetpilot/translate`
- 认证：不验证；不在桌面客户端嵌入共享密钥
- 限流：每来源 IP 在滚动半小时内最多 1000 次 POST，单次最多 200 字符。旧 `RATE_LIMIT_PER_MINUTE` 环境变量不再生效。
- 计数保存在函数实例内存中，实例重启会清空，多实例之间不共享；不是跨实例的全局配额。
- 协议：只使用控制台生成的 HTTPS 地址

执行 `npm run package:cfc` 会生成 `artifacts/cfc/NGR-AssetPilot-Baidu-CFC.zip`，上传该 ZIP 后无需安装依赖。

## 健康检查

```text
GET https://<id>.cfc-execute.<region>.baidubce.com/ngr-assetpilot/translate
```

返回 `ok: true` 且 `configured: true` 才能进入软件打包阶段。

## 安全边界

- 百度 APPID/密钥不得写入源码、GitHub、安装包或日志。
- 桌面安装包只包含公开 HTTPS Endpoint；百度 APPID/密钥只存在于 CFC 环境变量。
- 公开端点必须配合 CFC 并发上限、费用预算/告警和按来源限流；客户端内置共享 Token 不具备保密性，因此禁止使用。
- 函数只接受 1–200 字符翻译，不接受文件、图片、提示词或任意上游地址。
