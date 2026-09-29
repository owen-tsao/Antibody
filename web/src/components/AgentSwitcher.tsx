import { CaretUpDown, Plugs } from "@phosphor-icons/react";

import type { Agent } from "@/api";
import AgentTile from "@/components/AgentTile";
import Dropdown from "@/components/Dropdown";
import { agentKindLine, heroTitle, selectable } from "@/lib/derive";
import { linkProps, onboarding } from "@/lib/routes";
import { cn } from "@/lib/utils";

/**
 * Which agent the next run attacks — the rail's top block, the Home card's name and Current run's empty
 * face are all this. A `Dropdown` whose rows are agent tiles (stopped ones disabled) and whose footer is
 * "Connect an agent". `size` picks the trigger: `rail` is tile + name + kind line; `hero` is the bare name
 * in the parent's type with a caret, for the agent card's title. `iconOnly` is the collapsed rail (opens sideways).
 */
export default function AgentSwitcher({
  agents,
  selected,
  onSelect,
  size = "rail",
  iconOnly = false,
  className,
}: {
  agents: Agent[] | null;
  selected: Agent | null;
  onSelect: (id: string) => void;
  size?: "rail" | "hero";
  iconOnly?: boolean;
  className?: string;
}) {
  const hero = size === "hero";
  const tile = iconOnly ? 20 : 28;

  return (
    <Dropdown
      value={selected?.id ?? null}
      options={(agents ?? []).map((a) => ({
        value: a.id,
        label: a.name,
        disabled: !selectable(a),
        aside: selectable(a) ? undefined : "stopped",
        row: (
          <>
            <AgentTile agent={a} size={20} />
            <span className="min-w-0 flex-1 truncate">{a.name}</span>
          </>
        ),
      }))}
      onChange={onSelect}
      label="Agent to attack"
      disabled={!agents}
      placement={iconOnly ? "right" : "below"}
      align={hero ? "center" : "start"}
      className={cn(hero && "inline-block", className)}
      footer={
        <a {...linkProps(onboarding(1))} className="flex h-9 items-center gap-2.5 rounded-md px-2 text-[13px] text-[var(--muted)] transition-colors hover:bg-[var(--hover)] hover:text-[var(--fg)]">
          <Plugs size={16} className="shrink-0" aria-hidden />
          Connect an agent
        </a>
      }
      trigger={({ open }) =>
        hero ? (
          // The card sets the size; the caret is half a cap high and centred on the one-line name, at its right end.
          <span className={cn("inline-flex items-center gap-[0.35em] rounded-md px-2 transition-opacity hover:opacity-80", open && "opacity-80")}>
            {selected ? heroTitle(selected.name).name : "…"}
            <CaretUpDown className="h-[0.5em] w-[0.5em] shrink-0 opacity-70" aria-hidden />
          </span>
        ) : (
          <span
            title={iconOnly ? selected?.name : undefined}
            className={cn(
              "flex items-center rounded-md text-left transition-colors hover:bg-[var(--hover)]",
              iconOnly ? "h-9 w-full justify-center" : "h-11 w-full gap-2.5 px-2",
              !agents && "hover:bg-transparent",
            )}
          >
            {selected ? <AgentTile agent={selected} size={tile} /> : <span className="rounded-[8px] bg-[var(--inset)]" style={{ width: tile, height: tile }} aria-hidden />}
            {!iconOnly && (
              <>
                <span className="flex min-w-0 flex-col">
                  <span className="truncate text-[13px] font-medium leading-tight text-[var(--fg)]">{selected?.name ?? "…"}</span>
                  <span className="truncate text-[11px] leading-tight text-[var(--faint)]">{agentKindLine(selected)}</span>
                </span>
                <CaretUpDown size={14} className="ml-auto shrink-0 text-[var(--faint)]" aria-hidden />
              </>
            )}
          </span>
        )
      }
    />
  );
}
