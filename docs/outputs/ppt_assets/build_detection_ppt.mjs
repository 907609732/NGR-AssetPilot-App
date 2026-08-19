import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const toolRequire = createRequire("/var/folders/gf/_6_h194165n17d3c211h85xc0000gn/T/codex-presentations/019f118f-a73d-7650-820e-75f0ff9875a6/ngr-detection-ppt/tmp/index.mjs");
const { Presentation, PresentationFile } = toolRequire("@oai/artifact-tool");

const root = "/Users/chenyuecai/Documents/NGR AI AutoName Tool";
const assetDir = path.join(root, "ppt_assets");
const outDir = path.join(root, "outputs");
const qaDir = "/var/folders/gf/_6_h194165n17d3c211h85xc0000gn/T/codex-presentations/019f118f-a73d-7650-820e-75f0ff9875a6/ngr-detection-ppt/tmp/qa";
const finalPptx = path.join(outDir, "NGRAI辅助UI切图检测功能介绍.pptx");

const W = 1280;
const H = 720;
const ink = "#17232B";
const muted = "#5E6B73";
const panel = "#F1F5F7";
const line = "#D7E1E6";
const teal = "#0F8790";
const orange = "#E8782E";
const green = "#16A06A";

async function writeBlob(file, blob) {
  await fs.writeFile(file, new Uint8Array(await blob.arrayBuffer()));
}

async function png(name) {
  return fs.readFile(path.join(assetDir, name));
}

function addText(slide, text, position, style = {}) {
  const shape = slide.shapes.add({
    geometry: "textbox",
    position,
    fill: "none",
    line: { style: "solid", fill: "none", width: 0 },
  });
  shape.text = text;
  shape.text.style = {
    fontSize: style.fontSize ?? 22,
    bold: style.bold ?? false,
    color: style.color ?? ink,
    alignment: style.alignment ?? "left",
  };
  return shape;
}

function addRule(slide, left, top, width, color = line) {
  slide.shapes.add({
    geometry: "rect",
    position: { left, top, width, height: 2 },
    fill: color,
    line: { style: "solid", fill: color, width: 0 },
  });
}

function addTag(slide, label, left, top, width, color = teal) {
  const shape = slide.shapes.add({
    geometry: "roundRect",
    position: { left, top, width, height: 34 },
    fill: color,
    line: { style: "solid", fill: color, width: 0 },
    borderRadius: 10,
  });
  shape.text = label;
  shape.text.style = { fontSize: 16, bold: true, color: "#FFFFFF", alignment: "center" };
}

function addScreenshot(slide, bytes, position, alt, fit = "contain") {
  slide.shapes.add({
    geometry: "roundRect",
    position: { left: position.left - 10, top: position.top - 10, width: position.width + 20, height: position.height + 20 },
    fill: "#FFFFFF",
    line: { style: "solid", fill: line, width: 1 },
    borderRadius: 16,
    shadow: "shadow-sm",
  });
  slide.images.add({
    blob: bytes,
    contentType: "image/png",
    alt,
    fit,
    position,
    geometry: "roundRect",
    borderRadius: 10,
  });
}

function addFooter(slide, page) {
  addText(slide, "NGRAI辅助UI切图命名工具 · UI切图检测", { left: 56, top: 678, width: 520, height: 24 }, { fontSize: 13, color: "#87939B" });
  addText(slide, String(page).padStart(2, "0"), { left: 1160, top: 674, width: 64, height: 30 }, { fontSize: 16, bold: true, color: "#87939B", alignment: "right" });
}

function addStepList(slide, items, left, top, width, color = teal) {
  items.forEach((item, index) => {
    const y = top + index * 76;
    const circle = slide.shapes.add({
      geometry: "ellipse",
      position: { left, top: y + 2, width: 38, height: 38 },
      fill: color,
      line: { style: "solid", fill: color, width: 0 },
    });
    circle.text = String(index + 1);
    circle.text.style = { fontSize: 18, bold: true, color: "#FFFFFF", alignment: "center" };
    addText(slide, item.title, { left: left + 54, top: y, width, height: 28 }, { fontSize: 23, bold: true });
    addText(slide, item.body, { left: left + 54, top: y + 32, width, height: 34 }, { fontSize: 16, color: muted });
  });
}

