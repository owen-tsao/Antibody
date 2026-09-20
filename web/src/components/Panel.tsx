// The structured panel every overview surface is built from (Home, agent detail, settings sections): a grey
// `--frame` edge on the page's own black — the same surface as the cycles box; `--card` is for floating
// surfaces that must separate from the page (a dropdown, a hover card) — a 44 px title row — title left, an
// optional right slot for a count or a link — and a body. Rows inside a panel are hairline-separated and end
// in `→` when they go somewhere (`PanelRow`). The shape is Clad's home panels; the looks are the app's tokens.

import { ArrowRight } from "@phosphor-icons/react";
import type { MouseEvent, ReactNode } from "react";

import { cn } from "@/lib/utils";

export default function Panel({ title, aside, children, className, bodyClassName }: { title: ReactNode; aside?: ReactNode; children: ReactNode; className?: string; bodyClassName?: string }) {
  return (
    <section className={cn("flex flex-col rounded-xl border border-[var(--frame)] bg-[var(--bg)]", className)}>
      <header className="flex h-11 shrink-0 items-center justify-between gap-3 rounded-t-xl border-b border-[var(--border)] px-4">
        <h2 className="truncate text-[13px] font-medium text-[var(--fg)]">{title}</h2>
        {aside && <div className="flex shrink-0 items-center gap-3 text-[12px] text-[var(--faint)]">{aside}</div>}
      </header>
      <div className={cn("flex-1 rounded-b-xl [&>*:last-child>a:last-child]:rounded-b-xl", bodyClassName)}>{children}</div>
    </section>
  );
}

/** A row that goes somewhere: title, a quiet second line, `→` on the right that brightens with the row. */
export function PanelRow({ href, onClick, title, line, trailing }: { href: string; onClick: (e: MouseEvent<HTMLAnchorElement>) => void; title: ReactNode; line?: ReactNode; trailing?: ReactNode }) {
  return (
    <a href={href} onClick={onClick} className="group flex items-center gap-4 px-4 py-3 transition-colors hover:bg-[var(--hover)]">
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-[13px] text-[var(--fg)]">{title}</span>
        {line && <span className="truncate text-[12px] text-[var(--faint)]">{line}</span>}
      </span>
      {trailing && <span className="tabular shrink-0 text-[12px] text-[var(--muted)]">{trailing}</span>}
      <ArrowRight size={14} className="shrink-0 text-[var(--faint)] transition-colors group-hover:text-[var(--fg)]" aria-hidden />
    </a>
  );
}

/** What a panel says when it has nothing to list: one quiet centred line. */
export function PanelEmpty({ children }: { children: ReactNode }) {
  return <p className="px-4 py-8 text-center text-[12px] text-[var(--faint)]">{children}</p>;
}
