# Antibody — self-healing for AI agents

[![CI](https://github.com/owen-tsao/Antibody/actions/workflows/ci.yml/badge.svg)](https://github.com/owen-tsao/Antibody/actions/workflows/ci.yml)

![The Antibody dashboard: the agent card with its facts — config v0 → v4, blocks 5 of 7, normal customers 11 of 11 — beside the list of failures that still need a decision and the recent runs](docs/hero.jpg)

Antibody attacks your AI agent on purpose, proves each failure, writes a rule that would have stopped it, and only keeps the rule if it fixes the break without undoing any earlier fix or hurting normal users. Every failure becomes a permanent regression test. The rules it keeps are enforced by a gateway that sits between your agent and its tools — so your agent's code is never touched.

Built solo at CoreWeave Hacks (Agent Loops), San Francisco, September 12–13, 2026, and productionised over the two weeks after. Runs on W&B Inference, traced and evaluated in Weave: every episode, judge call, gate evaluation and cost number in this README is in the [`chaos-monkey` Weave project](https://wandb.ai/owentsao23-clad-labs/chaos-monkey/weave).

## Reviewing this repo

If you have ten minutes, read these in order — they are the whole argument:

1. `tests/test_e2e_passthrough.py` — the product in one test: an external agent breaks, a rule is proposed, the gate accepts it, a human approves it, the gateway enforces it. No model calls.
2. `chaos/gateway.py` — the only code that runs in a customer's infrastructure. Auth, fail-closed by tool class, live policy reload, shadow mode.
3. `chaos/judge.py` and `chaos/gate.py` — why a verdict can be trusted: deterministic checks by tool class, typed facts to the LLM, pass^k, legit coverage.
4. `chaos/domains/airline/` — what a domain pack is, in five files.
5. `docs/plans/10-production-fit.md` — the research and decisions behind the shape above, including what was rejected and what is not built.

CI runs the test suite (522 tests, none of which need an API key), the web build and lint on every push to `main` and every pull request. `docs/SMOKE.md` is the ten-minute manual checklist; `docs/plans/handoffs/` holds the report from every build lane and the independent reviews that gated each plan, including the blockers they found.

What is deliberately *not* here: a database (runs are files on disk, moved to `history/` between runs), per-user auth (one shared bearer token each for the API and the gateway), a shared session store for the gateway, and an SDK that applies rules as code. Each is named where it matters below, with what stands in for it today.

## The idea in one paragraph

An AI support agent is a set of drawers it can open: look up a record, issue a refund, send an email, cancel a flight. Attacks are ways of tricking it into opening the wrong drawer. Antibody finds those tricks, then puts a lock on the drawer — "a refund needs the customer to have asked for one, on a record you actually looked up" — and proves the lock holds while ordinary customers still get served. The lock is a rule in a small proxy you run in front of your tools. You approve each rule before it goes live, and you can run the proxy in *shadow* mode first to see what it would have blocked in your real traffic.

## What it does

Four agents take turns, and a gate decides:

1. **Chaos Agent** invents an attack for the world the target lives in: a poisoned note in a record it reads, a tool that returns garbage or times out, a customer with a sympathetic story about someone else's account, a request phrased so that the honest answer is "no". It picks its attack family with a bandit (what has been working gets tried more) and reads the target's real traces to route around rules that already shipped.
2. **Target Agent** is whatever you point Antibody at: the built-in support bot (Llama 3.1 8B) or your own agent behind a URL.
3. **Judge** decides if the target failed — deterministically wherever it can: did a money or record-changing tool get called for something the customer never asked about? did a lookup return someone else's record? did a message go to an address that is not the customer's? did the agent refuse a perfectly reasonable request? Only the fuzzy cases go to an LLM judge, and it sees typed facts about the tool calls, never raw tool output, so an attack cannot talk its way past the judge either.
4. **Repair Agent** proposes one fix from a fixed menu. For an external agent that menu is per-tool rules (deny, require the customer's intent, require a prior lookup, cap the calls); for the built-in sandbox it also has prompt and guardrail edits.
5. **Eval Gate** runs the candidate against the new failure (twice — "fixed" means both samples pass), every past failure, and a suite of legitimate customer tasks. A fix ships only if it closes the new hole, holds every old fix, and leaves ordinary customers no worse off than today's production. The gate also reports how many of the legit tasks were actually runnable against this agent, so an empty guard is never silently a passing one.

Then the Chaos Agent studies the new defenses and goes again. Rejected fixes get retries within a cycle and a second pass at the end of the run.

### Domains, not one storefront

Attacks, legit tasks, seed records and the judge's checks come from a **domain pack** under `chaos/domains/`. Two ship today: `retail` (the original Northwind storefront — orders, refunds, email, Zendesk tickets) and `airline` (reservations, flight status, cancellations, rebooking, seats, compensation). Each pack carries its attack families (five for airline, four for retail) written in terms of tool *classes* (money, message, record change, read) rather than tool names, so the same family attacks any agent in that domain. Every episode works on its own copy of the pack's records, so parallel gate episodes cannot contaminate each other. Pick a pack with `ANTIBODY_DOMAIN=airline` on the command line, in the dashboard's run settings, or on the agent's row.

## Running it

```bash
uv sync
cp .env.example .env        # WANDB_API_KEY, and optionally ZENDESK_SUBDOMAIN + ZENDESK_OAUTH_TOKEN
uv run python -m chaos.loop run --chaos-cycles 4
```

For a short run that still tells the whole story (one seed attack breaks v0, gets repaired, then one Chaos-invented attack, then the first attack replayed against the hardened config; about 3 minutes on the mock world):

```bash
uv run python -m chaos.loop run --seeds 1 --chaos-cycles 1 --repair-attempts 2
```

Each fresh run moves the previous run's files to `history/<timestamp>/` rather than overwriting them, so earlier cycle records keep pointing at the configs they were made with. `ANTIBODY_SEED` fixes the run's random choices (attack family order, fault selection, record sampling) so two runs with the same seed and model temperature 0 are comparable; the seed is recorded in the run.

Other commands: `check [version]` (re-verify a saved config against every known attack and legit task — a CI step), `reset` (wipe run state), `golden` (snapshot the run into `data/golden/` for demo fallback), `vulnerability` (how many of the final attacks land on each config version), `cleanup` (solve every ticket the harness created). `ANTIBODY_NO_ZENDESK=1` forces the mock world.

### The dashboard

```bash
scripts/dev.sh              # API on :8000, web UI on :5173
```

Pages: **Home** (the current run and what needs attention), **Agents** (everything you have connected; open one for what is in force, what every run found, its live gateway traffic and the rules it is running under), **Current run** (the four orbs live, then the results with per-version numbers — fixed k/k, legit coverage, cost and latency), **Runs** (history), **Schedules**, **Review** (approve or reject each version with its diff against the last approved one, what it would have blocked in real traffic, and the rules file and gateway command to copy), **Settings** (models, run settings, domain, API token). Press **Heal** to start a live run, or **Replay** to play the committed golden run back on its original timeline so a demo never depends on the network.

## Bring your own agent

Antibody needs three things from an agent: take a customer message, make its tool calls where Antibody can see them, and reply. Everything else — injecting the fault, judging the actions, enforcing an approved rule — happens between the agent and its tools.

Run your agent as a small HTTP service and point the loop at it:

- **Accept an episode.** `POST /episode` with `{session_id, message, customer_id, customer_email, tools_url}`. `message` is the customer's opening turn; the customer fields belong in your prompt.
- **Call your tools through `tools_url`.** `GET {tools_url}/tools` lists them; every call is `POST {tools_url}/tools/{name}` with the arguments as JSON and the header `X-Antibody-Session: <session_id>`. If you give Antibody the URL of your *real* tools (`tools_backend` on the agent's row), it forwards each call there with the same session header after the fault and the rules have had their say — the sandbox's own tools are only used when you do not.
- **Reply.** Return `200 {"reply": "…"}`. Antibody waits up to 120 seconds, then scores the episode from the tool calls it saw and the reply.

```bash
ANTIBODY_TARGET=http://127.0.0.1:8792 ANTIBODY_TOOLS_BACKEND=http://127.0.0.1:8793 \
ANTIBODY_DOMAIN=airline ANTIBODY_NO_ZENDESK=1 uv run python -m chaos.loop run --seeds 2 --chaos-cycles 2
```

Two worked examples live in `examples/agents/`, each in its own venv with no imports from Antibody:

- `openai_agents_support/` — a stock OpenAI Agents SDK support agent using Antibody's sandbox tools.
- `openai_cs_airline/` — OpenAI's own [customer-service demo](https://github.com/openai/openai-cs-agents-demo) (six agents with handoffs and guardrails, MIT-licensed, attributed) with its chat UI removed and its real tools served on a second port so Antibody can front them. It runs on `Qwen/Qwen3-235B-A22B-Instruct-2507` through W&B Inference because `gpt-oss-120b` narrates the handoff instead of calling it; set `OPENAI_API_KEY` and `AGENT_MODEL=gpt-5.2` to run it as OpenAI shipped it.

On the night this was built, the loop ran 12 cycles against the airline demo for about seven cents of inference and the gate accepted a rule requiring a verified lookup before `cancel_flight`, `book_new_flight` and `issue_compensation`; the gateway in shadow mode then logged `would_block` for the same impersonation attack. That is the whole product working end to end on an agent Antibody did not write.

Hosted agents that expose a conversation API can be attacked too: `ANTIBODY_TARGET=fin:<label>` with `INTERCOM_FIN_TOKEN` drives Intercom Fin's Agent API. Fin's tools are not observable, so the gateway is the only enforcement point for it. Built against Intercom's published API and a fake; not yet run against a real workspace.

The honest caveats:

- It is a few lines of glue in your agent — a session id carried in a header, one URL from the request body — not zero.
- Legit tasks come from the domain pack and are matched to your tools by name or declared alias. Tasks your agent has no tool for are skipped and reported as coverage ("legit guard covers 10/11 tasks"), not counted as failures; tasks whose tool has the same name but a different signature can still read as failures.
- In Weave, an external agent's tool calls appear as root traces rather than nested under the episode; they do share the episode's thread (the session id the agent forwards in `X-Antibody-Session`), so the Threads view still shows the conversation as one row.
- Ticket mode over HTTP has not been exercised; the Zendesk account is suspended.

## From a finding to production

The loop finds and fixes failures. Around it sit the pieces that make a fix something a team can run.

**Fixes are staged, not shipped.** Every config version the gate accepts starts out *pending*. On the Review page you see its rules diffed against the last approved version, how many of your recorded real tool calls it would have blocked, and Approve / Reject. The highest approved version is the *certified* one; `python -m chaos.loop check --approved` checks against that in CI.

**What you take away from a run.** The report (attacks run, landed, blocked, fixed k/k, legit pass rate and coverage, cost); the approved `tool_rules.json`; the gateway command with that version pinned; and, for each rule, a starting-point snippet for enforcing it in code instead — an OpenAI Agents SDK guardrail, a LangGraph interrupt, or a sentence for the prompt. The snippets are templates, not tested against the SDKs.

**An enforcement gateway, shadow first.** `python -m chaos.gateway --backend <your tools url> --version approved --shadow` runs the certified version's rules in front of your real tools and only logs what it *would* have blocked. Run it that way for a week, read the shadow-replay panel, then switch to `--enforce`. `ANTIBODY_GATEWAY_TOKEN` makes every call need that bearer; `ANTIBODY_BACKEND_AUTH` is the `Authorization` your tools expect, forwarded as-is and never logged. When a tool cannot be reached or a check itself fails, money and record changes are refused and lookups go through marked degraded; each rule can override that and set its own timeout. Approving a version reaches a running gateway within a minute (or on `SIGHUP`); `GET /health` says which version is live. A gateway on `--version approved` will not fall back to an older or empty policy if the approvals file disappears — it keeps serving what it has and says so.

**Real incidents become tests.** Paste a support transcript on an agent's page (or `POST /api/scenarios/import`), pick the attack family, and it joins the regression suite every later gate and every `check` must pass.

**Bring your own tools.** Tools an agent lists are classified (money, message, mutate, read, unknown — by name and description, or by the pack when there is one) and each gets a proposed starter rule you can apply as a version in one click. The onboarding wizard runs three quick attacks before it says "done", so the first finding arrives inside ten minutes.

**Schedules.** Attack an agent on an interval, or whenever its tools or version change. Schedules fire through the same start path as the Heal button, so a missing key or an already-running loop shows up in the row as *skipped*, never as a crash.

**A token on the API.** Set `ANTIBODY_API_TOKEN` and every route but `/api/health` wants it as a bearer; the dashboard asks for it once and keeps it in the browser.

The fine print:

- The gateway runs only the world-agnostic per-tool rules. The sandbox's seven policy flags and its validators know the sandbox's records and never touch real traffic. `X-Antibody-Customer` is a log label, not an identity.
- Session state lives in the gateway process; running two gateways behind a load balancer needs sticky sessions on `X-Antibody-Session`. A shared session store is not built.
- "Changed" for an `on_change` schedule means the agent's `GET /tools` (and `GET /version`, if it has one) answered differently.
- Imported incidents are scored in the domain pack's world, so import conversations where the agent did the wrong thing.
- The API token and gateway token are single shared secrets, not per-user auth.
- Not built yet: an MCP transport for the gateway, an in-repo SDK that applies rules as code, multi-turn attacks, and a persistent store for runs and sessions.

## How Antibody uses Weave

Everything the loop does is traced in the [`chaos-monkey` Weave project](https://wandb.ai/owentsao23-clad-labs/chaos-monkey/weave); this is what to look for there, and what the dashboard reads back.

- **Cost is Weave's number, not ours.** The loop registers the W&B Inference price table with Weave at start, so every model call in a trace is priced by Weave. Each cycle's `cost_usd` is read back from its trace when it can be, and the record says `cost_source: weave`; when Weave cannot price a call (an unregistered model, an outage) the cycle keeps the in-process estimate from the same table and says `estimated`. The run report labels the total the same way — one estimated cycle makes the sum an estimate.
- **One thread per conversation.** An episode runs inside a Weave thread named by its session id, and the agent's tool calls join that thread through the `X-Antibody-Session` header. In the Threads view, one row is one conversation: the attack, the agent's model calls and its tool calls. The judge runs after the episode and is traced on its own, next to the thread rather than inside it.
- **Versions compared on one leaderboard.** The legit-user suite is one published Evaluation per run, reused by the baseline and by every gate, so the run's leaderboard (`antibody-<domain>-legit-<run stamp>`) lines every config version the run produced — accepted or rejected — up on the same rows and scorer. Its URL is on the run.
- **Gateway calls scored — opt-in.** `ANTIBODY_GATEWAY_WEAVE=1` (with a `WANDB_API_KEY`) makes the gateway trace each forwarded call as `gateway.tool_call` in the session's thread and score it with `ToolRuleScorer`, a deterministic scorer that re-runs the live rule and records whether it blocks and whether the gateway agreed. Shadow mode scores without blocking, which is how the guardrail doubles as a monitor. Off by default: a customer's gateway never phones home unless asked, and what it sends is the tool name, the arguments and the tool's result (both minus anything named like a credential, strings cut at 500 characters), the decision, the customer's turns, the version's rules and the session id as the thread id — never a request header, the gateway token, the backend bearer or the customer id.
- **Prompts are objects.** The judge's prompt and every config version's system prompt are published as `StringPrompt`s, versioned by content, and in a `run` each `TargetAgent` model version points at the prompt it was evaluated with (the `vulnerability` and `check` commands measure without publishing prompts).
- **Your decisions are feedback.** Approving or rejecting a version on the Review page adds a 👍 or 👎 and your note to the gate evaluation that admitted it, so the Evaluations view shows what a person thought of each accepted fix. Skipped silently when the API has no Weave client; never blocks the decision.
- **A monitor on the judge (set up in the UI).** `docs/SMOKE.md` has the recipe for an LLM-as-judge monitor over `judge_scorer` calls: sample 20 %, ask a W&B Inference model whether the verdict was justified by the typed facts. Not code; a one-time setup in Weave.

Weave is never load-bearing: without a key the loop's `check` refuses to run (every row is an evaluation), but the API, the gateway and the test suite run without one. The loop itself needs a key to start (`weave.init` and the dataset publish are not optional there); everything Weave-related past that point — cost readback, threads, the leaderboard, prompts, feedback, gateway scoring — fails soft and never changes a gate outcome.

## Repository map

| Path | What it is |
| --- | --- |
| `chaos/` | The loop: agents, tool bus, judge, gate, run state, Zendesk client. `python -m chaos.loop` is the entry point; `python -m chaos.gateway` is the enforcement gateway. |
| `chaos/domains/` | Domain packs (`retail`, `airline`): tools, seed records, policy text, legit tasks, attack families. |
| `api/` | FastAPI adapter the dashboard talks to: run files, loop control, replay, agents, approvals, incidents, schedules, gateway replay, bearer-token check. |
| `web/` | The dashboard (Vite + React). |
| `examples/agents/` | Agents Antibody can attack that are not its own: a stock OpenAI Agents SDK support agent and OpenAI's airline customer-service demo, each in its own venv. |
| `data/golden/` | A committed known-good run: cycle records, configs v0…vN, and the phase log the replay plays. |
| `runs/`, `history/` (gitignored) | The current run's files, and every previous run. |
| `scripts/` | `dev.sh` (both servers), the Zendesk OAuth helper, and the spikes that de-risked W&B Inference and Zendesk. |
| `docs/` | `SMOKE.md` (the ten-minute manual checklist), `FRONTEND.md` (UI spec and API contract), `plans/` (design decisions, research, and the handoff reports for every build lane). |

See `docs/plans/10-production-fit.md` for the research behind the production shape — which real agents to test against, why deterministic checks gate and the LLM judge does not, what the gateway must promise — and the Weave project for every trace and evaluation.
