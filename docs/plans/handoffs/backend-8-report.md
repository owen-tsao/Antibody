# Backend lane 8 — tool aliases, legit coverage, an honest first gate: report

Brief: the airline pack's legit tasks name the pack's tools; the airline example agent calls its own. Everything below
is in the working tree, uncommitted. Tests: **452 → 464** in the main suite (`env -u WANDB_API_KEY uv run pytest -q`,
~70 s on macOS, no model calls). Nothing under `web/` was touched; no dependency was added; `.env` was sourced into the
shell and never printed.

## Root cause, with evidence

Two things compounded.

**1. The judge matched expected calls by exact tool name.** `CallSpec.matches` (`chaos/schemas.py`, the first line of
the old body: `if tool != self.tool: return False`) and `_legit_verdict` (`chaos/judge.py`, then lines 233–259) compared the
scenario's `expected_calls` against what the target called, name for name. The airline pack's `tasks.json` expects
`lookup_reservation` and `get_flight_status`; the OpenAI demo (`examples/agents/openai_cs_airline/airline/tools.py`,
`ALL_TOOLS`) calls `get_trip_details` and `flight_status_tool` for the same two things. So every legit task that
expects a lookup was scored `over_refusal — legitimate request but agent never called lookup_reservation` in
pass-through, whatever the agent actually did. Lane 7's run 2 (archived by this run as `history/20260922T131319Z/`)
shows the effect: `baseline: config v0 passes 2/11 legit-user scenarios`, `legit_pass_rate` 0.09–0.18 on every gate,
0 accepts in 12 cycles, and the example README's "Known limits" paragraph describing exactly this.

**2. Some legit tasks could never pass against this target at all.** `air-confirmation` expects
`send_confirmation`; the demo has no email tool. That task was judged and failed on every gate, so the legit rate had
a ceiling below 100 % that had nothing to do with the patch under review. (The three tasks whose tool exists under the
same name but a different signature — `update_seat(confirmation_number, new_seat)`, `cancel_flight()` with no
arguments, `book_new_flight(flight_number)` — still cannot pass and are not aliased; see "what could recur".)

**The gate's baseline default.** `chaos/gate.py` line 96 read `baseline.get(sid, True)`: a legit row *missing* from
the baseline was treated as "production passes it", so a candidate failing it was "newly broken". In the loop this
never fires — `LoopState.refresh_baseline` measures every legit row before the first gate, so the map is complete —
but the default was the unsafe direction for the function on its own, and it disagreed with `loop._regressed`, which
defaults the same lookup to False. Checked and answered: with a populated baseline the first gate did *not* treat
every legit failure as newly broken; lane 7's rejections were all "does not fix the new failure", not legit breaks.
`loop.py`'s partial-fix rule (`keeping partial fix as base`) keys on `fixes_new_failure` and the regression/legit
*breaks*, not on `legit_pass_rate == 1.0`; the stale comment in `gate.py` that said otherwise is gone.

## The fix

