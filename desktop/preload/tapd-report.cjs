"use strict";

const { contextBridge, ipcRenderer } = require("electron");

const channels = Object.freeze({
  load: "tapd:load",
  login: "tapd:login",
  collect: "tapd:collect",
  cancel: "tapd:cancel",
  save: "tapd:save",
  restore: "tapd:restore",
  clearAllData: "tapd:clear-all-data",
  extractBugImages: "tapd:extract-bug-images",
  listBugImages: "tapd:list-bug-images",
  getBugImage: "tapd:get-bug-image",
  export: "tapd:export",
  copy: "tapd:copy",
  openPath: "tapd:open-path",
  openItem: "tapd:open-item",
  progress: "tapd:progress",
});

const invoke = (channel, payload) => ipcRenderer.invoke(channel, payload);
const bridge = Object.freeze({
  load: () => invoke(channels.load),
  login: () => invoke(channels.login),
  collect: (scope) => invoke(channels.collect, scope),
  cancel: () => invoke(channels.cancel),
  save: (input) => invoke(channels.save, input),
  restoreSnapshot: (id) => invoke(channels.restore, id),
  clearAllData: () => invoke(channels.clearAllData),
  extractBugImages: (input) => invoke(channels.extractBugImages, input),
  listBugImages: (input) => invoke(channels.listBugImages, input),
  getBugImage: (input) => invoke(channels.getBugImage, input),
  export: (input) => invoke(channels.export, input),
  copy: (input) => invoke(channels.copy, input),
  openPath: (path) => invoke(channels.openPath, path),
  openItem: (url) => invoke(channels.openItem, url),
  onProgress: (callback) => {
    if (typeof callback !== "function") return () => {};
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on(channels.progress, listener);
    return () => ipcRenderer.removeListener(channels.progress, listener);
  },
});

contextBridge.exposeInMainWorld("tapd", bridge);
