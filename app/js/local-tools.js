(() => {
  const api = window.ngrDesktop?.localTools;
  if (!api) return;
  const get = name => document.getElementById("localTools" + name);
  const dialog = get("Dialog");
  const mcp = get("Mcp");
  const web = get("Web");
  const open = get("Browser");
  const notice = get("Notice");
  let busy = false;
  let state;

  function render() {
    mcp.checked = state?.mcpEnabled === true;
    web.checked = state?.webEnabled === true;
    get("McpConnect").hidden = !mcp.checked;
    get("Grant").hidden = !mcp.checked && !web.checked;
    get("McpUrl").textContent = state?.mcpUrl ?? "";
    mcp.disabled = web.disabled = busy;
    open.disabled = busy || !web.checked;
  }

  async function request(action, details = {}, message = "") {
    if (busy) return;
    busy = true;
    notice.textContent = "";
    try {
      const pending = api.action({ action, ...details });
      render();
      state = await pending;
      notice.textContent = action === "grantSource" ? state.granted ? "已授权，可以让 AI 处理这些图片" : "" : message;
    } catch (error) {
      notice.textContent = error?.message?.replace(/^Error invoking remote method .*?:\s*(?:Error:\s*)?/, "") || "操作未完成，请重试";
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
  web.addEventListener("change", () => void request("set", { feature: "web", enabled: web.checked }));
  open.addEventListener("click", () => void request("openBrowser"));
  get("CopyUrl").addEventListener("click", () => void request("copyUrl", {}, "地址已复制"));
  get("CopyToken").addEventListener("click", () => void request("copyToken", {}, "令牌已复制"));
  get("GrantFiles").addEventListener("click", () => void request("grantSource", { kind: "files" }));
  get("GrantDirectory").addEventListener("click", () => void request("grantSource", { kind: "directory" }));
  get("Rotate").addEventListener("click", () => {
    if (window.confirm("重置后，AI 客户端需要重新填写令牌。")) {
      void request("rotateToken", {}, "令牌已重置");
    }
  });
})();
