# Handoff — Frontend lane: sidebar, agents page, onboarding wizard (plan Block 3)

Worktree `/Users/owentsao/antibody-frontend`, branch `feature/onboarding-sidebar` (forked from
`feature/fully-connected` at `76df0c4`, which has Blocks 1–2 merged: agents API + app shell). Read
`/Users/owentsao/Coreweave Hacks/docs/plans/00-overview.md` fully — **Block 3** is your spec, and the Block 1
and Block 2 `## Decisions` subsections are the contracts you build on. Then read `web/src/App.tsx`,
`web/src/components/Shell.tsx`, `web/src/lib/routes.ts`, `web/src/lib/settings.ts`,
`web/src/components/SettingsDrawer.tsx`, `web/src/api.ts`, `web/src/lib/derive.ts` (the `emptyStateFor` and
`shellPill` area), `api/agents.py` (docstring + `list_agents`/`ping`), `api/example_agent.py`, and the
`/api/agents*` routes in `api/main.py`. House rules: `/Users/owentsao/Coreweave Hacks/.cursor/rules/code-organization.mdc`
and Owen's UI standard `/Users/owentsao/.cursor/skills/my-ui-standard/SKILL.md`.

## What you are building, in one sentence

The sidebar becomes a real Linear-style rail (sections, visible edge, collapsible, "Current run" item instead
of the floating pill), the Agents page lists connected agents with ping/tool-mapping status, and a
full-screen onboarding wizard (Choose → Connect → Tools → First run) using Owen's `wizard-steps` rail makes the
whole connect-and-heal path terminal-free.

## Owen's review of the Block 2 build (why this block exists)

Sidebar edge invisible; the old Heal hero reads as marketing inside a tool; the bottom-left "replay paused"
pill floats; the connect page (a placeholder) looks bad; Settings and Replays should be sidebar tabs; the
sidebar should collapse. He pointed at Linear as the reference for how a production app is structured:
sections of nouns, muted text, one active row, an obvious primary action top-right, counts where they matter.

## The wizard rail from Owen's component library

Read `/Users/owentsao/.cursor/skills/component-library/prompts/wizard-steps-rail-integration.md` (full
source embedded) and look at `/Users/owentsao/.cursor/skills/component-library/screenshots/wizard-rail-shipped.png`
(the shipped Clad onboarding: rail on top, step eyebrow + title + one-line sub centred, choice cards, Back /
Continue at the bottom, "Save & exit" top-right). Extract the **rail only** (`WizardRail`: 28 px rounded tiles,
number → check when done, spring scale on the active tile, connectors whose fill `scaleX`es in). Adapt: our
monochrome tokens (`--fg/--muted/--faint/--border`), `framer-motion` (installed) not `motion/react`, lucide
`Check`, `useReducedMotion`. Do not add any dependency. Do not import from the library — copy and adapt.

## Facts

- `Shell.tsx:26-34` `ShellData` render prop (`loop`, `replay`, `status`, `statusError`) fed by three polls at
  `:43-51`; the run page relies on it — **keep the polls**, delete only the pill JSX (`:81-91`) and
  `shellPill()` in `derive.ts`. `/api/health` is polled in `App.tsx:64`; move it into `Shell` as `health`.
- `routes.ts`: `Route` union at `:7`, `parse` `:26-39` (pure; `/app` and unknown `/app/*` → `RUNS` at `:38`),
  `href` `:41`, `navigate` `:91`, `useRoute` `:113`, `linkProps` `:121`. `agent-new` kind exists at `:10,:30`.
- `settings.ts`: `RunSettings` `:8-19` (no `untilQuiet`, no `target`), `toStartBody` `:91-99`, `DEFAULT_SETTINGS`,
  `estimateLabel`. `SettingsDrawer.tsx:145-200` renders the field rows (Seeds / Chaos cycles / Repair attempts /
  Second pass / World) inside a fixed `aside`.
