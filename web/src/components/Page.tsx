// The anatomy every page under the shell shares (docs/plans/07-app-rework.md §5): a 56 px header row —
// title left, the page's one primary action right, hairline below — and a content area with fixed
// gutters. The header is what stops a page "floating": it gives the content a top edge and puts the
// action where every production app puts it. Titles are Inter, not serif; serif is the landing page's.

import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

export default function Page({
  title,
  eyebrow,
  action,
  children,
  className,
}: {
  title: ReactNode;
  /** A quiet line above the title: a section name, or an agent's name over its page. */
  eyebrow?: ReactNode;
  /** The page's single primary action, or an inline status when there is nothing to do. */
  action?: ReactNode;
  children: ReactNode;
  /** For the content area. */
  className?: string;
}) {
  return (
    <div className="flex min-h-full flex-col">
      <header className="sticky top-0 z-10 flex h-14 shrink-0 items-center justify-between gap-4 border-b border-[var(--border)] bg-[var(--bg)]/85 px-8 backdrop-blur-sm">
        <div className="flex min-w-0 items-baseline gap-3">
          {eyebrow && <span className="truncate text-[12px] text-[var(--faint)]">{eyebrow}</span>}
          <h1 className="truncate text-[16px] font-semibold tracking-[-0.015em] text-[var(--fg)]">{title}</h1>
        </div>
        {action && <div className="flex shrink-0 items-center gap-3">{action}</div>}
      </header>
      <div className={cn("w-full max-w-[1200px] flex-1 px-8 py-6", className)}>{children}</div>
    </div>
  );
}
