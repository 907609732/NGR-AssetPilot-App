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
  assert.equal(packageJson.dependencies["electron-log"], "5.4.4");
  assert.equal(packageJson.dependencies.fflate, "0.8.3");
  assert.equal(packageJson.devDependencies["@playwright/test"], "1.62.1");
  assert.equal(packageJson.scripts["build:prod"], "node scripts/run-build.mjs prod");
  assert.equal(packageJson.scripts["build:dev"], "node scripts/run-build.mjs dev");
  assert.equal(packageJson.scripts["build:test"], "node scripts/run-build.mjs test");
  assert.equal(packageJson.scripts["prepare:offline-translation"], "node scripts/prepare-offline-translation-model.mjs");
  const builderConfig = fs.readFileSync(path.join(projectRoot, "build", "electron-builder.config.cjs"), "utf8");
  assert.match(builderConfig, /"app\/\*\*\/\*"/);
  assert.equal(fs.existsSync(path.join(projectRoot, "app", "js", "workspace-backup-stream-worker.js")), true);
  const secretScanner = fs.readFileSync(path.join(projectRoot, "scripts", "scan-package-secrets.mjs"), "utf8");
  assert.match(secretScanner, /relativeFile === "builder-effective-config\.yaml"/);
  assert.match(secretScanner, /containsBuffer\(filePath, needle\)/);
});

test("应用版本、界面标识和静态资源缓存版本保持一致", () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(projectRoot, "package.json"), "utf8"));
  const packageLock = JSON.parse(fs.readFileSync(path.join(projectRoot, "package-lock.json"), "utf8"));
  const appConfig = fs.readFileSync(path.join(projectRoot, "app", "js", "config.js"), "utf8");
  const appIndex = fs.readFileSync(path.join(projectRoot, "app", "index.html"), "utf8");
  const escapedVersion = packageJson.version.replaceAll(".", "\\.");

  assert.equal(packageLock.version, packageJson.version);
  assert.equal(packageLock.packages[""].version, packageJson.version);
  assert.match(appConfig, new RegExp(`const APP_VERSION = "V${escapedVersion}";`));

  const visibleVersions = [...appIndex.matchAll(/data-app-version[^>]*>V(\d+\.\d+\.\d+)</g)].map((match) => match[1]);
  assert.equal(visibleVersions.length, 3);
  assert.deepEqual([...new Set(visibleVersions)], [packageJson.version]);

  const cacheVersions = [...appIndex.matchAll(/[?&]v=V(\d+\.\d+\.\d+)/g)].map((match) => match[1]);
  assert.equal(cacheVersions.length, 23);
  assert.deepEqual([...new Set(cacheVersions)], [packageJson.version]);
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
  assert.equal(prod.nsis.guid, "3b6eb1bd-e46d-5424-a667-f8c65639ec5e");
  assert.equal(dev.nsis.guid, "272695ec-f969-5e42-a779-b51db392d233");
  assert.equal(testConfig.nsis.guid, "d6e22a5c-0be8-54e8-9315-5a7bb7c4dc98");
  assert.equal(new Set([prod.nsis.guid, dev.nsis.guid, testConfig.nsis.guid]).size, 3);
  assert.equal(prod.nsis.oneClick, false);
  assert.equal(prod.nsis.allowToChangeInstallationDirectory, true);
  assert.equal(prod.nsis.perMachine, false);
  assert.deepEqual(prod.win.target, [{ target: "nsis", arch: ["x64"] }]);
  assert.deepEqual(dev.win.target.map(({ target }) => target), ["nsis", "portable"]);
  assert.deepEqual(testConfig.win.target.map(({ target }) => target), ["nsis", "portable"]);
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
    assert.equal(config.extraResources.length, 1);
    const offlineTranslation = config.extraResources.find(({ to }) => to === "offline-translation");
    assert.match(offlineTranslation.from, /build[\\/]generated[\\/]offline-translation$/);
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
  assert.match(bootstrap, /onEngineEvent:/);
  assert.match(bootstrap, /runtimeLogger\.(?:info|warn)/);
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

test("正式版发布工作流同时上传自动更新元数据", () => {
  const workflow = fs.readFileSync(path.join(projectRoot, ".github", "workflows", "desktop-release.yml"), "utf8");
  const latestEntries = workflow.match(/artifacts\/prod\/latest\.yml/g) || [];
  assert.equal(latestEntries.length, 2, "latest.yml 必须同时进入 Actions 构建产物和 GitHub Release");
  assert.match(workflow, /artifacts\/prod\/\*\.exe/);
  assert.match(workflow, /artifacts\/prod\/\*\.blockmap/);
  assert.match(workflow, /GITHUB_REF_NAME/);
  assert.match(workflow, /npm run verify:packaged:prod/);
  assert.match(workflow, /draft:\s*false/);
  assert.doesNotMatch(workflow, /draft:\s*true/);
  assert.match(workflow, /body_path:\s*docs\/releases\/\$\{\{ github\.ref_name \}\}\.md/);
  assert.match(workflow, /generate_release_notes:\s*false/);
});

test("GitHub Actions 固定第三方提交并使用最小发布权限", () => {
  const ci = fs.readFileSync(path.join(projectRoot, ".github", "workflows", "desktop-ci.yml"), "utf8");
  const release = fs.readFileSync(path.join(projectRoot, ".github", "workflows", "desktop-release.yml"), "utf8");
  for (const source of [ci, release]) {
    assert.doesNotMatch(source, /uses:\s*[^\s]+@v\d+/);
    const uses = [...source.matchAll(/uses:\s*[^\s]+@([0-9a-f]{40})\b/g)];
    assert.ok(uses.length >= 2);
    assert.match(source, /persist-credentials:\s*false/);
  }
  assert.match(ci, /permissions:\s*\r?\n\s+contents:\s*read/);
  assert.match(release, /permissions:\s*\r?\n\s+contents:\s*read/);
  assert.match(release, /environment:\s*production-release/);
  assert.match(release, /build-release:[\s\S]*?permissions:\s*\r?\n\s+contents:\s*write/);
});

test("发布校验清单不会引用未上传的 builder 调试文件", () => {
  const generator = fs.readFileSync(path.join(projectRoot, "scripts", "generate-release-metadata.mjs"), "utf8");
  assert.match(generator, /"builder-debug\.yml"/);
  assert.match(generator, /sbom\.metadata\.component\.name = packageJson\.name/);
});
