import type { ReactNode } from "react";

import type { Agent } from "@/api";
import { useMotionPref } from "@/hooks/useMotionPref";
import { agentHueRotate } from "@/lib/derive";
import { cn } from "@/lib/utils";

/**
 * An agent as a picture: the Ruixen "Container Text Scroll" card (~/.cursor/skills/component-library/prompts/
 * container-text-scroll-integration.md) with its scroll machinery dropped, per the note at the foot of that
 * prompt — the `Card`'s 4 px `#6C6C6C` rim on `#222`, its shadow stack, and inside it the demo's photo (one
 * soft amber streak on black, `object-cover object-left-top`) with the title set over the middle. Every agent
 * is its own colour by turning the photo's hue (`agentHueRotate`); `AgentTile` shows the same photo small, so
 * the tile and the card are one picture at two sizes. `name` is a slot so Home / Current run can make it the
 * agent switcher; `children` is an overlay over the photo (a full-face link, the Heal orb).
 */

// From the paste, verbatim: this is what sits the card on the page.
const SHADOW =
  "0 0 #0000004d, 0 9px 20px #0000004a, 0 37px 37px #00000042, 0 84px 50px #00000026, 0 149px 60px #0000000a, 0 233px 65px #00000003";

export const CARD_PHOTO = "/agent-card.jpg";
/** The paste's rim, for the card and for the placeholder drawn while the agent list loads. */
export const CARD_FRAME = "rounded-[30px] border-4 border-[#6C6C6C] bg-[#222222]";

export default function AgentCard({
  agent,
  name,
  subline,
  ratio = "video",
  title = "center",
  children,
  className,
}: {
  agent: Agent;
  /** The title over the photo — text, or the agent switcher. */
  name: ReactNode;
  subline?: string;
  ratio?: "video" | "free";
  /** Where the name sits: centred, or in the upper third to leave the lower half to an overlay. */
  title?: "center" | "upper";
  /** Overlay above the photo and below the title layer (z-40; use z-10…z-30). Stops pointer events only where it draws. */
  children?: ReactNode;
  className?: string;
}) {
  const reduced = useMotionPref();
  return (
    <div
      className={cn(
        // Hover: the photo drifts in (a slow zoom), the rim warms a step, the title lifts a hair. CSS only; under
        // reduced motion (the Display preference or the OS) the rim change is all that moves. The card itself does
        // not clip — the switcher's panel must be free to hang below a short card — so the photo is clipped alone.
        "group relative @container transition-colors duration-500 hover:border-[#8c8c8c]",
        CARD_FRAME,
        ratio === "video" && "aspect-video",
        className,
      )}
      style={{ boxShadow: SHADOW }}
    >
      <div className="absolute inset-0 overflow-hidden rounded-[26px]" aria-hidden>
        <img
          src={CARD_PHOTO}
          alt=""
          draggable={false}
          className={cn("h-full w-full object-cover object-left-top", !reduced && "transition-transform duration-[1200ms] ease-[cubic-bezier(.2,.7,.2,1)] group-hover:scale-[1.05]")}
          style={{ filter: `hue-rotate(${agentHueRotate(agent.id)}deg)` }}
        />
      </div>

      {children}

      {/* The title layer lets clicks fall through to the overlay (a grid card's face is a link) except on
          its own controls: the switcher's trigger and the links in its panel. */}
      <div
        className={cn(
          "pointer-events-none absolute inset-0 z-40 flex flex-col items-center px-6 text-center text-white",
          !reduced && "transition-transform duration-700 ease-out group-hover:-translate-y-1",
          title === "upper" ? "justify-start pt-[14%]" : "justify-center",
        )}
      >
        <div className="display leading-[1] [font-size:clamp(24px,9cqw,72px)] [&_a]:pointer-events-auto [&_button]:pointer-events-auto [&_[role=listbox]]:pointer-events-auto">{name}</div>
        {subline && <div className="mt-2 text-[13px] text-white/70">{subline}</div>}
      </div>
    </div>
  );
}
