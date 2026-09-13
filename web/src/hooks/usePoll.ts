import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Poll `fn` every `intervalMs`, pausing while the tab is hidden. Keeps the last good value
 * across transient errors so the UI never flashes empty during a hiccup. A response that is
 * JSON-identical to the current one keeps the previous reference, so memos and children keyed on
 * `data` do not re-run every tick while nothing has changed. `refresh()` polls now and restarts
 * the interval, for right after an action whose effect the next tick would otherwise show late.
 */
export function usePoll<T>(fn: () => Promise<T>, intervalMs: number) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fnRef = useRef(fn);
  const tickRef = useRef<() => void>(() => undefined);
  useEffect(() => {
    fnRef.current = fn;
  }, [fn]);

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Each poll chain carries a generation. `now()` starts a new chain and retires the old one, so
    // a fetch already in flight when refresh() is called neither reschedules itself (which would
    // leave two chains polling forever) nor overwrites the newer result with its stale one.
    let gen = 0;

    const tick = async (g: number) => {
      if (!alive || g !== gen) return;
      if (document.visibilityState === "visible") {
        try {
          const next = await fnRef.current();
          if (alive && g === gen) {
            setData((prev) => (prev !== null && JSON.stringify(prev) === JSON.stringify(next) ? prev : next));
            setError(null);
          }
        } catch (e) {
          if (alive && g === gen) setError(e instanceof Error ? e.message : String(e));
        }
      }
      if (alive && g === gen) timer = setTimeout(() => tick(g), intervalMs);
    };
    const now = () => {
      clearTimeout(timer);
      gen += 1;
      void tick(gen);
    };
    tickRef.current = now;

    void tick(gen);
    const onVisible = () => {
      if (document.visibilityState === "visible") now();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      alive = false;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [intervalMs]);

  const refresh = useCallback(() => tickRef.current(), []);
  return { data, error, refresh };
}
