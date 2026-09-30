import type { HTMLAttributes } from "react";

import { cn } from "@/lib/utils";

/**
 * A bar split into shares (docs/plans/14-agent-page.md "Two visuals"; source archived in the component library as
 * partition-bar, cut down to what one call site needs). Each segment is `num` wide out of the sum; a zero segment
 * takes no room. Two tones only — `fg` for the part that matters, `faint` for the rest — because the bar sits under
 * a line of text that already names the numbers.
 */
export interface PartitionSegment {
  num: number;
  tone?: "fg" | "faint";
  label: string;
}

export default function PartitionBar({ segments, className, ...props }: { segments: PartitionSegment[]; className?: string } & Omit<HTMLAttributes<HTMLUListElement>, "children">) {
  const total = segments.reduce((sum, s) => sum + Math.max(0, s.num), 0);
  if (total <= 0) return null;
  return (
    <ul className={cn("flex w-full flex-row gap-[3px]", className)} aria-label={segments.map((s) => `${s.label} ${s.num}`).join(", ")} {...props}>
      {segments
        .filter((s) => s.num > 0)
        .map((s) => (
          <li key={s.label} className={cn("h-0.5 min-w-0 shrink-0 grow-0 rounded-full", s.tone === "faint" ? "bg-[var(--faint)]" : "bg-[var(--fg)]")} style={{ flexBasis: `${(s.num / total) * 100}%` }} title={`${s.label}: ${s.num}`} />
        ))}
    </ul>
  );
}
