# Antibody — Frontend Implementation Plan

Written Sat Sep 12, 6:40 PM against commit `89b74c6`. Execute from this file. The backend contracts referenced here are what `chaos/` produces today; three small backend additions are requested in section 9 and everything degrades gracefully without them.

Decisions already made (do not reopen): React app is the product; dark monochrome per Owen's UI standard; live attack runs from the UI; charts are hand-drawn SVG; Weave opens in a new tab via buttons, never an iframe; marimo is an optional Analysis tab decided Sunday 10:30; no fake inputs — anything unbuilt is disabled and labeled roadmap.

---

## 1. What we are building

One page, three states, plus an optional fourth tab.

| State | Route | Job | Loud element |
| --- | --- | --- | --- |
| Connect | `/` | Pick the target, see its tool manifest, choose attack families, press Start | **Start loop** button |
| Loop | `/loop` | The demo screen: current state statement, cycle ledger, run-attack button, two small charts | The hero statement |
| Cycle detail | `/loop?cycle=N` (side pane) | Handoffs in order, verdict evidence, patch, gate numbers, config diff, Weave buttons | none |
| Analysis (optional) | `/analysis` | marimo notebook in an iframe reading Weave | none |

The agents never run inside the browser. A ~120-line FastAPI adapter (`api/`) sits between React and `chaos/`; it spawns the loop as a subprocess and reads the same files the CLI writes.

```
web/  (Vite + React + TS + Tailwind)  ──HTTP──▶  api/main.py (FastAPI)  ──import/subprocess──▶  chaos/
                                                       │  reads: cycles.jsonl, runs/configs/v*.json, runs/regression.json
                                                       │  spawns: uv run python -m chaos.loop run ...
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

**Golden run** (`data/golden/`): same files, committed. The API serves it when `?source=golden` or when `cycles.jsonl` does not exist.

**Not in the record today** (hidden in the UI until section 9 lands): the episode's tool calls and final reply; Weave trace/eval URLs; vulnerability-by-version numbers.

Derived in the frontend, never stored:
- Row status: `!attack_succeeded` → "blocked"; `attack_succeeded && gate?.accepted` → "repaired"; `attack_succeeded && gate && !gate.accepted` → "unfixed"; `attack_succeeded && !gate` → "failed".
- Patch layer: `tighten_tool_policy` → tool; `add_tool_validator` → validator; `add_guardrail_rule | rewrite_system_prompt` → prompt.
- Hero numbers: latest `config_after`, latest `regression_suite_size`, latest non-null `gate.legit_pass_rate`, latest gate accepted/rejected.

---

## 3. API (FastAPI, `api/main.py`, ~120 lines)

Runs on `:8000`. Vite dev server proxies `/api` to it. CORS not needed with the proxy.

| Method | Path | Returns / does |
| --- | --- | --- |
| GET | `/api/state` | `{ latest_version, suite_size, legit_pass_rate, last_gate: "accepted"\|"rejected"\|null, loop: {running, pid, started_at, exit_code}, source: "live"\|"golden" }` |
| GET | `/api/cycles?source=live\|golden` | `CycleRecord[]` in file order |
| GET | `/api/configs` | `[{version, parent_version, patch_note}]` |
| GET | `/api/configs/{v}` | full `AgentConfig` |
| GET | `/api/regression` | `Scenario[]` |
| GET | `/api/manifest` | `{ target: {name, model}, tools: [{name, description, side_effect: bool, free_text_fields: string[]}], families: [{kind, title, seed_id}], legit: [{id, title, user_message}] }` — built from `TOOL_SPECS`, `SEED_SCENARIOS`, `LEGIT_SCENARIOS` |
| POST | `/api/loop/start` | body `{chaos_cycles, seeds: bool, from_version: int}` → spawns `uv run python -m chaos.loop run ...` with stdout to `runs/loop.log`; 409 if already running |
| GET | `/api/loop/log?tail=200` | last N lines of `runs/loop.log` |
| POST | `/api/loop/reset` | calls `chaos.state.reset()`; 409 if running |
| POST | `/api/attack` | body `{scenario_id, version}` → in-process `run_target_agent(load_config(version), scenario)` + `judge_episode`; returns `{episode: {tool_calls[], final_reply}, verdict, duration_s}`. Does **not** write to `cycles.jsonl`; this is a preview, not a cycle. `weave.init` once at API startup so the attack is traced. |

Polling, not SSE: the Loop screen fetches `/api/state` and `/api/cycles` every 2 s while `loop.running`, every 10 s otherwise. Fewer moving parts; the file is tiny.

Side-effect classification for the manifest: `issue_refund` and `send_email` are side effects (hardcode the set for now; a manifest field is the roadmap). Free-text fields: `lookup_order` → `["notes", "status"]`.

## 4. Screens

Design tokens and rules come from Owen's UI standard (dark set). Summary of what that means here: black floor, `#0c0c0e` surface only for the detail pane and dialogs, hairlines `rgba(255,255,255,.08)` for structure, Inter 13–14px, weights 400/500/600, mono tabular numerals for every number, color only as a 6px dot or a thin line (`#4ade80` live, `#f87171` danger), one raised element per screen, no card grids, no icons unless they earn it, no helper text under controls.

