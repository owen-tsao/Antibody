import { type FormEvent, useState } from "react";

import { getToken, setToken } from "@/api";
import { fieldLabel, primaryButton, textButton, textInput } from "@/lib/ui";
import { cn } from "@/lib/utils";

/**
 * The API token form (api/auth.py): a password field, Save, and Forget when one is stored. Two homes — the
 * shell's locked state (every read answered 401) and Settings → Access. The token is written to `api.ts`'s
 * storage and never shown back; `onChange` fires after either action so the caller can re-poll.
 */
export default function TokenField({ onChange, className }: { onChange?: () => void; className?: string }) {
  const [draft, setDraft] = useState("");
  const [stored, setStored] = useState(() => getToken() !== null);

  const save = (e: FormEvent) => {
    e.preventDefault();
    const t = draft.trim();
    if (!t) return;
    setToken(t);
    setDraft("");
    setStored(true);
    onChange?.();
  };
  const forget = () => {
    setToken(null);
    setStored(false);
    onChange?.();
  };

  return (
    <form onSubmit={save} className={cn("flex flex-col gap-3", className)}>
      <label className="flex flex-col gap-1.5">
        <span className={fieldLabel}>{stored ? "Replace the stored token" : "API token"}</span>
        <input
          type="password"
          className={cn(textInput, "code")}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="the value of ANTIBODY_API_TOKEN"
          autoComplete="off"
          spellCheck={false}
        />
      </label>
      <div className="flex items-center gap-4">
        <button type="submit" className={primaryButton} disabled={!draft.trim()}>
          Save
        </button>
        {stored && (
          <button type="button" onClick={forget} className={textButton}>
            Forget token
          </button>
        )}
      </div>
    </form>
  );
}
