import { useEffect, useRef, useState } from "react";

/**
 * Presentation smoothing for a polled value whose states can be shorter than the poll interval.
 *
 * The loop's `chaos` phase lasts ~1 s (0 s on seed scenarios: loop.py sets "chaos" and then
 * "target" back to back), so a 1 s poll usually sees baseline → target and the Chaos orb never
 * lights. This hook keeps every value that arrived on screen for at least `minMs` before showing
 * the next one, so a phase that really happened is not skipped.
 *
 * Nothing is invented: only values the API actually returned are ever displayed, in the order they
 * arrived. The only liberty is *when* the next one appears. Values whose `key` matches what is
 * already shown (same phase, new `since`/`attempt`) replace it immediately: there is no phase change
 * to protect. The pending queue is capped so a burst of changes can never lag the screen by more
 * than ~`maxLagMs`; when it would, the oldest pending values are dropped in favour of the newest.
 *
 * Bumping `epoch` drops the queue and lets the next value through at once. A replay seek is a
 * deliberate jump, not a phase that happened; smoothing it would show the orbs lagging the clock.
 */
export function useDwell<T>(value: T, key: (v: T) => string, minMs = 1_200, maxLagMs = 2_500, epoch = 0): T {
  const [shown, setShown] = useState<T>(value);
  const shownRef = useRef<T>(value);
  const shownAt = useRef(0);
  const queue = useRef<T[]>([]);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const keyRef = useRef(key);
  keyRef.current = key;
  const maxQueue = Math.max(1, Math.floor(maxLagMs / minMs));
  const lastEpoch = useRef(epoch);

  useEffect(() => {
    if (lastEpoch.current !== epoch) {
      lastEpoch.current = epoch;
      clearTimeout(timer.current);
      timer.current = undefined;
      queue.current = [];
      shownAt.current = 0;
    }
    const show = (v: T) => {
      shownRef.current = v;
      shownAt.current = Date.now();
      setShown(v);
    };
    const pump = () => {
      clearTimeout(timer.current);
      timer.current = undefined;
      const next = queue.current[0];
      if (next === undefined) return;
      const wait = shownAt.current + minMs - Date.now();
      if (wait > 0) {
        timer.current = setTimeout(pump, wait);
        return;
      }
      queue.current.shift();
      show(next);
      if (queue.current.length) timer.current = setTimeout(pump, minMs);
    };

    const k = keyRef.current;
    const tail = queue.current.at(-1) ?? shownRef.current;
    if (k(value) === k(tail)) {
      // Same phase as what is (or is about to be) shown: refresh its fields without a dwell and
      // without restarting the dwell clock.
      if (queue.current.length) {
        queue.current[queue.current.length - 1] = value;
      } else {
        shownRef.current = value;
        setShown(value);
      }
      return;
    }
    queue.current.push(value);
    while (queue.current.length > maxQueue) queue.current.shift();
    pump();
  }, [value, minMs, maxQueue, epoch]);

  useEffect(() => () => clearTimeout(timer.current), []);

  return shown;
}
