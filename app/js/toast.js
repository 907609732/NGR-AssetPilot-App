/* NGR AssetPilot V2.25 module: toast.js */
function showToast(message) {
  window.clearTimeout(toastTimer);
  els.toast.textContent = message;
  els.toast.classList.remove("hidden");
  toastTimer = window.setTimeout(() => els.toast.classList.add("hidden"), 2600);
}
