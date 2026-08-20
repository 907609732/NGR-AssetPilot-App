import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [html, source, browserSource, styles] = await Promise.all([
  readFile(new URL("../app/index.html", import.meta.url), "utf8"),
  readFile(new URL("../app/js/local-image-search.js", import.meta.url), "utf8"),
  readFile(new URL("../app/js/local-image-browser.js", import.meta.url), "utf8"),
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
  assert.match(source, /const libraryId = state\.activeLibraryId;/);
  assert.match(source, /const modelId = state\.activeModelId \|\| undefined;/);
  assert.match(source, /beginSearch\(libraryId\)/);
  assert.match(source, /searchByImage\(\{ libraryId, modelId,/);
  assert.match(source, /searchByText\(\{ libraryId, modelId, text \}\)/);
  assert.match(source, /renderSearchResults\(result, \{[\s\S]*\.\.\.context/);
  assert.match(browserSource, /context\.token !== state\.searchToken \|\| context\.libraryId !== state\.library\?\.id/);
  assert.match(browserSource, /const snapshot = \{ libraryId: context\.libraryId, imageId: result\.imageId \}/);
  assert.doesNotMatch(browserSource, /openResult\(\{ libraryId: state\.library/);
  assert.match(source, /nodes\.localSearchTextTab\.disabled = !supported/);
  assert.match(source, /removeModel\(\{ modelId: model\.id \}\)/);
  assert.match(source, /result\?\.valid !== true/);
  assert.match(source, /applyCustomPixelDefaults/);
  assert.match(source, /integerPixels \? "1" : "0\.003921568627451"/);
});

test("无查询时默认显示只读素材库，并采用文件夹树和固定100张分页", () => {
  for (const id of [
    "localSearchQuickLibrarySelect",
    "localSearchBrowser",
    "localSearchAssetFolders",
    "localSearchAssetFilter",
    "localSearchAssetSort",
    "localSearchAssetGrid",
    "localSearchAssetPagination",
    "localSearchReturnToLibrary",
  ]) {
    assert.match(html, new RegExp(`id=["']${id}["']`), `missing #${id}`);
  }
  assert.match(browserSource, /const PAGE_SIZE = 100/);
  assert.match(browserSource, /THUMBNAIL_CONCURRENCY = 4/);
  assert.match(browserSource, /new globalScope\.IntersectionObserver/);
  assert.match(browserSource, /mode: "browse"/);
  assert.match(browserSource, /mode === "search-error"/);
  assert.match(browserSource, /listAssetFolders\(\{ libraryId: state\.library\.id, parentPrefix: prefix \}\)/);
  assert.match(browserSource, /listAssets\(\{/);
  assert.match(source, /function isActiveLibrarySearchable\(\)/);
  assert.match(source, /nodes\.localSearchImageInput\.disabled = !searchable/);
  assert.match(source, /当前模型尚未分析此图库；素材仍可浏览/);
  assert.match(styles, /\.local-search-browser/);
  assert.match(styles, /\.local-search-asset-grid/);
});
