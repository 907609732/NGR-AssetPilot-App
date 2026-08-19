"use client";

import { useEffect } from "react";

const revealSelector = [
  ".signal-strip > div",
  ".section-heading",
  ".feature-card",
  ".workflow-intro",
  ".step-card",
  ".security-visual",
  ".security-copy",
  ".download-section",
  "footer",
].join(",");

export function MotionController() {
  useEffect(() => {
    const root = document.documentElement;
    const header = document.querySelector<HTMLElement>("[data-site-header]");
    const glow = document.querySelector<HTMLElement>("[data-cursor-glow]");
    const productStage = document.querySelector<HTMLElement>(".product-stage");
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const finePointer = window.matchMedia("(pointer: fine)").matches;
    let frame = 0;

    root.classList.add("motion-mounted");

    const updateScroll = () => {
      const scrollTop = window.scrollY;
      const scrollRange = Math.max(document.documentElement.scrollHeight - window.innerHeight, 1);
      root.style.setProperty("--scroll-progress", `${Math.min(scrollTop / scrollRange, 1)}`);
      root.style.setProperty("--hero-copy-y", `${Math.max(-72, scrollTop * -0.075)}px`);
      root.style.setProperty("--hero-stage-y", `${Math.min(48, scrollTop * 0.045)}px`);
      header?.classList.toggle("is-scrolled", scrollTop > 34);
      frame = 0;
    };

    const requestScrollUpdate = () => {
      if (!frame) frame = window.requestAnimationFrame(updateScroll);
    };

    updateScroll();
    window.addEventListener("scroll", requestScrollUpdate, { passive: true });
    window.addEventListener("resize", requestScrollUpdate, { passive: true });

    const revealTargets = Array.from(document.querySelectorAll<HTMLElement>(revealSelector));
    let observer: IntersectionObserver | undefined;

    if (!reducedMotion) {
      revealTargets.forEach((element, index) => {
        element.classList.add("reveal-pending");
        element.style.setProperty("--reveal-delay", `${(index % 3) * 75}ms`);
      });

      observer = new IntersectionObserver(
        (entries) => {
          entries.forEach((entry) => {
            if (!entry.isIntersecting) return;
            entry.target.classList.add("is-visible");
            observer?.unobserve(entry.target);
          });
        },
        { threshold: 0.14, rootMargin: "0px 0px -7% 0px" },
      );
      revealTargets.forEach((element) => observer?.observe(element));
    }

    let pointerFrame = 0;
    const moveGlow = (event: PointerEvent) => {
      if (!finePointer || !glow) return;
      const x = event.clientX;
      const y = event.clientY;
      if (pointerFrame) window.cancelAnimationFrame(pointerFrame);
      pointerFrame = window.requestAnimationFrame(() => {
        glow.style.transform = `translate3d(${x}px, ${y}px, 0)`;
        glow.classList.add("is-active");
      });
    };
    window.addEventListener("pointermove", moveGlow, { passive: true });

    const tiltProduct = (event: PointerEvent) => {
      if (!finePointer || !productStage) return;
      const bounds = productStage.getBoundingClientRect();
      const x = (event.clientX - bounds.left) / bounds.width;
      const y = (event.clientY - bounds.top) / bounds.height;
      productStage.style.setProperty("--tilt-y", `${-4 + (x - 0.5) * 7}deg`);
      productStage.style.setProperty("--tilt-x", `${1 - (y - 0.5) * 5}deg`);
    };
    const resetProductTilt = () => {
      productStage?.style.setProperty("--tilt-y", "-4deg");
      productStage?.style.setProperty("--tilt-x", "1deg");
    };
    productStage?.addEventListener("pointermove", tiltProduct, { passive: true });
    productStage?.addEventListener("pointerleave", resetProductTilt);

    const spotlightCards = Array.from(document.querySelectorAll<HTMLElement>(".feature-card"));
    const cardHandlers = spotlightCards.map((card) => {
      const handler = (event: PointerEvent) => {
        const bounds = card.getBoundingClientRect();
        card.style.setProperty("--spot-x", `${event.clientX - bounds.left}px`);
        card.style.setProperty("--spot-y", `${event.clientY - bounds.top}px`);
      };
      card.addEventListener("pointermove", handler, { passive: true });
      return { card, handler };
    });

    return () => {
      root.classList.remove("motion-mounted");
      window.removeEventListener("scroll", requestScrollUpdate);
      window.removeEventListener("resize", requestScrollUpdate);
      window.removeEventListener("pointermove", moveGlow);
      productStage?.removeEventListener("pointermove", tiltProduct);
      productStage?.removeEventListener("pointerleave", resetProductTilt);
      cardHandlers.forEach(({ card, handler }) => card.removeEventListener("pointermove", handler));
      observer?.disconnect();
      if (frame) window.cancelAnimationFrame(frame);
      if (pointerFrame) window.cancelAnimationFrame(pointerFrame);
    };
  }, []);

  return (
    <>
      <div className="scroll-progress" aria-hidden="true"><span /></div>
      <div className="cursor-glow" data-cursor-glow aria-hidden="true" />
    </>
  );
}
