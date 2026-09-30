import { useEffect, useRef } from "react";

import { useCanvasSetup } from "@/hooks/useCanvasSetup";
import { cn } from "@/lib/utils";

/**
 * A donut drawn as a field of dithered squares (docs/plans/14-agent-page.md "Two visuals"; source archived in the
 * component library as dither-donut-chart). Each segment is a share of the whole; inside it the first `filled`
 * part of the sweep is dense and the rest sparse, so a segment reads as "this much of it is covered" without a
 * second ring or a colour. Shares and fills ease over 500 ms when the data changes — switching versions is the
 * comparison. Under reduced motion the wave in the dots stops and changes land at once. Greys only; the palette
 * keeps colour for signals.
 */
export interface DonutSegment {
  name: string;
  /** The segment's share of the ring, as a count. */
  value: number;
  /** 0–1: how much of the segment is dense (what the version blocks, of the family's attacks). */
  filled: number;
  color: string;
}

const smoothstep = (min: number, max: number, value: number) => {
  const x = Math.max(0, Math.min(1, (value - min) / (max - min)));
  return x * x * (3 - 2 * x);
};

const hash = (x: number, y: number) => {
  const h = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453;
  return h - Math.floor(h);
};

/** The wedge outline the dots are clipped to: an annular sector with rounded corners. */
function drawRoundedWedge(ctx: CanvasRenderingContext2D, cx: number, cy: number, rIn: number, rOut: number, aStart: number, aEnd: number, cr: number) {
  const sweep = aEnd - aStart;
  if (sweep <= 0.001) return;
  const r = Math.min(cr, (rOut - rIn) / 2, (sweep * rIn) / 2);
  const aStartIn = aStart + r / rIn;
  const aEndIn = aEnd - r / rIn;
  const aStartOut = aStart + r / rOut;
  const aEndOut = aEnd - r / rOut;
  ctx.moveTo(cx + rIn * Math.cos(aStartIn), cy + rIn * Math.sin(aStartIn));
  ctx.arc(cx, cy, rIn, aStartIn, aEndIn);
  ctx.arcTo(cx + rIn * Math.cos(aEnd), cy + rIn * Math.sin(aEnd), cx + rOut * Math.cos(aEnd), cy + rOut * Math.sin(aEnd), r);
  ctx.arcTo(cx + rOut * Math.cos(aEnd), cy + rOut * Math.sin(aEnd), cx + rOut * Math.cos(aEndOut), cy + rOut * Math.sin(aEndOut), r);
  ctx.arc(cx, cy, rOut, aEndOut, aStartOut, true);
  ctx.arcTo(cx + rOut * Math.cos(aStart), cy + rOut * Math.sin(aStart), cx + rIn * Math.cos(aStart), cy + rIn * Math.sin(aStart), r);
  ctx.arcTo(cx + rIn * Math.cos(aStart), cy + rIn * Math.sin(aStart), cx + rIn * Math.cos(aStartIn), cy + rIn * Math.sin(aStartIn), r);
}

const LOGICAL = 200;
const R_IN = 55;
const R_OUT = 86;
const MORPH_MS = 500;

