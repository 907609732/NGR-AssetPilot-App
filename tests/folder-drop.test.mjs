import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const uploadSource = fs.readFileSync(path.join(projectRoot, "app", "js", "uploads-editor-translator.js"), "utf8");
const dropApi = new Function(`${uploadSource}\nreturn { collectDroppedFiles };`)();

function fileEntry(file) {
  return {
    isFile: true,
    isDirectory: false,
    file(resolve) { resolve(file); },
  };
}

function directoryEntry(children) {
  let readCount = 0;
  return {
    isFile: false,
    isDirectory: true,
    createReader() {
      return {
        readEntries(resolve) {
          readCount += 1;
          resolve(readCount === 1 ? children : []);
        },
      };
    },
  };
}

test("新目录句柄失败后仍能使用同一 drop 周期捕获的文件夹入口", async () => {
  let sameDropTick = true;
  const image = { name: "button.png", type: "image/png", size: 12, lastModified: 1 };
  const entry = directoryEntry([fileEntry(image)]);
  const item = {
    kind: "file",
    getAsFileSystemHandle() {
      queueMicrotask(() => { sameDropTick = false; });
      return Promise.reject(new Error("handle unavailable"));
    },
    webkitGetAsEntry() {
      return sameDropTick ? entry : null;
    },
    getAsFile() { return null; },
  };

  const files = await dropApi.collectDroppedFiles({ items: [item], files: [] });
  assert.deepEqual(files, [image]);
  assert.equal(sameDropTick, false);
});

test("文件夹句柄递归导入并保留相对目录", async () => {
  const image = { name: "icon.png", type: "image/png", size: 24, lastModified: 2 };
  const fileHandle = { kind: "file", name: image.name, getFile: async () => image };
  const childDirectory = {
    kind: "directory",
    name: "icons",
    async *values() { yield fileHandle; },
  };
  const rootDirectory = {
    kind: "directory",
    name: "ui",
    async *values() { yield childDirectory; },
  };
  const item = {
    kind: "file",
    getAsFileSystemHandle: () => Promise.resolve(rootDirectory),
    webkitGetAsEntry: () => null,
    getAsFile: () => null,
  };

  const files = await dropApi.collectDroppedFiles({ items: [item], files: [] });
  assert.equal(files.length, 1);
  assert.equal(files[0], image);
  assert.equal(files[0].webkitRelativePath, "ui/icons/icon.png");
});
