import assert from "node:assert/strict";
import { File } from "node:buffer";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";

const detectionSource = fs.readFileSync(new URL("../app/js/assets-detection.js", import.meta.url), "utf8");
const storageSource = fs.readFileSync(new URL("../app/js/export-template-storage.js", import.meta.url), "utf8");
const htmlSource = fs.readFileSync(new URL("../app/index.html", import.meta.url), "utf8");

const formatHelpersSource = detectionSource.match(
  /const DETECTION_PNG_ERROR_MESSAGE[\s\S]+?(?=\nasync function mapWithConcurrency)/,
)?.[0];
const revalidateSource = storageSource.match(
  /function revalidateDetectionAssets\(\) \{[\s\S]+?\n\}/,
)?.[0];

assert.ok(formatHelpersSource, "应能提取切图格式检测函数");
assert.ok(revalidateSource, "应能提取检测结果重检函数");

const context = vm.createContext({
  TextDecoder,
  Uint8Array,
});
vm.runInContext(formatHelpersSource, context);

const validPngBytes = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

function makeFile(name, bytes, type = "") {
  const content = Array.isArray(bytes) ? new Uint8Array(bytes) : bytes;
  return new File([content], name, { type });
}

async function validateFile(file) {
  context.candidateFile = file;
  const result = await vm.runInContext("validateDetectionFormat(candidateFile)", context);
  return JSON.parse(JSON.stringify(result));
}

test("切图格式检测仅允许扩展名和内容均为 PNG", async () => {
  for (const [name, type] of [["icon.png", "image/png"], ["ICON.PNG", ""], ["icon.png", "application/octet-stream"]]) {
    const result = await validateFile(makeFile(name, validPngBytes, type));
    assert.equal(result.valid, true, `${name} 应通过`);
    assert.equal(result.detectedFormat, "PNG");
    assert.deepEqual(result.messages, []);
  }

  const renamedPng = await validateFile(makeFile("icon.jpg", validPngBytes, "image/jpeg"));
  assert.equal(renamedPng.valid, false);
  assert.match(renamedPng.messages[0], /扩展名必须是 \.png/);
});

test("常见非 PNG 格式全部报错，MIME 和改名不能绕过", async () => {
  const samples = [
    ["photo.jpg", [0xff, 0xd8, 0xff, 0xe0], "JPEG"],
    ["asset.webp", Buffer.from("RIFF0000WEBP"), "WebP"],
    ["anim.gif", Buffer.from("GIF89a"), "GIF"],
    ["vector.svg", Buffer.from("<?xml version=\"1.0\"?><svg viewBox=\"0 0 1 1\"></svg>"), "SVG"],
    ["sprite.bmp", Buffer.from("BM000000"), "BMP"],
    ["texture.tiff", [0x49, 0x49, 0x2a, 0x00], "TIFF"],
    ["icon.ico", [0x00, 0x00, 0x01, 0x00], "ICO"],
    ["photo.avif", Buffer.from("0000ftypavif"), "AVIF"],
    ["photo.heic", Buffer.from("0000ftypheic"), "HEIC/HEIF"],
  ];

  for (const [name, bytes, expectedFormat] of samples) {
    const result = await validateFile(makeFile(name, bytes, "image/png"));
    assert.equal(result.valid, false, `${name} 不应通过`);
    assert.equal(result.detectedFormat, expectedFormat);
    assert.match(result.messages[0], /NGR只允许png格式，不允许其他格式/);
  }

  const disguisedJpeg = await validateFile(makeFile("fake.png", [0xff, 0xd8, 0xff, 0xe0], "image/png"));
  assert.equal(disguisedJpeg.valid, false);
  assert.equal(disguisedJpeg.detectedFormat, "JPEG");
});

test("空文件、截断 PNG 和未知格式不能作为 PNG 通过", async () => {
  const invalidFiles = [
    makeFile("empty.png", []),
    makeFile("truncated.png", validPngBytes.subarray(0, 8)),
    makeFile("unknown.png", Buffer.from("not-an-image"), "image/png"),
  ];
  for (const file of invalidFiles) {
    const result = await validateFile(file);
    assert.equal(result.valid, false);
    assert.match(result.messages[0], /NGR只允许png格式，不允许其他格式/);
  }
});

test("检测入口不再静默过滤其他格式文件", () => {
  for (const file of [
    makeFile("sprite.bmp", []),
    makeFile("texture.tiff", []),
    makeFile("unknown.custom", []),
  ]) {
    context.candidateFile = file;
    assert.equal(vm.runInContext("isDetectionCandidate(candidateFile)", context), true);
  }
  assert.match(detectionSource, /const detectionFiles = files\.filter\(isDetectionCandidate\)/);
  assert.match(detectionSource, /const formatValidation = await validateDetectionFormat\(file\)/);
  assert.match(detectionSource, /formatMessages: formatValidation\.messages/);
});

test("切换检测规则后仍保留格式错误", () => {
  Object.assign(context, {
    detectionAssets: [{
      id: "jpeg-1",
      dimensions: { width: 128, height: 128 },
      formatMessages: ["注意导出切图格式，NGR只允许png格式，不允许其他格式（检测到 JPEG）"],
    }],
    getActiveDetectionProfile: () => ({ mode: "ui" }),
    validateDetectionDimensions: () => ({
      hasIssue: false,
      hasWarning: false,
      label: "图集",
      messages: [],
      warnings: [],
    }),
    updateSimilarResourceWarnings() {},
    renderDetectionList() {},
  });
  vm.runInContext(revalidateSource, context);
  vm.runInContext("revalidateDetectionAssets()", context);
  const asset = JSON.parse(vm.runInContext("JSON.stringify(detectionAssets[0])", context));
  assert.equal(asset.hasIssue, true);
  assert.match(asset.messages[0], /NGR只允许png格式/);
});

test("界面明确说明只有 PNG 能通过，同时保持其他格式可被选择后报错", () => {
  assert.match(htmlSource, /仅 PNG 格式可通过检测；其他格式会标记错误/);
  assert.match(htmlSource, /id="detectionFolderInput"[^>]+accept="image\/\*,\.svg"/);
  assert.match(htmlSource, /系统同时校验扩展名和 PNG 文件内容/);
});
