import { type RefObject, useEffect, useRef } from "react";

import { useMotionPref } from "@/hooks/useMotionPref";

/**
 * The plumbing a canvas that redraws every frame needs, measured once instead of per frame: the element's logical
 * size (kept by a `ResizeObserver`, with the backing store sized to it at device pixels), whether it is on screen
 * and the tab is visible (an `IntersectionObserver` and `visibilitychange`, so an off-screen canvas costs nothing),
 * and the app's reduced-motion preference. Written for the dither donut (docs/plans/14-agent-page.md) whose
 * source imported it without shipping it.
 */
export function useCanvasSetup(): { canvasRef: RefObject<HTMLCanvasElement | null>; rect: RefObject<{ width: number; height: number }>; isVisible: RefObject<boolean>; reducedMotion: boolean } {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rect = useRef({ width: 0, height: 0 });
  const isVisible = useRef(true);
  const reducedMotion = useMotionPref();

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const measure = () => {
      const box = canvas.getBoundingClientRect();
      rect.current = { width: box.width, height: box.height };
      canvas.width = Math.round(box.width * dpr);
      canvas.height = Math.round(box.height * dpr);
    };
    measure();
    const resize = new ResizeObserver(measure);
    resize.observe(canvas);
    const seen = new IntersectionObserver(([entry]) => {
      isVisible.current = (entry?.isIntersecting ?? true) && document.visibilityState !== "hidden";
    });
    seen.observe(canvas);
    const onVisibility = () => {
      isVisible.current = document.visibilityState !== "hidden";
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      resize.disconnect();
      seen.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  return { canvasRef, rect, isVisible, reducedMotion };
}