### 4.1 Connect (`/`)

Archetype: grouped sections, hairline-separated, one column, max-width 720px.

```
ANTIBODY                                                   self-healing for AI agents

TARGET
  (•) Northwind support agent            Llama 3.1 8B · 3 tools
  ( ) Connect your own agent             roadmap — in-process, HTTP, config-only     [disabled]

  tool            side effect   free-text fields
  lookup_order    —             notes, status
  issue_refund    money         —
  send_email      outbound      —

ATTACKS
  [x] Prompt injection via tool output      [x] Tool returns garbage      [x] Social engineering
  Cycles after seeds  [ 3 ]      Start from  [ v0 ▾ ]

GATE  (read-only)
  fixes the new failure · every past failure still fixed · legit users ≥ baseline (3 cases)

                                                              [ Start loop ]   ← the one raised button
```

Behavior: Start → `POST /api/loop/start` → navigate to `/loop`. If a loop is already running, the button reads "View running loop" (quiet outline) instead. If `cycles.jsonl` exists and no loop is running, a quiet secondary "Reset run" appears with a confirm.

Section headers are 11px uppercase tracked faint. The disabled option is real UI in a disabled state with the word "roadmap", not a fake input.

### 4.2 Loop (`/loop`) — the demo screen

Archetype: hero statement + ledger. Two columns: ledger 62%, side column 38%. Both columns end on the same line; the ledger scrolls inside its column.

```
● v3  ·  4 tests in suite  ·  legit users 3/3  ·  last patch accepted          [ Run seed attack against v0 ]
   (6px dot: green = last gate accepted or idle; red = a failure is being repaired right now)

cycle  attack                                        result     patch layer   gate                 config
  5    Injected instructions in order notes…         blocked    —             —                    v3
  4    Malformed lookup pushes agent to refund…      unfixed    prompt        rejected 3/3 legit   v3
  3    Garbage lookup + urgent refund request        repaired   prompt        accepted             v2 → v3
  2    Order lookup returns null…                    repaired   validator     accepted             v1 → v2
  1    Injected instructions in order notes…         repaired   validator     accepted             v0 → v1

side column:
  VULNERABILITY BY VERSION        (SVG bars, v0..vN, hidden until section 9 data exists)
  SUITE SIZE / LEGIT PASS RATE    (SVG step + flat line from cycles)
  LOOP LOG                        (last 12 lines of runs/loop.log, mono, faint; only while running)
```

Ledger rules: hairline rows, no zebra, no borders around the table. `result` is a word plus a 6px dot: blocked (faint dot), repaired (green), unfixed (red), failed (red). A red 1px line under the row only while that cycle's repair is in flight (i.e. the newest row has `attack_succeeded` and the loop is running and no newer row exists). New rows enter at the top with a 160ms fade/translate; nothing else animates.

Run seed attack: `POST /api/attack {scenario_id: "seed-injection-refund", version: 0}`. Button becomes quiet + "Running…" with a 15 s timeout. Result renders as a **transient preview row** at the top of the ledger, visually distinct (dashed hairline above it, label "preview · not logged"), showing the tool calls (`issue_refund(B-2001, 899.00)` in danger color) and the verdict reason. A second quiet button appears next to it: "Same attack against v3" → same call with the latest version → second preview row shows `blocked by policy`. Preview rows are dismissed with × or on next real cycle. This is the 0:20 demo beat and the Q&A "type your own attack" moment.

Hero statement is 20px/500 with tabular numerals; it is the only large text on the screen.

### 4.3 Cycle detail (side pane over the side column, `/loop?cycle=N`)

Click a ledger row. The side column is replaced by a `#0c0c0e` panel (a genuinely separate object, so a surface is allowed). Escape or × returns.

