(() => {
  const more = document.getElementById("moreFeaturesPopover");
  const moreEntry = document.getElementById("moreFeaturesEntry");
  const dialog = document.getElementById("figmaVariantsDialog");

  // Close before a feature handler can open a native child window and take focus.
  more.addEventListener("click", (event) => {
    if (event.target.closest(".more-feature-item") && more.matches(":popover-open")) more.hidePopover();
  }, { capture: true });
  more.addEventListener("toggle", () => moreEntry.setAttribute("aria-expanded", String(more.matches(":popover-open"))));
  document.getElementById("figmaVariantsEntry").addEventListener("click", () => dialog.showModal());
  document.getElementById("figmaVariantsClose").addEventListener("click", () => dialog.close());
  dialog.addEventListener("click", (event) => {
    const rect = dialog.getBoundingClientRect();
    if (event.target === dialog && (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom)) dialog.close();
  });
  dialog.addEventListener("close", () => moreEntry.focus({ preventScroll: true }));
})();