- `api.ts` has **no agent fetchers yet**; `LoopStartBody` lacks `target`, `RunRow` lacks `agent`. The backend
  shapes (from Block 1's report, all live on this branch):

  ```ts
  interface AgentPing { at: string; ok: boolean; latency_ms: number }
  interface AgentTool { name: string; description: string }
  interface Agent { id: string; name: string; transport: "in-process" | "http"; url: string | null;
    created_at: string | null; last_ping: AgentPing | null; tools: AgentTool[] | null; synthetic: boolean;
    running?: boolean; starting?: boolean; pid?: number | null }              // example row only
  type PingResult =
    | { ok: true;  latency_ms: number; reply_preview: string | null; tools: AgentTool[] | null; mapping: { known: string[]; unknown: string[] } | null }
    | { ok: false; latency_ms: number; error: string;                 tools: AgentTool[] | null; mapping: { known: string[]; unknown: string[] } | null };
  // GET /api/agents → Agent[]  (builtin first, then example, then stored; poll at ≥ 3 s — each call probes 8790)
  // POST /api/agents {name, url} → 201 Agent | 400 | 409 (duplicate URL)
  // DELETE /api/agents/:id → 204 | 404 | 409 (a loop is running)
  // POST /api/agents/:id/ping → 200 PingResult | 404
  // POST /api/agents/example/start → 202 {pid, started_at, url, running:false, starting:true} | 503 no key | 409 {detail:{message,…}}
  // POST /api/agents/example/stop → 200 {running, url, pid, starting, stopped, owned} | 404 nothing running
  // GET /api/agents/example/log?tail=200 → {lines: string[]}
  // LoopStartBody.target?: string | null (agent id); POST /api/loop/start 201 → {…, target: string (canonical)}
  // RunRow.agent: {id, name} | null
  ```
- Stored rows carry `tools` but not `mapping`; compute "N/M mapped" client-side against `GET /api/manifest.tools`
  names. Synthetic rows (`builtin`, `example`) never get `last_ping` persisted — show "—" until pinged in-session.
- Storefront tool names: `lookup_order`, `issue_refund`, `send_email`, `read_ticket`, `set_ticket_status`.
- Build/lint: `npm --prefix web run build`, `npm --prefix web run lint` (pre-existing warnings in
  `ui/orb.tsx`, `ui/button.tsx`, `ui/badge.tsx`, `hooks/useDwell.ts` are not yours). Tests:
  `env -u WANDB_API_KEY uv run pytest -q` (231 now; you add none unless you touch `api/`, which you should not).

## Build, in this order (build + lint clean after each; commit each)

1. **`api.ts`**: the types and fetchers above; `LoopStartBody.target`, `LoopStarted.target`, `RunRow.agent`.
2. **Routes**: add kinds `home`, `replays`, `settings`, `onboarding` (`step: 1|2|3|4`); `parse`: `/app` and
   `/app/home` → home, `/app/onboarding/:step` (bad step → 1), `/app/agents/new` → redirect to onboarding step 2
   (in `redirectLegacy` or `parse`; remove the `agent-new` kind); `href` for each. Update `emptyStateFor`'s kind
   union in `derive.ts`.
3. **Shell**: sections exactly as the plan lists (`Antibody` · Home · Current run ● · *Workspace* · Agents · Runs ·
   Replays · Settings); active row by route; `aria-current`; "Current run" only when `loop.running || replay.active`,
   dot pulses while `loop.running` (respect reduced motion), links to `/app/runs/live`. Visible edge (`--border-2`)
   and a slightly different rail surface (one new CSS variable in `index.css` is fine, e.g. `--bg-rail`). Collapse:
   240 → 48 px icon rail with lucide icons + `title` tooltips, `[` toggles (ignore when focus is in an input),
   persisted in `localStorage` (`antibody.rail.v1`), animated width with reduced-motion respected. Below md: top
   bar with a menu button opening the rail as an overlay. Rail footer: the no-key line from `health`. Remove the
   pill. Replays and Settings get titled placeholder pages (Block 4 builds them) so no rail link is dead.
4. **Agents page** (`pages/Agents.tsx` is today's *run* page — do not confuse; create `pages/AgentsList.tsx` or rename
   today's to `pages/RunLive.tsx` first, your call, say which): header "Agents" + primary **Connect agent** →
   `/app/onboarding/1`. Rows per the plan; quiet actions on the `example` row (start → shows "starting…" until
   `running`; stop); delete with inline confirm on second click and the 409 message inline. Empty state (only
   synthetic rows): one line + the Connect action.
5. **Shared settings fields**: extract the rows from `SettingsDrawer.tsx:145-200` into `components/RunSettingsFields.tsx`
   (two call sites: the drawer today, the wizard step 4 now; Block 4's dialog later). Add `untilQuiet: number | null`
   and `target: string | null` to `RunSettings`, `normalizeSettings`, `toStartBody` (`until_quiet`, `target`),
   `settingsSummary`, `estimateLabel` ("at most N cycles" when `untilQuiet` is set). Drop `world` from the fields
   (keep the type; the API default `auto` is right). The drawer keeps working with the shared rows.
6. **Wizard** at `/app/onboarding/:step`, full-screen route rendered *outside* `Shell` (like the landing):
   rail on top, "Skip for now" top-right → `/app/home`, step eyebrow ("STEP 2 OF 4 · CONNECT"), serif title at
   the page-title size, one-line sub, content, Back / Continue bottom. Steps per the plan. Step 1's three cards
   (choice-card pattern from the Clad screenshot: icon, title, one-line body, check when selected); choosing
   Demo skips to step 4 with `target: "builtin"`; Example starts it (`exampleStart`, poll `agents()` until
   `running`, show the log's last line while starting) then skips to step 3 with the example's ping; Your own →
   step 2. Step 2: name + URL, **Ping** button → inline result; Save enabled only after `ok`; save → step 3 with
   that ping's `mapping`. The contract snippet (20 lines: `POST /episode` in `{session_id, message, customer_id,
   customer_email, tools_url}`, `{reply}` out, tools at `<tools_url>/tools/<name>`, optional `GET /tools`) in a
   collapsed disclosure with a copy button and a link to `examples/agents/openai_agents_support/README.md`
   on GitHub-relative path. Step 3: mapping as the plan words it. Step 4: `RunSettingsFields` with the agent
   preselected and shown read-only at the top; **Heal** → `loopStart(toStartBody(settings))` → `/app/runs/live`;
   409 → `/app/runs/live`; other errors inline; disabled with tooltip when `health.has_api_key === false`.
   Wizard state lives in React state for the session (a refresh restarts at step 1; acceptable — say so).
7. **First-run rule** as a Home page effect: `/app/home` (which is still a placeholder page in this block — make
   it a minimal titled page) loads `agents()`, `runs()`, and reads `loop` from `ShellData`; if no non-synthetic
   agents, no rows other than `golden`, and not `loop.running`, `replaceState` to `/app/onboarding/1`. Quiet
   loading state so Home never flashes.
8. **Owed fix**: on the live run page hide the seed-attack preview (`Results.tsx` ~168-183) unless the run's
   agent is built-in (`RunRow.agent?.id === "builtin"` or `manifest.target.transport === "in-process"` for `live`).
9. **Landing**: add the subhead "Let it break. Watch it heal." under the title on `Intro.tsx` (it is leaving the
   old Heal page in Block 4; putting it on the landing now means it is never lost).
10. Append `## Decisions` under Block 3 in `/Users/owentsao/Coreweave Hacks/docs/plans/00-overview.md`
    (main checkout, absolute path) for anything the plan left open. Update the routes table in `docs/FRONTEND.md`.

## Verify in the browser (build, then `uv run uvicorn api.main:app --port 8031` from your worktree, keyless)

- `/app` with an empty `history/` → onboarding step 1; "Skip for now" → Home; Home never flashes first.
- Rail: edge visible, sections, `[` collapses to icons, state survives reload; no pill anywhere; during a
  replay "Current run ●" appears and links to the run; leaving pauses (unchanged Block 2 behaviour).
- Agents: builtin + example rows; ping the example while it is down → the exact error inline; Connect agent →
  wizard. Without a key, `exampleStart` shows the 503 text and Heal is disabled with the reason.
- Wizard step 2 against a bogus URL → error inline; Save stays disabled. (You cannot test a green ping without
  the key; say so.)
- Screenshots to `/Users/owentsao/antibody-frontend-screens/block3-*.png`: rail expanded, rail collapsed, agents
  list, wizard step 1, step 2 with error, step 4.

## Boundaries

- **Owns:** `web/**`, `docs/FRONTEND.md` (routes table). **Do not touch** `api/`, `chaos/`, `examples/`,
  `tests/`, `README.md`, `docs/plans/*` except the Block 3 Decisions append. No new dependency. No new colours
  beyond one rail-surface variable.
- **Git:** small single-topic commits on `feature/onboarding-sidebar`, plain-language messages (what and why).
  **Never push, never touch other branches.** Never read or print `.env`.

## Done when

- Everything in "Verify" passes; build/lint clean; 231 tests still pass.
- Report: commits, screenshots, decisions, what was NOT tested, and any backend gap you hit (the backend lane
  is working in parallel on `feature/trustworthy-numbers`; tell me, don't fix it yourself).