const p = Presentation.create({ slideSize: { width: W, height: H } });

{
  const slide = p.slides.add();
  slide.background.fill = "#FFFFFF";
  addTag(slide, "普通用户教程", 56, 58, 132, teal);
  addText(slide, "UI切图检测\n功能介绍", { left: 56, top: 150, width: 540, height: 180 }, { fontSize: 64, bold: true });
  addText(slide, "提交资源前，快速检查格式、尺寸、警告项和疑似重复资源。", { left: 60, top: 366, width: 560, height: 72 }, { fontSize: 26, color: muted });
  addRule(slide, 60, 478, 380, teal);
  addText(slide, "适用版本 V2.18", { left: 60, top: 510, width: 240, height: 34 }, { fontSize: 18, color: muted });
  addScreenshot(slide, await png("01-home.png"), { left: 676, top: 82, width: 520, height: 520 }, "软件主界面", "cover");
  addFooter(slide, 1);
}

{
  const slide = p.slides.add();
  slide.background.fill = "#FFFFFF";
  addText(slide, "什么时候用切图检测？", { left: 56, top: 52, width: 720, height: 58 }, { fontSize: 44, bold: true });
  addText(slide, "在资源提交前做一次检查，先发现问题，再回到设计工具修正。", { left: 58, top: 116, width: 760, height: 34 }, { fontSize: 20, color: muted });
  addStepList(slide, [
    { title: "格式", body: "检查是否符合项目要求，例如 NGR 只允许 PNG。" },
    { title: "尺寸", body: "检查单数尺寸、大图阈值、图标标准尺寸等。" },
    { title: "警告", body: "找出允许但不推荐的资源，提交前人工确认。" },
    { title: "重复", body: "开启后辅助发现疑似重复或相似图片。" },
  ], 76, 202, 475);
  addScreenshot(slide, await png("02-detect-empty.png"), { left: 664, top: 170, width: 520, height: 390 }, "检测页面空状态", "cover");
  addFooter(slide, 2);
}

{
  const slide = p.slides.add();
  slide.background.fill = "#FFFFFF";
  addText(slide, "入口和页面结构", { left: 56, top: 52, width: 720, height: 58 }, { fontSize: 44, bold: true });
  addText(slide, "普通用户主要看三个区域：顶部选择检测方式，中间上传文件，下方看结果。", { left: 58, top: 116, width: 850, height: 34 }, { fontSize: 20, color: muted });
  addScreenshot(slide, await png("02-detect-empty.png"), { left: 64, top: 166, width: 760, height: 476 }, "检测页面结构", "contain");
  addTag(slide, "1 选择检测模式", 866, 210, 184, teal);
  addText(slide, "检测项目组、检测模式、重复检测都在页面顶部。", { left: 868, top: 254, width: 300, height: 70 }, { fontSize: 20, color: ink });
  addTag(slide, "2 上传资源", 866, 358, 142, orange);
  addText(slide, "上传文件夹，也可以补充单张图片。", { left: 868, top: 402, width: 300, height: 58 }, { fontSize: 20, color: ink });
  addTag(slide, "3 查看结果", 866, 504, 142, green);
  addText(slide, "检测完成后，在下方列表查看问题和警告。", { left: 868, top: 548, width: 300, height: 64 }, { fontSize: 20, color: ink });
  addFooter(slide, 3);
}

{
  const slide = p.slides.add();
  slide.background.fill = "#FFFFFF";
  addText(slide, "先选检测方式", { left: 56, top: 52, width: 600, height: 58 }, { fontSize: 44, bold: true });
  addText(slide, "检测前确认项目组、检测模式和是否开启重复检测。", { left: 58, top: 116, width: 760, height: 34 }, { fontSize: 20, color: muted });
  addScreenshot(slide, await png("03-detect-results.png"), { left: 600, top: 138, width: 568, height: 440 }, "检测方式选择", "cover");
  const rows = [
    ["NGR切图规范", "检查 PNG、双数尺寸、大图规则"],
    ["策划配置切图规范", "检查尺寸是否符合配置资源要求"],
    ["图标尺寸检测规范", "检查正方形和标准图标尺寸"],
    ["重复检测", "关闭最快，低/中/高逐级更敏感"],
  ];
  rows.forEach((row, i) => {
    const y = 190 + i * 82;
    addText(slide, row[0], { left: 76, top: y, width: 250, height: 34 }, { fontSize: 24, bold: true, color: i === 3 ? orange : teal });
    addText(slide, row[1], { left: 76, top: y + 38, width: 430, height: 32 }, { fontSize: 18, color: muted });
    addRule(slide, 76, y + 74, 410);
  });
  addFooter(slide, 4);
}

