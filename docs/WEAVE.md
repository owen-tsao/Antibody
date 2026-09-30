# How Antibody uses Weave

Everything the loop does is traced in the [`chaos-monkey` Weave project](https://wandb.ai/owentsao23-clad-labs/chaos-monkey/weave).
This is what to look for there, and what the dashboard reads back. The README carries the short version; this page
is the full one.

## Cost is Weave's number, not ours

The loop registers the W&B Inference price table (`chaos/config.py` `PRICE_PER_MILLION_USD`) with Weave at start, so
every model call in a trace is priced by Weave. Each cycle's `cost_usd` is read back from its trace when it can be, and
the record says `cost_source: weave`; when Weave cannot price a call (an unregistered model, an outage) the cycle keeps
the in-process estimate from the same table and says `estimated`. The run report labels the total the same way — one
estimated cycle makes the sum an estimate.

## One thread per conversation

An episode runs inside a Weave thread named by its session id, and the agent's tool calls join that thread through the
`X-Antibody-Session` header. In the **Threads** view, one row is one conversation: the attack, the agent's model calls
and its tool calls. The judge runs after the episode and is traced on its own, next to the thread rather than inside it.

An external agent's tool calls appear as root traces rather than nested under the episode; they do share the
episode's thread, so the Threads view still shows the conversation as one row.

## Versions compared on one leaderboard

The legit-user suite is one published Evaluation per run, reused by the baseline and by every gate, so the run's
leaderboard (`antibody-<domain>-legit-<run stamp>`) lines every config version the run produced — accepted or
rejected — up on the same rows and scorer. Its URL is on the run (`weave_leaderboard_url`).

## Gateway calls scored — opt-in

`ANTIBODY_GATEWAY_WEAVE=1` (with a `WANDB_API_KEY`) makes the gateway trace each forwarded call as `gateway.tool_call`
in the session's thread and score it with `ToolRuleScorer`, a deterministic scorer that re-runs the live rule and
records whether it blocks and whether the gateway agreed. Shadow mode scores without blocking, which is how the
guardrail doubles as a monitor.

Off by default: a customer's gateway never phones home unless asked. What it sends when asked: the tool name, the
arguments and the tool's result (both minus anything named like a credential, strings cut at 500 characters), the
decision, the customer's turns, the version's rules and the session id as the thread id. Never a request header, the
gateway token, the backend bearer or the customer id.

## Prompts are objects

The judge's prompt and every config version's system prompt are published as `StringPrompt`s, versioned by content.
In a `run`, each `TargetAgent` model version points at the prompt it was evaluated with. The `vulnerability` and
`check` commands measure without publishing prompts.

## Your decisions are feedback

Approving or rejecting a version on the Review page adds a 👍 or 👎 and your note to the gate evaluation that admitted
it, so the **Evaluations** view shows what a person thought of each accepted fix. Skipped silently when the API has no
Weave client; never blocks the decision.

## A monitor on the judge (set up in the UI)

`docs/SMOKE.md` has the recipe for an LLM-as-judge monitor over `judge_scorer` calls: sample 20 %, ask a W&B
Inference model whether the verdict was justified by the typed facts. Not code; a one-time setup in Weave.

## What Weave is never allowed to do

Weave is never load-bearing. Without a key the loop's `check` refuses to run (every row is an evaluation), but the
API, the gateway and the test suite run without one. The loop itself needs a key to start (`weave.init` and the
dataset publish are not optional there); everything Weave-related past that point — cost readback, threads, the
leaderboard, prompts, feedback, gateway scoring — fails soft and never changes a gate outcome.
