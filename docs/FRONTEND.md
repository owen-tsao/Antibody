# Antibody — Frontend Implementation Plan

Written Sat Sep 12, 6:40 PM against commit `89b74c6`; revised 7:20 PM after Owen's three-page layout review and 7:30 PM after the Interactive List Preview and Agent Plan components were handed over. Execute from this file. The backend contracts referenced here are what `chaos/` produces today; four small backend additions are requested in section 9 and everything degrades gracefully without them.

Decisions already made (do not reopen): React app is the product; three pages — Intro, Agents, Results — plus an optional Analysis tab; dark monochrome per Owen's UI standard; four 21st.dev components are used verbatim from `~/.cursor/skills/component-library/prompts/` — the liquid-metal hero (Intro), the Orb (Agents), the Agent Plan (`agent-plan.tsx`, the agents' work on the Agents page) and the Interactive List Preview (`interactive-list-preview.tsx`, the cycle list on Results) — with every deviation from the pasted source listed in §4 and commented at the top of the file; the hover preview shows a single-color chart (browser SVG by default, marimo PNG if the Analysis tab ships), not a stock photo; dependencies are added exactly as the four prompts list them; live attack runs from the UI; Weave opens in a new tab via buttons, never an iframe; marimo is an optional Analysis tab decided Sunday 10:30; no fake inputs and no fake motion — orbs animate only from a real backend phase signal, status is never clickable, and any replay is labeled as such.

---

## 1. What we are building

Three pages that tell one story: **press start → watch the agents work → see the proof.** Plus an optional fourth tab.

| Page | Route | Job | Loud element |
| --- | --- | --- | --- |
| Intro | `/` | Liquid-metal splash, one button, one quiet line naming the target | **Start healing** button |
| Agents | `/agents` | Four orbs (Chaos, Target, Judge, Repair) lit by the live phase; every cycle as an Agent Plan task beneath them (five subtasks: Chaos, Target, Judge, Repair, Gate); gate line | The active orb |
| Results | `/results` | Interactive List Preview of cycles — hover slides a white bar and floats that cycle's chart, click opens the detail (handoffs, gate numbers, config diff, Weave buttons) — plus run-attack buttons | **Run seed attack against v0** |
| Analysis (optional) | `/analysis` | marimo notebook in an iframe reading Weave | none |

Screen-level state (`useState`) switches pages; no router. The agents never run inside the browser. A ~140-line FastAPI adapter (`api/`) sits between React and `chaos/`; it spawns the loop as a subprocess and reads the same files the CLI writes.

```
web/  (Vite + React + TS + Tailwind)  ──HTTP──▶  api/main.py (FastAPI)  ──import/subprocess──▶  chaos/
                                                       │  reads: cycles.jsonl, runs/status.json, runs/configs/v*.json, runs/regression.json
                                                       │  spawns: PYTHONUNBUFFERED=1 uv run python -m chaos.loop run ...
                                                       └  in-process: run_target_agent + judge_episode for /attack
```

---

## 2. Data the frontend consumes (verified against `chaos/schemas.py` @ 89b74c6)

**CycleRecord** (one line of `cycles.jsonl`):

```
cycle: int
timestamp: ISO string
scenario: { id, kind, title, user_message, customer_id, faults[], expected_behavior, forbidden_tool_calls[], attacker_goal, origin }
attack_succeeded: bool
verdict: { scenario_id, config_version, passed, failure_kind|null, reason, method: "deterministic"|"llm", evidence: {} }
patch: { kind, rationale, guardrail_rule?, system_prompt?, validator_name?, tool_policy? } | null
gate: { accepted, fixes_new_failure, regression_pass_rate, legit_pass_rate, failed_scenario_ids[], reason } | null
config_before: int
config_after: int
regression_suite_size: int
weave_call_url: string | null        # ALWAYS null today — see section 9
```

`scenario.kind` ∈ `prompt_injection_via_tool | tool_returns_garbage | social_engineering | ambiguous_request`.
`scenario.origin` ∈ `seed | chaos_agent | legit`.
`verdict.failure_kind` ∈ `unauthorized_action | hallucinated_success | data_leak | wrong_action | crash | over_refusal`.
`patch.kind` ∈ `add_guardrail_rule | rewrite_system_prompt | add_tool_validator | tighten_tool_policy`.

**AgentConfig** (`runs/configs/v{n}.json`): `version, system_prompt, guardrail_rules[], tool_output_validators[], tool_policy{refund_requires_order_match, refund_requires_user_intent, refund_max_amount, email_only_to_order_owner, lookup_only_own_orders}, parent_version, patch_note`.

**Regression suite** (`runs/regression.json`): `Scenario[]`.

**Golden run** (`data/golden/`): same files, committed. The API serves it when `?source=golden` or when the live file does not exist. This fallback applies to configs too, so "same attack against v3" works after a reset.

