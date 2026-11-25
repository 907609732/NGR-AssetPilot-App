(() => {
  const home = document.getElementById("homeView");
  if (!home) return;

  const layer = document.createElement("div");
  layer.className = "home-ambient";
  layer.setAttribute("aria-hidden", "true");
  const glow = document.createElement("div");
  glow.className = "home-ambient-glow";
  layer.append(glow);
  home.prepend(layer);

  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
  let frame;
  home.addEventListener("pointermove", (event) => {
    if (reducedMotion.matches || event.pointerType !== "mouse") return;
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      const bounds = layer.getBoundingClientRect();
      glow.style.transform = `translate(${event.clientX - bounds.left}px, ${event.clientY - bounds.top}px)`;
      glow.style.opacity = "1";
    });
  });
  home.addEventListener("pointerleave", () => {
    cancelAnimationFrame(frame);
    glow.style.opacity = "0";
  });
})();
