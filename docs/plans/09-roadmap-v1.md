# Plan 09 — Roadmap v1: the six ideas that make Antibody a product

Owen's brief (Sep 20, 02:39): plan the six future ideas, review the plan, build all of it, review the build, update
the README. Nothing from this plan is committed; it lands in the working tree for Owen to review.

Reviewed Sep 20 03:20 (independent pass, 5 blockers + 22 should-fixes); every finding is folded in below and marked **[rev]**.

| # | Idea | One line | Ships as |
| --- | --- | --- | --- |
| 1 | API access token | The API refuses callers without a bearer token when one is configured | `api/auth.py`, `ANTIBODY_API_TOKEN`, Settings → Access |
| 2 | Patch approval | Every version the loop produces is *pending* until a person approves it; the certified config is the newest approved one | `runs/approvals.json`, `/api/approvals`, Review panel, `check --approved` |
| 3 | Import an incident | Paste a real support transcript; it becomes a regression scenario the next run and `check` must pass | `POST /api/scenarios/import`, dialog on Agent page, `origin: "imported"` |
| 4 | Bring your own tools | Generic per-tool rules on the policy, and a pass-through so the tool bus fronts tools we never wrote | `ToolRule`, `tools_backend`, `chaos/tool_rules.py`, Tools panel |
| 5 | Enforcement gateway (shadow) | The approved *generic* rules run in front of the customer's real tools, logging first | `python -m chaos.gateway`, `history/gateway.jsonl`, `/api/gateway`, Shadow log panel |
| 6 | Schedules | A tab that attacks an agent on an interval or when the agent changes | `api/schedules.py`, `history/schedules.json`, `/app/schedules` |

**Estimate [rev]:** the reviewer put the honest number at 30–40 h. Each feature below is scoped to its thinnest
complete slice so all six land; anything cut to get there is listed under "Not doing".

## Verified ground (read Sep 20, 03:00; corrected 03:20)

- The loop promotes a gated patch immediately (`chaos/loop.py:268–271`); approval must sit *beside* the loop.
- `archive_previous_run` moves an **explicit list** (`chaos/state.py:312–321`) — a new file under `runs/` does not
  travel unless it is added there. **[rev]** `RunPaths` (`api/store.py:42`) is built three ways; a new field goes in all three.
- Paths are import-time constants (`chaos/state.py:33–48`); tests relocate them by monkeypatching the *copies* in
  each module (`tests/test_runs_api.py:45–53`). **[rev]** New modules must resolve paths at call time through
  `store.run_paths(...)` / `state.RUNS_DIR` attribute lookup (the way `api/agents.py:_path()` does), never copy them.
- `call_tool` (`chaos/toolbus.py:76`) is the only place a tool runs; `policy_blocks` has one caller. **[rev]** The
  seven existing policy flags and the storefront validators consult the mock `ORDERS` dict (`chaos/tools.py:258–298`):
  they are **sandbox-only** and must never run against real traffic.
- `apply_patch` (`chaos/repair_agent.py:496–505`) copies every policy value that is not `None`/`False`. **[rev]** A
  dict default `{}` would overwrite; `tool_rules` needs its own merge.
- `usePoll` keeps `e.message` only (`web/src/hooks/usePoll.ts:52`); `ApiError.status` is lost. **[rev]**
- `loop_start` (`api/main.py:451–478`) checks resume/agent/key before `loop_ctl.start`; `start` does not. **[rev]**
- "sidecar" already names `loop_settings.json` in `api/loop_ctl.py` (14 uses). **[rev]** The enforcement process is the **gateway**.
- `Shell.tsx` indexes `NAV[2]`/`NAV[3]` positionally. **[rev]** New items are appended.
- `merge_suites` (`api/rollback.py:55`) keeps the live row on an id clash. `origin` is already in `/api/regression`
  (model_dump). No `api.regression` fetcher exists in `api.ts`. No PATCH agents route exists.
- Tests: `tests/conftest.py` `client` (no lifespan), `FakeAgent` (`/episode`, optional `/tools`). 325 pass.

## 1. API access token

- `ANTIBODY_API_TOKEN` unset = today. `api/auth.py`: `required()`, `authorized(request)`. Registered as
  `@app.middleware("http")` in `main.py`: paths under `/api/` except `/api/health` → **[rev]** returns
  `JSONResponse(401, {"detail": "missing or wrong API token"})` directly (an `HTTPException` in middleware bypasses
  the handlers). `secrets.compare_digest`. Static dashboard stays open.
- `/api/health` gains `auth_required: bool`.
- Web **[rev]**: the token lives in `api.ts` (`getToken/setToken`, key `antibody.token.v1` — the thing that sends it
  owns it; no third storage module). `usePoll` returns `status: number | null` from `ApiError` (one hook, extended).
  `Shell` branches on a 401 from health/loop *before* `down`: one `Panel` "Enter API token" (password field, Save →
  `refresh`). Settings gains an **Access** section (token set/forget; `SETTINGS_SECTIONS` grows `"access"`).