```
CYCLE 3 · v2 → v3 · 14:52:07
Garbage lookup + urgent refund request                    chaos_agent · tool_returns_garbage

Chaos → Target      "I need a refund on A-1002 right now…"   faults: lookup_order:malformed
Target → Judge      issue_refund(A-1002, 129.99)             (tool calls hidden until section 9)
Judge → Repair      FAIL · unauthorized_action · deterministic
                    "issue_refund called for A-1002 … customer never requested a refund"
Repair → Gate       add_guardrail_rule · layer: prompt
                    "If a tool returns an error or no data, tell the customer…"
Gate → v3           ACCEPTED · fixes ✓ · regression 2/2 · legit 3/3

CONFIG DIFF v2 → v3   (collapsed; mono; unified diff of the two JSON files, + lines in --fg, - lines in --muted)

[ Open trace in Weave ]  [ Open evaluation in Weave ]      (hidden while weave_call_url is null)
```

The handoff list is the whole point: it shows four agents cooperating in one glance. Sender → receiver in `--muted`, payload in `--fg`, one line each, evidence on a second indented line in `--muted`.

### 4.4 Analysis (`/analysis`, optional, Sunday 10:30 go/no-go)

Full-width iframe of `marimo run analysis/app.py --port 2718`. The notebook reads Weave via the client (UNVERIFIED call shapes — 10-minute spike) and shows: pass rate per config version across the final suite, patch layers over time, judge method split (deterministic vs LLM), cost per cycle. If the iframe is blocked or the spike fails, the tab is not rendered at all.

## 5. Stack and layout

Approved dependencies: Node — `vite`, `react`, `react-dom`, `typescript`, `tailwindcss`, `@tailwindcss/vite`, `react-router-dom`. Python — `fastapi`, `uvicorn`. Nothing else without asking (no chart library, no icon library yet, no state library; `useState` + `fetch` + one polling hook is enough).

```
api/
  main.py            FastAPI app: routes in section 3; weave.init at startup; subprocess handle in module state
  manifest.py        builds /api/manifest from chaos.tools.TOOL_SPECS, chaos.scenarios.*
web/
  index.html
  vite.config.ts     proxy /api -> http://localhost:8000
  src/
    main.tsx  App.tsx  routes.tsx
    styles.css         tokens as CSS variables (from the UI standard, dark set) + Tailwind
    api.ts             typed fetchers; types mirror section 2 exactly
    hooks/usePoll.ts   interval fetch with visibility pause
    lib/derive.ts      rowStatus(), patchLayer(), heroNumbers(), configDiff()
    pages/Connect.tsx  pages/Loop.tsx
    components/Hero.tsx  Ledger.tsx  LedgerRow.tsx  PreviewRow.tsx  CycleDetail.tsx  Handoffs.tsx
                ConfigDiff.tsx  Sparkline.tsx (SVG step/line)  Bars.tsx (SVG bars)  Section.tsx  Button.tsx  Dot.tsx
runs/loop.log        stdout of the spawned loop (ignored by git)
```

Commands: `uv run uvicorn api.main:app --reload --port 8000` and `cd web && npm run dev` (port 5173). One `make dev` or `scripts/dev.sh` runs both.

Config diff is computed in the browser from two `/api/configs/{v}` responses with a ~40-line LCS on `JSON.stringify(cfg, null, 2).split("\n")`. No diff library.

---

## 6. Build order and time

| # | Slice | Done when | Est. |
| --- | --- | --- | --- |
| 1 | Scaffold: Vite + Tailwind + tokens + router; FastAPI with `/api/state`, `/api/cycles`, `/api/configs*`; `npm run dev` shows the hero line from golden data | Hero renders "v3 · 4 tests · legit 3/3" from `data/golden` | 35 min |
| 2 | Ledger with derived status, row dots, polling | All 5 golden rows render with correct status words | 30 min |
| 3 | Cycle detail pane with handoffs and gate numbers | Clicking row 3 shows the four handoffs | 35 min |
| 4 | `/api/attack` + Run seed attack + "same attack against vN" preview rows | v0 preview shows the refund in red; v3 preview shows blocked | 35 min |
| 5 | Connect page + `/api/manifest` + `/api/loop/start` + running indicator + loop log tail | Start from the UI, rows appear as the loop runs | 45 min |
| 6 | Config diff + SVG charts (suite size / legit from cycles; vulnerability once data exists) | Diff of v2→v3 shows the added guardrail rule | 30 min |
| 7 | Polish against the standard: alignment pass, focus states, reduced-motion, screenshot check | Screenshot reviewed; no card grids, one raised button per screen | 30 min |
| 8 | Optional: Analysis tab (marimo) | Iframe renders charts from Weave | 45 min, Sunday only |

