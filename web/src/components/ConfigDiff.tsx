import { useState } from "react";

import type { AgentConfig } from "@/api";
import { configDiff, type DiffLine, fileDiff, type NumberedLine, numberedDiff, type PseudoFile, splitDiff } from "@/lib/derive";
import { cn } from "@/lib/utils";

const COLLAPSE_AT = 12;

export type DiffMode = "unified" | "split";

/**
 * Two configs as a line diff. With `file` it is that one pseudo-file (`lib/derive.ts` `fileDiff`, context lines
 * included, a line-numbered gutter) — the Review page's document; without it, every change across the config in
 * one block with a `where:` prefix per line (`configDiff`) — the cycle page, where the lines come from five files
 * and a number would mean nothing. `mode` folds the diff into two columns (`splitDiff`); the Review page's tab
 * strip toggles it. Changes are marked without colour fills: an added line carries a hairline left bar, a removed
 * line is dimmed and struck. Loading the two configs is the caller's job: the cycle page reads a cycle's
 * before/after pair, the Review page a candidate and the last approved version.
 */
export default function ConfigDiff({
  before,
  after,
  file,
  mode = "unified",
  collapseAt = COLLAPSE_AT,
  className,
}: {
  before: AgentConfig;
  after: AgentConfig;
  file?: PseudoFile;
  mode?: DiffMode;
  /** Lines shown before "show all"; `Infinity` never folds. */
  collapseAt?: number;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const lines: DiffLine[] = file ? fileDiff(before, after, file) : configDiff(before, after);
  const shown = numberedDiff(open || lines.length <= collapseAt ? lines : lines.slice(0, collapseAt));
  const gutter = !!file;

  if (lines.length === 0) return <p className={cn("text-[13px] text-[var(--faint)]", className)}>{file ? "empty in both versions" : "no changes"}</p>;

  const more = lines.length > collapseAt && (
    <button type="button" onClick={() => setOpen((o) => !o)} className="mt-2 text-[12px] text-[var(--muted)] hover:text-[var(--fg)]" style={{ fontFamily: "var(--font-sans)" }}>
      {open ? "show less" : `show all ${lines.length} lines`}
    </button>
  );

  if (mode === "split" && gutter) {
    return (
      <div className={cn("code text-[12px] leading-[1.6]", className)}>
        <div className="grid grid-cols-2 gap-x-4">
          {splitDiff(shown).map((row, i) => (
            <Row key={i} left={row.left} right={row.right} />
          ))}
        </div>
        {more}
      </div>
    );
  }

  return (
    <pre className={cn("code whitespace-pre-wrap break-words text-[12px] leading-[1.6]", className)}>
      {shown.map((l, i) => (
        <Line key={i} line={l} gutter={gutter} />
      ))}
      {more}
    </pre>
  );
}

/** One unified line: old/new numbers in the gutter (file mode), the sign, then the text marked by weight and a bar, never a fill. */
function Line({ line, gutter }: { line: NumberedLine; gutter: boolean }) {
  return (
    <div className={cn("flex", tone(line.sign))}>
      {gutter && (
        <span className="tabular mr-3 flex shrink-0 select-none text-[var(--faint)]">
          <span className="w-8 text-right">{line.old ?? ""}</span>
          <span className="w-8 text-right">{line.new ?? ""}</span>
        </span>
      )}
      <span className="mr-2 inline-block w-3 shrink-0 select-none text-[var(--faint)]">{line.sign.trim()}</span>
      <span className="min-w-0 flex-1 whitespace-pre-wrap break-words">{line.text}</span>
    </div>
  );
}

/** One side-by-side row: two cells, each a numbered line or an empty slot when the other file has nothing there. */
function Row({ left, right }: { left: NumberedLine | null; right: NumberedLine | null }) {
  const cell = (l: NumberedLine | null, no: number | null) => (
    <div className={cn("flex min-w-0", tone(l?.sign ?? " "))}>
      <span className="tabular mr-3 w-8 shrink-0 select-none text-right text-[var(--faint)]">{no ?? ""}</span>
      <span className="min-w-0 flex-1 whitespace-pre-wrap break-words">{l?.text ?? ""}</span>
    </div>
  );
  return (
    <>
      {cell(left, left?.old ?? null)}
      {cell(right, right?.new ?? null)}
    </>
  );
}

/** Every line carries the bar's slot so text stays aligned; only an added line's bar is drawn (foreground). Removed: faint and struck. Context: muted. */
function tone(sign: DiffLine["sign"]): string {
  const slot = "border-l pl-2";
  if (sign === "+") return `${slot} border-[var(--fg)] text-[var(--fg)]`;
  if (sign === "-") return `${slot} border-transparent text-[var(--faint)] line-through decoration-[var(--faint)]`;
  return `${slot} border-transparent text-[var(--muted)]`;
}

export function Label({ children }: { children: React.ReactNode }) {
  return <h3 className="mb-3 text-[12px] font-medium text-[var(--faint)]">{children}</h3>;
}
