# Handoff — Frontend lane 5: Review page, rule snippets, onboarding for real agents, honest run numbers (plan 10, B1 + B2 + A5 UI)

Repo `/Users/owentsao/Coreweave Hacks`, branch `feature/production-fit` (checked out; working tree holds
uncommitted work — **never commit, stash, reset or checkout**). Read `docs/plans/10-production-fit.md` §3 (pitch,
layers), §4 Track B, §5 should-fixes on B1, §5b (loops 3–4). House rules: `.cursor/rules/code-organization.mdc`
and Owen's UI standard `~/.cursor/skills/my-ui-standard/SKILL.md` (read it). Reuse map in the rule: `api.ts` one
fetcher per route; `usePoll`; `lib/derive.ts` for every label/number; `Facts.tsx`; `Panel`; `MetalFrame`;
`textInput`/`outlineButton`/`fieldLabel` in `lib/ui.ts`. You edit `web/` only, plus `web/src/api.ts` types.

A backend lane is building the API in parallel. Where an endpoint does not exist yet, code against the contract
below and make the page degrade (empty state, not a crash) when the field is absent. Typecheck: `npm --prefix web
run build`; lint: `npm --prefix web run lint`. Dev server: `scripts/dev.sh` (API :8000, Vite :5173).

## Facts (verified Sep 21–22)

- Approvals: `GET /api/approvals?source` (`api/main.py:299-310`) → `{certified, decisions: [{version, status,
  ...}]}`; `POST /api/configs/{v}/review` (`:313-320`, live-only). `GET /api/configs/{v}?source` (`:282-288`).
  `GET /api/runs/{id}` embeds `configs` (`:399-414`) — there is **no** `/api/runs/{id}/configs`.
- `configDiff` in `web/src/lib/derive.ts:142-154` diffs two `AgentConfig`s incl. `tool_rules`;
  `components/ConfigDiff.tsx` is cycle-bound (`before/after` from `cycle.config_before/after`, `:38`).
- The Agent page already has Approve/Reject (`web/src/pages/Agent.tsx:134-144`); `RunResults.tsx` shows review
  marks (`:57, 193`) and Approve/Reject buttons. **B1 replaces the Agent-page panel** (delete it) and the RunResults
  buttons become a link into the Review page filtered to that run.
- `ToolRule` in `api.ts:89-94`: `deny, requires_user_intent, intent_words, requires_verified_lookup, max_calls`.
  `ruleLine` in `derive.ts:979-986`; `TOOL_CLASS_LABEL`, `toolRows`, `toolsLine` exist.
- Onboarding wizard: `web/src/pages/Onboarding.tsx` — steps connect (URL + ping), contract, tools list, done.
  Tools panel on the Agent page uses `GET /api/agents/{id}/tools` (proposal with class + starter rule) and
  `POST /api/agents/{id}/tools/apply`; `PATCH /api/agents/{id}` sets `tools_backend`. Loop start:
  `POST /api/loop/start` with `LoopStartBody` (`api/loop_ctl.py:88-110`; `chaos_cycles` etc.).
- Shell nav is positional (`Shell.tsx` indexes `NAV[2]`/`NAV[3]`) — append new items only. Routes in
  `lib/routes.ts`.
- Gateway log: `GET /api/gateway` → shadow log rows `{tool, args, decision: blocked|would_block|allowed, ...}`
  shown on the Agent page's Shadow log panel.

## Contracts (backend lanes implement these; code against them now)

- `GET /api/gateway/replay?version=<n|approved>&source=live` →
  `{version, calls: number, would_block: number, by_tool: Record<string, {calls: number; would_block: number}>,
  samples: Array<{tool: string; args: Record<string, unknown>; reason: string; at: string}>}` (up to 20 samples).
  Meaning: re-run version N's `tool_rules` over the recorded real calls in `history/gateway.jsonl`.
- Run manifest gains `domain: string`, `seed: number | null`, `target: "builtin" | "http"`.
- `CycleRecord` gains `latency_ms?`, `tokens?: {input, output}`, `cost_usd?`; `GateResult` gains
  `pass_k?: {k, passed}`.
- `GET /api/domains` → `[{name, tools: [{name, class}], families: string[], legit: number}]`.
- Scenario rows: `expected_calls` / `forbidden_calls: Array<{tool, args}>` replace `forbidden_tool_calls`.

## Build, in this order

### B1 — Review page `/app/review` (3–4 days of the lane)

Layout (three columns on desktop, stacked below `lg`):
- **Left — queue.** Pending versions first, then decided, newest first; each row: `v{n}`, run title, "fixes cycle N ·
  <cycle title>", status mark (reuse `ReviewMark`). `?run=<id>` filters; the Run page links here with it.
