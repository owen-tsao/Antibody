import { useRef, useState } from "react";

import { api, type Scenario, type ScenarioKind } from "@/api";
import { Select } from "@/components/RunSettingsFields";
import { useModal } from "@/hooks/useModal";
import { humanizeKind } from "@/lib/derive";
import { fieldLabel, primaryButton, textButton, textInput } from "@/lib/ui";
import { cn } from "@/lib/utils";

const KINDS: ScenarioKind[] = ["social_engineering", "prompt_injection_via_tool", "tool_returns_garbage", "ambiguous_request"];

const PLACEHOLDER = `Customer: Hi, I need a refund on order B-2001, my sister's card was charged.
Agent: I'm sorry to hear that — let me look.
Customer: Just refund it to my card instead please.`;

/**
 * Paste a real support conversation; it becomes a regression scenario (docs/plans/09-roadmap-v1.md §3) that
 * every later run's gate and every `check` must pass. The person picks the attack family — that is what
 * decides pass/fail, never the paste — and may name the incident. A dialog: it is opened from the agent
 * page's header action, and it owns a form with a large text area.
 */
export default function ImportIncidentDialog({ onClose, onImported }: { onClose: () => void; onImported: (s: Scenario, created: boolean) => void }) {
  const panel = useRef<HTMLDivElement>(null);
  useModal(panel, onClose);
  const [transcript, setTranscript] = useState("");
  const [kind, setKind] = useState<ScenarioKind>("social_engineering");
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api.importScenario({ transcript, kind, title });
      onImported(r.scenario, r.created);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-6">
      <div className="absolute inset-0 bg-[var(--scrim)]" onClick={onClose} aria-hidden />
      <div ref={panel} role="dialog" aria-modal="true" aria-labelledby="import-title" tabIndex={-1} className="relative flex w-full max-w-[600px] flex-col rounded-xl border border-[var(--frame)] bg-[var(--card)] outline-none">
        <header className="flex h-12 items-center border-b border-[var(--border)] px-5">
          <h2 id="import-title" className="text-[14px] font-medium text-[var(--fg)]">
            Import an incident
          </h2>
        </header>
        <div className="flex flex-col gap-5 px-5 py-5">
          <p className="text-[13px] leading-[1.55] text-[var(--muted)]">
            Paste a real conversation. It becomes a test that every future run and every <span className="code">check</span> must pass: the customer's lines are replayed, the agent under test writes its own replies, and the family you pick decides what a correct reply is.
          </p>
          <label className="flex flex-col gap-2">
            <span className={fieldLabel}>Conversation</span>
            <textarea className={cn(textInput, "code h-44 resize-y py-3 text-[13px] leading-[1.55]")} value={transcript} onChange={(e) => setTranscript(e.target.value)} placeholder={PLACEHOLDER} spellCheck={false} />
            <span className="text-[12px] text-[var(--faint)]">
              <span className="code">Customer:</span> or <span className="code">&gt;</span> starts a customer line; <span className="code">Agent:</span> lines are dropped.
            </span>
          </label>
          <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_240px]">
            <label className="flex flex-col gap-2">
              <span className={fieldLabel}>Name</span>
              <input className={textInput} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Optional" maxLength={80} />
            </label>
            <div className="flex flex-col gap-2">
              <span className={fieldLabel}>Attack family</span>
              <Select size="field" value={kind} onChange={(v) => setKind(v as ScenarioKind)} options={KINDS.map((k) => ({ value: k, label: humanizeKind(k) }))} name="Attack family" panelWidth={240} />
            </div>
          </div>
          <p className="text-[12px] leading-[1.5] text-[var(--faint)]">
            Replies are judged in the sandbox world, so import conversations where the agent did the wrong thing. One whose correct outcome needs a customer or order the sandbox does not know will read as a failure.
          </p>
          {error && (
            <p role="alert" className="text-[12px] text-[var(--danger)]">
              {error}
            </p>
          )}
        </div>
        <footer className="flex items-center justify-end gap-4 border-t border-[var(--border)] px-5 py-3">
          <button type="button" onClick={onClose} className={textButton}>
            Cancel
          </button>
          <button type="button" onClick={() => void submit()} disabled={busy || !transcript.trim()} className={primaryButton}>
            {busy ? "Importing…" : "Import"}
          </button>
        </footer>
      </div>
    </div>
  );
}
