/* NGR AssetPilot V2.25 module: toast.js */
function showToast(message) {
  showToastAction(message);
}

function showToastAction(message, actionLabel = "", action = null) {
  window.clearTimeout(toastTimer);
  els.toastMessage.textContent = String(message || "");
  els.toastAction.onclick = null;
  const hasAction = Boolean(actionLabel && typeof action === "function");
  els.toastAction.classList.toggle("hidden", !hasAction);
  els.toastAction.textContent = hasAction ? actionLabel : "";
  if (hasAction) {
    els.toastAction.onclick = () => {
      window.clearTimeout(toastTimer);
      els.toast.classList.add("hidden");
      els.toastAction.onclick = null;
      action();
    };
  }
  els.toast.classList.remove("hidden");
  toastTimer = window.setTimeout(() => {
    els.toast.classList.add("hidden");
    els.toastAction.onclick = null;
  }, hasAction ? 8000 : 2600);
}
