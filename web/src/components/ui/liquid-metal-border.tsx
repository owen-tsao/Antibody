// A liquid-metal frame: a thin animated chrome ring around any surface.
//
// Adapted from the 21st.dev "Liquid Metal Button" (johuniq): a canvas running the paper-shaders
// liquid-metal fragment shader sits underneath, and an opaque inner surface inset by `thickness`
// covers everything but the rim. The shader parameters are that component's, unchanged (repetition
// 4, softness .5, RGB shift .3, angle 45, circle shape zoomed 8x so the stripes fill the canvas).
// It used the raw `ShaderMount` from @paper-design/shaders; this uses the React wrapper the project
// already ships, which takes the same parameters and pauses itself off-screen and in hidden tabs.
//
// The circle shape paints metal only inside a circle sized from the canvas's *shorter* side, so on
// a wide, flat frame (the stats plate is ~16:1) the ends of the rim would be black. The canvas is
// therefore a square as wide as the frame, centred vertically and clipped by the frame: the circle
// then spans the full width whatever the aspect ratio. On square and 3:2 frames this is invisible.
//
// Motion follows the original too: idle 0.6, hover 1.0, a 2.4 burst on click that settles back.
// Reduced motion freezes the ring (a still chrome rim, not a flat border).
//
// Every frame is one WebGL context. Browsers allow ~16 per page, and the Agents page already spends
// four on the orbs, so this is for the few button-shaped controls and the cycles box, not for text
// links. `maxPixelCount` keeps a large frame (the box) from rendering millions of pixels a frame for
// a rim that is 1.5 px wide.

import { LiquidMetal } from "@paper-design/shaders-react";
import { useEffect, useState, type CSSProperties, type HTMLAttributes, type ReactNode } from "react";

import ErrorBoundary from "@/components/ErrorBoundary";
import { cn } from "@/lib/utils";

const IDLE = 0.6;
const HOVER = 1;
const BURST = 2.4;
const BURST_MS = 300;

const SHADER = {
  colorBack: "#000000",
  colorTint: "#ffffff",
  repetition: 4,
  softness: 0.5,
  shiftRed: 0.3,
  shiftBlue: 0.3,
  distortion: 0,
  contour: 0,
  angle: 45,
  scale: 8,
  shape: "circle",
  offsetX: 0.1,
  offsetY: -0.1,
} as const;

const GL = { antialias: false, powerPreference: "low-power" } as const;

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

export interface MetalFrameProps extends HTMLAttributes<HTMLDivElement> {
  /** Outer corner radius in px. Use a large number (9999) for a circle. */
  radius: number;
  /** Rim width in px. 1.5 reads as a hairline of chrome; 2 for controls 80 px and up. */
  thickness?: number;
  /** Class for the inner surface. Give it an opaque background or the shader shows through. */
  innerClassName?: string;
  innerStyle?: CSSProperties;
  /** Pixel budget for the shader canvas; the rim never needs full resolution on a large frame. */
  maxPixelCount?: number;
  /** Set when the frame is inside a control that already reports hover/press (e.g. a motion button). */
  active?: boolean;
  children?: ReactNode;
}

export function MetalFrame({
  radius,
  thickness = 1.5,
  innerClassName,
  innerStyle,
  maxPixelCount,
  active,
  className,
  style,
  children,
  onMouseEnter,
  onMouseLeave,
  onClick,
  ...rest
}: MetalFrameProps) {
  const reduced = usePrefersReducedMotion();
  const [hovered, setHovered] = useState(false);
  const [burst, setBurst] = useState(false);

  useEffect(() => {
    if (!burst) return;
    const id = setTimeout(() => setBurst(false), BURST_MS);
    return () => clearTimeout(id);
  }, [burst]);

  const speed = reduced ? 0 : burst ? BURST : hovered || active ? HOVER : IDLE;
  const innerRadius = Math.max(0, radius - thickness);

  return (
    <div
      {...rest}
      className={cn("relative overflow-hidden", className)}
      style={{ borderRadius: radius, ...style }}
      onMouseEnter={(e) => {
        setHovered(true);
        onMouseEnter?.(e);
      }}
      onMouseLeave={(e) => {
        setHovered(false);
        onMouseLeave?.(e);
      }}
      onClick={(e) => {
        setBurst(true);
        onClick?.(e);
      }}
    >
      <ErrorBoundary
        label="metal frame"
        fallback={<div className="absolute inset-0 border border-[var(--border-2)]" style={{ borderRadius: radius }} aria-hidden />}
      >
        <LiquidMetal
          {...SHADER}
          speed={speed}
          maxPixelCount={maxPixelCount}
          webGlContextAttributes={GL}
          style={{
            position: "absolute",
            left: 0,
            top: "50%",
            width: "100%",
            minHeight: "100%",
            aspectRatio: "1 / 1",
            transform: "translateY(-50%)",
          }}
          aria-hidden
        />
      </ErrorBoundary>
      <div
        className={cn("relative bg-[var(--bg)]", innerClassName)}
        style={{ margin: thickness, borderRadius: innerRadius, ...innerStyle }}
      >
        {children}
      </div>
    </div>
  );
}
