export const LOCAL_IMAGE_SEARCH_VERSION = "clip-b32-multilingual-v1";
export const MODEL_PACKAGE_FORMAT = "ngr-assetpilot-local-ai-model";
export const MODEL_PACKAGE_VERSION = 1;
export const MODEL_PACKAGE_EXTENSION = "ngrmodel";
export const EMBEDDING_DIMENSIONS = 512;
export const QUERY_MAX_BYTES = 25 * 1024 * 1024;
export const QUERY_MAX_PIXELS = 50_000_000;
export const DEFAULT_RESULT_LIMIT = 50;
export const SUPPORTED_IMAGE_EXTENSIONS = new Set([
  ".jpg", ".jpeg", ".png", ".webp", ".bmp", ".gif", ".tif", ".tiff",
]);

export const MODEL_FILES = Object.freeze([
  {
    model: "vision",
    relativePath: "config.json",
    size: 4524,
    sha256: "493ef57ff783e42d1530c91b53469b7fdf8db8a9c1408e86998fcb7899a4f495",
    url: "https://huggingface.co/Xenova/clip-vit-base-patch32/resolve/d15189d7028b43f1d3e65039190477f6af591c2a/config.json",
  },
  {
    model: "vision",
    relativePath: "preprocessor_config.json",
    size: 520,
    sha256: "6f638fb9401a6d6296feff533ee7efe657b787c49f954f82f5906b36ef2a1b1f",
    url: "https://huggingface.co/Xenova/clip-vit-base-patch32/resolve/d15189d7028b43f1d3e65039190477f6af591c2a/preprocessor_config.json",
  },
  {
    model: "vision",
    relativePath: "onnx/vision_model_quantized.onnx",
    size: 89117001,
    sha256: "583fd1110a514667812fee7d684952aaf82a99b959760c8d7dca7e0ab9839299",
    url: "https://huggingface.co/Xenova/clip-vit-base-patch32/resolve/d15189d7028b43f1d3e65039190477f6af591c2a/onnx/vision_model_quantized.onnx",
  },
  {
    model: "text",
    relativePath: "config.json",
    size: 628,
    sha256: "2cd2fc7c5b226b5d4fa160cd63e31d59ad5b1b7568a24a10e6d11698d68c188a",
    url: "https://huggingface.co/aurantium/clip-ViT-B-32-multilingual-v1/resolve/143c7bc5489174177859c03641bcf69a4622b42c/config.json",
  },
  {
    model: "text",
    relativePath: "tokenizer.json",
    size: 2919362,
    sha256: "bf1b59b7b11c95f194f51708d918eea378e09d05f84c0e1656dc5180e8117088",
    url: "https://huggingface.co/aurantium/clip-ViT-B-32-multilingual-v1/resolve/143c7bc5489174177859c03641bcf69a4622b42c/tokenizer.json",
  },
  {
    model: "text",
    relativePath: "tokenizer_config.json",
    size: 1249,
    sha256: "672e7474c88e20b75d57145dd7a170966fd0161f8ba0121426a0e58654d3443a",
    url: "https://huggingface.co/aurantium/clip-ViT-B-32-multilingual-v1/resolve/143c7bc5489174177859c03641bcf69a4622b42c/tokenizer_config.json",
  },
  {
    model: "text",
    relativePath: "special_tokens_map.json",
    size: 695,
    sha256: "5d5b662e421ea9fac075174bb0688ee0d9431699900b90662acd44b2a350503a",
    url: "https://huggingface.co/aurantium/clip-ViT-B-32-multilingual-v1/resolve/143c7bc5489174177859c03641bcf69a4622b42c/special_tokens_map.json",
  },
  {
    model: "text",
    relativePath: "vocab.txt",
    size: 995526,
    sha256: "fe0fda7c425b48c516fc8f160d594c8022a0808447475c1a7c6d6479763f310c",
    url: "https://huggingface.co/aurantium/clip-ViT-B-32-multilingual-v1/resolve/143c7bc5489174177859c03641bcf69a4622b42c/vocab.txt",
  },
  {
    model: "text",
    relativePath: "quantize_config.json",
    size: 838,
    sha256: "e694b329b70cb7b02ff53970e4fb282fcfe4114daf8a8c4fcd2e5d1f030cf49b",
    url: "https://huggingface.co/aurantium/clip-ViT-B-32-multilingual-v1/resolve/143c7bc5489174177859c03641bcf69a4622b42c/quantize_config.json",
  },
  {
    model: "text",
    relativePath: "onnx/model_quantized.onnx",
    size: 135758529,
    sha256: "dc112f9666c31b9a9e7c0e49de2b4c7422c2e1dff86d79a5c47015fed5066b40",
    url: "https://huggingface.co/aurantium/clip-ViT-B-32-multilingual-v1/resolve/143c7bc5489174177859c03641bcf69a4622b42c/onnx/model_quantized.onnx",
  },
]);

export const MODEL_TOTAL_BYTES = MODEL_FILES.reduce((sum, file) => sum + file.size, 0);
