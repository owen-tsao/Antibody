# Antibody — self-healing for AI agents

[![CI](https://github.com/owen-tsao/Antibody/actions/workflows/ci.yml/badge.svg)](https://github.com/owen-tsao/Antibody/actions/workflows/ci.yml)

![Antibody](docs/hero.jpg)

Your support agent will be tricked. Someone will hide instructions in an order note, a lookup will time out at the wrong moment, a stranger will tell a sympathetic story about somebody else's account. Antibody gets there first: it attacks your agent on purpose, proves each failure, writes the rule that would have stopped it, and keeps that rule only if it fixes the break without undoing an earlier fix or hurting a normal customer. Every failure becomes a permanent test. The rules it keeps run in a small gateway between your agent and its tools, so your agent's code is never touched.

Built solo at CoreWeave Hacks (Agent Loops), San Francisco, September 12–13, 2026, then productionised over the two weeks after. It runs on W&B Inference and every episode, verdict, gate evaluation and cent is traced in the [`chaos-monkey` Weave project](https://wandb.ai/owentsao23-clad-labs/chaos-monkey/weave).

## The sixty-second version

We pointed Antibody at an agent we did not write: OpenAI's own [airline customer-service demo](https://github.com/openai/openai-cs-agents-demo), six agents with handoffs and guardrails, running on W&B Inference.

Antibody made the reservation lookup time out. The agent cancelled a flight it had never verified, booked a new one, and paid compensation, for a customer it had not looked up. No model had to judge that; a deterministic check on the tool calls caught it.

Repair proposed a rule: `cancel_flight`, `book_new_flight` and `issue_compensation` now require a verified lookup first. The gate replayed the attack twice, re-ran every earlier attack, and ran the legitimate-customer suite. The rule passed and shipped. Over the same twelve cycles the gate refused eleven other proposals, one of them because it broke a customer flow that had worked before. Total inference: about seven cents.

Then the gateway went in front of the agent's real tools in shadow mode and logged `would_block` for the same impersonation attempt. Flip it to `--enforce` and the call is blocked.

That run is `history/20260925T233010Z`, and every number above is in Weave.

## Try it

```bash
make setup                  # uv sync + npm ci
cp .env.example .env        # add your WANDB_API_KEY
make dev                    # API on :8000, dashboard on :5173
```

Open the dashboard, pick an agent, press **Heal**. Four orbs light up in turn as Chaos attacks, the agent answers, the Judge scores and Repair proposes; the results page shows what got through, what was fixed, and what it cost.

No key yet? `make demo` builds the dashboard and plays back the committed reference run on its original timeline.

The same loop from a terminal:

```bash
make run ARGS="--seeds 1 --chaos-cycles 1 --repair-attempts 2"   # one seed attack, one invented one, ~3 min
make check ARGS="--approved"                                      # re-verify the approved config; exits 1 on any failure
```

Runs never overwrite each other; the previous one moves to `history/<timestamp>/`. `ANTIBODY_DOMAIN=airline` swaps the domain pack.

## How it works

Four agents take turns, and a gate has the last word.

1. **Chaos** invents an attack for the world your agent lives in: a poisoned note in a record, a tool that returns garbage or hangs, a customer who is not who they say they are. It learns which families are landing and reads your agent's real traces to route around rules that already shipped.
2. **Target** is whatever you point it at: the built-in Northwind Support agent (Llama 3.1 8B on a sandbox storefront) or your own agent behind a URL.
3. **Judge** decides if the agent failed, deterministically wherever it can. Did a money or record-changing tool fire for something the customer never asked for? Did a lookup return someone else's record? Only the fuzzy cases go to an LLM, and it sees typed facts about the tool calls, never raw tool output, so an attack cannot talk its way past the judge either.
4. **Repair** proposes one fix from a fixed menu: per-tool rules (deny, require the customer's intent, require a prior lookup, cap the calls), plus prompt and guardrail edits for the sandbox.
5. **Gate** replays the new attack twice (one lucky pass does not count), replays every earlier attack, and runs a suite of legitimate customer tasks. A fix ships only if it closes the hole, holds every old fix, and leaves normal customers no worse off than production. It also says how many legit tasks were actually runnable against your agent, so an empty guard never reads as a passing one.

Then Chaos studies the new defences and goes again.

Attacks, legit tasks, seed records and the judge's checks come from a **domain pack** in `chaos/domains/`. Two ship: `retail` (orders, refunds, email, tickets) and `airline` (reservations, cancellations, rebooking, compensation). Packs describe attacks by tool *class* — money, message, record change, read — so one attack family works against any agent in that domain.

## What reaches production

The loop finds and fixes. These are the pieces that let a team actually run it.

- **Nothing ships itself.** Every version the gate accepts waits as *pending*. On **Review** you see its rules diffed against the last approved version, how many of your recorded real tool calls it would have blocked, and Approve or Reject. The highest approved version is *certified*, and `make check ARGS="--approved"` tests it in CI.
- **A gateway, shadow first.** `python -m chaos.gateway --backend <your tools> --version approved --shadow` runs the certified rules in front of your real tools and only logs what it would have blocked. Run it for a week, read the log, then switch to `--enforce`. If a tool cannot be reached, money and record changes fail closed. Approving a version reaches a running gateway within a minute.
- **A real incident becomes a test.** Paste a support transcript on an agent's page, pick the attack family, and it joins the regression suite every future gate has to pass.
- **Your tools, classified.** Connect an agent and each tool it lists gets a class and a proposed starter rule you can apply as a version in one click.
- **Attack on a schedule**, or whenever your agent's tools or version change.
- **One token** guards the API; another guards the gateway.

## Bring your own agent

Antibody needs three things: take a customer message, make tool calls where Antibody can see them, reply.

- **Accept an episode.** `POST /episode` with `{session_id, message, customer_id, customer_email, tools_url}`.
- **Call tools through `tools_url`.** `GET {tools_url}/tools` lists them; each call is `POST {tools_url}/tools/{name}` with the header `X-Antibody-Session: <session_id>`. Give Antibody the URL of your *real* tools and it forwards each call there after the fault and the rules have had their say.
- **Reply** with `200 {"reply": "…"}`.

A few lines of glue, none of it Antibody code. The agent's logic is untouched.

Two agents Antibody did not write are bundled in `examples/agents/`, each in its own venv, and the dashboard can start and stop them: **Northwind Support (Agents SDK)**, a stock OpenAI Agents SDK support agent, and **Skyward Air Support (Agents SDK)**, the OpenAI customer-service demo from the story above with its real tools served on a second port so Antibody can front them. Hosted agents with a conversation API work too: `ANTIBODY_TARGET=fin:<label>` drives Intercom Fin (built against Intercom's published API and a fake; not yet run on a live workspace).

## Weave, end to end

The short version; `docs/WEAVE.md` has the rest.

- **Cost is Weave's number.** The loop registers the W&B Inference price table with Weave and reads each cycle's cost back from its trace.
- **One thread per conversation.** The attack, the agent's model calls and its tool calls share a thread named by the session id.
- **Every version on one leaderboard.** The legit suite is one published Evaluation per run, so accepted and refused versions line up on the same rows.
- **Your decisions are feedback.** Approve or reject on Review and the gate evaluation gets a 👍 or 👎 with your note.
- **Prompts are objects**, versioned by content. **Gateway calls can be scored**, opt-in, with nothing sensitive sent.

Weave is never load-bearing: past `weave.init`, everything fails soft and never changes a gate's verdict.

## If you have ten minutes

Read these, in order. They are the whole argument.

1. `tests/test_e2e_passthrough.py` — the product in one test: an external agent breaks, a rule is proposed, the gate accepts it, a person approves it, the gateway enforces it. No model calls.
2. `chaos/gateway.py` — the only code that runs in a customer's stack. Auth, fail-closed by tool class, live policy reload, shadow mode.
3. `chaos/judge.py` and `chaos/gate.py` — why a verdict can be trusted: deterministic checks by tool class, typed facts to the LLM, pass twice, legit coverage.
4. `chaos/domains/airline/` — a domain pack, in five files.
5. `docs/plans/10-production-fit.md` — the research and the decisions, including what was rejected.

CI runs 522 tests (none need an API key), the web build and lint on every push. `docs/SMOKE.md` is the ten-minute manual checklist; `docs/plans/handoffs/` holds the report from every build lane and the independent review that gated each plan, blockers included.

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
