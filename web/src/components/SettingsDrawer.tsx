import { motion, useReducedMotion } from "framer-motion";
import { useEffect, useId, useRef, useState } from "react";

import { api, type Manifest } from "@/api";
import {
  CHAOS_CYCLES,
  DEFAULT_SETTINGS,
  estimateLabel,
  isDefaultSettings,
  REPAIR_ATTEMPTS,
  SEEDS,
  type RunSettings,
  type World,
} from "@/lib/settings";
import { cn } from "@/lib/utils";

/**
 * Settings for the next Heal run (docs/plans/02, A2). A solid panel on the right edge, over the splash:
 * no backdrop blur, because the shaders behind it would drop frames repainting through one. Monochrome,
 * the Agents header's type scale, text buttons with the `u-line` wipe for every control.
 *
 * The parent owns the settings (it sends them with POST /api/loop/start and persists them); this only
 * edits them. It is mounted while open, so the manifest is fetched per opening (cheap: the API caches it).
 *
 * Keyboard: focus moves into the panel on open and is trapped there (Tab wraps), Esc closes, and focus
 * returns to whatever opened it. Motion is a short slide, or nothing under prefers-reduced-motion.
 */

interface Props {
  settings: RunSettings;
  onChange: (next: RunSettings) => void;
  onClose: () => void;
}

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

const textButton =
  "group rounded text-[13px] text-[var(--muted)] transition-colors hover:text-[var(--fg)] disabled:cursor-default disabled:text-[var(--faint)] disabled:hover:text-[var(--faint)]";

