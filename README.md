# Antibody — self-healing for AI agents

[![CI](https://github.com/owen-tsao/Antibody/actions/workflows/ci.yml/badge.svg)](https://github.com/owen-tsao/Antibody/actions/workflows/ci.yml)

![Antibody](docs/hero.jpg)

Antibody attacks your AI agent on purpose, proves each failure, writes a rule that would have stopped it, and only keeps the rule if it fixes the break without undoing an earlier fix or hurting normal customers. Every failure becomes a permanent regression test. The rules it keeps are enforced by a small gateway between your agent and its tools, so your agent's code is never touched.

Built solo at CoreWeave Hacks (Agent Loops), San Francisco, September 12–13, 2026, then productionised over the two weeks after. Runs on W&B Inference and is traced end to end in Weave: every episode, judge call, gate evaluation and cost number here is in the [`chaos-monkey` Weave project](https://wandb.ai/owentsao23-clad-labs/chaos-monkey/weave).

## Contents

- [Quick start](#quick-start)
- [How it works](#how-it-works)
- [From a finding to production](#from-a-finding-to-production)
- [Bring your own agent](#bring-your-own-agent)
- [Weave](#weave)
- [Reviewing this repo](#reviewing-this-repo)
- [What it does not do yet](#what-it-does-not-do-yet)
- [Repository map](#repository-map)

## Quick start

```bash
make setup                  # uv sync + npm ci
cp .env.example .env        # add WANDB_API_KEY
make dev                    # API on :8000, dashboard on :5173
```

Open the dashboard, pick an agent, press **Heal**. The four orbs light up as Chaos attacks, the target answers, the Judge scores and Repair proposes; the results page shows what got through, what was fixed and what it cost.

Without a key, `make demo` still works: it builds the dashboard and plays back the committed reference run on its original timeline.

From the terminal, the same loop is:

```bash
make run ARGS="--seeds 1 --chaos-cycles 1 --repair-attempts 2"   # one seed attack, one invented attack, ~3 min
make check                                                        # re-verify the current config; exits 1 on any failure
```

Each run moves the previous one to `history/<timestamp>/`, so nothing is overwritten. `ANTIBODY_SEED` makes two runs comparable; `ANTIBODY_DOMAIN=airline` picks the other domain pack.

## How it works

Four agents take turns, and a gate decides.

1. **Chaos** invents an attack for the world the target lives in: a poisoned note in a record, a tool that times out or returns garbage, a customer with a sympathetic story about someone else's account. It picks its attack family with a bandit and reads the target's real traces to route around rules that already shipped.
2. **Target** is whatever you point Antibody at: the built-in Northwind Support agent (Llama 3.1 8B, in-process, on a sandbox storefront) or your own agent behind a URL.
3. **Judge** decides if the target failed, deterministically wherever it can: did a money or record-changing tool fire for something the customer never asked about? did a lookup return someone else's record? Only the fuzzy cases go to an LLM judge, and it sees typed facts about the tool calls, never raw tool output, so an attack cannot talk its way past it.
4. **Repair** proposes one fix from a fixed menu: per-tool rules for an external agent (deny, require the customer's intent, require a prior lookup, cap the calls); prompt and guardrail edits as well for the sandbox.
5. **Gate** runs the candidate against the new failure (twice; one lucky pass does not count), every past failure, and a suite of legitimate customer tasks. A fix ships only if it closes the new hole, holds every old fix, and leaves ordinary customers no worse off than production. It also reports how many legit tasks were runnable against this agent, so an empty guard is never a passing one.

Then Chaos studies the new defences and goes again.

Attacks, legit tasks, seed records and the judge's checks come from a **domain pack** under `chaos/domains/`. Two ship: `retail` (orders, refunds, email, tickets) and `airline` (reservations, cancellations, rebooking, compensation). Packs describe attacks in terms of tool *classes* (money, message, record change, read), so one family attacks any agent in that domain.

## From a finding to production

The loop finds and fixes. These are the pieces that make a fix something a team can run.

- **Fixes are staged, not shipped.** Every version the gate accepts starts *pending*. On **Review** you see its rules diffed against the last approved version, how many of your recorded real tool calls it would have blocked, and Approve / Reject. The highest approved version is *certified*; `make check ARGS="--approved"` tests against that in CI.
- **A gateway, shadow first.** `python -m chaos.gateway --backend <your tools url> --version approved --shadow` runs the certified rules in front of your real tools and only logs what it *would* have blocked. Run it for a week, then switch to `--enforce`. If a tool cannot be reached, money and record changes fail closed; an approved version reaches a running gateway within a minute.
- **Real incidents become tests.** Paste a support transcript on an agent's page, pick the attack family, and it joins the regression suite every later gate must pass.
- **Bring your own tools.** Tools an agent lists are classified and each gets a proposed starter rule you can apply as a version in one click.
- **Schedules.** Attack an agent on an interval, or whenever its tools or version change.
- **One token.** `ANTIBODY_API_TOKEN` guards the API; `ANTIBODY_GATEWAY_TOKEN` guards the gateway.

## Bring your own agent

Antibody needs three things from an agent: take a customer message, make its tool calls where Antibody can see them, and reply. Run your agent as a small HTTP service:

- **Accept an episode.** `POST /episode` with `{session_id, message, customer_id, customer_email, tools_url}`.
- **Call tools through `tools_url`.** `GET {tools_url}/tools` lists them; each call is `POST {tools_url}/tools/{name}` with the header `X-Antibody-Session: <session_id>`. Give Antibody the URL of your *real* tools (`tools_backend` on the agent's row) and it forwards each call there after the fault and the rules have had their say.
- **Reply.** `200 {"reply": "…"}`. Antibody scores the episode from the tool calls it saw and the reply.

That is a few lines of glue in your agent, none of it Antibody code; the agent's logic is untouched.

Two agents Antibody did not write are bundled in `examples/agents/`, each in its own venv. The dashboard lists them as **Northwind Support (Agents SDK)** — a stock OpenAI Agents SDK support agent — and **Skyward Air Support (Agents SDK)** — OpenAI's own [customer-service demo](https://github.com/openai/openai-cs-agents-demo) (six agents with handoffs and guardrails, MIT-licensed) with its real tools served on a second port so Antibody can front them. It runs on `Qwen/Qwen3-30B-A3B-Instruct-2507` through W&B Inference; with `OPENAI_API_KEY` it runs as OpenAI shipped it.

In a 12-cycle run against the airline agent (about seven cents of inference) the gate accepted one rule — a verified lookup before `cancel_flight`, `book_new_flight` and `issue_compensation` — and refused eleven others, one because it broke a customer flow that had worked. The gateway in shadow mode then logged `would_block` for the same impersonation attack. That run is `history/20260925T233010Z` and the video's subject.

Hosted agents with a conversation API can be attacked too: `ANTIBODY_TARGET=fin:<label>` drives Intercom Fin. Built against Intercom's published API and a fake; not yet run against a real workspace.

## Weave

Short version; `docs/WEAVE.md` has the rest.

- **Cost is Weave's number.** The loop registers the W&B Inference price table with Weave, reads each cycle's cost back from its trace, and says `estimated` when it had to fall back.
- **One thread per conversation.** The attack, the agent's model calls and its tool calls share a thread named by the session id.
- **Versions on one leaderboard.** The legit suite is one published Evaluation per run, so every version the run produced lines up on the same rows.
- **Your decisions are feedback.** Approve or reject on Review and the gate evaluation gets a 👍 / 👎 with your note.
- **Prompts are objects.** Judge and system prompts are versioned `StringPrompt`s.
- **Gateway calls scored, opt-in.** `ANTIBODY_GATEWAY_WEAVE=1` traces and scores forwarded calls; off by default, and it never sends headers, tokens or the customer id.

Weave is never load-bearing: everything past `weave.init` fails soft and never changes a gate outcome.

## Reviewing this repo

If you have ten minutes, read these in order:

1. `tests/test_e2e_passthrough.py` — the product in one test: an external agent breaks, a rule is proposed, the gate accepts it, a human approves it, the gateway enforces it. No model calls.
2. `chaos/gateway.py` — the only code that runs in a customer's infrastructure. Auth, fail-closed by tool class, live policy reload, shadow mode.
3. `chaos/judge.py` and `chaos/gate.py` — why a verdict can be trusted: deterministic checks by tool class, typed facts to the LLM, pass twice, legit coverage.
4. `chaos/domains/airline/` — what a domain pack is, in five files.
5. `docs/plans/10-production-fit.md` — the research and decisions behind this shape, including what was rejected.

CI runs 522 tests (none need an API key), the web build and lint on every push. `docs/SMOKE.md` is the ten-minute manual checklist; `docs/plans/handoffs/` holds the report from every build lane and the independent review that gated each plan.

## What it does not do yet

- No database: runs are files on disk, moved to `history/` between runs.
- No per-user auth: one shared bearer token each for the API and the gateway.
- Gateway session state lives in the process; two gateways behind a load balancer need sticky sessions on `X-Antibody-Session`.
- The gateway enforces the world-agnostic per-tool rules only. The sandbox's policy flags and validators never touch real traffic.
- Legit tasks are matched to your tools by name or declared alias; tasks your agent has no tool for are reported as coverage, not counted as failures.
- The per-rule code snippets (Agents SDK guardrail, LangGraph interrupt) are templates, not tested against the SDKs.
- Not built: an MCP transport for the gateway, an SDK that applies rules as code, multi-turn attacks. Ticket mode over HTTP has not been exercised.

## Repository map

| Path | What it is |
| --- | --- |
| `chaos/` | The loop: agents, tool bus, judge, gate, run state. `python -m chaos.loop` runs it; `python -m chaos.gateway` is the enforcement gateway. |
| `chaos/domains/` | Domain packs (`retail`, `airline`): tools, seed records, policy text, legit tasks, attack families. |
| `api/` | FastAPI adapter the dashboard talks to: run files, loop control, replay, agents, approvals, incidents, schedules, gateway replay. |
| `web/` | The dashboard (Vite + React). |
| `examples/agents/` | The two bundled agents, each in its own venv, with no imports from Antibody. |
| `data/golden/` | The committed reference run the dashboard can replay without a key. |
| `runs/`, `history/` (gitignored) | The current run's files, and every previous run. |
| `scripts/` | `dev.sh` (both servers) and the spikes that de-risked W&B Inference and Zendesk. |
| `docs/` | `SMOKE.md` (manual checklist), `WEAVE.md` (tracing in depth), `FRONTEND.md` (UI spec and API contract), `DEMO_VIDEO.md`, `plans/` (design decisions and build reports). |