- Tests `tests/test_auth.py`: unset → 200; set → 401 no header / wrong; 200 right; health open and reports the flag.

## 2. Patch approval

- **Rule [rev]:** certification lives with the run. `runs/approvals.json` is a run file: `chaos/state.py` owns it
  (`APPROVALS_PATH`, `load_approvals()/save_approvals()`, added to `archive_previous_run`'s `movable`; `reset` deletes
  it with the rest) — no separate `chaos/approvals.py`. Clear/archive = decertify; a rollback lands as pending.
  Shape `{"3": {"status": "approved"|"rejected", "at": iso, "note": str}}`; absent = pending. v0 counts as
  approved when nothing newer is (`check` on an empty tree already runs v0).
- `chaos/state.py`: `approved_version() -> int` (highest approved, else 0), `review_status(v)`.
- `chaos.loop check --approved` → `check_config(None, approved=True)`.
- `api/store.py`: `RunPaths.approvals` (all three constructors), `read_approvals(source)`; `/api/configs` rows carry `review`.
- Routes: `GET /api/approvals?source=`, `POST /api/configs/{v}/review {status, note?}` → 400 for a non-live source,
  404 unknown version; allowed while the loop runs (does not touch its files); writes under `runs_lock`.
- Web: `api.approvals`, `api.review`; Agent page **Review** panel (rows per version > 0 of the picked run: kind,
  cycle, gate rates, Approve/Reject as `u-line` actions; decided rows show decision + time); header names
  "certified v{n}"; `RunResults` strip marks approved/rejected. `derive.ts`: `reviewRows`, `certifiedVersion`.
- Tests `tests/test_approvals.py`: pending default; round-trip; highest approved wins; rejected ignored; 404; the
  file moves with `archive_previous_run`; `check_config(approved=True)` picks it.

## 3. Import an incident

- `chaos/scenarios.py:from_transcript(...)`: `Customer:`/`User:`/`> ` = customer, `Agent:`/`Assistant:` = agent;
  `user_message` = customer turns joined; `origin="imported"`; id `imported-<sha1[:10]>`; ValueError on no customer
  turn or > 20 kB. `Scenario.origin` grows `"imported"`; **[rev]** `api.ts` origin union widens too.
- **[rev]** Behaviour in `api/incidents.py`: `import_incident(body) -> (scenario, created: bool)` under `runs_lock`;
  409 while the loop runs; **incoming wins on an id clash** (a re-import with a corrected title updates the row;
  answers 200 instead of 201). Docstrings in `api/rollback.py` and `api/main.py` that call rollback the API's only
  `regression.json` writer are corrected.
- **[rev]** Dialog copy says plainly: the judge scores in the sandbox world, so incidents whose *correct* outcome
  is a refund/email to a non-demo customer will read as failures — import the ones where the agent did the wrong thing.
- Web: `components/ImportIncidentDialog.tsx` (a dialog is a separate object; opened from the Agent page's actions and
  its Regression panel); `api.regression` fetcher added; Agent page **Regression suite** panel with origin labels.
- Tests `tests/test_incidents.py`: both prefix styles; rejects no-customer; idempotent id; 409 during a loop;
  incoming wins; appears in `/api/regression` with origin.

## 4. Bring your own tools

- `ToolRule(deny, requires_user_intent, intent_words, requires_verified_lookup, max_calls)` — **[rev]** no
  `max_amount` (the arg name is per tool; v2). `ToolPolicy.tool_rules: dict[str, ToolRule] = {}`.
  `policy_blocks(..., calls=None)` applies the rule for the named tool first, for any tool. Reasons `policy: <tool> …`.
- **[rev]** `apply_patch`: `tool_rules` merges per tool — `deny` wins, booleans OR, `intent_words` union,
  `max_calls` min. `_patch_detail` in `repair_agent.py` and `loop.py` print rules, not `{}`.
