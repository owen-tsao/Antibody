import { useCallback, useEffect, useRef, useState } from "react";

import { POLL_CADENCES, usePrefs } from "@/lib/prefs";

/**
 * Poll `fn` every `intervalMs`, pausing while the tab is hidden. Keeps the last good value
 * across transient errors so the UI never flashes empty during a hiccup. A response that is
 * JSON-identical to the current one keeps the previous reference, so memos and children keyed on
 * `data` do not re-run every tick while nothing has changed. `refresh()` polls now and restarts
 * the interval, for right after an action whose effect the next tick would otherwise show late.
 * `failing` counts consecutive failed ticks (0 after any success), so a caller holding last-good data
 * can still tell a one-tick hiccup from an API that has gone away. The Display preference "poll cadence"
 * scales every interval here, so no call site knows about it. `baseIntervalMs: 0` reads once per `fn`
 * identity (and on `refresh()`) — the one-shot read for files that do not change under the page.
 * `reset()` forgets the last answer (data and error null, as at mount) and asks again at once, retiring any
 * fetch in flight — for a caller that knows the files behind it just changed: keeping last-good data would
 * otherwise show the old answer as if it were new.
 */
export function usePoll<T>(fn: () => Promise<T>, baseIntervalMs: number) {
  const { prefs } = usePrefs();
  const intervalMs = baseIntervalMs * POLL_CADENCES[prefs.pollCadence];
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [failing, setFailing] = useState(0);
  const fnRef = useRef(fn);
  const tickRef = useRef<() => void>(() => undefined);
  useEffect(() => {
    fnRef.current = fn;
    if (intervalMs === 0) tickRef.current();
  }, [fn, intervalMs]);

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
            setFailing(0);
          }
        } catch (e) {
          if (alive && g === gen) {
            setError(e instanceof Error ? e.message : String(e));
            setFailing((n) => n + 1);
          }
        }
      }
      if (alive && g === gen && intervalMs > 0) timer = setTimeout(() => tick(g), intervalMs);
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
  const reset = useCallback(() => {
    setData(null);
    setError(null);
    setFailing(0);
    tickRef.current();
  }, []);
  return { data, error, failing, refresh, reset };
}
