window.NGR_LOCAL_AI_CONFIG = {
  provider: "openai",
  apiFormat: "responses",
  baseUrl: "https://api.openai.com/v1",
  apiKey: "填入你的临时测试 API Key",
  model: "gpt-4.1-mini",
  providerNote: "本机临时测试 API",
};

window.NGR_LOCAL_KIMI_CONFIG = {
  provider: "kimi",
  apiFormat: "chat",
  baseUrl: "https://api.moonshot.cn/v1",
  apiKey: "填入你的 Kimi / Moonshot API Key",
  model: "moonshot-v1-8k-vision-preview",
  providerNote: "Kimi / Moonshot 视觉模型",
};

window.NGR_LOCAL_TRANSLATION_CONFIG = {
  provider: "baidu",
  baiduAppId: "填入你的百度翻译 App ID",
  baiduSecret: "填入你的百度翻译密钥",
  baiduEndpoint: "https://fanyi-api.baidu.com/api/trans/vip/translate",
  textBaseUrl: "https://api.openai.com/v1",
  textApiKey: "填入你的文本翻译模型 API Key",
  textModel: "gpt-4.1-mini",
};
