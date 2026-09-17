/**
 * The one-line "API is down" state, identical on Agents, Results and Cycle: the same faint words
 * the pages already used, plus a "retry" text button that polls again now instead of waiting for
 * the next tick. Rendered inline inside the page's status line so it sits on the same baseline and
 * type scale as the text it replaces.
 */
export default function ApiDown({ onRetry, className }: { onRetry: () => void; className?: string }) {
  return (
    <span className={className}>
      <span className="text-[var(--faint)]">api unreachable · </span>
      <button
        type="button"
        onClick={onRetry}
        className="group rounded text-[var(--faint)] transition-colors hover:text-[var(--muted)]"
      >
        <span className="u-line">retry</span>
      </button>
    </span>
  );
}
