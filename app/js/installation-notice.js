(() => {
  function openTutorial() {
    const overlay = document.getElementById("tutorialCenterOverlay");
    if (!overlay || !window.NgrTutorialCenter) return null;
    window.NgrTutorialCenter.open();
    return overlay;
  }

  function openVersionNotice(notice) {
    const dialog = document.getElementById("installationNoticeDialog");
    const title = document.getElementById("installationNoticeTitle");
    const version = document.getElementById("installationNoticeVersion");
    const notes = document.getElementById("installationNoticeNotes");
    title.textContent = notice.kind === "reinstall" ? "重新安装完成" : "更新完成";
    const { versionLabel } = window.NgrUpdateUi;
    const currentVersion = versionLabel(notice.version);
    const previousVersion = versionLabel(notice.previousVersion);
    const previousLabel = notice.previousVersion && previousVersion !== currentVersion
      ? `（更新前 ${previousVersion}）`
      : "";
    version.textContent = `当前版本 ${currentVersion}${previousLabel}`;
    notes.textContent = typeof notice.notes === "string" && notice.notes.trim()
      ? notice.notes
      : "暂无版本变动说明";
    dialog.showModal();
    return dialog;
  }

  async function showInstallationNotice() {
    const bridge = window.ngrDesktop?.installationNotice;
    if (!bridge) return;
    const notice = await bridge.get();
    if (!notice?.id) return;

    if (document.hidden) {
      await new Promise((resolve) => {
        function whenVisible() {
          if (document.hidden) return;
          document.removeEventListener("visibilitychange", whenVisible);
          resolve();
        }
        document.addEventListener("visibilitychange", whenVisible);
      });
    }

    let view;
    if (notice.kind === "first") view = openTutorial();
    if (notice.kind === "update" || notice.kind === "reinstall") view = openVersionNotice(notice);
    if (!view) return;

    // Leave a rendering frame between opening the view and consuming the install event.
    await new Promise((resolve) => {
      window.requestAnimationFrame(() => window.requestAnimationFrame(resolve));
    });
    if (!document.hidden && view.getClientRects().length) await bridge.acknowledge(notice.id);
  }

  function start() {
    void showInstallationNotice().catch((error) => console.warn("安装完成提示加载失败", error));
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  } else {
    start();
  }
})();
