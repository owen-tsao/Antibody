# Plan 11 — Results you can compare, a review inbox, schedule avatars, and Weave done properly

Written Sep 27, 2026, 01:15. Scope Owen asked for: (a) a screen that shows actual results and compares agent
versions; (b) Review as inbox → editor with back/next, not "stuck on one run"; (c) schedule nodes carry the agent's
avatar, not monograms; (d) every Weave suggestion from the Sep 27 list. Constraints: no new dependency (so **ruff is
not added** — asked twice, no answer; the dependency rule stands), no commits, no questions. Submission is Tue
Sep 29 midnight PT; judges weigh code quality and resilience over polish, so every item below must land with tests
and without adding concepts.

## 0. Facts this plan rests on (verified Sep 27 unless marked)

- `weave 0.53.9` is installed and exposes `weave.thread`, `weave.StringPrompt`, `WeaveClient.add_cost` /
  `query_costs`, `Call.apply_scorer`, `call.feedback.add / add_note / add_reaction`, and
  `weave.flow.leaderboard.Leaderboard` with `LeaderboardColumn(evaluation_object_ref, scorer_name,
  summary_metric_path, should_minimize)`. (Checked by import in the project venv.)
- Weave usage today: 22 `@weave.op`s; `weave.Evaluation` per gate leg with `judge_scorer` (`chaos/evals.py:61,133`);
  `TargetAgent(weave.Model)` per config version (`evals.py:27`); `publish_dataset` for regression/legit suites
  (`evals.py:81`); `weave_eval_urls` on cycle records (`chaos/schemas.py:466`); `weave.init(ENTITY_PROJECT)` in
  `chaos/loop.py:445`; project `owentsao23-clad-labs/chaos-monkey` (`chaos/config.py:15`). Cost today is estimated
  from a price table in `chaos/config.py` (lane 6).
- `vulnerability_by_version(samples, versions)` exists in `chaos/loop.py:607` and is reachable only as the CLI
  command `vulnerability` (`:447`). `GET /api/state` returns `vulnerability` (`api/main.py:315`) and Home shows
  "not measured" when it is null. There is **no API route** that runs it; `api/loop_ctl.py` spawns only `run`.
  Gate results per version (`fix_passes/fix_samples`, `regression_pass_rate`, `legit_pass_rate`, `legit_covered`,
  `cost_usd`, `latency_ms`) are already on every cycle record — free, no inference.
- Review page: tree scoped by the sidebar's "agent to attack" switcher (`web/src/pages/Review.tsx`); tabs are
  `(run, version, file)` records (`lib/derive.ts` `ReviewTab`); `decisionLabel` marks archived runs; decisions are
  `POST /api/configs/{v}/review` **live only**. Routes in `lib/routes.ts`; `Shell.tsx` nav is positional.
- `AgentTile` in `web/src/components/AgentCard.tsx` renders the agent's photo small with the per-agent hue
  (`agentHueRotate`); `Schedules.tsx` nodes are 28 px `MetalFrame` orbs with `monogram(name)`; `TimelineItem` has
  no `icon` field any more (ui-7).
- Home's "Needs attention" = cycles whose attack landed and no fix was accepted (`attentionWhy` in derive.ts).
  A pending version is a different thing (a decision to make). Keep them distinct.
- Tests: 480 keyless (`conftest` isolates `runs/` and disables dotenv). Build/lint clean.

## 1. Results: the version comparison matrix (Run page)

**Where.** The Run page's results view (`web/src/components/RunResults.tsx`) — not a new nav item. While a run is
live the orbs stay above it; when finished, this is the page.

**Shape.** Columns = versions v0…vN (certified marked with the existing `ReviewMark`; "all" rail stays for the
cycle list below). Two row groups:
1. **Gate numbers per version (free, always shown):** fixed k/k, regression pass, legit pass · coverage, cost,
   p50 latency, and the decision (pending/approved/rejected). Source: cycle records + approvals, already fetched.
2. **Attack matrix (measured):** rows = every attack the run produced (seed + chaos), grouped by family; cell =
   landed / blocked / not measured for that version. Source: `vulnerability` (`{version: {scenario_id:
   landed_bool}}` — confirm the exact shape in `store.read_vulnerability` and `vulnerability_by_version`).
   When null, the group shows one quiet line — "Not measured for this run" — and a **Measure** action.

