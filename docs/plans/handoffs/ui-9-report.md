# UI 9 — Schedules: agent avatars in the orbit nodes

Plan 11 §3 (with the §7 "§0 nits" correction: `AgentTile` lives in `web/src/components/AgentTile.tsx`, and there is no web
test runner, so `monogram` had no tests to delete). Every schedule node on `/app/schedules` now carries its agent's picture — the
agent card's photo turned to the agent's hue, exactly what `AgentTile` shows in the rail and on Runs — inside the existing 28 px
`MetalFrame` ring, with a two-line label beneath. Build and lint clean: `npm --prefix web run build` OK; `npm --prefix web run
lint` 0 errors, 10 warnings, all pre-existing and all in files this lane did not touch (`ui/orb.tsx` ×8, `ui/button.tsx`,
`ui/badge.tsx`, `hooks/useDwell.ts`). Nothing committed.

## What changed

**`web/src/components/ui/radial-orbital-timeline.tsx`**

- `TimelineItem.mark: string` (the two letters) is replaced by `avatar: { src: string; hue: number } | null` — an image and the CSS
  `hue-rotate` degrees that colour it. The component stays agent-agnostic: it draws whatever picture the host hands it and knows
  nothing about `AgentCard` or agent ids.
- `content` and `category` are deleted from `TimelineItem`. Neither was read anywhere since the in-place detail card went in
  ui-7; the host was computing `scheduleLine(s)` and `agent_name ?? "removed agent"` for fields nothing drew.
- The node's inner surface (`h-[calc(100%-3px)]`, so 25 px inside the 1.5 px rim) gets `overflow-hidden` and holds the `<img>`
  when `avatar` is set — `object-cover`, `objectPosition: "45% 50%"`, the tile's crop — or stays an empty black disc when it is
  null. The avatar-in-ring is JSX here, not a component: it has one call site.
- Selected state: the ring's `active` (faster chrome) and the ×1.5 scale are unchanged. The old "inner turns white" treatment is
  kept only for the plain orb; a photo does not get painted over.
- Label: two `block truncate max-w-[160px]` lines — `title` at white/75, `date` at white/45 — centred under the node, whole label at
  40 % when paused, `title` to full white and the label scaled ×1.1 when selected. `aria-label` stays `${title} · ${date}`.

**`web/src/pages/Schedules.tsx`**

- Builds `avatar: s.agent_name ? { src: CARD_PHOTO, hue: agentHueRotate(s.agent) } : null`. `agent_name` is the API's own signal
  that the agent row still exists (`api/schedules.py describe()` writes null when `agents.get_agent` finds nothing), and it is
  what `scheduleLine` / `scheduleStatus` / `scheduleEnergy` already key on — one meaning of "deleted", not a second lookup
  against the shell's agent list.
- `title` is `scheduleTitle(s)`; `date` stays `triggerLabel(s.trigger)`. The dead `content` / `category` / `mark` fields go.
- Imports `CARD_PHOTO` from `AgentCard` and `agentHueRotate` from derive — the same two things `AgentTile` composes, so a node and
  a tile are one picture at two crops.

**`web/src/lib/derive.ts`**

- `monogram()` deleted (nothing else used it; it used nothing else).
- `scheduleTitle(s)` added, docstringed: the schedule's own name, or the agent's card title (`heroTitle(agent_name).name`, the
  parenthetical dropped) when the schedule's name is empty or is the agent's name verbatim; a schedule whose agent is gone shows
  its own name. This is the "agent's name, or the schedule name when it differs" rule from the plan; the parenthetical rule is my
  reading of "agent's name" as the name the hero card and switcher show, not the raw row — `Example airline agent`, not
  `Example airline agent (OpenAI CS demo)` at 11 px.

`AgentTile.tsx` is untouched: the node's inner surface is 25 px and circular, `AgentTile`'s sizes are 20/28/48 with a 28 %
radius set inline, so reusing it would have meant a `size`/`radius` escape hatch for one caller. Two-call-sites rule: the `<img>`
stays in the timeline.

## What I saw (Vite dev server at :5173 against the API at :8000)

Setup: the install had one schedule (`Sweep`, demo agent, every day). I created `Airline nightly` (airline agent, every 6 h) and,
to exercise the deleted-agent branch, connected a throwaway agent `Ghost agent (ui-9 test)` at `http://127.0.0.1:9/`, put a paused
schedule `Orphan sweep` on it, then deleted the agent. All three test objects were deleted at the end; the API lists `Sweep` alone
and the three synthetic agents, as before.

Measured with CDP `Runtime.evaluate` on each node (`ui9-schedules-three-nodes.png`):

| node | ring | inner | `<img>` | hue | frame opacity | hairline | label |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Sweep (demo agent) | 28×28 | 25×25, `overflow:hidden`, circular | `/agent-card.jpg`, loaded (1400×933), 25×25, `object-fit: cover`, `45% 50%` | `hue-rotate(0deg)` | 1 | no | `Sweep` / `every day`, 51 px wide |
| Airline nightly | 28×28 | 25×25 | same | `hue-rotate(230deg)` | 1 | no | `Airline nightly` / `every 6h`, 71 px |
| Orphan sweep (agent deleted) | 28×28 | 25×25, black | **none** | — | 0.4 | yes | `Orphan sweep` / `every 1h`, label at 0.4 |

- The airline node's `hue-rotate(230deg)` is byte-identical to the sidebar `AgentTile`'s for the same agent, and to the Agents
  page card's (`ui9-neighbour-agents.png`: tile 28 px radius 8 px hue 230; cards hue 0 / 230 / 200). Same photo, same hue, so the
  orbit and the rail agree on who is who.
- Long name: renamed the airline schedule to a 60-character string. Line 1 measured 160 px with `text-overflow: ellipsis` over
  311 px of text; the label container shrank to 160 (`nowrap` inside an absolutely positioned box would otherwise run the full
  width — `max-w` on the lines caps it).
- Agent-name case: renamed it to `Example airline agent (OpenAI CS demo)` verbatim; the node read `Example airline agent · every
  6h` after the next poll.
- Click `Sweep`: node `aria-pressed=true`, z-index 200, ring 42 px (×1.5) with the photo at 37.5 px inside, title white, the
  dialog opened with the right row (`ui9-schedules-dialog.png`). Cancel released the node and the orbit resumed.
- Screenshots did not time out this session; three are saved under `/var/folders/gk/4js863bx5k175g264xx0cyg80000gn/T/cursor/
  screenshots/ui9-*.png`.

## Not verified

- A node in the `running` state (rim dot). Its markup is unchanged from ui-7 and the CDP probe confirmed `dot: false` on all
  three idle nodes; seeing the dot needs a scheduled run in flight, which I did not start.
- `prefers-reduced-motion` (the shader freezes; nothing in this change touches that path).
- The production build in a browser — the dev server was used for the walk; `vite build` itself is clean.
- Orbits with many nodes (8+): with 160 px labels and a 200 px radius, neighbouring labels will start to touch somewhere around
  eight nodes. The old single-line label had no cap at all, so this is not a regression, but it is a limit to know about.
