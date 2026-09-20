import { useState } from "react";

import { api, ApiError, type Agent } from "@/api";
import OrbButton from "@/components/OrbButton";
import type { ShellData } from "@/components/Shell";
import { usePoll } from "@/hooks/usePoll";
import { replayRunId, seedCount } from "@/lib/derive";
import { linkProps, LIVE_RUN, navigate, SETTINGS } from "@/lib/routes";
import { estimateLabel, toStartBody, type RunSettings } from "@/lib/settings";
import { NO_KEY_LINE } from "@/lib/ui";
import { cn } from "@/lib/utils";

/**
 * The one loud element of Current run's empty face: the Heal orb with the estimate under it. Press → `POST
 * /api/loop/start` for `target` with the saved defaults → Current run; a 409 (a loop already runs) goes there
 * too. Without a key it is disabled and says why. While a loop runs or a tape plays the orb yields to a line
 * pointing at what is on screen — one run at a time is the product's rule, not the button's.
 */
export default function HealOrb({ shell, settings, target, size = 128, className }: { shell: ShellData; settings: RunSettings; target: Agent | null; size?: number; className?: string }) {
  const { loop, replay, health, refresh } = shell;
  const { data: manifest } = usePoll(api.manifest, 60_000);
  const noKey = health !== null && !health.has_api_key;
  const running = loop?.running ?? false;
  const tapeId = replayRunId(replay);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const heal = async () => {
    if (!target) return;
    setBusy(true);
    setError(null);
    try {
      await api.loopStart(toStartBody({ ...settings, target: target.id }));
      navigate(LIVE_RUN);
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) navigate(LIVE_RUN);
      else setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      refresh();
    }
  };

  if (running) {
    return (
      <a {...linkProps(LIVE_RUN)} className={cn("group flex flex-col items-center gap-2 rounded text-center", className)}>
        <span className="text-[15px] font-medium text-[var(--fg)]">Running{shell.status?.cycle ? ` · cycle ${shell.status.cycle}` : ""}</span>
        <span className="text-[12px] text-[var(--muted)] transition-colors group-hover:text-[var(--fg)]">open Current run →</span>
      </a>
    );
  }
  if (tapeId) {
    return (
      <a {...linkProps({ kind: "run", id: tapeId })} className={cn("group flex flex-col items-center gap-2 rounded text-center", className)}>
        <span className="text-[15px] font-medium text-[var(--fg)]">Watching a recording</span>
        <span className="text-[12px] text-[var(--muted)] transition-colors group-hover:text-[var(--fg)]">open it →</span>
      </a>
    );
  }
  const disabled = busy || noKey || !target;
  return (
    <div className={cn("flex flex-col items-center gap-5", className)}>
      <OrbButton onClick={heal} disabled={disabled} aria-label="Heal" title={noKey ? NO_KEY_LINE : undefined} className={cn(disabled && "cursor-default opacity-60")} style={{ width: size, height: size }}>
        <span className="display leading-none" style={{ fontSize: Math.round(size * 0.2) }}>
          {busy ? "…" : "Heal"}
        </span>
      </OrbButton>
      <p className="text-center text-[12px] leading-[1.6] text-[var(--muted)]">
        {noKey ? (
          NO_KEY_LINE
        ) : !target ? (
          "no agent selected"
        ) : (
          <>
            {estimateLabel(settings, seedCount(manifest))} ·{" "}
            <a {...linkProps(SETTINGS)} className="rounded text-[var(--faint)] transition-colors hover:text-[var(--fg)]">
              change defaults
            </a>
          </>
        )}
      </p>
      {error && (
        <p role="alert" className="text-center text-[12px] text-[var(--danger)]">
          {error}
        </p>
      )}
    </div>
  );
}
