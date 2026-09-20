// The one visual for an agent, everywhere it appears (rail switcher, wizard cards, agent header): the agent
// card's photo (`AgentCard`), cropped square and turned to the agent's hue — so the tile is the card at
// thumbnail size, not a second mark. No letters, no generic icons, no third-party logos.

import type { Agent } from "@/api";
import { CARD_PHOTO } from "@/components/AgentCard";
import { agentHueRotate } from "@/lib/derive";
import { cn } from "@/lib/utils";

type Size = 20 | 28 | 48;

export default function AgentTile({ agent, size = 28, className }: { agent: Pick<Agent, "id">; size?: Size; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn("relative inline-block shrink-0 overflow-hidden bg-[#222] after:pointer-events-none after:absolute after:inset-0 after:rounded-[inherit] after:ring-1 after:ring-inset after:ring-white/15 after:content-['']", className)}
      style={{ width: size, height: size, borderRadius: Math.round(size * 0.28) }}
    >
      <img src={CARD_PHOTO} alt="" draggable={false} className="h-full w-full object-cover" style={{ objectPosition: "45% 50%", filter: `hue-rotate(${agentHueRotate(agent.id)}deg)` }} />
    </span>
  );
}
