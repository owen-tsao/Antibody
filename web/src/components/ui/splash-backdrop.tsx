// Full-bleed background behind the Intro and Heal screens: two shader layers, both from
// @paper-design/shaders-react (already a dependency).
//
//   1. MeshGradient — the monochrome gradient from Owen's component library entry
//      `paper-shaders-mesh-gradient-hero` (its demo palette, unchanged).
//   2. LiquidMetal — the chrome blob from `liquid-metal-hero`, with the exact params tuned earlier
//      in liquid-metal-hero.tsx (Backdrop preset, metaballs, repetition 2.5, softness .2), except
//      `colorBack` is fully transparent so the blob sits on the gradient instead of painting its
//      own #AAAAAC field. The shader premultiplies by colorBack alpha, so this is a supported path.
//
// Performance, with no visible change:
//   - The gradient is a smooth low-frequency field, so it renders at ~1 MP and upscales invisibly
//     (`maxPixelCount`, `minPixelRatio: 1`). The liquid metal keeps the library default (2x, full
//     detail) because its dispersion fringes are fine-grained.
//   - `antialias: false` on both contexts. MSAA only smooths geometry edges; a full-screen quad has
//     none, so the multisample buffers were pure cost.
//   - The mount already pauses when the tab is hidden or the element leaves the viewport.
//
// Rendered once by App for the intro/heal pages, so moving between them never remounts either
// shader. Both unmount before the Agents page mounts its four orb canvases.

import { LiquidMetal, liquidMetalPresets, MeshGradient } from "@paper-design/shaders-react";
import { useEffect, useState } from "react";

const MESH_COLORS = ["#000000", "#1a1a1a", "#333333", "#ffffff"];
const GL = { antialias: false, powerPreference: "high-performance" } as const;

function usePrefersReducedMotion() {
  const [reduced, setReduced] = useState(
    () => typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const onChange = (e: MediaQueryListEvent) => setReduced(e.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return reduced;
}

export default function SplashBackdrop() {
  const reduced = usePrefersReducedMotion();
  return (
    <>
      <MeshGradient
        colors={MESH_COLORS}
        speed={reduced ? 0 : 0.5}
        distortion={0.8}
        swirl={0.1}
        minPixelRatio={1}
        maxPixelCount={1280 * 720}
        webGlContextAttributes={GL}
        style={{ position: "fixed", inset: 0, zIndex: -20, width: "100%", height: "100%" }}
        aria-hidden
      />
      <LiquidMetal
        {...liquidMetalPresets[2].params}
        colorBack="#00000000"
        shape="metaballs"
        repetition={2.5}
        softness={0.2}
        speed={reduced ? 0 : liquidMetalPresets[2].params.speed}
        webGlContextAttributes={GL}
        style={{ position: "fixed", inset: 0, zIndex: -10, width: "100%", height: "100%" }}
        aria-hidden
      />
    </>
  );
}
