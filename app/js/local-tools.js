(() => {
  const api = window.ngrDesktop?.localTools;
  if (!api) return;
  const get = name => document.getElementById("localTools" + name);
  const dialog = get("Dialog");
  const mcp = get("Mcp");
  const open = get("Browser");
  const notice = get("Notice");
  let busy = false;
  let state;

  function feedback(message = "", error = false) {
    notice.textContent = message;
    notice.hidden = !message;
    notice.dataset.error = String(error);
  }

  function render() {
    mcp.checked = state?.mcpEnabled === true;
    get("McpConnect").hidden = !mcp.checked;
    get("McpUrl").textContent = state?.mcpUrl ?? "";
    mcp.disabled = busy || !state;
    for (const name of ["CopyGuide", "CopyUrl", "CopyToken", "Rotate"]) {
      get(name).disabled = busy;
    }
    open.disabled = busy;
  }

  async function request(action, details = {}, message = "") {
    if (busy) return;
    busy = true;
    feedback();
    try {
      const pending = api.action({ action, ...details });
      render();
      state = await pending;
      feedback(message);
    } catch (error) {
      feedback(error?.message?.replace(/^Error invoking remote method .*?:\s*(?:Error:\s*)?/, "") || "操作未完成，请重试", true);
    } finally {
      busy = false;
      render();
    }
  }

  get("Announcement").hidden = false;
  get("Help").addEventListener("click", () => {
    dialog.showModal();
    void request("status");
  });
  get("Close").addEventListener("click", () => dialog.close());
  mcp.addEventListener("change", () => void request("set", { feature: "mcp", enabled: mcp.checked }));
  open.addEventListener("click", () => void request("openBrowser"));
  get("CopyGuide").addEventListener("click", () => void request("copyMcpGuide", {}, "调用说明已复制"));
  get("CopyUrl").addEventListener("click", () => void request("copyUrl", {}, "地址已复制"));
  get("CopyToken").addEventListener("click", () => void request("copyToken", {}, "令牌已复制"));
  get("Rotate").addEventListener("click", () => {
    if (window.confirm("重置后，AI 客户端需要重新填写令牌。")) {
      void request("rotateToken", {}, "令牌已重置");
    }
  });
})();
