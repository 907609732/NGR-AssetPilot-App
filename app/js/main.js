/* NGR AssetPilot V2.25 module: main.js */
async function startApp() {
  resetAppLocalStorageOnVersionChange();
  bootstrapState();
  await hydrateDesktopCredentials();
  await restoreNamingWorkspaceFromStorage();
  init();
  enableNamingWorkspacePersistence();
  registerDesktopQuitPersistence();
}

startApp().catch((error) => {
  console.error("NGR AssetPilot 启动失败", error);
  setNamingWorkspaceSaveStatus("error", "工具初始化失败，请刷新页面重试");
});
