const path = require("node:path");

const projectRoot = path.resolve(__dirname, "..");
const packageJson = require(path.join(projectRoot, "package.json"));
const edition = process.env.NGR_BUILD_EDITION;
if (!['dev', 'test'].includes(edition)) throw new Error('NGR_BUILD_EDITION 必须是 dev 或 test');

const isTest = edition === 'test';
const editionLabel = isTest ? 'Test' : 'Dev';
const productName = `NGR AssetPilot ${editionLabel}`;
const artifactBase = `NGR-AssetPilot-${editionLabel}-${packageJson.version}`;

module.exports = {
  appId: `com.chenyuecai.ngrassetpilot.${edition}`,
  productName,
  executableName: productName,
  electronVersion: "43.4.1",
  asar: true,
  asarUnpack: [
    "node_modules/onnxruntime-node/bin/**/*",
    "node_modules/sharp/**/*",
    "node_modules/@img/**/*",
  ],
  compression: "maximum",
  npmRebuild: false,
  buildDependenciesFromSource: false,
  removePackageScripts: true,
  extraMetadata: {
    name: `ngr-assetpilot-${edition}`,
    version: packageJson.version,
    main: isTest ? "desktop/main/test-index.mjs" : "desktop/main/index.mjs",
  },
  directories: {
    app: projectRoot,
    buildResources: path.join(projectRoot, "build"),
    output: path.join(projectRoot, "artifacts", edition),
  },
  files: [
    "desktop/**/*",
    "app/**/*",
    "package.json",
    "LICENSE",
    "THIRD-PARTY-NOTICES.md",
    "!app/API配置文件/**/*",
    "!build/generated/**/*",
    "!desktop/services/test-secrets.mjs",
    "!node_modules/onnxruntime-web/**/*",
    "!node_modules/onnxruntime-node/bin/napi-v6/darwin/**/*",
    "!node_modules/onnxruntime-node/bin/napi-v6/linux/**/*",
    "!node_modules/onnxruntime-node/bin/napi-v6/win32/arm64/**/*",
    "!**/*.map",
    "!**/.DS_Store",
  ],
  extraResources: [],
  win: {
    icon: path.join(projectRoot, "build", "icon.ico"),
    target: [
      { target: "nsis", arch: ["x64"] },
      { target: "portable", arch: ["x64"] },
    ],
    verifyUpdateCodeSignature: false,
    legalTrademarks: productName,
  },
  nsis: {
    oneClick: false,
    perMachine: false,
    allowElevation: false,
    allowToChangeInstallationDirectory: true,
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
  publish: null,
};