{
  const slide = p.slides.add();
  slide.background.fill = "#FFFFFF";
  addText(slide, "上传后，直接看检测结果", { left: 56, top: 52, width: 760, height: 58 }, { fontSize: 44, bold: true });
  addText(slide, "列表会显示预览、尺寸、问题提示和警告提示。", { left: 58, top: 116, width: 760, height: 34 }, { fontSize: 20, color: muted });
  addScreenshot(slide, await png("03-detect-results.png"), { left: 64, top: 164, width: 760, height: 474 }, "检测结果列表", "contain");
  addText(slide, "优先看两件事", { left: 874, top: 184, width: 260, height: 34 }, { fontSize: 28, bold: true });
  addStepList(slide, [
    { title: "问题图片", body: "通常需要重新导出、调整尺寸或改格式。" },
    { title: "警告图片", body: "允许但不推荐，按项目要求决定是否优化。" },
    { title: "疑似重复", body: "只是辅助判断，需要人工对比确认。" },
  ], 876, 252, 270, orange);
  addFooter(slide, 5);
}

{
  const slide = p.slides.add();
  slide.background.fill = "#FFFFFF";
  addText(slide, "不懂提示，就先看规范", { left: 56, top: 52, width: 760, height: 58 }, { fontSize: 44, bold: true });
  addText(slide, "“查看检测规范”会展开当前模式的规则说明，适合解释为什么被标记。", { left: 58, top: 116, width: 900, height: 34 }, { fontSize: 20, color: muted });
  addScreenshot(slide, await png("04-rules-expanded.png"), { left: 72, top: 174, width: 782, height: 450 }, "检测规范展开", "contain");
  addText(slide, "规范里会说明", { left: 902, top: 192, width: 260, height: 36 }, { fontSize: 28, bold: true });
  addText(slide, "PNG 格式要求\n双数尺寸要求\n2048 大图警告\n图标标准尺寸\n重复资源判断方式", { left: 906, top: 252, width: 300, height: 230 }, { fontSize: 24, color: ink });
  addFooter(slide, 6);
}

{
  const slide = p.slides.add();
  slide.background.fill = "#FFFFFF";
  addText(slide, "用筛选按钮集中处理", { left: 56, top: 52, width: 760, height: 58 }, { fontSize: 44, bold: true });
  addText(slide, "先看问题，再看警告，处理顺序会更清楚。", { left: 58, top: 116, width: 760, height: 34 }, { fontSize: 20, color: muted });
  addScreenshot(slide, await png("05-problems-only.png"), { left: 62, top: 176, width: 548, height: 398 }, "只看问题图片", "cover");
  addScreenshot(slide, await png("06-warnings-only.png"), { left: 676, top: 176, width: 548, height: 398 }, "只看警告图片", "cover");
  addTag(slide, "只看问题图片", 226, 598, 164, orange);
  addTag(slide, "只看警告图片", 840, 598, 164, teal);
  addFooter(slide, 7);
}

