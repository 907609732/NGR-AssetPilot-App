import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [html, source, styles] = await Promise.all([
  readFile(new URL("../app/index.html", import.meta.url), "utf8"),
  readFile(new URL("../app/js/local-image-search.js", import.meta.url), "utf8"),
  readFile(new URL("../app/styles.css", import.meta.url), "utf8"),
]);

test("本地搜图展示真实推理设备、批量、速度与 ETA", () => {
  for (const id of [
    "localSearchEngineState",
    "localSearchVisionProvider",
    "localSearchTextProvider",
    "localSearchEngineBatch",
    "localSearchEngineFallback",
    "localSearchJobStage",
    "localSearchJobSpeed",
    "localSearchJobEta",
    "localSearchJobProvider",
  ]) {
    assert.match(html, new RegExp(`id=["']${id}["']`), `missing #${id}`);
  }
  assert.match(source, /getEngineStatus\(/);
  assert.match(source, /job\.imagesPerSecond/);
  assert.match(source, /job\.etaSeconds/);
  assert.match(source, /job\.executionProvider/);
  assert.match(source, /job\.fallbackReason/);
  assert.match(styles, /\.local-search-index-performance/);
});

test("模型管理器采用无路径的两阶段 ONNX 导入契约", () => {
  const wizardStart = html.indexOf('id="localSearchModelWizard"');
  const wizardEnd = html.indexOf("</form>", wizardStart);
  assert.ok(wizardStart >= 0 && wizardEnd > wizardStart, "missing model import wizard");
  const wizard = html.slice(wizardStart, wizardEnd);
  assert.doesNotMatch(wizard, /type=["']file["']/i, "renderer must not receive arbitrary file paths");
  assert.doesNotMatch(wizard, /webkitdirectory/i);

  assert.match(source, /validateModel\(\{ source: "dialog", type, preprocessing \}\)/);
  assert.match(source, /validationId: state\.modelValidation\.validationId/);
  assert.match(source, /kind: "custom"/);
  assert.match(source, /kind: "package"/);
  assert.match(source, /result\.files \|\| \[\]/);
  for (const field of ["layout", "width", "height", "colorSpace", "resizeMode", "pixelType", "scale", "mean", "std", "inputName", "outputName", "dimensions", "normalizeOutput", "textInputName", "textOutputName"]) {
    assert.match(source, new RegExp(`\\b${field}:`), `missing preprocessing field ${field}`);
  }
  assert.doesNotMatch(source, /\.files\[[^\]]+\]\.path|file\.path/);
});

test("模型选择按 modelId 隔离索引和搜索，并禁用单塔文字搜索", () => {
  assert.match(html, /id="localSearchModelSelect"/);
  assert.match(html, /id="localSearchManagedModels"/);
  assert.match(html, /图像单塔（仅图片搜索）/);
  assert.match(html, /图像塔 \+ 文字塔/);
  assert.match(html, /未认证/);

  assert.match(source, /setActiveModel\(\{ modelId \}\)/);
  assert.match(source, /startIndex\(\{ libraryId: state\.activeLibraryId, modelId:/);
  assert.match(source, /searchByImage\(\{ libraryId: state\.activeLibraryId, modelId:/);
  assert.match(source, /searchByText\(\{ libraryId: state\.activeLibraryId, modelId:/);
  assert.match(source, /nodes\.localSearchTextTab\.disabled = !supported/);
  assert.match(source, /removeModel\(\{ modelId: model\.id \}\)/);
  assert.match(source, /result\?\.valid !== true/);
  assert.match(source, /applyCustomPixelDefaults/);
  assert.match(source, /integerPixels \? "1" : "0\.003921568627451"/);
});