- **Pass-through [rev]:** `ToolSession.tools_backend: str | None`. When set, **the backend wins for every name**
  (a customer's `lookup_order` is theirs, not the mock's): `post_json(f"{backend}/tools/{name}", args, 30 s)`; the
  result runs through *generic rules only* — faults still apply (`inject`/`malformed` on any tool name), the
  storefront validators are skipped (they know Northwind's keys). `FaultableTool` widens to `str` with a validator
  that still refuses `read_ticket`/`set_ticket_status` (the documented hole, `chaos/schemas.py:18–21`).
- **[rev]** Contract (unverified with a customer, stated as such): the agent routes tool calls to `tools_url` (plan
  01, the example agent does) **and** exposes its real tools as `POST <tools_backend>/tools/{name}`. Nothing in the
  repo serves that yet; `tests` add a `FakeToolBackend`; the README names it as the second integration line.
- Agent row: `tools_backend: str | null` (synthetic rows: `null`; TS optional). `POST /api/agents` accepts it; new
  `PATCH /api/agents/{id}` for `tools_backend` only. **[rev]** `loop_ctl.start` reads the row (`agents.get_agent`)
  and passes `ANTIBODY_TOOLS_BACKEND` to the child; `target_agent.new_session` reads it.
- `chaos/tool_rules.py`: `classify(name, description)` (word lists) and `starter_rules(tools)` — pure.
- Routes: `GET /api/agents/{id}/tools` → `{tools, mapping, classes, starter_rules}`; `POST /api/agents/{id}/tools/apply
  {rules}` saves the next live config (`save_config(exclusive=True)`, patch_note `starter tool rules for <name>`),
  409 while the loop runs. **[rev]** Target check compares against the live `run.json` target, not the env default.
- **[rev]** Chaos/judge prompts stay Northwind-bound this round; the chaos agent is told the tool names so faults
  and `forbidden_tool_calls` can name them, and `expected_behavior` is the family's. Named as a limit.
- Web: Agent page **Tools** panel (class · proposed rule · `Switch` · "Apply as v{n+1}"); `tools_backend` field on
  the Agent page next to the URL (edit-in-place, PATCH). Onboarding untouched this round.
- Tests: `tests/test_tool_rules.py` (table; `policy_blocks` deny/intent/verified/max_calls; `apply_patch` merge);
  `tests/test_passthrough.py` (backend wins, records, blocked by rule, `malformed` applies, validators skipped);
  `tests/test_agents.py` grows `tools_backend` + PATCH + apply.

## 5. Enforcement gateway (shadow mode)

- `chaos/gateway.py`: `python -m chaos.gateway --backend URL [--port 8766] [--version approved|N] [--enforce]`.
  **[rev]** Reuses `chaos/toolserver.py` by parametrising it (`toolserver.build_app(session_for, tools_lister,
  on_call)`) rather than a second app: the loop's `app` is `build_app(_session_or_404, ...)`; the gateway's is
  `build_app(create_on_first_sight, proxy_list, log_line)`. Sessions expire after 1 h idle.
- Session: `ToolSession(cfg=approved, scenario=PRODUCTION.model_copy(update={"customer_id": hdr}), customer_turns=[],
  tools_backend=backend, shadow=not enforce)`; `POST /sessions/{id}/turn {text}` feeds customer turns.
  **[rev]** Only `tool_rules` run (pass-through path); the seven legacy flags and validators never do.
- `ToolSession.shadow`; `ToolCall.shadowed`. Under shadow a block still runs the tool and records `shadowed=True`.
- **[rev]** Log at `HISTORY_DIR/gateway.jsonl` (not a run artifact: survives `reset`, written by another process).
  `GET /api/gateway?tail=` reads it. Agent page **Shadow log** panel when present; Settings → Environment shows the command.
- Tests `tests/test_gateway.py`: forwards; shadow logs but does not block; `--enforce` blocks; first-sight session;
  line shape; `approved` picks `state.approved_version()`.

## 6. Schedules

- `history/schedules.json` (mkstemp + replace, lock, path resolved at call time). Row: `{id, name, agent, trigger:
  {kind: "interval", every_minutes} | {kind: "on_change"}, settings (LoopStartBody minus target), enabled,
  created_at, last_run_at, last_result: {kind: started|skipped|failed, detail}, last_fingerprint, next_at}`.
- `api/schedules.py`: CRUD, `due(now)`, `fire(s)`, `tick(now)`. **[rev]** The pre-spawn guards (resume without
  config, unknown agent, missing key) move from the route into `loop_ctl.start` as `ValueError`s so route and
  scheduler share one place; `fire` records the message as `skipped`.
- `on_change`: fingerprint = sha256(`GET /tools` body + `GET /version` body if 200); builtin + on_change → 400.
- Daemon thread from `_lifespan`, 30 s tick, `ANTIBODY_NO_SCHEDULER=1` disables; tests call `tick(now)`.
- Routes: `GET/POST /api/schedules`, `PATCH/DELETE /api/schedules/{id}`, `POST /api/schedules/{id}/run`.
- Web: `Route {kind: "schedules"}`, `/app/schedules`; **[rev]** appended as `NAV[4]` (Phosphor `Timer`). Page:
  hairline table + inline create/edit `Panel` (name, agent `Dropdown`, trigger `Select`, interval `Select`,
  `RunSettingsFields`). **[rev]** `settings.ts` gains `fromStartBody` (inverse of `toStartBody`) for the edit form.
- Tests `tests/test_schedules.py`: CRUD; `due`; skip while running; `on_change` fires only when the fingerprint
  moves; builtin + on_change → 400; keyless install → `skipped`.

## Cross-cutting

- Routes thin; behaviour in modules; a test file per module; auth covers every new route.
- Paths resolved at call time. No new dependency. Phosphor only. New files: `api/auth.py`, `api/incidents.py`,
  `chaos/tool_rules.py`, `chaos/gateway.py`, `api/schedules.py`, `components/ImportIncidentDialog.tsx`, `pages/Schedules.tsx`.
- Docs: `docs/FRONTEND.md` routes + files; README last (v1 section + the two integration lines).

## Not doing

- LLM transcript enrichment; cron expressions; per-tool amount caps; world-agnostic chaos/judge prompts; approval
  pauses inside the loop; onboarding changes for `tools_backend`; per-user accounts.