export default function DitherDonutChart({ segments, hover, className }: { segments: DonutSegment[]; hover?: number | null; className?: string }) {
  const { canvasRef, rect, isVisible, reducedMotion } = useCanvasSetup();

  // Display state lives in refs: the draw loop reads it every frame and React never re-renders for a frame.
  const timeRef = useRef(0);
  const hoverRef = useRef<number | null>(hover ?? null);
  const fromRef = useRef<{ shares: number[]; fills: number[] } | null>(null);
  const targetRef = useRef<{ shares: number[]; fills: number[] }>({ shares: [], fills: [] });
  const morphStart = useRef(0);
  const colorsRef = useRef<string[]>([]);

  useEffect(() => {
    hoverRef.current = hover ?? null;
  }, [hover]);

  useEffect(() => {
    const total = segments.reduce((a, s) => a + s.value, 0);
    const next = { shares: segments.map((s) => (total > 0 ? s.value / total : 0)), fills: segments.map((s) => Math.max(0, Math.min(1, s.filled))) };
    colorsRef.current = segments.map((s) => s.color);
    if (fromRef.current === null) fromRef.current = next;
    else {
      // Ease from what is on screen now, not from the last target, so a change mid-morph does not jump.
      fromRef.current = current(fromRef.current, targetRef.current, morphStart.current, reducedMotion);
      morphStart.current = performance.now();
    }
    targetRef.current = next;
  }, [segments, reducedMotion]);

  useEffect(() => {
    let frame = 0;
    const draw = () => {
      frame = requestAnimationFrame(draw);
      if (!isVisible.current) return;
      const canvas = canvasRef.current;
      const ctx = canvas?.getContext("2d");
      if (!canvas || !ctx) return;
      const { width, height } = rect.current;
      if (width === 0 || height === 0 || !fromRef.current) return;

      timeRef.current += reducedMotion ? 0 : 0.02;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      ctx.save();
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.scale((width * dpr) / LOGICAL, (height * dpr) / LOGICAL);

      const disp = current(fromRef.current, targetRef.current, morphStart.current, reducedMotion);
      const gap = 0.07;
      const hovered = hoverRef.current;
      const cell = 4.6;
      const t = timeRef.current;
      let start = -Math.PI / 2;

      for (let i = 0; i < disp.shares.length; i++) {
        const share = disp.shares[i]!;
        if (share <= 0) continue;
        const sweep = share * Math.PI * 2;
        const aStart = start + gap / 2;
        const aEnd = Math.max(aStart, start + sweep - gap / 2);
        const isHovered = hovered === i;
        const dim = hovered !== null && !isHovered;

        ctx.save();
        if (isHovered) {
          const mid = (aStart + aEnd) / 2;
          ctx.translate(Math.cos(mid) * 6, Math.sin(mid) * 6);
        }
        ctx.beginPath();
        drawRoundedWedge(ctx, 100, 100, R_IN, R_OUT, aStart, aEnd, 6);
        ctx.clip();
        ctx.globalAlpha = isHovered ? 1 : dim ? 0.22 : 0.72;
        ctx.fillStyle = colorsRef.current[i] ?? "#a1a1aa";

        const fill = disp.fills[i]!;
        for (let x = 14; x <= 186; x += cell) {
          for (let y = 14; y <= 186; y += cell) {
            const dx = x - 100;
            const dy = y - 100;
            const dist = Math.sqrt(dx * dx + dy * dy);
            if (dist < R_IN - cell || dist > R_OUT + cell) continue;
            const a = Math.atan2(dy, dx);
            let rel = a - aStart;
            while (rel < 0) rel += Math.PI * 2;
            while (rel >= Math.PI * 2) rel -= Math.PI * 2;
            if (rel > aEnd - aStart) continue;
            // Dense for the covered part of the sweep, sparse past it; a soft edge between so a fill of 0.6 is not a hard cut.
            const covered = 1 - smoothstep(fill - 0.04, fill + 0.04, rel / (aEnd - aStart));
            const waveRaw = reducedMotion ? 0 : Math.sin(dist * 0.1 - t) + Math.sin(a * 3 + t * 1.5) + Math.sin(dx * 0.05 + dy * 0.05 + t * 2);
            const wave = smoothstep(-1.5, 1.5, waveRaw);
            const jitter = hash(x, y);
            const size = cell * (0.18 + 0.52 * covered + 0.16 * wave * (0.4 + 0.6 * covered)) * (0.78 + 0.42 * jitter);
            ctx.fillRect(x - size / 2, y - size / 2, size, size);
          }
        }
        ctx.restore();
        start += sweep;
      }
      ctx.restore();
    };
    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, [canvasRef, rect, isVisible, reducedMotion]);

  return <canvas ref={canvasRef} className={cn("block h-full w-full", className)} aria-hidden />;
}

/** Where the morph is right now: eased from `from` to `to` by the time since `startedAt`; at once under reduced motion. */
function current(from: { shares: number[]; fills: number[] }, to: { shares: number[]; fills: number[] }, startedAt: number, reducedMotion: boolean) {
  const raw = reducedMotion || startedAt === 0 ? 1 : Math.min(1, (performance.now() - startedAt) / MORPH_MS);
  const e = 1 - Math.pow(2, -10 * raw);
  const mix = (a: number[], b: number[]) => b.map((v, i) => (a[i] ?? 0) + (v - (a[i] ?? 0)) * e);
  return { shares: mix(from.shares, to.shares), fills: mix(from.fills, to.fills) };
}