{
  const slide = p.slides.add();
  slide.background.fill = "#FFFFFF";
  addText(slide, "常见提示怎么处理", { left: 56, top: 52, width: 760, height: 58 }, { fontSize: 44, bold: true });
  addText(slide, "检测提示是辅助判断，最终以项目规范和负责人要求为准。", { left: 58, top: 116, width: 820, height: 34 }, { fontSize: 20, color: muted });
  const data = [
    ["非 PNG 格式", "重新导出为 PNG"],
    ["分辨率不是双数", "调整宽高，避免单数"],
    ["单边超过上限", "拆分图片或重新切图"],
    ["黄色警告", "允许但不推荐，按要求优化"],
    ["疑似重复资源", "人工对比，确认是否保留"],
  ];
  data.forEach((row, i) => {
    const y = 188 + i * 72;
    slide.shapes.add({ geometry: "rect", position: { left: 78, top: y - 10, width: 1030, height: 56 }, fill: i % 2 ? "#FFFFFF" : panel, line: { style: "solid", fill: "none", width: 0 } });
    addText(slide, row[0], { left: 104, top: y, width: 310, height: 34 }, { fontSize: 24, bold: true, color: i === 3 ? orange : ink });
    addText(slide, row[1], { left: 468, top: y + 2, width: 520, height: 32 }, { fontSize: 22, color: muted });
  });
  addFooter(slide, 8);
}

{
  const slide = p.slides.add();
  slide.background.fill = "#FFFFFF";
  addText(slide, "推荐操作流程", { left: 56, top: 52, width: 760, height: 58 }, { fontSize: 44, bold: true });
  addText(slide, "按这个顺序操作，普通用户基本不会漏步骤。", { left: 58, top: 116, width: 760, height: 34 }, { fontSize: 20, color: muted });
  addStepList(slide, [
    { title: "进入 UI切图检测", body: "从主界面点击检测入口。" },
    { title: "选择检测模式", body: "确认项目组、模式和重复检测。" },
    { title: "上传资源文件夹", body: "等待检测结果生成。" },
    { title: "筛选问题和警告", body: "记录需要修改的图片。" },
    { title: "清空后继续下一批", body: "清空列表不会删除本地原图。" },
  ], 88, 188, 500, teal);
  addScreenshot(slide, await png("07-icon-mode.png"), { left: 708, top: 174, width: 452, height: 392 }, "图标尺寸检测模式", "cover");
  addFooter(slide, 9);
}

{
  const slide = p.slides.add();
  slide.background.fill = "#FFFFFF";
  addText(slide, "交付前检查清单", { left: 56, top: 52, width: 760, height: 58 }, { fontSize: 44, bold: true });
  addText(slide, "检测不会修改图片，只帮你提前发现风险。", { left: 58, top: 116, width: 760, height: 34 }, { fontSize: 20, color: muted });
  const checks = [
    "是否选择了正确的检测项目组？",
    "检测模式是否符合当前资源类型？",
    "问题图片是否已经全部处理？",
    "警告图片是否已经确认可以提交？",
    "疑似重复资源是否人工对比过？",
  ];
  checks.forEach((text, i) => {
    const y = 198 + i * 72;
    slide.shapes.add({ geometry: "ellipse", position: { left: 98, top: y - 4, width: 30, height: 30 }, fill: green, line: { style: "solid", fill: green, width: 0 } });
    addText(slide, "✓", { left: 103, top: y - 6, width: 20, height: 30 }, { fontSize: 18, bold: true, color: "#FFFFFF", alignment: "center" });
    addText(slide, text, { left: 150, top: y - 8, width: 760, height: 40 }, { fontSize: 27, color: ink });
  });
  addRule(slide, 98, 594, 680, teal);
  addText(slide, "完成检查后，再提交资源。", { left: 98, top: 614, width: 520, height: 38 }, { fontSize: 24, bold: true, color: teal });
  addFooter(slide, 10);
}

await fs.mkdir(outDir, { recursive: true });
await fs.mkdir(qaDir, { recursive: true });
for (const [index, slide] of p.slides.items.entries()) {
  const stem = `slide-${String(index + 1).padStart(2, "0")}`;
  await writeBlob(path.join(qaDir, `${stem}.png`), await p.export({ slide, format: "png", scale: 1 }));
  await fs.writeFile(path.join(qaDir, `${stem}.layout.json`), await (await slide.export({ format: "layout" })).text());
}
await writeBlob(path.join(qaDir, "deck-montage.webp"), await p.export({ format: "webp", montage: true, scale: 1 }));
const pptx = await PresentationFile.exportPptx(p);
await pptx.save(finalPptx);
console.log(finalPptx);
