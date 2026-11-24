const fs = require("node:fs");
const path = require("node:path");

const projectRoot = path.resolve(__dirname, "..");
const packageJson = require(path.join(projectRoot, "package.json"));
const releasePolicy = require("./release-policy.cjs")(packageJson.version);
const installedElectronDist = path.join(projectRoot, "node_modules", "electron", "dist");
const edition = process.env.NGR_BUILD_EDITION;
const editionConfig = {
  prod: {
    appId: "com.chenyuecai.ngrassetpilot",
    productName: "NGR AssetPilot",
    packageName: "ngr-assetpilot",
    main: "desktop/main/prod-index.mjs",
    artifactBase: `NGR-AssetPilot-${packageJson.version}`,
    installerGuid: "3b6eb1bd-e46d-5424-a667-f8c65639ec5e",
  },
  dev: {
    appId: "com.chenyuecai.ngrassetpilot.dev",
    productName: "NGR AssetPilot Dev",
    packageName: "ngr-assetpilot-dev",
    main: "desktop/main/index.mjs",
    artifactBase: `NGR-AssetPilot-Dev-${packageJson.version}`,
    installerGuid: "272695ec-f969-5e42-a779-b51db392d233",
  },
  test: {
    appId: "com.chenyuecai.ngrassetpilot.test",
    productName: "NGR AssetPilot Test",
    packageName: "ngr-assetpilot-test",
    main: "desktop/main/test-index.mjs",
    artifactBase: `NGR-AssetPilot-Test-${packageJson.version}`,
    installerGuid: "d6e22a5c-0be8-54e8-9315-5a7bb7c4dc98",
  },
}[edition];
if (!editionConfig) throw new Error('NGR_BUILD_EDITION 必须是 prod、dev 或 test');

const { appId, productName, packageName, main, artifactBase, installerGuid } = editionConfig;
const publish = edition === "prod"
  ? [{
      provider: "github",
      owner: "907609732",
      repo: "NGR-AssetPilot-App",
      channel: "latest",
      releaseType: "release",
    }]
  : null;
const windowsTargets = edition === "prod"
  ? [{ target: "nsis", arch: ["x64"] }]
  : [
      { target: "nsis", arch: ["x64"] },
      { target: "portable", arch: ["x64"] },
    ];
const extraResources = [
  {
    from: path.join(projectRoot, "build", "icon.ico"),
    to: "tray-icon.ico",
  },
];
const finderLockPath = path.join(projectRoot, "build", "finder-builtin.lock.json");
if (fs.existsSync(finderLockPath)) {
  const finderAsar = path.join(projectRoot, "build", "generated", "finder-builtin", "resources", "app.asar");
  const lock = require(finderLockPath);
  const digest = require("node:crypto").createHash("sha256").update(fs.readFileSync(finderAsar)).digest("hex");
  if (digest !== lock.sha256 || fs.statSync(finderAsar).size !== lock.bytes) {
    throw new Error("内置快速找界面产物与固定版本不一致");
  }
  extraResources.push({ from: finderAsar, to: "finder-builtin/resources/app.asar" });
}
const managedProviderConfigPath = path.join(projectRoot, "build", "generated", "managed-provider-config.json");
if (!releasePolicy.offlineTranslationOnly && fs.existsSync(managedProviderConfigPath)) {
  extraResources.push({
    from: managedProviderConfigPath,
    to: "managed-provider-config.json",
  });
}

module.exports = {
  appId,
  productName,
  executableName: productName,
  electronVersion: "43.4.1",
  electronDist: fs.existsSync(installedElectronDist) ? installedElectronDist : undefined,
  afterPack: ({ appOutDir, electronPlatformName }) => {
    if (electronPlatformName === "win32") {
      fs.rmSync(path.join(appOutDir, "resources", "default_app.asar"), { force: true });
    }
  },
  asar: true,
  asarUnpack: [
    "node_modules/sharp/**/*",
    "node_modules/@img/**/*",
    "node_modules/playwright-core/**/*",
    "node_modules/sql.js/dist/sql-wasm.wasm",
  ],
  compression: "maximum",
  electronLanguages: ["zh-CN", "zh-TW", "en-US"],
  npmRebuild: false,
  buildDependenciesFromSource: false,
  removePackageScripts: true,
  extraMetadata: {
    name: packageName,
    version: packageJson.version,
    main,
  },
  directories: {
    app: projectRoot,
    buildResources: path.join(projectRoot, "build"),
    output: path.join(projectRoot, "artifacts", edition),
  },
  files: [
    "desktop/**/*",
    "build/finder-builtin.lock.json",
    "app/**/*",
    "package.json",
    "LICENSE",
    "THIRD-PARTY-NOTICES.md",
    "!app/API配置文件/**/*",
    "!build/generated/**/*",
    "!desktop/services/test-secrets.mjs",
    "!node_modules/onnxruntime-web/**/*",
    "!node_modules/onnxruntime-node/bin/**/*",
    // TAPD uses the Node WASM entry; omit browser/ASM/worker/debug builds and ZIP archives.
    "!node_modules/sql.js/dist/!(sql-wasm.js|sql-wasm.wasm)",
    "!**/*.map",
    "!**/.DS_Store",
  ],
  extraResources,
  win: {
    icon: path.join(projectRoot, "build", "icon.ico"),
    target: windowsTargets,
    verifyUpdateCodeSignature: edition === "prod" && !releasePolicy.unsigned,
    legalTrademarks: productName,
  },
  nsis: {
    // Keep the identity stable, while manual launches use the assisted wizard.
    // electron-updater still supplies /S and the current install directory.
    guid: installerGuid,
    oneClick: false,
    perMachine: false,
    allowElevation: false,
    allowToChangeInstallationDirectory: true,
    runAfterFinish: true,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    shortcutName: productName,
    deleteAppDataOnUninstall: false,
    artifactName: `${artifactBase}-Setup-x64.\${ext}`,
  },
  portable: {
    artifactName: `${artifactBase}-portable-x64.\${ext}`,
    requestExecutionLevel: "user",
  },
  publish,
};
