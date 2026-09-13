import { useEffect, useState } from "react";

import { api, type AgentConfig, type CycleRecord } from "@/api";
import { configDiff, type DiffLine } from "@/lib/derive";

const COLLAPSE_AT = 12;

export default function ConfigDiff({
  cycle,
  collapseAt = COLLAPSE_AT,
  onSettled,
}: {
  cycle: CycleRecord;
  collapseAt?: number;
  /** Fires once the diff has its final height: configs loaded, failed, or nothing to load. */
  onSettled?: () => void;
}) {
  const [before, setBefore] = useState<AgentConfig | null>(null);
  const [after, setAfter] = useState<AgentConfig | null>(null);
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState(false);
  const changed = cycle.config_before !== cycle.config_after;

  useEffect(() => {
    if (!changed) {
      onSettled?.();
      return;
    }
    let alive = true;
    // Drop the previous cycle's configs so the header never sits over the wrong diff while loading.
    setBefore(null);
    setAfter(null);
    setFailed(false);
    setOpen(false);
    Promise.all([api.config(cycle.config_before), api.config(cycle.config_after)])
      .then(([b, a]) => {
        if (alive) {
          setBefore(b);
          setAfter(a);
        }
      })
      .catch(() => {
        if (alive) setFailed(true);
      })
      .finally(() => {
        if (alive) onSettled?.();
      });
    return () => {
      alive = false;
    };
    // onSettled is a notification, not an input; re-running the fetch when the parent re-renders
    // with a new callback identity would be wrong.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [changed, cycle.config_before, cycle.config_after]);

  if (!changed) {
    return (
      <section>
        <Label>config</Label>
        <p className="text-[13px] text-[var(--faint)]">v{cycle.config_after} unchanged</p>
      </section>
    );
  }

  const lines: DiffLine[] = before && after ? configDiff(before, after) : [];
  const shown = open || lines.length <= collapseAt ? lines : lines.slice(0, collapseAt);

  return (
    <section>
      <Label>
        config diff v{cycle.config_before} → v{cycle.config_after}
      </Label>
      {failed ? (
        <p className="text-[13px] text-[var(--faint)]">config unavailable</p>
      ) : !before || !after ? (
        <p className="text-[13px] text-[var(--faint)]">loading…</p>
      ) : (
        <pre className="code whitespace-pre-wrap break-words text-[12px] leading-[1.6]">
          {shown.map((l, i) => (
            <div
              key={i}
              className={
                l.sign === "+" ? "text-[var(--fg)]" : l.sign === "-" ? "text-[var(--faint)] line-through" : "text-[var(--muted)]"
              }
            >
              <span className="mr-2 inline-block w-3 select-none text-[var(--muted)]">{l.sign}</span>
              {l.text}
            </div>
          ))}
          {lines.length > collapseAt && (
            <button
              type="button"
              onClick={() => setOpen((o) => !o)}
              className="mt-2 text-[12px] text-[var(--muted)] hover:text-[var(--fg)]"
              style={{ fontFamily: "var(--font-sans)" }}
            >
              {open ? "show less" : `show all ${lines.length} lines`}
            </button>
          )}
        </pre>
      )}
    </section>
  );
}

export function Label({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="mb-3 text-[12px] font-medium text-[var(--faint)]">{children}</h3>
  );
}