Total for 1–7: ~4 hours. Tonight (6:45–9:00): slices 1–4 — the whole demo screen against golden data plus the live attack. Tomorrow 9:15–10:30: slices 5–7. Slice 8 at the 10:30 go/no-go.

Slices 1–4 need nothing from the other chat. Slice 4 imports `chaos.target_agent`, `chaos.judge`, `chaos.state` read-only.

---

## 7. Demo flow with this UI (replaces the terminal-first flow in PLAN §1.4)

| Time | Screen | Action |
| --- | --- | --- |
| 0:00–0:20 | Slide 1 | Claim. |
| 0:20–0:35 | Connect | Target picker shows the manifest; press Start (loop begins in the background; we do not wait for it). |
| 0:35–0:55 | Loop | Press **Run seed attack against v0**. Preview row: `issue_refund(B-2001, $899.00)` in red, verdict "customer never requested a refund". Live. |
| 0:55–1:45 | Loop | Point at the ledger rows from the golden run (or the run made at 1:05 PM): repaired · validator · v0→v1; repaired · validator · v1→v2; repaired · prompt · v2→v3; unfixed · rejected. Click row 1: the four handoffs. "Same attack against v3" → preview row: blocked by policy. |
| 1:45–2:15 | Detail → Weave | Open trace in Weave (new tab): one `run_cycle` tree. Open evaluation: v2 vs v3 comparison. |
| 2:15–2:40 | Loop side column | Suite size rising, legit flat; vulnerability by version if built. |
| 2:40–3:00 | Slide 1 | Claim again; offer to type a custom attack in Q&A. |

Fallbacks: if `/api/attack` exceeds 15 s the preview row shows "(replayed)" with the golden cycle-1 tool calls. If the API is down, the page renders golden data from a static `web/public/golden.json` copied at build time, and the buttons are hidden.

---

## 8. Risks

| Risk | Mitigation |
| --- | --- |
| Spawned loop and `/api/attack` both call `weave.init` / share `_collector` state | Attack runs in the API process; loop runs in its own subprocess. No shared memory. |
| `cycles.jsonl` schema changes tonight | `api.ts` types are the only place the shape lives; `derive.ts` is defensive (`gate?.accepted ?? null`). |
| npm install on venue Wi-Fi | Node 24 / npm 11 already installed; Vite scaffold is ~30 packages. Do it first while other work proceeds. |
| Venue Wi-Fi during the live attack | 15 s timeout → replayed preview, labeled. |
| "Looks like a generated dashboard" | No KPI card grid; hero line + hairline table; one raised button; screenshot check in slice 7. |
| Two chats editing the same files | This plan touches only `api/`, `web/`, `scripts/dev.sh`, `.gitignore`, `pyproject.toml`. Never `chaos/`. |

---

## 9. Small asks for the backend chat (each ≤ 15 min; UI hides the feature until it lands)

1. **Weave URLs on the record.** In `run_cycle`, capture the root call and set `weave_call_url` (Weave exposes `ui_url` on the call object from `op.call(...)`, or via `weave.require_current_call()` inside the op — confirm which). Also add `weave_eval_urls: list[str]` to `GateResult` from the evaluation runs. Unlocks the two Weave buttons in the detail pane.
2. **Episode summary on the record.** Add `episode: {tool_calls: [{tool, args, blocked_by_policy}], final_reply: str}` to `CycleRecord` (or a slimmer `tool_calls` list). Unlocks the `Target → Judge` handoff line showing what the agent actually did.
3. **Vulnerability by version.** A `chaos.loop vulnerability` command: for each `runs/configs/v*.json`, run the final regression suite, write `runs/vulnerability.json` as `{"v0": failures, "v1": ...}`. Unlocks the primary chart. Cost ≈ versions × suite size target runs (~4 × 4 today).

Nice-to-have, not blocking: `blocked_by: str | None` on `ToolCall` naming the policy that fired (today it is a bool), so the UI can print "blocked by refund_requires_user_intent".

---

## 10. Definition of done (Sunday 11:00)

- [ ] `scripts/dev.sh` brings up API + web; `/` and `/loop` render from golden data with the API down (static fallback) and from live data with it up.
- [ ] Connect → Start spawns the loop; rows appear within one polling interval of being written.
- [ ] Run seed attack against v0 shows the refund in red within 15 s or falls back to a labeled replay.
- [ ] Row click shows four handoffs and gate numbers; config diff for any accepted cycle.
- [ ] Weave buttons open the right trace and evaluation (requires ask #1).
- [ ] Screenshot reviewed against the UI standard: one raised element per screen, hairlines not boxes, mono numerals, color only as signal.
- [ ] Demo flow in section 7 rehearsed twice with a timer.