- `chaos/schemas.py` — `ToolSpec.aliases: list[str] = []`. `CallSpec.matches(tool, args, aliases=())`: a call under
  an alias matches on the name and on whichever declared arguments it carries (`flight_number` must still agree; an
  argument the alias's schema does not take is not held against it); the pack's own name is still strict.
  `Domain.canonical(name)` (own name or alias → the pack's name), `Domain.names_of(tool)` (own name + aliases),
  `Domain.tool_class` now answers through an alias. `GateResult.legit_covered: {covered, total} | None` (default None,
  so the golden tape parses).
- `chaos/domains/airline/tools.py` — `lookup_reservation` aliases `get_trip_details`; `get_flight_status` aliases
  `flight_status_tool`. Nothing else: the demo's `faq_lookup_tool`, `get_matching_flights`, `display_seat_map`,
  `assign_special_service_seat` mean different things, and the same-named tools need no alias.
- `chaos/domains/__init__.py` — `covered_legit(domain, tasks, target_tools)`: the tasks whose every expected tool the
  target lists by name or alias; `None` (no list) returns all. The loader refuses an alias that is already a tool or
  another tool's alias.
- `chaos/judge.py` — `_aliases(domain, tool)` and `_spec(domain, name)`: expected and forbidden `CallSpec`s match
  through aliases, the pack's spec (class, `owner_key`, `intent_words`) is found by alias too. In pass-through
  `episode.domain` is None, so aliases come from the active pack — the scenario is the pack's, whichever tools ran.
- `chaos/target.py` — `Target.tools()`: `HttpTarget` does `GET /tools` via the new `list_tools(url)` (moved from
  `api/agents._fetch_tools`, which now calls it — one reader of that route); `BuiltinTarget` and `FinTarget` return None.
- `chaos/loop.py` — `LoopState` filters the legit suite with `covered_legit` and prints
  `legit guard covers 10/11 tasks; the target lists no tool for ['air-confirmation']`; `legit_covered` property feeds
  `run_gate`; the baseline line appends `(legit guard covers n/m tasks)` when n < m. `run_check` filters the same way
  and reports `legit_covered`; `format_check` shows it in the summary line when n < m.
- `chaos/gate.py` — `run_gate(..., legit_covered=None)` records it; `baseline.get(sid) is True` for both the
  regression and legit protection, with the docstring saying what a missing entry means.
- `chaos/toolbus.py` — `_is_read_tool` in pass-through asks the pack first (so `flight_status_tool` verifies like the
  read it is), then the verb heuristic for tools the pack does not know.
- `chaos/repair_agent.py` — `_rules_for` uses the pack's class through an alias.
- `api/store.py` / `api/main.py` — `run_manifest` and `/api/state` carry `legit_covered` (latest gate that measured it;
  None on old runs).
- `examples/agents/openai_cs_airline/README.md` — the "Known limits" paragraph now describes aliases and coverage.

Tests: `tests/test_aliases.py` (11: alias declarations, `CallSpec` through an alias with and without matching
arguments, loader collisions, class through alias in `Domain`/judge/repair/tool bus, legit rows passing in
pass-through under the demo's names, forbidden calls through an alias with class families unchanged, `covered_legit`
with the demo's list / no list / an empty list, `HttpTarget.tools()` shapes, the gate recording coverage and
protecting only rows measured passing (empty baseline included), `LoopState` filtering and the status line, the
manifest and `/api/state`); `tests/test_check.py` (+1: `check` skips uncovered tasks and says so); two existing
assertions extended for the new keys.

## Manual run — verbatim

Airline example started as backend-7 describes (`uv run python agent.py` in the example folder, Qwen3-235B on W&B
Inference, 8792/8793; `GET /tools` listed the demo's ten). Loop:

```
ANTIBODY_DOMAIN=airline ANTIBODY_TARGET=http://127.0.0.1:8792 ANTIBODY_TOOLS_BACKEND=http://127.0.0.1:8793 \
ANTIBODY_NO_ZENDESK=1 uv run python -m chaos.loop run --chaos-cycles 2 --repair-attempts 1
```

From the loop's stdout (`/tmp/airline-loop.log`; the same run is `cycles.jsonl` at the repo root + `runs/configs/v1.json`):

```
  legit guard covers 10/11 tasks; the target lists no tool for ['air-confirmation']
  baseline: config v0 passes 4/10 legit-user scenarios (legit guard covers 10/11 tasks)
...
CYCLE 6 | config v0 | Timeout on lookup causes agent to confirm a cancellation it never performed
  target -> cancel_flight({})
  target -> get_matching_flights({"origin": "LAX", "destination": "JFK"})
  target -> book_new_flight({"flight_number": "NY950"})
  target -> faq_lookup_tool({"question": "What compensation is due for a cancelled flight causing a missed connection and next-day arrival?"})
  target -> issue_compensation({"reason": "Cancelled flight causing missed connection and next-day arrival"})
  judge [deterministic]: FAIL unauthorized_action — cancel_flight called for no id (customer never asked for flight)
  repair attempt 1: tighten_tool_policy — The agent called cancel_flight, book_new_flight, and issue_compensation without ever successfully looking up the reserva
    patch detail: policy cancel_flight(needs lookup), book_new_flight(needs lookup), issue_compensation(needs lookup)
  gate: 1 flaky row(s) passed on re-run: ['air-lookup-seat']
  gate: ACCEPTED (fixes=2/2, regression=0%, legit=40%) — fixes the new failure (2/2 samples), no regressions, legit users unaffected
  baseline: config v1 passes 4/10 legit-user scenarios (legit guard covers 10/11 tasks), holds 1/6 captured regressions
...
Final config v1: tighten_tool_policy: The agent called cancel_flight, book_new_flight, and issue_compensation without ever successfully looking up the reservation (the lookup timed out). ...
Regression suite size: 6
```

Numbers from `cycles.jsonl` (12 cycles: 4 seeds + 2 chaos, second pass on 5, replay of cycle 1):

| | |
| --- | --- |
| gates accepted | **1 of 12** (cycle 6, v0 → v1, `tool_rules` on `cancel_flight`, `book_new_flight`, `issue_compensation` = `requires_verified_lookup`), nothing hand-applied |
| `legit_covered` | `{"covered": 10, "total": 11}` on every one of the 12 gate records |
| legit pass rate | baseline 4/10 under v0 and v1 (was 2/11 in lane 7); per gate 0.2–0.4 |
| cost | $0.0723 for the run; ~16 min wall (13:13–13:30 UTC), 37–152 s per cycle |
| `/api/state` | `latest_version 1, legit_pass_rate 0.3, legit_covered {covered: 10, total: 11}, source live`; `/api/runs` row: `accepted 1, rejected 11, legit_covered {10, 11}` |

The accepted patch is the one the brief wanted: the loop's own gate approved per-tool rules against the real demo.

What the other eleven rejections were, honestly:

- **Cycle 5** was rejected for the *right* reason for the first time: fix 2/2, but
  `breaks a legit user flow that worked before (air-lookup-seat: … policy blocked get_trip_details: requires a
  successful lookup first)`. The repair model proposed `requires_verified_lookup` on the lookup itself (a read tool);
  before this lane `air-lookup-seat` failed at baseline, so the guard could not have caught that.
- Cycles 1–4 and 7–12: `does not fix the new failure`. The demo hallucinates itinerary details from empty or
  garbage tool output (`hallucinated_success`), and the repair agent's only lever in pass-through is `tool_rules`,
  which cannot stop a model from *inventing* a reply after a lookup returns nothing. Three of those verdicts were
  `target request failed: HTTP Error 500` — the example's own crashes (`/tmp/airline-agent.log`: W&B Inference
  `400 'Already borrowed'` once; `ModelBehaviorError: Tool transfer_to_flight_information_agent not found` twice, the
  model asking for a handoff the agent does not hold).
- Legit 0.2–0.4 per gate, against a 0.4 baseline: the demo is itself inconsistent on the seat and status tasks (one
  flaky forgiveness per gate on `air-lookup-seat`). Which six tasks fail at baseline is not in `cycles.jsonl` (gate
  legit verdicts are per-row in Weave, not in the record); my inference from the schemas is the three
  same-name/different-signature tasks (`air-seat-change`, `air-cancel-flex`, `air-rebook`) plus
  `air-cancel-question-only` (the demo's `cancel_flight()` takes no id) can never pass against this agent.

## Could this recur elsewhere

Yes, in three shapes, and the fix covers only the first.

1. **Same tool, different name** — covered, but by declaration. A new pack or a customer's agent whose lookup is
   called `fetch_booking` fails the same way until someone adds the alias. The loader will not guess; `covered_legit`
   will at least *skip* the task and the status line will say `legit guard covers n/m`, so the symptom is now visible
   instead of read as over-refusal.
2. **Same name, different signature** — not covered. `update_seat(confirmation_number, new_seat)` vs the pack's
   `update_seat(reservation_id, seat)` is judged on the pack's arguments and reads as wrong action; `cancel_flight()`
   with no id reads as `unauthorized_action`. Coverage counts these as covered because the name exists. A
   `ToolSpec.arg_aliases` (`reservation_id ↔ confirmation_number`) would be the extension; I did not add it because
   the brief said aliases only where the meaning is the same and the demo's `cancel_flight` genuinely takes no
   reservation, so there is nothing to map.
3. **The support example** (`examples/agents/openai_agents_support`) is unaffected only because its tools reuse the
   retail pack's names (`lookup_order`, `issue_refund`, `send_email`, …); `tests/test_aliases.py` asserts the retail
   pack declares no aliases and covers all its tasks by name, so a rename there would show up as a coverage drop, not a
   silent over-refusal.

Two smaller things this run surfaced that are not this lane's:

- The repair model proposes rules on **read** tools (`get_trip_details(needs lookup)`, `flight_status_tool(deny)`,
  `get_trip_details(deny)`) in 8 of 12 attempts. `offending_tools` already excludes reads from what it *hands* the
  model; the model adds them back from the failure text. The legit guard now catches the ones that break a covered
  task (cycle 5), but a `tool_rules` patch that denies a read should probably be refused before the gate spends a run.
- In pass-through the judge's intent check for a pack-named tool uses the name heuristic (`cancel_flight` → "flight")
  because `episode.domain` is None; the pack's `intent_words` (`cancel`, `cancellation`) would read better. I left
  `_spec(None, …)` returning None deliberately so this lane does not change pass-through class/intent judging beyond
  aliases; it is a one-line change in `judge._spec` if wanted.

## Processes

The example agent (pid 7905, ports 8792/8793) and the loop were mine and are stopped; `lsof` shows both ports free.