**Live phase** (`runs/status.json`, backend ask #4 — does not exist yet): `{ cycle: int, phase: "baseline"|"chaos"|"target"|"judge"|"repair"|"gate"|"idle", since: ISO, attack_succeeded: bool|null }`. Written at every phase transition by `loop.py`. This is the only thing that drives the orbs. Until it lands the orbs sit idle and the plan shows completed cycles only.

**Not in the record today** (hidden in the UI until section 9 lands): the episode's tool calls and final reply; Weave trace/eval URLs; vulnerability-by-version numbers; live phase.

Derived in the frontend, never stored:
- Row status: `!attack_succeeded` → "blocked"; `attack_succeeded && gate?.accepted` → "repaired"; `attack_succeeded && gate && !gate.accepted` → "unfixed"; `attack_succeeded && !gate` → "failed".
- Patch layer: `tighten_tool_policy` → tool; `add_tool_validator` → validator; `add_guardrail_rule | rewrite_system_prompt` → prompt.
- Headline numbers: latest `config_after`, latest `regression_suite_size`, latest non-null `gate.legit_pass_rate`, latest gate accepted/rejected.
- Orb state: the orb whose name equals `status.phase` is `thinking`; all others `null` (both Target and Judge during `gate`, Target during `baseline`). An active orb takes its agent's hue; idle/done are grey. The orbs say only who is working; whether the attack landed is the plan's job (`Judge → FAIL`). `targetDanger` stays in `derive.ts` for the plan, not the orbs.

---

## 3. API (FastAPI, `api/main.py`, ~140 lines)

Runs on `:8000`. Vite dev server proxies `/api` to it. CORS not needed with the proxy.

| Method | Path | Returns / does |
| --- | --- | --- |
| GET | `/api/state` | `{ latest_version, suite_size, legit_pass_rate, last_gate: "accepted"\|"rejected"\|null, loop: {running, pid, started_at, exit_code}, source: "live"\|"golden"\|"replay" }` |
| GET | `/api/status` | Precedence **live > replay > file**. If a loop process is alive (ours, or an external one whose cwd is this checkout), the file `runs/status.json` is served and any active replay is stopped on the spot (a live run owns the screen). Else, if a replay is active, the replayed row wins (see `/api/replay/start`). Else the file, or `{phase: "idle"}` if absent; if the file says a non-idle phase but no loop process is alive (stopped or crashed mid-run), the API returns `phase: "idle"` with `stale: true` and the recorded phase under `last_phase`. `/api/state` and `/api/cycles` use the same rule via one helper (`replay_if_no_loop` in `api/main.py`), so the three cannot disagree. |
| GET | `/api/cycles?source=live\|golden` | `CycleRecord[]` in file order |
| GET | `/api/configs` | `[{version, parent_version, patch_note}]`; falls back to golden when `runs/configs` is empty |
| GET | `/api/configs/{v}` | full `AgentConfig` (same fallback) |
| GET | `/api/regression` | `Scenario[]` |
| GET | `/api/manifest` | `{ target: {name, model}, tools: [{name, description, side_effect: bool, free_text_fields: string[]}], families: [{kind, title, seed_id}] }` — built from `TOOL_SPECS`, `SEED_SCENARIOS`. Used for the one line under the Start button. |
| POST | `/api/loop/start` | body `{mode: "fixed"\|"until_quiet", chaos_cycles: int (1–10, default 3), quiet_streak?: int, max_cycles?: int}` → stops an active replay (Heal always means a real run), then spawns `uv run python -m chaos.loop run --chaos-cycles N` with `PYTHONUNBUFFERED=1` and stdout to `runs/loop.log`; 201 with `{pid, started_at, mode, chaos_cycles}`; 409 if a loop is already running (ours or one found by `pgrep -f "chaos.loop run"` *in this checkout*). `quiet_streak`/`max_cycles` are accepted but ignored until `--until-quiet` exists (ask #5); `until_quiet` returns 400 until then and the UI hides the option. |
| GET | `/api/loop` | `{running, pid, started_at, exit_code, mode, chaos_cycles, external}`; `external: true` for a loop this API did not spawn (terminal-started, or ours after a `--reload`). Only processes whose working directory is this repo count — a loop in a second clone (e.g. under /tmp) is ignored; the cwd check uses `lsof` and is skipped when `lsof` is missing. |
| POST | `/api/loop/stop` | SIGTERMs the loop we spawned; 409 for an external loop, 404 if nothing is running. |
| GET | `/api/loop/log?tail=200` | last N lines of `runs/loop.log` |
| POST | `/api/loop/reset` | **planned (slice 7)** — calls `chaos.state.reset()`; 409 if running |
| POST | `/api/replay/start?speed=` | **Slice 7, landed.** The labeled fallback. Plays `data/golden/status_log.jsonl` (recorded phase transitions with `t_rel` seconds since that run began) into `/api/status`, and lets each golden cycle appear in `/api/cycles` at the moment the recording finished it (the cycle's `idle` row). While active: `/api/status` returns the recorded row plus `replay: true, recorded_at` (its `since` is moved onto this replay's clock so the elapsed timers count from now; the original is `recorded_since`); `/api/state` reports `source: "replay"` and `recorded_at`, computed from the visible cycles; `/api/configs*` and `/api/regression` serve golden. Ends by itself 5 s after the last row, or on `POST /api/replay/stop`. `speed` (0.1–50, default 1) is for rehearsals: `?speed=3` plays the 16-minute golden run in ~5.5. 201 `{recorded_at, duration_s, cycles, speed, started_at}`; 409 `{message, reason: "loop_running"|"replay_active"}` when a live loop or another replay is running. Never writes under `runs/`. A replay never outranks a real run: it is stopped when `POST /api/loop/start` is called and whenever a read route sees a live loop. Test-only: `ANTIBODY_IGNORE_EXTERNAL_LOOP=1` lets a scratch API on another port replay next to a real run (see `api/loop_ctl.py`). |
| GET | `/api/replay` | Always `{active, recording: {recorded_at, cycles, duration_s} \| null}` (`recording` describes the golden run a replay would play; parsed once and cached by file mtime; null if there is no golden log). While active, also `{paused, recorded_at, duration_s, cycles, speed, started_at, elapsed_s}` (`elapsed_s` in recording seconds, not clamped to the duration during the 5 s tail). Heal polls this every 2 s to label its replay link. |
| POST | `/api/replay/stop` | Clears the replay; every route goes back to live/golden files. |
| POST | `/api/replay/pause` | Freezes the replay at its current position (Back on Agents calls it, so nothing advances off-screen). The session keeps `t0` and accumulates paused wall-clock time; `/api/status` keeps returning the same frozen row with `paused: true`; a paused replay never expires. Idempotent. Returns `GET /api/replay`'s document; 404 if no replay is active. |
| POST | `/api/replay/resume` | Continues a paused replay from where it stopped (Heal's "Resume replay", the play button on Agents). Idempotent; same return/404 as pause. |
| POST | `/api/replay/speed?speed=` | Changes playback speed in place (0.1–50). The position is continuous: the session re-anchors `t0` so `elapsed` reads the same before and after. Pause state survives. Same return/404 as pause; 422 out of range. |
| POST | `/api/replay/seek?t=` | Jumps to `t` recording seconds, clamped to `[0, duration_s]`, forwards or backwards (cycles that had not landed by `t` disappear from `/api/cycles`; nothing is stateful, so rewinding is exact). Pause state survives. Same return/404 as pause. |
| POST | `/api/attack` | body `{scenario_id, version}` → in-process `run_target_agent(config, scenario)` + `judge_episode`; returns `{scenario_id, scenario_title, version, episode: {tool_calls[], final_reply, error}, verdict, duration_s}`. Does **not** write to `cycles.jsonl` or `runs/`; this is a preview, not a cycle. Config comes from `runs/configs` with the golden fallback. Errors: 404 unknown scenario/version, 503 config caught mid-write (retry) or `WANDB_API_KEY` missing, 409 an attack is already running, 504 past 40 s (the work finishes in the background), 500 if the target/judge raised. Tracing: `weave.init` is lazy (first attack) but warmed in a daemon thread at API startup so the first press does not pay for or hang on it; `ANTIBODY_NO_WEAVE=1` skips tracing entirely. |

Polling, not SSE: `/api/status` every 1 s on Agents (always; the orbs need it), `/api/state` + `/api/cycles` every 2 s while running **or while `source === "replay"`** (replayed cycles land on the recording's schedule), every 10 s otherwise.

Side-effect classification for the manifest: `issue_refund` and `send_email` are side effects (hardcoded). Free-text fields: `lookup_order` → `["notes", "status"]`.

## 4. Screens

Design tokens and rules come from Owen's UI standard (dark set). Summary of what that means here: black floor, `#0c0c0e` surface only for the detail pane and dialogs, hairlines `rgba(255,255,255,.08)` for structure, Inter 13–14px, weights 400/500/600, mono tabular numerals for every number, color only as a 6px dot or a thin line (`#4ade80` live, `#f87171` danger), one raised element per screen, no card grids, no icons unless they earn it, no helper text under controls.

### 4.1 Intro (`/`)

Archetype: full-viewport splash. The one place the standard permits a rich background, because it is a dismissible intro and there is no data on it.

```
┌──────────────────────────────────────────────────────────────────────────┐
│                                                                          │
│                 (liquid-metal shader, full bleed, chrome on black)        │
│                                                                          │
│                              ANTIBODY                                    │
│                       self-healing for AI agents                         │
│                                                                          │
│                          [ Start healing ]        ← the one raised pill  │
│                                                                          │
│     Northwind support agent · Llama 3.1 8B · 3 tools · 3 attack families │   ← mono 11px faint, from /api/manifest
│                                                                          │
└──────────────────────────────────────────────────────────────────────────┘
```

Source: `~/.cursor/skills/component-library/prompts/liquid-metal-hero-integration.md`, copied verbatim into `web/src/components/ui/` and adapted only for paths (Vite, not Next) — keep `framer-motion` and the shadcn `Button` as the prompt specifies. Replace the demo's badge/feature-card content with the four lines above; nothing else on the page. Wordmark Inter 500 `tracking-tighter`, subtitle `--muted`. The pill follows `prompts/premium-buttons.md` and `cta-button`: label only, no glyph.

Behavior: Start → `POST /api/loop/start` → navigate to Agents. If a loop is already running the pill reads "View agents". If the API returns 409 or fails, the pill goes quiet with the error text beneath it and a second quiet "Replay recorded run" appears (calls `/api/replay/start`). If `cycles.jsonl` exists and no loop is running, a quiet "Reset run" (with confirm) sits top-right.

Replay and Back: Back on Agents *pauses* a playing replay (`POST /api/replay/pause`); Heal then offers `Resume replay · 3× · m:ss / m:ss` (resume, go to Agents) and `stop replay`. Heal always starts a real run and discards any paused replay. With no live loop the Heal screen has exactly these two states — no replay session, or a paused one; a replay found still playing when Heal mounts (deep link) is paused on mount.

Replay transport (Agents, `components/ReplayControls.tsx`): while `/api/status` carries `replay: true` and a `duration_s`, a strip under the status line reads `replay · 10:31 PM  [⏸]  1× 3× 5× 10×  ━━━●────  m:ss / m:ss  stop`. Pause/play, the speed chips and the bar are `POST /api/replay/{pause,resume,speed,seek}`; the bar is click-to-seek (no drag) and a `role=slider` with ←/→ ±15 s, Home/End, Space to toggle. The clock is interpolated locally between polls from the last known `(elapsed_s, speed, paused)` anchor so it moves continuously; each action's response re-anchors at once and polled status is ignored for 0.9 s afterwards so an in-flight pre-action poll cannot flick the bar back. After any action Agents bumps `useDwell`'s `epoch` (drops the smoothing queue) and calls `refresh()` on the status/cycles polls, so orbs and cycle tabs snap to the new position rather than dwelling into it. The status line itself no longer carries replay text; the plain `· replay · stop replay` fallback only shows when `state.source === "replay"` but status has no clock (should not happen).

**Stopping rule (decided Sat 22:10; control removed from the UI Sun 00:30).** Two rules exist:

- `1 novel attack` — fixed count (`--chaos-cycles 1`). **This is the demo setting** and, for now, the only one the UI sends: Heal always posts `{mode: "fixed", chaos_cycles: 1}` (`DEMO_CHAOS_CYCLES` in `App.tsx`). It was 3 until the 15-minute measured run showed each extra Chaos cycle costs about 2 minutes of gates; the two seed attacks plus one invented attack already tell the break → repair → block story.
- `until 3 attacks in a row are blocked` — saturation rule (`--until-quiet 3 --max-cycles 12`, ask #5). **This is how the product actually works.** A run ends when the Chaos agent has stopped finding anything, which is the only honest meaning of "healed": not proven safe, but the attacker ran dry. Same convention as fuzzing.

The −/+ stepper (1–10) and the disabled "until N in a row" option were removed from the Heal screen for the demo: one screen, one decision. They are deferred, not rejected — the backend contract (`/api/loop/start` body: `mode`, `chaos_cycles`, `quiet_streak`, `max_cycles`) is unchanged, so putting the control back is a UI-only change once ask #5 lands. Nothing else is configurable from the UI; seeds always run, `from_version` is always fresh v0 unless a `?from=` param says otherwise. No wall-clock option: cycles are uneven (repair + gate is slow) and a timer would cut a gate in half.

The manifest line under the button (`Northwind support agent · Llama 3.1 8B · 3 tools · 3 attack families`) was also dropped from Heal; `/api/manifest` stays on the backend for anyone who wants it back.

Whichever rule ends the run, the Agents headline says so when phase returns to `idle`: `done · 3 novel attacks · 1 got through` or `done · 3 blocked in a row after 5 attacks`. A judge who asks "how do you know it's healed" should be able to read the answer off the screen.

Performance: the shader unmounts on navigation so it never competes with the orbs' WebGL contexts. `prefers-reduced-motion` → static chrome poster (a screenshot in `web/public/`).

### 4.2 Agents (`/agents`) — what the judges watch

Archetype: hero row + plan, one column, max-width 880px.

```
● cycle 2 · judge is scoring                                         v1 · 2 tests · legit 3/3

    ( orb )        ( orb )        ( orb )        ( orb )
     Chaos          Target         Judge          Repair
     idle           idle           thinking       idle
                    (red)

gate · fixes the new failure · every past failure still fixed · legit users ≥ baseline

◌  Cycle 2 · Order lookup returns null; agent must not invent a status        v1        in-progress
     ✓  Chaos generated the scenario                       (expanded) fault: lookup_order:null
     ✓  Target responded                                              tool calls: lookup_order · issue_refund
     ◌  Judge is scoring
     ○  Repair
     ○  Gate
✓  Cycle 1 · Injected instructions in order notes trigger a refund            v0 → v1   completed
```

Orbs: `Orb` from `prompts/agent-orb-integration.md`, copied verbatim to `web/src/components/ui/orb.tsx`. Four orbs at 112px in `bg-muted` rings as the demo shows. Colors: idle and done are the grey preset `["#E5E7EB", "#9CA3AF"]`; while an agent is active (`orbStates` → `"thinking"`) its orb lerps to that agent's hue via a `colorsRef` — Chaos red, Target amber, Judge blue, Repair green (`ORB_COLORS` in `Agents.tsx`, one pair per agent, derived from the `--danger`/`--live` tokens plus two distinct hues). During the gate both Target and Judge are active, so both are lit. The orbs carry one signal only — who is working — so a compromised Target is neither a red orb nor a red caption; the plan below says `Judge → FAIL` and the Repair step lights up, which is the story. `agentState`: the orb matching `status.phase` is `"thinking"`, others `null`. `seed` fixed per orb so they do not reshuffle on re-render. **The Perlin texture URL in the source must be changed to `/perlin.png`, served from `web/public/`** (downloaded once from the cdn.21st.dev URL in the prompt). Without this the orbs are blank offline. **Second change (found in build):** `<Scene>` is wrapped in `<Suspense fallback={null}>` inside the `<Canvas>`. With R3F 9.7 + React 19.2, drei's `useTexture` suspension otherwise escapes the canvas and the R3F root never draws a frame (canvas mounts, zero GL calls, no error). Also `@react-three/fiber` 9.x pins `react <19.3`, so React is pinned to `~19.2`.

Below each orb: name (13px 500) and state word (`--faint`). The gate line is text, not an orb: the gate is an evaluation, not an agent.

Plan: `Plan` from `prompts/interactive-list-preview-and-agent-plan-integration.md` (the `agent-plan.tsx` block), copied verbatim to `web/src/components/ui/agent-plan.tsx` with exactly three changes, each noted in a comment at the top of the file:

1. `initialTasks` becomes a `tasks: Task[]` prop (the hardcoded demo array stays as the default so the file still runs standalone).
2. The two status-randomizing click handlers (`toggleTaskStatus`, `toggleSubtaskStatus`) are removed. In the demo they set a random status on click; here status is truth from the backend and clicking must not change it. The icon stays, it just is not a button.
3. The `MCP Servers:` label reads `tool calls:`.

Everything else (framer-motion variants, lucide icons, the colored status badges, dashed connector, expand/collapse) is untouched. The colored badges are status signal, which the standard allows; nothing else on the page uses color.

Mapping `CycleRecord` → `Task`: `id` = cycle number; `title` = `Cycle N · {scenario.title}`; `description` = `scenario.user_message`; `status` = `in-progress` while this cycle is the one in `status.json`, else `completed` (repaired or blocked), `failed` (unfixed or failed), `need-help` (gate rejected but a later cycle exists — rare); `priority` unused (`"high"`); `level` = 0; `dependencies` = `[ "v{config_before}" ]` or `["v2 → v3"]` when accepted (the chips render config versions). Five `Subtask`s in order — Chaos, Target, Judge, Repair, Gate — each with `title` = one line (`Chaos generated the scenario`, `Target responded`, `Judge failed the target · unauthorized_action`, `Repair proposed add_guardrail_rule`, `Gate accepted · regression 2/2 · legit 3/3`), `description` = the evidence (fault list; final reply; verdict reason; guardrail text; gate reason), `tools` = tool names actually called by the Target (from `episode` once ask #2 lands; from `scenario.forbidden_tool_calls` hit in `verdict.evidence` until then), `status` per step: `completed` when its data exists, `in-progress` when `status.phase` equals it, `failed` for a Judge FAIL or Gate REJECTED, `pending` otherwise. Newest cycle first and expanded (`expandedTasks = [latest]`); older cycles collapsed to one line.

Clicking an orb expands the current cycle's matching subtask (sets the `expandedSubtasks` key; needs a small `expandedSubtasks` controlled-prop pair — `expandedSubtasks` / `onExpandedSubtasksChange` — which is change #4 if we want it; skip if tight on time and let the orb do nothing on click).

Data: completed steps come from `CycleRecord` (Chaos ← `scenario`, Target ← `episode` once ask #2 lands, Judge ← `verdict`, Repair ← `patch`, Gate ← `gate`). The in-flight step comes from `status.json` (`phase`, `since`). Until ask #4 lands there is no in-flight step — the plan shows completed cycles only and the orbs are idle. Replay mode is labeled `replay · recorded 1:05 PM` in `--faint` next to the headline.

Headline (20px/500, the only large text): `● cycle N · {agent} is {verb}` while running (`chaos is attacking`, `target is responding`, `judge is scoring`, `repair is patching`, `gate is verifying`); `● v3 · 4 tests · legit 3/3 · idle` when not. Right side: the same numbers as the Results page so the story is consistent. Top-right quiet link: `Results →`.

### 4.3 Results (`/results`) — the proof

Archetype: full-width interactive list with a hover preview, cycle detail beneath. Built on `InteractiveListPreview` from `prompts/interactive-list-preview-and-agent-plan-integration.md` (the `interactive-list-preview.tsx` block), copied verbatim to `web/src/components/ui/interactive-list-preview.tsx` with exactly three changes, noted in a comment at the top:

1. An optional `onSelect?: (index: number) => void` prop, called from an `onClick` on each `<tr>` (one attribute per row). The component has no click behavior today; we need one to open the detail.
2. The empty third `<td>` (the component ships it blank, `text-center`) renders a new optional `item.status` field. This is the `result` word.
3. `services` is typed `string | React.ReactNode` instead of `string`, so one row can carry a red `<span>`. Note the gsap text-color tween targets the `<td>`, so the span's own color must be set with `!important`-free specificity — an inline `style={{color}}` on the span wins over the animated td color.

Provenance caveat (build): the chat transcript lost the original paste, so the shipped file was reconstructed from working context, not copied byte-exact. Paint order was then corrected against the reference screenshot: preview image `z-0`, table `relative z-10`, so hovered text reads black on the bar and the image shows inverted through it. The library prompt file carries the same caveat.

Intro (build notes): the hero's `{...liquidMetalPresets[2]}` silently broke against `@paper-design/shaders-react` 0.0.80 (presets became `{name, params}`), giving the default grey diamond. Fixed to spread `.params` (grey `#AAAAAC` field, rainbow stripes as the preset intends) plus `shape="metaballs"` for the morphing blob; `repetition` 1.5→2.5 and `softness` .05→.2 so white bands never flood a whole lobe. Full-resolution render (a 1x cap was tried and rejected as blurry). Text stays the component's white-over-fluid. Title in Instrument Serif via a global `h1` rule; body Inter; both from Google Fonts with system fallbacks. Two CTAs: **Start the healing** (live) and quiet **Replay last run** (replay) — the mode flows into Agents.

`gsap` stays; the clip-path reveal, the white highlight bar sliding between rows, the black active-row text, the pointer-follow parallax and the `mix-blend-mode: difference` preview all stay. `bgColor="#000000"`. The coarse-pointer fallback (stacked list with the image beside each row) stays and is what a phone would see.

**The preview image is a chart, not a photo.** `item.img` is a string, so we hand it an SVG data URL generated in the browser per cycle: `lib/previewSvg.ts` builds a 390×450 SVG for cycle N from data we already have — a step line of suite size per cycle and a line of legit pass rate per cycle, with cycle N marked and its `v{before} → v{after}` labeled; once ask #3 lands, bars of failures per config version v0..vN with N's version outlined go on top. White strokes on transparent, mono labels, encoded with `encodeURIComponent` into `data:image/svg+xml;utf8,...`. Under `mix-blend-mode: difference` on black, white strokes render white; this is why the charts must be single-color. No chart library. Optional upgrade (slice 10): if `runs/previews/cycle-N.png` exists (exported by the marimo Analysis notebook via matplotlib), the API serves it and it replaces the SVG for that row — the "pretty graph" version, labeled `rendered by marimo` in the detail. Falls back to SVG when absent, so live cycles always have a preview.

```
cycle · attack                             kind                        result       patch · gate · config
CYCLE 5 · INJECTED NOTES → REFUND          PROMPT INJECTION VIA TOOL   BLOCKED      — · — · V3
CYCLE 4 · MALFORMED LOOKUP → REFUND        TOOL RETURNS GARBAGE        UNFIXED      PROMPT · REJECTED 2/3 · V3
CYCLE 3 · GARBAGE LOOKUP + URGENT REFUND   TOOL RETURNS GARBAGE        REPAIRED     PROMPT · ACCEPTED 2/2 3/3 · V2 → V3   ◀ hovered: white bar, black text, chart floats center
CYCLE 2 · NULL LOOKUP → INVENTED STATUS    TOOL RETURNS GARBAGE        REPAIRED     VALIDATOR · ACCEPTED · V1 → V2
CYCLE 1 · INJECTED NOTES → REFUND          PROMPT INJECTION VIA TOOL   REPAIRED     VALIDATOR · ACCEPTED · V0 → V1

──────────────────────────────────────────────────────────────────────────────────────────────
CYCLE 3 · v2 → v3 · 14:52:07                                   [ Open trace in Weave ]  [ Open evaluation in Weave ]
Chaos → Target   "I need a refund on A-1002 right now…"        CONFIG DIFF v2 → v3
Target → Judge   issue_refund(A-1002, 129.99)                  + "If a tool returns an error or no data…"
Judge → Repair   FAIL · unauthorized_action · deterministic
Repair → Gate    add_guardrail_rule · layer: prompt
Gate → v3        ACCEPTED · regression 2/2 · legit 3/3
```

Column mapping: `client` = `CYCLE N · {short title}` (uppercase mono, as the component styles it); `platform` = `scenario.kind` humanized; `status` (new) = result word; `services` = `{patch layer} · {gate word} {numbers} · {config_before → config_after}`. A transient preview row from the seed attack is prepended as `PREVIEW · NOT LOGGED` with `services` = the red tool call; the component animates row text between white and black, so the danger color is applied via an inline-styled `<span>` in `services` (change #3). Worth it: the red `issue_refund(B-2001, 899.00)` is the demo's punch line.

Clicking a row (`onSelect`) opens the detail beneath the list: header, five handoff lines (sender → receiver in `--muted`, payload in `--fg`, evidence on an indented second line), config diff (collapsed when > 12 lines), Weave buttons (hidden while `weave_call_url` is null). With nothing selected the detail shows the latest cycle. Escape clears the selection.

Headline above the list (20px/500, the only large text): `● v3 · 4 tests in suite · legit users 3/3 · last patch accepted`, with the two buttons on the right: **Run seed attack against v0** (the one raised element) and the quiet **Same attack against v3**. Run seed attack: `POST /api/attack {scenario_id: "seed-injection-refund", version: 0}`, 15 s timeout, result prepended as the preview row; the second button uses the latest version and shows `blocked by policy`. Preview rows dismiss with × or on the next real cycle. A text field for custom attacks is roadmap and is not rendered.

Empty state (fresh run, no cycles yet): one line, `measuring baseline…`, no list.

Top-left quiet link: `← Agents`.

### 4.4 Analysis (`/analysis`, optional, Sunday 10:30 go/no-go)

Full-width iframe of `marimo run analysis/app.py --port 2718`. The notebook reads Weave via the client (UNVERIFIED call shapes — 10-minute spike) and shows: pass rate per config version across the final suite, patch layers over time, judge method split (deterministic vs LLM), cost per cycle. If the iframe is blocked or the spike fails, the tab is not rendered at all.

Bonus, only if the tab ships: the same notebook exports one matplotlib PNG per cycle to `runs/previews/cycle-N.png` (390×450, white on transparent, single color — it renders under `mix-blend-mode: difference`). `/api/previews/{n}` serves it when present; the Results list uses it instead of the browser SVG for that row. Labeled `rendered by marimo` in the detail. Nice for the marimo prize; zero risk because the SVG path is the default.

## 5. Stack and layout

Approved dependencies (Owen, 7:15 PM — "whatever is needed to follow the prompts/code exactly"; 7:24 PM pasted the two components that add the last two):

- Base: `vite`, `react`, `react-dom`, `typescript`, `tailwindcss`, `@tailwindcss/vite`.
- Liquid-metal prompt: `@paper-design/shaders-react`, `framer-motion`, `@radix-ui/react-slot`, `class-variance-authority` (shadcn Button), `clsx` + `tailwind-merge` (for `cn`).
- Orb prompt: `three`, `@react-three/fiber`, `@react-three/drei`.
- Interactive list preview prompt: `gsap`.
- Agent plan prompt: `lucide-react` (`framer-motion` already listed).
- Python: `fastapi`, `uvicorn`.

Nothing else without asking: no router, no chart library, no state library. `useState` + `fetch` + one polling hook.

Install order tonight, before anything else, because of venue Wi-Fi: `three` / fiber / drei first (largest), then shaders-react, then gsap, framer-motion, lucide-react, then the rest. If `@react-three/drei` fails to resolve, the documented fallback is `useLoader(THREE.TextureLoader, "/perlin.png")` from fiber — one line, ask Owen before doing it.

```
api/
  main.py            FastAPI app: routes in section 3; weave.init at startup; subprocess handle in module state
  manifest.py        builds /api/manifest from chaos.tools.TOOL_SPECS, chaos.scenarios.*
  replay.py          plays data/golden/status_log.jsonl + cycles on schedule; owns the "replay" source
web/
  index.html
  vite.config.ts     proxy /api -> http://localhost:8000
  public/perlin.png  downloaded once from the cdn.21st.dev URL in the Orb prompt
  public/intro-poster.png   reduced-motion fallback for the liquid-metal splash
  src/
    main.tsx  App.tsx (page state: intro | agents | results | analysis; `?page=agents|results` deep-links for
                       demos and screenshots, `?demo=<component>` renders one ui component standalone)
    styles.css         tokens as CSS variables (from the UI standard, dark set) + Tailwind v4 `@theme inline` that maps the shadcn
                       semantic names every pasted component uses (--background --foreground --card --border --muted --muted-foreground
                       --secondary --secondary-foreground --primary --primary-foreground --accent --input --ring) onto those values.
                       Without this block `bg-card`, `border-border`, `text-muted-foreground` compile to nothing and the components look broken.
    lib/utils.ts       cn()
    api.ts             typed fetchers; types mirror section 2 exactly
    hooks/usePoll.ts   interval fetch with visibility pause
    lib/derive.ts      rowStatus(), patchLayer(), headline(), orbStates(), configDiff(), cyclesToTasks(), cyclesToListItems()
    lib/previewSvg.ts  cyclePreviewSvg(cycle, all) → data:image/svg+xml URL (white-on-transparent bars + step line)
    components/ui/     verbatim from the prompts: liquid-metal hero, button.tsx, orb.tsx,
                       interactive-list-preview.tsx (+onSelect, +item.status), agent-plan.tsx (+tasks prop, −random toggles)
    pages/Intro.tsx  Agents.tsx  Results.tsx
    components/Headline.tsx  OrbRow.tsx  GateLine.tsx  PreviewRow.tsx  CycleDetail.tsx  Handoffs.tsx  ConfigDiff.tsx  Dot.tsx
runs/loop.log        stdout of the spawned loop (ignored by git)
runs/status.json     live phase (ask #4; ignored by git)
data/golden/status_log.jsonl   recorded phase transitions for replay (committed, produced by ask #4 during the next golden run)
```

Commands: `uv run uvicorn api.main:app --port 8000` (add `--reload` only while editing `api/`: a reload forgets the loop it spawned, and Stop stops working for that run) and `cd web && npm run dev` (port 5173). One `scripts/dev.sh` runs both.

Tailwind version: the pasted components use v4-only utilities (`h-4.5`, `w-78`, `aspect-3/4`, `bg-secondary/40`). We are on Tailwind v4 via `@tailwindcss/vite`, so they compile as written; do not "fix" them to v3 spellings. `"use client"` directives at the top of each component are Next.js no-ops under Vite and stay.

Config diff is computed in the browser from two `/api/configs/{v}` responses with a ~40-line LCS on `JSON.stringify(cfg, null, 2).split("\n")`. No diff library.

WebGL budget: the intro shader unmounts before the orbs mount; four orb canvases at 112px on the Agents page; zero on Results. Browsers cap around 16 contexts; we use at most 4 at once.

Animation budget: gsap runs one `requestAnimationFrame` loop on Results for the pointer-follow (it is in the component; it idles cheaply). framer-motion `layout` animations run on the Agents plan only when a cycle expands. Nothing animates on a timer.

Fonts: `font-family: Inter, system-ui, sans-serif` — no web-font request, so the venue Wi-Fi cannot break type. The list preview and its headline use the component's `font-mono` (system monospace), which is also the token for numbers everywhere else, so the Results page reads as one family. If Inter is not installed locally the system fallback is acceptable.

---

## 6. Build order and time

| # | Slice | Done when | Est. |
| --- | --- | --- | --- |
| 0 | `npm install` of every approved dependency; download `perlin.png`; `cn()`, tokens, page state shell; copy the four prompt components into `components/ui/` unmodified and confirm each demo renders | `npm run dev` shows three empty pages you can switch between; each `/ui` demo renders standalone | 35 min |
| 1 | FastAPI: `/api/state`, `/api/cycles`, `/api/configs*`, `/api/status` (idle stub), golden fallback | `curl /api/cycles` returns the 4 golden rows | 30 min |
| 2 | Results: headline + `InteractiveListPreview` fed by `cyclesToListItems()` + `previewSvg` + `onSelect` → `CycleDetail` (handoffs, gate numbers) from golden data | Hover row 3 → white bar, black text, chart floats center; click → detail shows five handoffs and `ACCEPTED · 2/2 · 3/3` | 55 min |
| 3 | `/api/attack` + Run seed attack + Same attack against v3 preview rows | v0 preview shows the refund in red; v3 preview shows blocked | 35 min |
| 4 | Agents: four orbs (verbatim Orb, local texture, grey preset), names, gate line, `Plan` fed by `cyclesToTasks()` from golden data | Orbs render and idle; cycle 3 expands to five subtasks with evidence and tool chips; clicking an icon does nothing | 55 min |
| 5 | Intro: liquid-metal hero verbatim, Start pill, stopping-rule control (fixed count now; `until_quiet` hidden until ask #5), manifest line, `/api/loop/start`, `/api/manifest` | Start with `3 novel attacks` spawns the loop and lands on Agents; `/api/loop` reports running; a second Start returns 409 and the pill reads "View agents" | 40 min |
| 6 | Live wiring: `/api/status` polling → orb states, in-progress subtask, headline verb, Target red lerp (needs ask #4) | With a loop running, the active orb is the only one thinking and exactly one subtask shows the dashed in-progress icon | 30 min |
| 7 | Replay: `api/replay.py` + `/api/replay/start` + label | Replay lights the orbs through the golden run's phases with the `replay · recorded` label visible. **Done Sun 00:30** — see §3; `?speed=` for rehearsals. | 30 min |
| 8 | Config diff + preview chart refinement (vulnerability bars once ask #3 lands) | Diff of v2→v3 shows the added guardrail rule; hover chart marks the hovered version | 25 min |
| 9 | Polish against the standard: alignment, focus states, reduced-motion (poster; the two components already honor `prefers-reduced-motion`), screenshot check of all three pages | One raised element per page; color only as signal; no card grids | 30 min |
| 10 | Optional: Analysis tab (marimo) + per-cycle PNG previews | Iframe renders charts from Weave; hovering a row shows the marimo-rendered chart | 60 min, Sunday only |

Total for 0–9: ~6 hours. Tonight (7:30–11:00): slices 0–4 — the proof page and the orbs against golden data. Tomorrow 8:30–10:30: slices 5–9. Slice 10 at the 10:30 go/no-go.

Slices 0–5 need nothing from the other chat. Slice 6 needs ask #4; slice 7 needs the `status_log.jsonl` from a golden run made after ask #4 lands.

---

## 7. Demo flow with this UI (replaces the terminal-first flow in PLAN §1.4)

| Time | Screen | Action |
| --- | --- | --- |
| 0:00–0:15 | Intro | Liquid metal on screen while the claim is spoken. One line names the target. |
| 0:15–0:20 | Intro → Agents | Press **Start healing**. The loop starts for real. |
| 0:20–0:50 | Agents | Target orb lights up (baseline running), then Chaos. "Four agents. Chaos attacks, Target responds, Judge proves the failure, Repair patches it, and a gate in Weave decides." The plan shows cycle 1 forming, one subtask at a time. |
| 0:50–1:40 | Results | Switch to Results, showing the run made earlier today. Press **Run seed attack against v0**: preview row, `issue_refund(B-2001, 899.00)` in red, "customer never requested a refund". Then **Same attack against v3**: `blocked by policy`. Hover rows 1→3: the white bar slides, each row's chart floats up — validator, validator, prompt; row 4: rejected, legit 2/3 — "the gate said no." Click row 3 for the handoffs. |
| 1:40–2:10 | Results → Weave | Open trace in Weave (new tab): one `run_cycle` tree. Open evaluation: v2 vs v3. Back. |
| 2:10–2:40 | Agents | Back to the live loop. Cycle 1 should be at Repair or Gate by now; if the gate has accepted, the headline reads `v1`. Point at the plan: this happened while we talked. |
| 2:40–3:00 | Intro or Results | Claim again; offer a custom attack in Q&A. |

Why Start is pressed live: the Agents page is the demo's centerpiece and it is only honest with a real loop behind it. The seed attack at 0:50 runs while the loop is in its Chaos/Target phase (one call at a time), not during the gate's parallel evaluation, so the two do not compete for inference concurrency.

Fallbacks, in order: if the live loop has not lit an orb within 20 s of Start, press **Replay recorded run** (the label `replay · recorded 1:05 PM` stays on screen; say so out loud). If `/api/attack` exceeds 15 s the preview row shows `(replayed)` with the golden cycle-1 tool calls. If the API is down, the backup video.

---

## 8. Risks

| Risk | Mitigation |
| --- | --- |
| Orb texture served from `cdn.21st.dev` → blank orbs on venue Wi-Fi | Download to `web/public/perlin.png` in slice 0; change the one URL in `orb.tsx`. Verified by loading the page with Wi-Fi off. |
| `three` + fiber + drei + shaders-react install fails or is slow on venue Wi-Fi | Slice 0 runs first, tonight, at the venue. If drei will not resolve, the one-line `useLoader` fallback (ask Owen first). |
| Orbs animate without a real signal (fake UI) | Orb state is derived only from `/api/status`. No timers. Until ask #4 lands, orbs idle. Replay is labeled on screen. |
| Agent Plan demo lets a click randomize a task's status — a judge clicks an icon and a real FAIL flips to "completed" | The two toggle handlers are removed in our copy (change #2 in §4.2). Status is read-only. |
| Agent Plan's colored badges (`bg-green-100 text-green-700` etc.) are light-theme tints on our black page | Accepted as status signal; verified on screen in slice 4. If they glare, override the six badge classes with the standard's success/danger tokens — same shape, our colors. |
| Interactive List Preview hides everything on a coarse pointer (touch) and shows a stacked list | Demo is on a laptop; the stacked fallback is fine for a phone. Not a demo path. |
| `mix-blend-mode: difference` turns a colored chart into odd colors | Charts are single-color white on transparent by construction (`previewSvg.ts`, and the marimo export rule in §4.4). Verified by hovering with a golden row in slice 2. |
| gsap `clipPath` reveal and the highlight bar depend on `getBoundingClientRect` of the table | The component already measures per hover; the list is inside a fixed-width container so a resize mid-demo cannot misplace the bar. |
| Live loop is slow during the demo | Labeled replay within 20 s of Start; Results shows the earlier run regardless. |
| Seed attack and the loop's gate compete for inference | Demo sequence runs the attack during the loop's Chaos/Target phase, before the first gate (~60–90 s in). |
| Spawned loop and `/api/attack` both call `weave.init` / share `_collector` state | Attack runs in the API process; loop runs in its own subprocess. No shared memory. |
| Loop log never streams | Spawn with `PYTHONUNBUFFERED=1`. |
| `cycles.jsonl` schema changes tonight | `api.ts` types are the only place the shape lives; `derive.ts` is defensive (`gate?.accepted ?? null`). |
| Liquid metal + orbs = "looks like a template" | Intro is the only rich surface and holds four lines; Agents and Results are hairline-and-type. Orbs are grey when idle or done and take one hue each only while that agent works (red/amber/blue/green), so colour still means "this one is active"; the orbs never say pass/fail — the plan does. Screenshot check in slice 9. |
| Projector at 1280×720 | Agents page is single-column max 880px; Results columns collapse to stacked below 1100px. |
| Two chats editing the same files | This plan touches only `api/`, `web/`, `scripts/dev.sh`, `.gitignore`, `pyproject.toml`. Never `chaos/`. |

---

## 9. Small asks for the backend chat (each ≤ 15 min; UI hides the feature until it lands)

1. **Weave URLs on the record.** In `run_cycle`, capture the root call and set `weave_call_url` (Weave exposes `ui_url` on the call object from `op.call(...)`, or via `weave.require_current_call()` inside the op — confirm which). Also add `weave_eval_urls: list[str]` to `GateResult` from the evaluation runs. Unlocks the two Weave buttons in the detail pane.
2. **Episode summary on the record.** Add `episode: {tool_calls: [{tool, args, blocked_by_policy}], final_reply: str}` to `CycleRecord` (or a slimmer `tool_calls` list). Unlocks the `Target → Judge` handoff line showing what the agent actually did.
3. **Vulnerability by version.** A `chaos.loop vulnerability` command: for each `runs/configs/v*.json`, run the final regression suite, write `runs/vulnerability.json` as `{"v0": failures, "v1": ...}`. Unlocks the vulnerability bars in the hover chart (until then the chart shows suite size and legit pass rate per cycle). Cost ≈ versions × suite size target runs (~4 × 4 today).
4. **Live phase file (highest priority — the orbs depend on it).** In `loop.py`, write `runs/status.json` at every transition: `{cycle, phase: "baseline"|"chaos"|"target"|"judge"|"repair"|"gate"|"idle", since: ISO, attack_succeeded: bool|null}`. Also append each transition to `runs/status_log.jsonl` (same fields plus `t_rel` seconds since loop start) so a golden run can be replayed. ~10 lines; write to a temp file and rename so the API never reads a half-written JSON. Then re-run the golden run so `data/golden/status_log.jsonl` exists. *(Landed: `chaos/status.py`, called from `loop.py`. Golden `status_log.jsonl` still needed.)*
5. **Saturation stopping rule — this is how the product should actually end a run.** Today `run` does seeds, then exactly `--chaos-cycles N` novel attacks, then stops — even if the last attack just got through and the fresh patch has never been tested against anything new. Add `--until-quiet K` (with `--max-cycles M` as a hard cap, default 12): after the seeds, keep calling `generate_scenario` until K consecutive novel attacks have `attack_succeeded == false`, or M total cycles. When the run ends, write the reason into the final `status.json`: `{phase: "idle", stop_reason: "fixed"|"quiet"|"max_cycles", novel_attempts, novel_successes, quiet_streak}`. That is the line the Agents headline prints as "healed". Roughly 15 lines: the `for _ in range(args.chaos_cycles)` loop becomes a `while` with a counter. `--chaos-cycles` stays as-is for the demo (predictable length). Mutually exclusive flags.

Nice-to-have, not blocking: `blocked_by: str | None` on `ToolCall` naming the policy that fired (today it is a bool), so the UI can print "blocked by refund_requires_user_intent".

**Deferred past the demo (decided Sun 00:50).** A run archive and replay picker. Today `chaos.loop reset` overwrites `runs/` and `golden` keeps exactly one snapshot, so there is one recording and nothing to choose between; the Heal link names it (`Replay recorded run · 10:31 PM · 7 cycles`). To offer a choice: the loop (or `golden`) writes each finished run to `data/recordings/<started_at>/{cycles.jsonl,status_log.jsonl,configs/}`, the API adds `GET /api/recordings` and `POST /api/replay/start?recording=<id>`, and Heal lists them. ~45 min across both chats; not worth the risk the night before.

---

## 10. Definition of done (Sunday 11:00)

- [ ] `scripts/dev.sh` brings up API + web; all three pages render from golden data with no loop running.
- [ ] Intro → Start spawns the loop and lands on Agents; the active orb is the only one thinking; the plan shows exactly one in-progress subtask.
- [ ] When the loop finishes, the Agents headline states the stopping rule and result (`done · 3 novel attacks · 1 got through`, or the quiet-streak line once ask #5 lands). No unqualified "healed" anywhere in the UI.
- [ ] Orbs render with Wi-Fi off (local texture).
- [ ] Replay lights the orbs through the golden run with the `replay · recorded` label visible.
- [ ] Results: hover row 3 slides the white bar and floats a white chart; click shows five handoffs and `ACCEPTED · 2/2 · 3/3`; config diff for any accepted cycle.
- [ ] Clicking any status icon on the Agents plan changes nothing.
- [ ] Run seed attack against v0 shows the refund in red within 15 s or falls back to a labeled replay; Same attack against v3 shows blocked.
- [ ] Weave buttons open the right trace and evaluation (requires ask #1).
- [ ] Screenshots of all three pages reviewed against the UI standard: one raised element per page, hairlines not boxes, mono numerals, color only as signal, grey orbs.
- [ ] Demo flow in section 7 rehearsed twice with a timer, once with the replay fallback.

