import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";

const storageSource = fs.readFileSync(new URL("../app/js/export-template-storage.js", import.meta.url), "utf8");
const detectionSource = fs.readFileSync(new URL("../app/js/assets-detection.js", import.meta.url), "utf8");
const htmlSource = fs.readFileSync(new URL("../app/index.html", import.meta.url), "utf8");

const profileHelpers = storageSource.match(
  /function getDefaultDetectionProfiles\(\) \{[\s\S]+?(?=\nfunction getActiveDetectionProfile)/,
)?.[0];
const dimensionHelpers = detectionSource.match(
  /function getNgrRiskMessage\(profile\) \{[\s\S]+?(?=\nfunction validateUploadDimensions)/,
)?.[0];
const fileConstraintHelper = detectionSource.match(
  /function validateDetectionFileConstraints\(file, profile\) \{[\s\S]+?\n\}/,
)?.[0];

assert.ok(profileHelpers, "应能提取检测配置归一化函数");
assert.ok(dimensionHelpers, "应能提取尺寸检测函数");
assert.ok(fileConstraintHelper, "应能提取文件约束函数");

const context = vm.createContext({});
vm.runInContext(profileHelpers, context);
vm.runInContext("function isPowerOfTwo(value) { return value > 0 && (value & (value - 1)) === 0; }", context);
vm.runInContext(dimensionHelpers, context);
vm.runInContext(fileConstraintHelper, context);

function normalize(profile) {
  context.candidateProfile = profile;
  return JSON.parse(vm.runInContext("JSON.stringify(normalizeDetectionProfile(candidateProfile))", context));
}

function validate(width, height, profile) {
  context.candidateDimensions = { width, height };
  context.candidateProfile = profile;
  return JSON.parse(vm.runInContext(
    "JSON.stringify(validateDetectionDimensions(candidateDimensions, candidateProfile))",
    context,
  ));
}

test("旧检测项目组自动补齐全部新规则并限制异常配置范围", () => {
  const legacy = normalize({ id: "legacy", name: "旧项目", mode: "ngr", atlasMultiple: 2 });
  assert.equal(legacy.minWidth, 1);
  assert.equal(legacy.maxFileSizeMb, 0);
  assert.equal(legacy.oversizeSeverity, "error");
  assert.equal(legacy.riskSide, 2048);
  assert.equal(legacy.pcEffectWidth, 2560);
  assert.equal(legacy.plannerRequirePowerOfTwo, true);
  assert.deepEqual(legacy.iconAllowedSizes, [32, 64, 128, 256, 512, 1024]);

  const bounded = normalize({
    minWidth: -1,
    maxFileSizeMb: 20000,
    maxSide: 999999,
    oversizeSeverity: "unknown",
    iconAllowedSizes: "64, 32, 64, nope, 999999",
  });
  assert.equal(bounded.minWidth, 1);
  assert.equal(bounded.maxFileSizeMb, 0);
  assert.equal(bounded.maxSide, 1024);
  assert.equal(bounded.oversizeSeverity, "error");
  assert.deepEqual(bounded.iconAllowedSizes, [32, 64]);
});

test("NGR 图集倍数、尺寸上下限和告警级别均按项目组配置生效", () => {
  const base = normalize({
    mode: "ngr",
    minWidth: 16,
    minHeight: 16,
    atlasMultiple: 8,
    largeThreshold: 512,
    largeMultiple: 16,
    maxSide: 1024,
    oversizeSeverity: "warning",
    riskSide: 2048,
    riskSideSeverity: "error",
  });

  assert.match(validate(8, 8, base).messages.join(" "), /不得小于 16x16/);
  assert.match(validate(66, 64, base).messages.join(" "), /图集宽高需要是8的倍数/);
  assert.match(validate(520, 520, base).messages.join(" "), /大图需要是16的倍数/);

  const oversize = validate(1200, 800, base);
  assert.equal(oversize.hasIssue, false);
  assert.match(oversize.warnings.join(" "), /不能超过1024/);

  const risk = validate(2048, 1024, base);
  assert.equal(risk.hasIssue, true);
  assert.match(risk.messages.join(" "), /白名单审批/);
});

test("背景和效果图尺寸、策划规则与 Icon 尺寸均可独立配置", () => {
  const ngr = normalize({
    mode: "ngr",
    backgroundWidth: 4000,
    backgroundHeight: 2000,
    pcEffectWidth: 3000,
    pcEffectHeight: 1600,
    mobileEffectWidth: 2200,
    mobileEffectHeight: 1000,
  });
  assert.equal(validate(4000, 2000, ngr).label, "背景图");
  assert.equal(validate(3000, 1600, ngr).label, "PC效果图");
  assert.equal(validate(2200, 1000, ngr).label, "移动端效果图");

  const planner = normalize({ mode: "planner", plannerRequireEven: false, plannerRequirePowerOfTwo: false });
  assert.equal(validate(63, 65, planner).hasIssue, false);

  const icon = normalize({ mode: "icon", iconRequireSquare: false, iconAllowedSizes: "48,96" });
  assert.equal(validate(48, 96, icon).hasIssue, false);
  assert.match(validate(64, 64, icon).messages.join(" "), /48、96/);
});

test("文件大小上限和设置页新增控件均为真实生效配置", () => {
  context.candidateFile = { size: 2.5 * 1024 * 1024 };
  context.candidateProfile = normalize({ maxFileSizeMb: 2 });
  const result = JSON.parse(vm.runInContext(
    "JSON.stringify(validateDetectionFileConstraints(candidateFile, candidateProfile))",
    context,
  ));
  assert.match(result.messages[0], /2.5 MB/);

  for (const id of [
    "detectionMinWidth",
    "detectionMaxFileSizeMb",
    "detectionOversizeSeverity",
    "detectionRiskSide",
    "detectionPcEffectWidth",
    "detectionMobileEffectWidth",
    "detectionPlannerRequirePowerOfTwo",
    "detectionIconAllowedSizes",
  ]) {
    assert.match(htmlSource, new RegExp(`id="${id}"`));
  }
  assert.match(htmlSource, /PNG（扩展名与文件内容双重校验）/);
});
