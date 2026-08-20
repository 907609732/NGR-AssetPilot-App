import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { test } from "node:test";
import { createProjectEnvironment, projectPaths, projectRoot } from "../scripts/project-env.mjs";

const require = createRequire(import.meta.url);
const builderConfigPath = path.join(projectRoot, "build", "electron-builder.config.cjs");

function loadBuilderConfig(edition) {
  const previous = process.env.NGR_BUILD_EDITION;
  process.env.NGR_BUILD_EDITION = edition;
  delete require.cache[require.resolve(builderConfigPath)];
  try { return require(builderConfigPath); }
  finally {
    if (previous === undefined) delete process.env.NGR_BUILD_EDITION;
    else process.env.NGR_BUILD_EDITION = previous;
  }
}

test("桌面依赖版本全部精确锁定", () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(projectRoot, "package.json"), "utf8"));
  assert.equal(packageJson.devDependencies.electron, "43.4.1");
  assert.equal(packageJson.devDependencies["electron-builder"], "26.15.3");
  assert.equal(packageJson.dependencies["electron-updater"], "6.8.9");
  assert.equal(packageJson.dependencies["@huggingface/transformers"], "4.2.0");
  assert.equal(packageJson.dependencies["onnxruntime-node"], "1.24.3");
  assert.equal(packageJson.dependencies.sharp, "0.35.3");
  assert.equal(packageJson.dependencies["adm-zip"], "0.6.0");
  assert.equal(packageJson.devDependencies["@playwright/test"], "1.62.1");
  assert.equal(packageJson.scripts["build:prod"], "node scripts/run-build.mjs prod");
  assert.equal(packageJson.scripts["build:dev"], "node scripts/run-build.mjs dev");
  assert.equal(packageJson.scripts["build:test"], "node scripts/run-build.mjs test");
});

test("正式版、开发版和测试版身份、入口、数据与产物完全隔离", () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(projectRoot, "package.json"), "utf8"));
  const prod = loadBuilderConfig("prod");
  const dev = loadBuilderConfig("dev");
  const testConfig = loadBuilderConfig("test");
  assert.equal(prod.appId, "com.chenyuecai.ngrassetpilot");
  assert.equal(dev.appId, "com.chenyuecai.ngrassetpilot.dev");
  assert.equal(testConfig.appId, "com.chenyuecai.ngrassetpilot.test");
  assert.equal(prod.productName, "NGR AssetPilot");
  assert.equal(dev.productName, "NGR AssetPilot Dev");
  assert.equal(testConfig.productName, "NGR AssetPilot Test");
  assert.equal(prod.extraMetadata.main, "desktop/main/prod-index.mjs");
  assert.equal(dev.extraMetadata.main, "desktop/main/index.mjs");
  assert.equal(testConfig.extraMetadata.main, "desktop/main/test-index.mjs");
  assert.equal(path.resolve(prod.directories.output), path.resolve(projectPaths.prodArtifacts));
  assert.equal(path.resolve(dev.directories.output), path.resolve(projectPaths.devArtifacts));
  assert.equal(path.resolve(testConfig.directories.output), path.resolve(projectPaths.testArtifacts));
  assert.ok(prod.nsis.artifactName.includes(`NGR-AssetPilot-${packageJson.version}`));
  assert.ok(dev.nsis.artifactName.includes(`NGR-AssetPilot-Dev-${packageJson.version}`));
  assert.ok(testConfig.nsis.artifactName.includes(`NGR-AssetPilot-Test-${packageJson.version}`));
  for (const config of [prod, dev, testConfig]) {
    assert.deepEqual(config.extraResources, []);
    assert.ok(config.files.includes("!build/generated/**/*"));
    assert.ok(config.files.includes("!app/API配置文件/**/*"));
    assert.ok(config.files.includes("!desktop/services/test-secrets.mjs"));
    assert.ok(config.asarUnpack.some((pattern) => pattern.includes("onnxruntime-node/bin")));
  }
  assert.deepEqual(prod.publish, [{
    provider: "github",
    owner: "907609732",
    repo: "NGR-AssetPilot-App",
    channel: "latest",
    releaseType: "release",
  }]);
  assert.equal(dev.publish, null);
  assert.equal(testConfig.publish, null);
});

test("三个入口明确选择版本且启动器不内置平台凭据", () => {
  const prodEntry = fs.readFileSync(path.join(projectRoot, "desktop", "main", "prod-index.mjs"), "utf8");
  const devEntry = fs.readFileSync(path.join(projectRoot, "desktop", "main", "index.mjs"), "utf8");
  const testEntry = fs.readFileSync(path.join(projectRoot, "desktop", "main", "test-index.mjs"), "utf8");
  const bootstrap = fs.readFileSync(path.join(projectRoot, "desktop", "main", "bootstrap.mjs"), "utf8");
  assert.match(prodEntry, /edition:\s*"prod"/);
  assert.match(devEntry, /ngr-edition=test/);
  assert.match(testEntry, /edition:\s*"test"/);
  assert.match(bootstrap, /NGR AssetPilot Dev/);
  assert.match(bootstrap, /NGR AssetPilot Test/);
  assert.match(bootstrap, /com\.chenyuecai\.ngrassetpilot/);
  assert.match(bootstrap, /app\.isPackaged\s*&&\s*isProductionEdition/);
  assert.match(bootstrap, /channel:\s*updateChannel/);
  assert.doesNotMatch(bootstrap, /updaterRequested\s*=\s*false/);
  assert.doesNotMatch(prodEntry + devEntry + testEntry + bootstrap, /local-config\.js|KIMI_API_KEY|BAIDU_SECRET/);
});

test("缓存、临时文件、日志和三版本产物全部定向工程目录", () => {
  const env = createProjectEnvironment();
  for (const directory of Object.values(projectPaths)) {
    assert.ok(path.resolve(directory).startsWith(path.resolve(projectRoot) + path.sep));
  }
  assert.equal(env.TEMP, projectPaths.temp);
  assert.equal(env.NPM_CONFIG_CACHE, projectPaths.npmCache);
  assert.equal(env.ELECTRON_CACHE, projectPaths.electronCache);
  assert.equal(env.ELECTRON_BUILDER_CACHE, projectPaths.electronBuilderCache);
  assert.equal(env.PLAYWRIGHT_BROWSERS_PATH, projectPaths.playwrightCache);
});