export default function SettingsDrawer({ settings, onChange, onClose }: Props) {
  const reduced = useReducedMotion();
  const titleId = useId();
  const panel = useRef<HTMLDivElement>(null);
  // The trap is installed once per opening; reading the latest onClose through a ref keeps a re-render
  // (every stepper click) from re-running the effect and yanking focus back to the panel.
  const closeRef = useRef(onClose);
  useEffect(() => {
    closeRef.current = onClose;
  }, [onClose]);

  const [manifest, setManifest] = useState<Manifest | null>(null);
  useEffect(() => {
    let alive = true;
    api
      .manifest()
      .then((m) => alive && setManifest(m))
      .catch(() => alive && setManifest(null));
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    const el = panel.current;
    if (!el) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    el.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        closeRef.current();
        return;
      }
      if (e.key !== "Tab") return;
      const items = Array.from(el.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      const inside = active instanceof Node && el.contains(active);
      if (e.shiftKey && (active === first || active === el || !inside)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (active === last || !inside)) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      opener?.focus();
    };
  }, []);

  const seedCount = manifest ? manifest.families.filter((f) => f.seed_id).length : null;
  // The seeds stepper walks 0 … S−1 then "all" (= S, so no duplicate stop). S is the manifest's count,
  // or the API's cap while the manifest is unknown.
  const seedTop = Math.max(1, seedCount ?? SEEDS.max);
  const set = (patch: Partial<RunSettings>) => onChange({ ...settings, ...patch });

  const seedsDown = () => set({ seeds: settings.seeds === null ? seedTop - 1 : settings.seeds - 1 });
  const seedsUp = () => set({ seeds: settings.seeds !== null && settings.seeds + 1 >= seedTop ? null : (settings.seeds ?? 0) + 1 });

  const slide = reduced
    ? { initial: { opacity: 0 }, animate: { opacity: 1 }, exit: { opacity: 0 }, transition: { duration: 0 } }
    : {
        initial: { x: "100%" },
        animate: { x: 0 },
        exit: { x: "100%" },
        transition: { duration: 0.28, ease: [0.2, 0.65, 0.3, 0.9] as const },
      };

  return (
    <>
      {/* Click-away layer. A flat tint, not a blur: the splash shaders keep their frame rate. */}
      <motion.div
        className="fixed inset-0 z-30 bg-black/20"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: reduced ? 0 : 0.2 }}
        onClick={onClose}
        aria-hidden
      />
      <motion.aside
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        {...slide}
        className="fixed inset-y-0 right-0 z-40 flex w-[min(340px,100vw)] flex-col border-l border-[var(--border)] bg-[var(--card)] px-6 py-7 text-left text-[var(--fg)] outline-none"
      >
        <header className="flex items-baseline justify-between">
          <h2 id={titleId} className="text-[13px] font-medium">
            Run settings
          </h2>
          <button type="button" onClick={onClose} className={textButton}>
            <span className="u-line">close</span>
          </button>
        </header>

        <div className="mt-6 divide-y divide-[var(--border)] border-y border-[var(--border)]">
          <Row label="Seeds">
            <Stepper
              value={settings.seeds === null ? "all" : settings.seeds}
              onDown={seedsDown}
              onUp={seedsUp}
              downDisabled={settings.seeds === SEEDS.min}
              upDisabled={settings.seeds === null}
              name="seeds"
            />
          </Row>
          <Row label="Chaos cycles">
            <Stepper
              value={settings.chaosCycles}
              onDown={() => set({ chaosCycles: settings.chaosCycles - 1 })}
              onUp={() => set({ chaosCycles: settings.chaosCycles + 1 })}
              downDisabled={settings.chaosCycles <= CHAOS_CYCLES.min}
              upDisabled={settings.chaosCycles >= CHAOS_CYCLES.max}
              name="chaos cycles"
            />
          </Row>
          <Row label="Repair attempts">
            <Stepper
              value={settings.repairAttempts}
              onDown={() => set({ repairAttempts: settings.repairAttempts - 1 })}
              onUp={() => set({ repairAttempts: settings.repairAttempts + 1 })}
              downDisabled={settings.repairAttempts <= REPAIR_ATTEMPTS.min}
              upDisabled={settings.repairAttempts >= REPAIR_ATTEMPTS.max}
              name="repair attempts"
            />
          </Row>
          <Row label="Second pass">
            <button
              type="button"
              role="switch"
              aria-checked={settings.secondPass}
              onClick={() => set({ secondPass: !settings.secondPass })}
              className={cn(textButton, "tabular w-10 text-right", settings.secondPass && "text-[var(--fg)]")}
            >
              <span className="u-line">{settings.secondPass ? "on" : "off"}</span>
            </button>
          </Row>
          <Row label="World">
            <div className="flex items-baseline gap-3" role="group" aria-label="World">
              {(["auto", "mock"] as World[]).map((w) => (
                <button
                  key={w}
                  type="button"
                  aria-pressed={settings.world === w}
                  onClick={() => set({ world: w })}
                  className={cn(textButton, settings.world === w && "text-[var(--fg)]")}
                >
                  <span className="u-line">{w}</span>
                </button>
              ))}
            </div>
          </Row>
        </div>

        <div className="tabular mt-4 flex items-baseline justify-between text-[12px] text-[var(--faint)]">
          <span>{estimateLabel(settings, seedCount)}</span>
          {!isDefaultSettings(settings) && (
            <button type="button" onClick={() => onChange({ ...DEFAULT_SETTINGS })} className={cn(textButton, "text-[12px] text-[var(--faint)]")}>
              <span className="u-line">reset</span>
            </button>
          )}
        </div>

        {manifest && (
          // An external agent has no model to name (Antibody only sees its URL), so the line is just its name.
          <p className="mt-auto pt-6 text-[12px] leading-relaxed text-[var(--faint)]">
            {manifest.target.name}
            {manifest.target.model_short && (
              <>
                <span className="px-1.5">·</span>
                <span title={manifest.target.model ?? undefined}>{manifest.target.model_short}</span>
              </>
            )}
          </p>
        )}
      </motion.aside>
    </>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between py-3">
      <span className="text-[13px]">{label}</span>
      {children}
    </div>
  );
}

function Stepper({
  value,
  onDown,
  onUp,
  downDisabled,
  upDisabled,
  name,
}: {
  value: number | string;
  onDown: () => void;
  onUp: () => void;
  downDisabled: boolean;
  upDisabled: boolean;
  /** For the buttons' accessible names ("fewer seeds", "more seeds"). */
  name: string;
}) {
  return (
    <div className="flex items-baseline gap-3">
      <button type="button" onClick={onDown} disabled={downDisabled} aria-label={`fewer ${name}`} className={textButton}>
        <span className="u-line">−</span>
      </button>
      <span className="tabular w-7 text-center text-[13px]" aria-live="polite">
        {value}
      </span>
      <button type="button" onClick={onUp} disabled={upDisabled} aria-label={`more ${name}`} className={textButton}>
        <span className="u-line">+</span>
      </button>
    </div>
  );
}