**Measure action.** `POST /api/runs/{id}/measure` → `loop_ctl` spawns `python -m chaos.loop vulnerability` for
that run (live only; history runs are read-only — the button is disabled with a title saying so). Same guard as
Heal (refuses while a loop runs; needs the key). Cost shown before the click: `attacks × versions × samples` model
calls, estimated from the run's own `cost_usd` per episode; wording "about $0.40 · ~6 min". Progress via the existing
status line (`set_phase(..., measuring="vulnerability")` already exists). `loop_ctl` gains a `command` field
(`run | vulnerability`) rather than a second spawner — extend, don't fork.

**Cell click** → the cycle for that attack (existing route). Row hover shows the attack's title. Keyboard: the
matrix is a real `<table>` with `scope`d headers; no ARIA grid needed.

**derive.ts:** `versionColumns(run, approvals)`, `matrixRows(cycles, vulnerability)`, `measureEstimate(run)`,
`matrixCell(...)` — pure, docstringed. `api.ts`: `runsMeasure(id)` fetcher; `RunRow.vulnerability` type tightened
to the confirmed shape.

**Leaderboard tie-in (Weave item 3).** The same numbers publish to a Weave Leaderboard per run (§4.3). The matrix
header carries a "Open in Weave" link to it when the URL is known.

## 2. Review: inbox → editor

