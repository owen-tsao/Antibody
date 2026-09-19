import { motion, useReducedMotion } from "framer-motion";
import { useEffect, useId, useRef, useState } from "react";

import { api, type Manifest } from "@/api";
import RunSettingsFields from "@/components/RunSettingsFields";
import { useModal } from "@/hooks/useModal";
import { seedCount } from "@/lib/derive";
import { DEFAULT_SETTINGS, estimateLabel, isDefaultSettings, type RunSettings } from "@/lib/settings";
import { textButton } from "@/lib/ui";
import { cn } from "@/lib/utils";

/**
 * Settings for the next Heal run (docs/plans/02, A2). A solid panel on the right edge, over the splash:
 * no backdrop blur, because the shaders behind it would drop frames repainting through one. Monochrome,
 * text buttons with the `u-line` wipe for every control; the field rows are `RunSettingsFields`, shared
 * with the onboarding wizard.
 *
 * The parent owns the settings (it sends them with POST /api/loop/start and persists them); this only
 * edits them. It is mounted while open, so the manifest is fetched per opening (cheap: the API caches it).
 *
 * Keyboard: `useModal` — focus moves into the panel on open and is trapped there (Tab wraps), Esc closes,
 * the page behind stops scrolling, focus returns to whatever opened it. Motion is a short slide, or nothing
 * under prefers-reduced-motion.
 */

interface Props {
  settings: RunSettings;
  onChange: (next: RunSettings) => void;
  onClose: () => void;
}

export default function SettingsDrawer({ settings, onChange, onClose }: Props) {
  const reduced = useReducedMotion();
  const titleId = useId();
  const panel = useRef<HTMLDivElement>(null);
  useModal(panel, onClose);

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

  const seeds = seedCount(manifest);

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

        <div className="mt-6">
          <RunSettingsFields settings={settings} onChange={onChange} seedCount={seeds} />
        </div>

        <div className="tabular mt-4 flex items-baseline justify-between text-[12px] text-[var(--faint)]">
          <span>{estimateLabel(settings, seeds)}</span>
          {!isDefaultSettings(settings) && (
            <button
              type="button"
              onClick={() => onChange({ ...DEFAULT_SETTINGS, target: settings.target })}
              className={cn(textButton, "text-[12px] text-[var(--faint)]")}
            >
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
