import assert from "node:assert/strict";
import { Blob } from "node:buffer";
import fs from "node:fs";
import vm from "node:vm";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const fflate = require("../app/vendor/fflate-0.8.3.min.js");
const source = fs.readFileSync(new URL("../app/js/export-template-storage.js", import.meta.url), "utf8");
const namingSource = fs.readFileSync(new URL("../app/js/naming-knowledge.js", import.meta.url), "utf8");
const duplicateStatusSource = namingSource.match(/function getDuplicateStatus[\s\S]+?(?=\nfunction inferKind)/)?.[0];
assert.ok(duplicateStatusSource, "应能提取重复命名状态函数");

let downloadedBlob = null;
let downloadedName = "";

const context = {
  Blob,
  Map,
  Set,
  Uint8Array,
  URL: {
    createObjectURL(blob) {
      downloadedBlob = blob;
      return "blob:test";
    },
    revokeObjectURL() {},
  },
  console,
  defaultRules: {
    basePrefix: "T_UI",
    projectName: "工程名",
    viewName: "",
  },
  document: {
    createElement() {
      return {
        click() {
          downloadedName = this.download;
        },
      };
    },
  },
  els: {
    exportFiles: { disabled: false },
    exportModeSelect: { value: "folder" },
  },
  formatNamingName: (value) => value,
  localStorage: {
    getItem: () => null,
    setItem() {},
  },
  rules: {
    basePrefix: "T_UI",
    projectName: "DefaultProject",
    viewName: "Home",
    separator: "_",
  },
  currentWorkProjectName: "DefaultProject",
  prefixLibrary: [
    { id: "builtin:none", value: "", label: "无", builtin: true },
    { id: "builtin:t-ui", value: "T_UI", label: "T_UI", builtin: true },
    { id: "builtin:t-ui-icon", value: "T_UI_Icon", label: "T_UI_Icon", builtin: true },
  ],
  NgrPrefixLibrary: {
    sanitizePrefixValue: (value) => String(value || ""),
    normalizePrefixLibrary: (value) => value?.entries || value || [],
    getPrefixEntry: (entries, idOrValue) => entries.find((entry) => entry.id === idOrValue || entry.value === idOrValue) || (idOrValue === "__none" ? entries[0] : null),
    ensurePrefixEntry(entries, value) {
      const entry = { id: `custom:${value}`, value, label: value, builtin: false };
      entries.push(entry);
      return entry;
    },
    resolvePrefixValue: (entries, idOrValue) => entries.find((entry) => entry.id === idOrValue || entry.value === idOrValue)?.value || "",
  },
  sanitizeName: (value) => String(value || "")
    .trim()
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/\s+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, ""),
  sanitizePrefix: (value) => String(value || ""),
  showToast() {},
  window: {
    fflate,
    setTimeout(callback) {
      callback();
    },
  },
};

vm.createContext(context);
vm.runInContext(source, context);
vm.runInContext(duplicateStatusSource, context);

const projectAFile = new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" });
const projectBFile = new Blob([new Uint8Array([4, 5])], { type: "image/png" });
context.assets = [
  {
    id: "asset-a",
    customProjectName: "ProjectA",
    extension: ".png",
    file: projectAFile,
    finalBaseName: "Cloud",
  },
  {
    id: "asset-b",
    customProjectName: "ProjectB",
    extension: ".png",
    file: projectBFile,
    finalBaseName: "Button",
  },
];

const writtenFiles = new Map();
context.window.showDirectoryPicker = async () => ({
  async getDirectoryHandle(folderName) {
    return {
      async getFileHandle(fileName) {
        return {
          async createWritable() {
            return {
              async close() {},
              async write(blob) {
                writtenFiles.set(`${folderName}/${fileName}`, new Uint8Array(await blob.arrayBuffer()));
              },
            };
          },
        };
      },
    };
  },
});

assert.equal(await context.exportAssetsToProjectFolders(), 2);
assert.deepEqual([...writtenFiles.keys()].sort(), [
  "ProjectA/T_UI_ProjectA_Home_Cloud.png",
  "ProjectB/T_UI_ProjectB_Home_Button.png",
]);

await context.exportAssetsAsZip();
assert.equal(downloadedName, "DefaultProject_多工程导出.zip");
const zipFiles = fflate.unzipSync(new Uint8Array(await downloadedBlob.arrayBuffer()));
assert.deepEqual(Object.keys(zipFiles).sort(), [
  "ProjectA/T_UI_ProjectA_Home_Cloud.png",
  "ProjectB/T_UI_ProjectB_Home_Button.png",
]);
assert.deepEqual([...zipFiles["ProjectA/T_UI_ProjectA_Home_Cloud.png"]], [1, 2, 3]);
assert.deepEqual([...zipFiles["ProjectB/T_UI_ProjectB_Home_Button.png"]], [4, 5]);

assert.equal(context.buildExportProjectFolderName({ customProjectName: "CON" }), "_CON");
const albumEditedAsset = {
  ...context.assets[0],
  customBasePrefix: "T_UI_Icon",
  customProjectName: "ProjectA",
  customViewName: "Gallery",
  finalBaseName: "CloudEdited",
};
assert.equal(context.buildExportName(albumEditedAsset), "T_UI_Icon_ProjectA_Gallery_CloudEdited.png");
context.assets = [albumEditedAsset];
await context.exportAssetsAsZip();
assert.equal(downloadedName, "ProjectA.zip");
const editedZipFiles = fflate.unzipSync(new Uint8Array(await downloadedBlob.arrayBuffer()));
assert.deepEqual(Object.keys(editedZipFiles), ["ProjectA/T_UI_Icon_ProjectA_Gallery_CloudEdited.png"]);

assert.equal(context.findDuplicateExportAsset(), null);
context.assets.push({ ...context.assets[0], id: "asset-duplicate" });
assert.equal(context.findDuplicateExportAsset().id, "asset-duplicate");
const duplicateGroups = [...context.buildDuplicateExportGroups().values()].filter((group) => group.length > 1);
assert.equal(duplicateGroups.length, 1);
assert.equal(duplicateGroups[0].map((asset) => asset.id).join(","), "asset-a,asset-duplicate");
const duplicateContext = { groups: context.buildDuplicateExportGroups(), historicalMatch: null, historicalNames: new Set() };
const duplicateStatus = context.getDuplicateStatus(context.assets[0], duplicateContext);
assert.equal(duplicateStatus.kind, "batch");
assert.equal(duplicateStatus.count, 2);
assert.match(duplicateStatus.message, /asset-duplicate|共 2 张同名/);

context.assets[1].customProjectName = "ProjectB";
assert.equal(context.findDuplicateExportAsset(), null, "相同文件名位于不同工程文件夹时不应误报");

console.log("export packaging tests: OK");