**Index `/app/review`.** One row per agent (all agents from `GET /api/agents`, not the sidebar's selected one),
expandable, pending count badge. Inside: pending versions of that agent's runs, newest first — `v1 · fixes cycle 6 ·
Timeout on lookup · held 2/2 · legit 4/10 · 3 d ago`; live-run versions first (they are the only ones that can be
decided), archived ones after with `archived` in `--faint`. "Show decided" toggle per agent, off by default. Agents
with nothing pending collapse to one quiet line ("nothing to review"). Data: `api.runs()` + per-run
`api.approvals(source)` + `api.cycles(source)` — reuse what `Review.tsx` reads today, lifted into a `reviewInbox
(agents, runs, approvalsByRun, cyclesByRun)` derive function. Fetch in parallel; the poll is one `usePoll`.

**Editor `/app/review/:run/:version`.** The existing two-pane page, with: a breadcrumb `Review / <agent> / v1`
whose first crumb is the back link; `← prev` / `next →` **pending** arrows in the header strip (order = the inbox
order; disabled at the ends with a title); the tree stays scoped to that agent. The sidebar switcher no longer
drives this page; the editor derives its agent from the run. `?run=&v=` deep links redirect to the new route.

**Distinction kept.** The inbox lists decisions to make. Cycles that landed with no accepted fix stay on Home
("Needs attention") and the Run page; the inbox does not repeat them.

**Routes:** `review()` → index, `reviewVersion(run, v)` → editor; `Shell` nav unchanged (Review item points at
the index). `RunResults`' "Review this version →" links to the editor route.

## 3. Schedules: agent avatars in the orbs

Each node is the agent's photo (`AgentTile`'s image + hue) inside the existing 28 px `MetalFrame` ring — the
schedule's agent from `schedule.agent` → agent row. Label below, two lines: agent name (or schedule name when it
differs) and the trigger in words. Paused = 40 % + hairline ring; running = rim dot (unchanged). `monogram()` is
deleted with its tests. If the agent row is missing (deleted agent), fall back to a plain orb with the schedule's
name below — never a broken image.

## 4. Weave, in build order

Every item extends `chaos/evals.py` / `chaos/config.py` / `chaos/loop.py`; none adds a dependency; each is
guarded so keyless tests never touch the network (they already monkeypatch `weave.init`; follow `conftest`).

1. **Threads.** `run_episode` (both targets) runs inside `weave.thread(session_id)`; the tool server and gateway
   open `weave.thread(session_header)` around each tool call so an external agent's tool calls join the episode's
   thread. Fixes the README caveat "tool calls appear as root traces" — delete that sentence when verified in the
   Weave UI (manual check with the key).
2. **Native cost.** At `weave.init`, `client.add_cost(llm_id, prompt_token_cost, completion_token_cost)` for the
   five models (target, chaos, repair, judge, airline example's Qwen) from the existing price table — the table
   moves out of our arithmetic and becomes Weave's. `CycleRecord.cost_usd` is read from the call summary
   (`call.summary["weave"]["costs"]`, confirm key) with the local estimate as fallback when Weave is unavailable
   (`ANTIBODY_NO_WEAVE`). One source of truth; the fallback is labelled `estimated` in the API.
3. **Leaderboard.** At the end of a run (and on `check`), publish `Leaderboard(name=f"antibody-{run_id}",
   columns=[gate-new pass, gate-regression pass, gate-legit pass, cost (minimize)])` over the gate Evaluations of
   each version; store the ref/URL in `run.json` (`weave_leaderboard_url`) and expose it in the run manifest. The
   matrix header (§1) links to it.
4. **Gateway calls scored in Weave — opt-in.** `ANTIBODY_GATEWAY_WEAVE=1` (default off; a customer's gateway never
   phones home unless asked): the gateway `weave.init`s, each forwarded call is an op inside the session's thread,
   and the rule check is applied with `call.apply_scorer(ToolRuleScorer)` — a `weave.Scorer` wrapping
   `tool_rule_blocks` — so every production call carries a stored pass/block score in feedback. Shadow mode scores
   without blocking, which is exactly Weave's "guardrails double as monitors". The scorer is deterministic; the
   README says so.
5. **Prompts as objects.** `AgentConfig.system_prompt` and `JUDGE_SYSTEM` published as `weave.StringPrompt`
   (versioned by content) when a config is saved / the judge is first called; the eval's Model references the prompt
   ref. Sandbox-only value; small.
6. **Human decisions as feedback.** `review_config` (approve/reject) adds `add_reaction("👍"/"👎")` and
   `add_note(reason)` to the gate-new Evaluation call of that version (`weave_eval_urls[0]` → call id; confirm how
   to resolve a URL to a call — store the call id on the cycle record alongside the URL instead of parsing).
   Fails soft: a Weave error never blocks the decision.
7. **Monitor on the judge (UI, no code).** Documented in `docs/SMOKE.md` as a one-time setup: op `judge_scorer`,
   sampling 20 %, judge model a W&B Inference model, prompt "given the typed facts, was this verdict justified?",
   JSON response. Owen does this in the Weave UI; the plan records the exact fields.

README gets a "How Antibody uses Weave" section listing 1–7 as they land, in plain language, with the project link.

## 5. Lanes and order

Files barely overlap, so three lanes run in parallel after the plan review, then one review lane:

- **Lane A — backend Weave (§4.1–4.6) + measure route (§1 backend).** `chaos/evals.py`, `chaos/loop.py`,
  `chaos/config.py`, `chaos/gateway.py`, `chaos/toolserver.py`, `chaos/target.py`, `api/loop_ctl.py`,
  `api/main.py` (thin routes), `api/store.py`, tests. Contracts for the frontend: `POST /api/runs/{id}/measure` →
  `202 {started: true}` / `409` (loop busy) / `403` (history); run manifest `+ weave_leaderboard_url: string | null`,
  `+ cost_source: "weave" | "estimated"`; cycle record unchanged.
- **Lane B — frontend results + review (§1 UI, §2).** `web/` only; codes against the contracts; degrades when a field
  is absent.
- **Lane C — schedules avatars (§3) + README Weave section + SMOKE monitor recipe (§4.7).** `Schedules.tsx`,
  `radial-orbital-timeline.tsx`, `derive.ts` (delete `monogram`), `README.md`, `docs/SMOKE.md`. Tiny; runs first
  and finishes early.
- **Lane R — deep review** of all three (correctness, security of the opt-in gateway Weave path — no token or
  backend auth may reach Weave attributes; code quality; browser walk), then fixes, then final verify.

Definition of done: 480+ tests green keyless; build/lint clean; a real run (key) shows an episode thread with tool
calls nested, a leaderboard URL in `run.json`, cost from Weave on cycles; the Run page shows the matrix with the
free rows and the Measure action; the Review inbox lists pending versions per agent and the editor has back/next;
Schedules shows agent photos; README's Weave section matches what exists. No commits.

## 7. Changes after the independent review (Sep 27, 01:35 — `handoffs/review-plan-11.md`)

Accepted, with these amendments to the sections above. Where the review said "defer", the item is kept only in the
reduced, verified form written here; the lanes build **this section** where it conflicts with §1–§4.

- **§1 matrix data.** `read_vulnerability` returns per-version *counts* on `State` (`{"landed": {"v0": 8, "v4": 5},
  "suite_size": 8, "world": …}`); per-attack booleans live in `vulnerability_detail.json`. Lane A adds an optional
  `by_attack: {scenario_id: {"v0": bool, …}}` key to that same payload (from the detail file) — no new field
  elsewhere; the frontend renders counts when `by_attack` is absent.
- **§1 Measure.** `vulnerability_by_version` reads the live `runs/` paths only and `loop.main()` inits Weave
  unconditionally, so Measure is **live-run only** and needs the key (same refusals as Heal). Implemented as
  `LoopStartBody.mode: "run" | "vulnerability"` on the existing spawner — no new route, no second spawner; the UI
  calls `loopStart({mode: "vulnerability"})`. Progress is the existing boolean `measuring` flag plus the status
  line; the UI shows "measuring…" and refreshes when the loop exits. No fake progress bar.
- **§2 inbox data.** Today's Review read is 3N+1 requests per poll. Lane A adds `GET /api/review/inbox` computed in
  `api/store.py`: `[{agent: AgentRow-lite, pending: [{run, run_started, live, version, cycle, title, gate:
  {fix_passes, fix_samples, legit_pass_rate, legit_covered}, decided_at: null}], decided: [...same shape with
  status]}]`. One poll, one fetcher.
- **§4.1 cost.** `add_cost` takes USD **per token**; our table is per million — divide by 1e6. Whether W&B
  Inference's response `model` string equals the request id (needed for `llm_id` matching) is unknown: lane A makes
  one live call with the key, records the answer, and keys `add_cost` on the string that actually comes back.
  Cost source labelled `weave | estimated` on the run manifest.
- **§4.2 threads, corrected.** `weave.thread(thread_id)` groups calls as *turns* of one Thread; nesting comes only
  from the in-process call stack and there is no cross-process propagation. So: the episode's calls are one turn
  and each tool call from the tool server / gateway (same `thread_id` from `X-Antibody-Session`) is a sibling turn
  in the same Thread. Acceptance: the Weave Threads view shows one thread per episode containing the target's turn
  and its tool turns. README sentence changes from "nested under" to "grouped in one thread with".
- **§4.3 leaderboard, reduced.** A Leaderboard needs one Evaluation object ref shared across versions. Only the
  legit suite is fixed within a run, so: publish **one** `weave.Evaluation` for the legit suite at run start, reuse
  it for every gate's legit leg, and publish a Leaderboard with one column (legit pass rate per version Model).
  Regression legs stay per-cycle (the suite grows) and are not on the board. Honest, small, still a real
  Leaderboard.
- **§4.4 gateway → Weave, guarded.** Kept, opt-in (`ANTIBODY_GATEWAY_WEAVE=1` **and** a key present), with the exact
  guard from the review: the traced op takes primitives only — `(tool: str, args: dict, decision: str, elapsed_ms)`
  — never the session, request, headers, `backend_auth` or `X-Antibody-Customer`; a test asserts the op's captured
  inputs contain none of those strings when the env carries a fake bearer. If lane A cannot make that test airtight,
  the item is dropped and the report says why.
- **§4.5 prompts.** Publishing moves to `chaos/loop.py` (the only process that inits Weave); `save_config` stays
  Weave-free so the API process and keyless tests never touch it.
- **§4.6 decisions as feedback.** The API process does warm Weave in `api/attack.py:130` (the review's "never inits"
  is to be re-checked by lane A). If a client exists at decision time, `review_config` adds a reaction + note to the
  version's gate-new Evaluation call (call id stored on the cycle record at eval time); otherwise it skips silently.
  Never blocks the decision; test both branches.
- **§0 nits.** `AgentTile` lives in `web/src/components/AgentTile.tsx`; there is no web test runner (nothing to
  delete with `monogram`); keyless tests are offline because nothing in `api/` inits Weave — lane A must keep it so.
- **Cut:** nothing else. Ruff remains out (dependency).

## 6. Self-review (before the independent pass)

- *Does §1 add a concept?* No — it replaces the version rail's cells with a table and gives the existing
  `vulnerability` file a UI. The Measure route reuses the loop spawner.
- *Does §2 add a route?* One (`reviewVersion`). It removes the misuse of the global switcher, a net simplification.
- *Weave 4 risk:* a customer gateway calling Weave. Opt-in env var, documented, and the scorer sees only tool name,
  args (already logged locally) and decision — never headers. Reviewer must confirm.
- *Weave 2 risk:* `call.summary` cost key may differ by version; fallback path keeps cycles populated either way.
- *Weave 6 risk:* mapping a version to its eval call; store the call id at eval time (`EvalRun.call.id`) — cheap.
- *Time:* A ≈ 1 day, B ≈ 1 day, C ≈ 2 h, R ≈ 3 h. Fits before Tuesday with the commit/PR still to come.
