export const OFFLINE_TRANSLATION_MODEL = Object.freeze({
  id: "Xenova/opus-mt-zh-en",
  revision: "39d480d52a9ea3065a1f117adfe4dbc55de10e6f",
  displayName: "NGR 离线中英翻译",
  license: "CC-BY-4.0",
  files: Object.freeze([
    { path: "config.json", size: 1389, sha256: "293d318fce41dbf04114eac45037bb88a32d7c4ee21011a75e24a8b98ca45ad1" },
    { path: "generation_config.json", size: 293, sha256: "8dc29fef0fe82109f94ef3c2e6ea6bded3215d357b226c34cf7b4630726766c9" },
    { path: "onnx/decoder_model_merged_quantized.onnx", size: 60212804, sha256: "c6b7f04ff1ba0fbd1bf6852599b4c0cad6fe512d57cd887f44ef36cf705424cb" },
    { path: "onnx/encoder_model_quantized.onnx", size: 52899742, sha256: "84d5e171b626bc8b6b220d022ac58696e9528c25deeacca62b5cbf4364547a99" },
    { path: "source.spm", size: 804677, sha256: "e27a3a1b539f4959ec72ea60e453f49156289f95d4e6000b29332efc45616203" },
    { path: "special_tokens_map.json", size: 74, sha256: "5e4d1f5e759d74cb1c2fe1d165cfc62b5237aa904de759380cd6f43042eec723" },
    { path: "target.spm", size: 806530, sha256: "6a881f4717cd7265f53fea54fd3dc689c767c05338fac7a4590f3088cb2d7855" },
    { path: "tokenizer.json", size: 6381339, sha256: "b306d0301cf280bfd647d7067b5ade2a97b987e6d678df110703c002433643ff" },
    { path: "tokenizer_config.json", size: 282, sha256: "08849acc0a539c4749d8665e9d6217735503a97871ccebeea8a762d5fba1acf7" },
    { path: "vocab.json", size: 1747906, sha256: "08a119a1defd522fa047cb5e3bfe3e89633e96caa38ced0dc9cee7ef1021a011" },
  ]),
});

export const OFFLINE_TRANSLATION_TOTAL_BYTES = OFFLINE_TRANSLATION_MODEL.files
  .reduce((total, file) => total + file.size, 0);
