import type { InteractiveListItem } from "@/components/ui/interactive-list-preview";
import { shortTitleOf, type AttackPreview } from "@/lib/derive";

/**
 * A seed-attack result as one row of the cycle list (docs/FRONTEND.md §4.3: "prepended as PREVIEW · NOT LOGGED").
 * It carries no `preview`/`img`: there is no chart for a run that was never logged, and the list renders
 * no hover card for such rows.
 *
 * The list's gsap tween animates every <td>'s color between white and black on hover, and the cells are
 * uppercase; the spans below carry inline `color` / `textTransform` so the red tool call and the PASS/FAIL
 * word survive both. `whiteSpace: normal` lets a long list of calls wrap inside the nowrap cell rather than
 * spill past the table edge.
 */
export function previewListItem(p: AttackPreview, onDismiss: () => void): InteractiveListItem {
  const verdict =
    p.passed === null ? null : p.passed ? "PASS" : `FAIL · ${(p.failureKind ?? "unknown").replace(/_/g, " ")}`;
  const verdictColor = p.passed === null ? undefined : p.passed ? "var(--live)" : "var(--danger)";
  // Strip the harness prefix; the row has room for "refunds require the customer to ask", not "policy: ...".
  const reasonOf = (blockedBy: string | null) => (blockedBy ?? "blocked by policy").replace(/^policy:\s*/i, "");

  return {
    client: `v${p.version} · ${shortTitleOf(p.title)}`,
    platform: p.replayed ? "preview · replayed" : "preview",
    status: "not logged",
    spanGutter: true,
    services: (
      <span
        className="inline-flex max-w-full flex-wrap items-baseline justify-end gap-x-2 gap-y-1"
        style={{ textTransform: "none", whiteSpace: "normal" }}
      >
        {p.error && (
          <span style={{ color: "var(--muted)" }}>
            {p.error}
            {p.replayed ? " — (replayed)" : ""}
          </span>
        )}
        {p.calls.length === 0 && !p.error && <span style={{ color: "var(--muted)" }}>no tool calls</span>}
        {p.calls.map((c, i) => (
          <span key={i} style={c.tone === "danger" ? { color: "var(--danger)" } : undefined}>
            {c.tone === "blocked" ? <s style={{ textDecorationColor: "var(--faint)" }}>{c.label}</s> : c.label}
            {c.tone === "blocked" && (
              <span style={{ color: "var(--muted)" }} title={c.blockedBy ?? undefined}>
                {" "}
                blocked · {reasonOf(c.blockedBy)}
              </span>
            )}
            {i < p.calls.length - 1 && <span style={{ opacity: 0.5 }}> ·</span>}
          </span>
        ))}
        {verdict && (
          <>
            <span style={{ opacity: 0.5 }}>·</span>
            <span title={p.reason} style={{ color: verdictColor, fontWeight: 600 }}>
              {verdict}
            </span>
            {p.outcome && (
              <span title={p.reason} style={{ color: verdictColor }}>
                {p.outcome}
              </span>
            )}
          </>
        )}
        {p.durationS !== null && (
          <>
            <span style={{ opacity: 0.5 }}>·</span>
            <span className="tabular-nums">{p.durationS.toFixed(1)} s</span>
          </>
        )}
        <button
          type="button"
          aria-label="dismiss preview"
          className="ml-1 rounded px-1 opacity-60 hover:opacity-100"
          onClick={(e) => {
            e.stopPropagation();
            onDismiss();
          }}
        >
          ×
        </button>
      </span>
    ),
  };
}
