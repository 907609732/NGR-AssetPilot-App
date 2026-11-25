(() => {
  const home = document.getElementById("homeView");
  if (!home || home.querySelector(".home-ambient")) return;
  const layer = document.createElement("div");
  layer.className = "home-ambient";
  layer.setAttribute("aria-hidden", "true");
  layer.innerHTML = '<div class="home-ambient-glow"></div><div class="home-ambient-ripple"></div>';
  home.prepend(layer);
  const [glow, ripple] = layer.children;
  const reduced = matchMedia("(prefers-reduced-motion: reduce)");
  let frame = 0;
  let pulse;
  const position = event => {
    const bounds = layer.getBoundingClientRect();
    return `translate(${event.clientX - bounds.left}px, ${event.clientY - bounds.top}px)`;
  };
  home.addEventListener("pointermove", event => {
    if (reduced.matches || event.pointerType === "touch") return;
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      glow.style.transform = position(event);
      glow.style.opacity = "1";
    });
  });
  home.addEventListener("pointerleave", () => {
    cancelAnimationFrame(frame);
    glow.style.opacity = "0";
  });
  home.addEventListener("click", event => {
    if (reduced.matches || event.target !== home || event.button !== 0 || !event.detail) return;
    const origin = position(event);
    pulse?.cancel();
    pulse = ripple.animate([
      { opacity: 0.85, transform: origin + " scale(.14)" },
      { opacity: 0, transform: origin + " scale(2)" },
    ], { duration: 760, easing: "cubic-bezier(.18,.7,.25,1)" });
  });
})();