- **Middle — files.** A file tree of pseudo-files for the selected version: `tool_rules.json` (always), and for
  builtin targets only: `system_prompt.md`, `guardrails.md`, `validators.json`, `policy_flags.json`. For HTTP targets
  those four are **hidden** (they are Antibody's internal config, not the customer's — plan §5). Changed files are
  marked; unchanged are dimmed.
- **Right — diff.** Selected file diffed against the **last approved** version (not the previous version); header
  "v3 vs approved v1". Refactor `ConfigDiff.tsx` to take `(before: AgentConfig, after: AgentConfig, file)` and keep
  the cycle page calling it with cycle configs (one component, two call sites). Text files render as a line diff;
  JSON files as a key diff using `configDiff`.
- **Top strip.** Agent name · domain · "fixes cycle N: <what the attack did>" · gate line (pass^k when present,
  legit pass rate) · Approve / Reject (reuse the existing review POST; on success, refresh the queue).
- **Shadow-replay panel** (under the diff): "This version would have blocked **N** of the last **M** real calls",
  per-tool bars, and up to 20 sample rows (tool, args summary, reason, when). Empty state when `calls === 0`:
  "No real traffic recorded yet — run the gateway in shadow mode." From `GET /api/gateway/replay`.
- **Export strip** (B2 lives here too): copy `tool_rules.json`; copy the gateway command with the version pinned
  (`python -m chaos.gateway --backend <tools_backend> --version <n>`; `tools_backend` from the agent row).
- Delete the Agent-page approve panel; RunResults' Approve/Reject become "Review this version →" linking here.
- Every label/number is a named function in `derive.ts` with a one-line docstring (`reviewQueue`, `pseudoFiles`,
  `replayLine`, …). Add nav item "Review" (append).

### B2 — framework snippets for each accepted rule (1 day)

`derive.ts`: `ruleSnippet(tool: string, rule: ToolRule, framework: "openai-agents" | "langgraph" | "prompt")
-> string` — pure templates, no model call:
- OpenAI Agents SDK: a `tool_input_guardrail` function on that tool (deny → reject; `requires_user_intent` → check
  the run context's last user message for `intent_words`; `max_calls` → counter on the context) and, for
  money/mutate classes, `needs_approval=True`.
- LangGraph: an `interrupt()` before the node that calls the tool, with the same condition.
- Prompt addendum: one sentence per rule for teams with no code access.
Shown on the Review page as a tabbed code block with copy. Snippets are labelled "starting point — review before
use". Snippet correctness against the real SDKs is **not** tested here; say so in the report.

### A5 — onboarding for real agents (1–2 days)

In `Onboarding.tsx` after the connect step:
- **Tools step** becomes real: field for the tools URL (`tools_backend`, `PATCH /api/agents/{id}`); after saving,
  fetch `GET /api/agents/{id}/tools` and show each tool with its class chip and the proposed starter rule (reuse
  `toolRows`/`ruleLine`); "Apply starter rules" → `POST …/tools/apply`. Explain in one line what a starter rule is.
  If the agent exposes no `/tools`, say so and offer to continue with the sandbox.
- **Smoke step (new, before "done")**: "Run 3 quick attacks" → `POST /api/loop/start` with `chaos_cycles: 3`,
  `repair_attempts: 0` (verify the body field names in `loop_ctl.py`); poll `api.loop` and `api.cycles`; show the
  three cycles as they land with their verdicts; when the loop exits, show the first finding ("Attack 2 got through:
  <title>") with a link to that cycle, or "All three blocked — your agent is holding" if none landed. Done button
  enabled after the loop exits (or Skip).
- Copy uses the pitch's language (plan §3): locks on drawers, never touches your code, shadow mode first.

### Run page numbers (½ day)

`versionCells`/`summaryCells` add, when present: `pass^k` ("fixed k/k"), `cost` (sum of `cost_usd`, formatted),
`p50 latency`. `runFacts` adds `domain` and `seed` when present. Empty when absent — no placeholders like "—" for
fields that simply are not there yet.

## Do not

- No new dependency; no new component without two call sites (the file tree and diff are JSX in the page unless
  the cycle page reuses them — `ConfigDiff` does, keep it one component). No second poll hook, fetch wrapper or
  underline style. No emojis. Do not touch backend files. Do not commit.

## Deliver

`docs/plans/handoffs/frontend-5-report.md`: what shipped (files), decisions where this handoff was wrong or silent
(evidence), `tsc`/lint status, browser check per page (use the Cursor browser tools against `scripts/dev.sh`; the
backend may lack the new fields — say which panels you could only see in their empty state), and what is **not**
tested. Then stop.
