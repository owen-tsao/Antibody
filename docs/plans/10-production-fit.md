# Plan 10 — Fitting Antibody to real agents

Owen's brief (Sep 21, 23:25): research how the industry tests and hardens production agents, answer "how does this
work with a real agent — is it a repo, a URL, what?", then plan a proper split. Nothing here is built yet; this
document is the research and the proposed order. Decisions still open are listed at the end and put to Owen in chat.

## 1. What is true today (read from the code, Sep 21)

- **A customer's agent is a URL, not a repo.** Antibody requires exactly one endpoint, `POST {url}/episode`, with
  `{session_id, message, customer_id, customer_email, tools_url}` in and `{reply}` out (`chaos/target.py:59-96`).
  `GET /tools` is optional and used only by the connect screen and `on_change` schedules.
- **Antibody never sees their prompt or code.** The example agent embeds its own copy of the Northwind prompt
  (`examples/agents/openai_agents_support/agent.py:35-37`). For an HTTP target, Repair may only produce
  `tighten_tool_policy` and `add_tool_validator` (`chaos/target.py:28-31, 68`); `rewrite_system_prompt` and
  `add_guardrail_rule` are refused.
- **What is under test is their decision-making**: model, prompt, orchestration, framework guardrails. Antibody sees
  the tool calls (through its tool server, `X-Antibody-Session`) and the final reply. Their tool *implementations*
  are under test only when `tools_backend` pass-through is set; then `POST {tools_backend}/tools/{name}` is called
  and only `ToolRule`s and scenario faults run (`chaos/toolbus.py:33-36, 135-162`).
- **Only `ToolRule`s survive to production.** The seven policy flags and every validator read the mock `ORDERS`
  and are skipped in pass-through and in the gateway (`chaos/schemas.py:33-35`, `chaos/toolbus.py:135-141`).
- **Northwind is not a fixture, it is wired through everything.** `ORDERS` lives in `chaos/tools.py:20-24` and is
  imported by the judge (`chaos/judge.py:17`) and the chaos agent (`chaos/chaos_agent.py:346`); seeds and the legit
  suite hard-code `A-1001`/`A-1002`/`B-2001` (`chaos/scenarios.py:73-111, 172-261`); the chaos prompt hard-codes
  the three tool signatures (`:48`). Every deterministic judge check names a sandbox tool and reads `ORDERS`.
- **Never exercised:** the customer side of `tools_backend` (plan 09 §4 says so; no real agent has run it); the
  gateway forwards no session header to the backend (`chaos/toolbus.py:156`); there is no MCP or A2A anywhere.

## 2. What the research says

Sources are linked in §6. Verified = read in the source; inferred = my conclusion from several sources.

**How others connect to "a real agent".** Two modes, everywhere:
- *Black box (URL).* promptfoo's HTTP target, Coval's "agent connection", Maxim's workflow endpoint. Same as our
  `/episode`. LangGraph Server additionally speaks A2A (`POST /a2a/{assistant_id}`, `message/send`); the OpenAI
  Agents SDK declined A2A. Verified.
- *White box (code).* promptfoo's `file://agent.py` provider with a `call_api(prompt, options, context)` function;
  Glassray "lands in your repo as a diff"; Relios "pinpoints which sentence… broke". Verified. This is the only mode
  in which anyone produces a *code* diff.

**How others make the sandbox real.** Three patterns, all used commercially:
- *Domain packs* (τ-bench, τ²-bench, AgentDojo): a domain = database schema + seeded data + tools + a written
  policy + tasks with a checkable goal. τ²-bench generated telecom by prompting an LLM for a PRD, then the schema,
  tools, mock DB and unit tests, then hand-fixing until tests pass. Retail/airline/telecom are MIT and include a
  simulated user. Verified (repo licenses checked Sep 21).
- *Digital twins of real SaaS* (Veris, Arga, Pome): stateful copies of Stripe/Zendesk/Slack with the same endpoints
  and webhooks. Big engineering; a company in itself. Verified.
- *Record and replay* (AgentReplay, SpecOps): freeze production traces, replay tool responses deterministically,
  assert on tool calls and side-effects. Verified.

**How others judge.** τ-bench compares the *database end-state* to a goal state rather than reading the
transcript; AgentDojo has a `utility` check (did the user task happen) and a `security` check (did the injected task
happen) per task, and reports pass^k over repeated trials because agents are inconsistent. Our judge reads the
transcript and tool calls; it cannot see state unless the sandbox is ours. Verified.

**Where fixes live.** CaMeL (DeepMind) and its follow-ups argue defenses must sit *outside* the model — capabilities
checked at the tool call — because prompt-level rules can be argued around. In 2026 this is a product category:
Invariant Guardrails/Gateway, Intercept, mcpfw, AgentWard, hoophq/mcpproxy all enforce YAML/DSL rules on
`tools/call` at the transport, almost all as **MCP proxies**, with block/log("shadow")/approval modes. Verified.
The OpenAI Agents SDK's own primitives for the same idea are `tool_input_guardrails` and `needs_approval`;
LangGraph's is `interrupt()` before the side-effect node. Verified.

**Who else closes the loop.** A 2026 cohort — Converra, Relios, ClosedLoop, Glassray, Kytte — mines production
traces, proposes prompt/policy/code fixes, regression-tests them, and gates deploys. None of them attacks the agent
first, and none ships the fix as a runtime enforcement rule. Verified from their pages (inferred: marketing pages,
not product trials).

**Inferred product framing.** The market has three separate categories: simulation/eval (Coval, Maxim, Veris),
runtime enforcement (Invariant, Lasso, Lakera — now acquired for $300M), and closed-loop improvement (Converra,
Relios). **Corrected after loop-1 research (Sep 22):** the "attack produces the runtime rule" idea is *not* unique.
Promptfoo Enterprise's Adaptive Guardrails turn red-team failures into production blocking policies (verified in
their docs); Lakera pairs Red with Guard. Both, however, produce **input-prompt classifiers** (200–500 ms, judged
by a model, on the text going in). Antibody's rule is a **deterministic check on the tool call** — the CaMeL
position: enforce at the action, not the prompt — and it ships only after passing a regression suite, a legit-user
suite, and a human approval. That combination — attack → deterministic action rule → gated → approved → enforced —
is the narrower, defensible claim. The kill condition stands: if customers will not put a proxy in front of their
tools, the enforce link dies and Antibody is one more simulator.

**Where the buyer's agent actually runs (loop-1 research).** Most production support agents are not self-built:
Intercom Fin, Decagon, Sierra, Ada, Forethought. Verified: Fin calls the customer's systems through *Data
connectors* — an HTTPS URL, method and headers the customer configures, manageable via a Configuration API — and
Decagon/Sierra likewise act "through APIs". This means the **tool proxy is insertable even for a hosted agent**: the
customer points the connector at Antibody's gateway instead of their API. The **attack side** is the open question:
hosted platforms need a way to be *talked to* per turn (Fin has a Fin Agent API with `procedures/{id}/run`; whether
it can drive a full conversation is **unverified**). Three deployment shapes therefore exist, and the plan must
name which it serves first:

| Shape | Attack entry | Tool proxy | Fix layer |
| --- | --- | --- | --- |
| Self-built agent (LangGraph, Agents SDK, custom) | `POST /episode` shim | `tools_backend` / MCP | 0 now, 1 soon, 2 later |
| Hosted platform (Intercom Fin, Decagon, Sierra) | **Fin: verified** — Fin Agent API `POST /fin/start` + `/fin/reply`, status `awaiting_user_reply` → read `fin_replied`; access via request form. Decagon/Sierra: unverified | gateway as the Data-connector URL | 0 only |
| SDK / in-repo | `antibody run agent.py` | in-process | 0, 1, 2 |

First target is the self-built shape (it is what discovery reaches and what the code supports). The hosted shape
is the larger market; the gateway already fits it, and for Fin the attack entry is a second `Target` class
(`FinTarget`: start → poll status → reply), scheduled as A7 once a Fin workspace is available.

**Evaluation validity (loop-1 research).** Three 2026 papers matter for A2 and the gate:
- *GAUGE* (arXiv 2609.12191): on τ²-bench, LLM-judge "satisfaction" carries essentially no information about task
  success (57.5% of "satisfied" transcripts failed the task); the judge ranks well across a wide capability span but
  its decision-disagreement rate jumps from <1% to 31% on near-equal pairs. **Our gate compares near-equal pairs**
  (before vs after one patch) — the exact regime where a transcript judge is unreliable.
- *Lost in Simulation* (2601.17087) and *Sim2Real* (2603.11245): LLM-simulated users shift agent success by up to
  9 pp across simulator models and are too cooperative; state-based rewards and human judgement also disagree.
- Consequences, folded into A2/C2: the **gate's fixed/not-fixed decision must rest on deterministic checks**
  (state or tool-call), with the LLM judge only breaking ties it is calibrated for; report **pass^k** (k = the
  gate's sample count) rather than a single pass; keep **imported incidents** (real transcripts) as the judge's
  calibration set and show judge-vs-deterministic agreement on them; treat the chaos agent's persona as a variable
  and run at least two attacker models before calling a family "blocked".
- **The judge can itself be injected.** AgentDojo deliberately refuses an LLM evaluator because "if such an attack
  were particularly successful, there is a chance that it would also hijack the evaluation model." Our LLM-judge
  fallback reads the transcript that contains the injection. Mitigation for A2: the judge never sees raw tool
  output — it sees the tool-call list, the deterministic verdicts, and the agent's reply, with tool results
  summarised into typed facts (`returned record for id X`, `returned error`) by code, not by a model.
- **Expected calls are a reference, not the only path.** τ²-bench replays one reference trajectory to derive the
  goal DB state and passes any trajectory reaching it; AgentDojo's `ground_truth` uses `...` for arguments that
  do not matter. A2's `expected_calls` adopts both: match on a declared arg subset, and compare **end state**
  when the pack owns the data, so an agent that cancels then rebooks in a different order still passes.

**Approval as a real decision (loop-2 research).** Policy-as-code practice (Permit, OPA/GitOps): treat a rule
change like a code change — preview environment, unit tests, and **replay recent real decisions against the new
policy to flag any that come out differently**. Antibody already has the log (`history/gateway.jsonl`) and the
rules are pure functions. B1 gains one panel: *"this rule would have blocked N of the last M real calls"*, computed
by re-running `tool_rule_blocks` over the shadow log. That is the difference between approving a guess and
approving a decision, and it is cheap.

**Gateway as production infrastructure (loop-1 research).** Practitioner consensus (Twilio's LLM-gateway
postmortem, guardrail-latency guides): a guardrail in the request path is an unreliable dependency; decide
fail-open vs fail-closed per check — "the default is the worst case you can live with"; give it a strict time
budget so the LLM, not the guardrail, is the rate-determining step; track p99 per route, not aggregate; alert on
every bypass. For Antibody's gateway this becomes a written contract in C2: **fail-closed for money and mutate
classes, fail-open-and-log for read and message**, configurable per tool; a per-call budget for the rule check
(target ≤ 5 ms — the rules are pure functions, no model call) and a per-call timeout to the backend; p99 per tool in
`gateway.jsonl`; a health endpoint that reports the policy version in force.

## 3. Answers to Owen's questions

**The pitch (Sep 22).**

> **Antibody is an immune system for AI support agents.** Point it at your agent — we never see your code. It
> plays your worst customers: prompt injections hidden in order data, social engineers asking for someone else's
> refund, tools that time out mid-conversation. Every time an attack lands, Antibody writes a rule that would have
> stopped it — not a prompt tweak, a hard check on the tool call — proves the rule against your real customers'
> conversations, and hands it to you to approve. Approved rules run as a proxy in front of your tools, so the same
> attack can never land twice. Your agent gets safer every night without anyone editing it.

Three lines for a judge: *Attacks your agent. Writes the rule that stops it. Enforces it where the model can't
argue.* The trust claims, all true today: never touches their code; rules are deterministic checks, not another
model; nothing enforces without a human approving it; shadow mode logs for a week before it blocks anything.

**"Explain the diff / changing their code, simply."** Think of their agent as a person at a help desk, and their
tools as the drawers that person can open (refunds, emails, customer records). Antibody never retrains the person.
It puts locks on the drawers. When an attack tricks the person into opening the refund drawer for the wrong
customer, Antibody writes a lock rule — *"refund drawer only opens after a record lookup for that same customer"* —
tests the lock against a week of real requests to make sure honest customers still get their refunds, and asks you
to approve it. The **diff** you review is the lock list before and after: which drawer, which condition. It is
short, it is readable, and it applies to any agent because drawers are the same everywhere. Changing the *person*
(their prompt, their code) is the later layer, only possible if they hand us the repo, and it is never the thing that
protects them in production — the locks are.

**"Would the agent be in a repo or what?"** A URL, today and for the first customers. Their agent runs wherever it
runs; onboarding asks for the URL and, for real tools, a second URL (`tools_backend`) or — after Track A4 — an MCP
URL. The repo only enters when we want to hand back a *code* change; that is a second, later integration mode
(`antibody run ./agent.py`, the promptfoo pattern) and it needs a framework adapter per SDK.

**"How do we have diffs if they only post a link?"** There are three layers of fix, ordered by how much access we
need. The Review page shows whichever layer applies.

| Layer | Needs | What the diff is | Status |
| --- | --- | --- | --- |
| 0. Gateway rule | URL only | `tool_rules` before/after — deny, needs-intent, verified-lookup, max-calls per tool | Exists (`configDiff`, approvals) |
| 1. Suggested change | URL only | A framework-native snippet they paste: OpenAI SDK `tool_input_guardrail` / `needs_approval`, LangGraph `interrupt`, or a prompt addendum for anything else | Not built |
| 2. Applied change | Repo / SDK mode | A real git diff to their prompt file or guardrail config, opened as a PR | Not built; needs adapters |

Layer 0 is the production product (it is what the enforcement gateways sell). Layer 1 is cheap and is what the
IDE-style page shows on the right for an external agent. Layer 2 is the "in-line editor" idea and is a quarter away.

**"It's their harness being tested, right?"** Yes. In sandbox mode: their model + prompt + orchestration +
guardrails, against our tools and our data. In pass-through mode: all of that plus their tool implementations,
against their staging data. Not tested in either mode: their production data, their auth, their UI.

**"How do we move away from Northwind?"** Make "Northwind" one *domain pack* among several, and make the chaos
agent and judge read the domain from the session instead of importing `ORDERS`. The second and third packs come
from τ²-bench (airline, telecom — MIT, with tools, seeded DB, policy text and tasks). A customer's own domain is
then either a pack we generate from their `GET /tools` + a PRD-style prompt (τ²-bench's own method) or, simpler,
their staging environment behind `tools_backend`.

**"What real agent can we test on?"** In order of realism versus effort:
1. `openai/openai-cs-agents-demo` — OpenAI's official airline customer-service demo on the Agents SDK, with
   booking/cancellation/refund tools. MIT. One `/episode` route to add. Same SDK as our example agent.
2. Owen's Clad helpdesk agent — real, in production, real tools, Owen controls it. Unverified: how much work a
   `/episode` shim is; that is the first check to run.
3. τ²-bench's reference agent — already has a simulated user and three domains; lets us compare our judge to a
   state-based one on the same transcripts.
4. `negativexq/agentic-customer-service-platform` — LangGraph, refunds/cancellations with policy controls; the
   LangGraph integration test once one SDK works.

## 4. The split

Three tracks. A is the bet; B is the thing customers see; C is what keeps A and B from falling over. They run in
that priority, and C is sliced into every week rather than saved for the end.

### Track A — Fit to real agents

| # | Slice | Why first | Kill / done signal |
| --- | --- | --- | --- |
| A1 | **Domain pack abstraction.** `Domain = {name, tools, seed data, policy text, legit tasks, attack families, judge facts}`. `chaos/tools.py` becomes `domains/retail`. Chaos and judge take the domain from `ToolSession`, never import `ORDERS`. | Every other slice inherits this coupling (report §1). | All 325+ tests pass with Northwind as a pack; `grep ORDERS chaos/judge.py chaos/chaos_agent.py` is empty. |
| A2 | **Second pack from τ²-bench airline.** Import tools + DB + policy; write 4 attack families in class terms (money / message / mutate / read) using `tool_rules.py` classification. | Proves the abstraction with someone else's domain. | Builtin agent attacked in airline with zero Northwind words in any prompt. |
| A3 | **First real agent.** `/episode` shim for `openai-cs-agents-demo` (and Clad if the shim is an afternoon). Run pass-through with its tools as `tools_backend`. | The `tools_backend` server side has never run. | One full run → patch → approve → gateway shadow log, on an agent we did not write. |
| A4 | **MCP transport** for tool server and gateway (streamable-HTTP). Agents that already use MCP change one URL; no code. Needs the `mcp` package — ask before adding. | Every 2026 enforcement product is an MCP proxy; it is the zero-code BYOT. | Example agent with tools via MCP, all rules enforced. |
| A5 | **Onboarding for real agents.** Wizard asks for tools URL (REST or MCP), shows the classification and starter rules, runs a 3-cycle smoke attack before "done". | The wizard stops at "connect a URL" today. | A stranger connects the cs-agents demo without reading the README. |
| A6 | **Multi-turn scenarios** (roadmap #20). `Scenario` grows a turn list; the chaos agent plays the customer across turns, reusing the gateway's `customer_turns` seam. | Real social engineering builds trust before asking. | A social-engineering attack that fails single-turn and lands in three turns, judged correctly. |
| A7 | **`FinTarget`** — a second `Target` class for Intercom Fin (`/fin/start`, poll `awaiting_user_reply`, `/fin/reply`), gateway as the Data-connector URL. | The hosted shape is most of the market; the API is verified to exist. | Needs a Fin workspace with Agent API access; scheduled when one is available. |

**A5's concrete bar (loop-2 research):** promptfoo's red-team onboarding is `init → run → report`, three commands
and one config file, first result in minutes. Antibody's equivalent is: paste URL → ping → tools appear classified
with starter rules → a **3-cycle smoke attack runs before the wizard says "done"** and shows one real finding. Time
to first finding under ten minutes, no README.

Track A kill condition: if after A3 a real agent's tool calls cannot be judged without Northwind knowledge, or if
discovery (plan 06) finds no team willing to put a proxy in front of tools, stop and re-plan around simulation only.

**Decided Sep 21 (grill round 3) — the shape of Track A:**

- **A3 runs before A1**, as a two-day spike. The demo's airline tool names match none of the judge's deterministic
  checks, so the LLM judge decides alone and the demo can be attacked today; what breaks scopes A1.
- **A3 connects in pass-through**: the demo's in-memory tool functions are wrapped in a small `/tools/{name}`
  server and set as `tools_backend`. This is the never-exercised path and the point of the spike.
- **A domain pack mirrors τ²-bench**: `domains/<name>/{tools.py, db.json, policy.md, tasks.json, attacks.json}` —
  code only for tool behaviour, data for everything else. Northwind becomes `domains/retail`.
- **Expected state is a set of write calls**: each pack-mode scenario lists the `(tool, args)` a correct run must
  make and must not make; the judge compares against recorded calls (τ-bench's method). Pass-through keeps the
  transcript + tool-call judge.
- **A2 ships five families in tool-class terms** — injection via read output → forbidden money/message; garbage or
  timeout from a read → any mutate on no data; social engineering for another customer's record → leak or
  unauthorized mutate; ambiguous request → over-refusal or wrong record; exfiltration — read output smuggled into a
  message tool to an outside address. **Budget abuse** (many small money calls under a per-call cap) needs a
  `ToolRule.max_total` spend field first and is the last A2 item.
- **C1 is a written 10-minute checklist plus one pytest** that drives connect → run → approve → gateway through the
  API with `FakeAgent`. No browser e2e dependency.

**Decided Sep 21 (grill round 4):**

- The demo lives at `examples/agents/openai_cs_airline/` — vendored (or submodule) with our two shim files beside
  it, the same layout as `examples/agents/openai_agents_support/`.
- A2's airline pack is **ours**: seed data and tasks written for our attack families; τ²-bench is used for tool
  names, policy text and task ideas, not imported wholesale (their tasks test goal completion, not attacks, and
  their tool signatures are unverified against `/tools/{name}`).
- The **LLM judge stays as the fallback everywhere**; deterministic checks and state checks run first and
  short-circuit. Disagreement surfacing (roadmap #4) stays deferred.
- **Execution: independent review of this plan first**, then one chat runs C1 → A3 spike → A1 → A2 sequentially
  (they share `judge.py`, `scenarios.py`, `toolbus.py`), with B1 in a second UI-only chat.

### Track B — Fix delivery and the Review page

| # | Slice | Notes |
| --- | --- | --- |
| B1 | **Review page** at `/app/review`: approval queue on the left (pending versions), pseudo-files (prompt, guardrails, validators, per-tool rules) as a file tree, diff vs last *approved* on the right, "fixes cycle N: <title>" on top, Approve/Reject. Read-only; reuses `configDiff`, `/api/approvals`, run-embedded `configs`. No editor dependency. **Replaces** the Agent page's approve panel. Adds the **shadow-replay panel**: "would have blocked N of the last M real calls", from re-running the rules over `gateway.jsonl`. Hides Antibody-internal pseudo-files for HTTP targets. | Layer 0 above. Three–four days. |
| B2 | **Layer-1 export.** For each accepted `ToolRule`, render the framework snippet (OpenAI SDK, LangGraph, generic prompt addendum) with a copy button on the Review page. Pure derive + templates. | One day. Makes the page useful for external agents. |
| B3 | **SDK mode** `antibody run ./agent.py` + first adapter (OpenAI Agents SDK): run their agent in-process, patch their prompt/guardrail file, show a real diff, optional PR. | Layer 2. After A is proven; a quarter's item. |

### Track C — Hardening, security, cleanup (sliced weekly)

| # | Slice | Notes |
| --- | --- | --- |
| C1 | **Manual smoke checklist** (10 min, written, run at the end of every build session) + one end-to-end pytest through the API with `FakeAgent`. | This week, before anything in A. |
| C2 | **Pass-through and gateway correctness:** forward a session header to `tools_backend`; auth on the gateway (`X-Antibody-Customer` is unauthenticated); per-call timeouts and body limits both ways; idle-session GC test. | Found in §1. Security-review pass after. |
| C3 | **Storage and ops:** SQLite (or one JSONL per run) behind `api/store.py`; loop backoff; structured logs; gateway log rotation. | Only after a second user exists; not before. |
| C4 | The remaining items from the 27-idea review (below), in the order they block A/B. | Numbers are the original roadmap ids. |

**Where each of the 17 open roadmap items lands.** Sizes are from the Sep 21 review; "absorbed" means the
track slice above already is that item.

| # | Item | Size | Track | Note |
| --- | --- | --- | --- | --- |
| 6 | Per-tool attack families | L | **A2** | Absorbed: class-level families (money / message / mutate / read) are A2. |
| 20 | Multi-turn scenarios | M | **A6** (new) | `Scenario` carries one message; the gateway's `customer_turns` is the only seam. Social engineering needs trust-building turns. After A3. |
| 13 | Cost and latency per cycle | S | **C2** | Token/dollar/wall-time on `CycleRecord`; Weave already has the numbers. First ops question a buyer asks. |
| 3 | Audit bundle per cycle | S | **B1** | One export (scenario, episode, verdict, patch, gate evals, Weave URLs) from the Review page. |
| 15 | Notifications | S | **C2** | Slack/email on patch accepted, attack landed with no fix, schedule skipped. Composio. |
| 22 | SQLite behind `store.py` | M | **C3** | Absorbed. Only once two processes write at once. |
| 24 | Rate-limit backoff | S | **C3** | Absorbed. No 429 handling in `chaos/`; a nightly schedule on a shared key will hit it. |
| 23 | Structured logs | S | **C3** | Absorbed. 40 `print(` calls in `chaos/loop.py`. |
| 19 | Seeded determinism | S | **C2** | No `random.seed` anywhere; two runs differ by more than model noise. Needed before pass^k reporting (A2). |
| 17 | Patch minimality | S | **B2** | Preference order lives only in the repair prompt; make it a checked property when rendering layer-1 snippets. |
| 9 | Framework adapters | L | **B3** | Absorbed: SDK mode is the adapter. |
| 11 | Attack library pack | M | **A2** | Falls out of domain packs: an attack family is data, not code. |
| 12 | Side-by-side comparison | M | **B1** | Two versions in the Review page's diff view; same `configDiff`. |
| 5 | "Why legit users passed" copy | S | **B1** | Copy on the Review page's gate line. |
| 25 | Model leaderboard | S | **D** | Distribution: which target model survives which pack. After A2 gives a second domain. |
| 26 | Hosted "break my agent" sandbox | L | **D** | Needs cost caps and multi-tenant auth (Q5); not before discovery. |
| 27 | Blog post | S | **D** | Write after A3: "we attacked OpenAI's own support demo". |

Track D (distribution) is not scheduled in §Order; it starts when A3 has a result worth writing about.

### Order

Decided Sep 21 (grill round 2): the Sep 26 submission no longer governs the week; Track A starts now. First real
agent is `openai-cs-agents-demo` alone (the Clad spike is dropped). Judge grades state for packs and transcript +
tool calls in pass-through. MCP comes after A3. Review page is a global queue at `/app/review` with a link from each
run. "Production grade" this month means reliability for one user, nothing multi-tenant.

1. **This week:** Owen's manual pass and C1 (smoke checklist + e2e test) first — one day — then A3 as a spike
   before A1: put the demo behind `/episode` with its tools as `tools_backend` and see what breaks. The spike
   decides how much of A1 is needed for the judge to say anything useful without Northwind.
2. **Next two weeks:** A1, A2, then A3 properly. B1 in parallel (UI-only). C2 folded into A3.
3. **After:** A4 (once the `mcp` dependency is approved), A5, A6, B2. Discovery calls from plan 06 run alongside;
   their answers decide whether B3 or C3 comes next.

## 5. Independent review (Sep 21, 23:55) — what changes

An independent pass read the plan against the code. Everything below was verified by me afterwards where marked
**[v]**. The direction stands; the A3 spike as first written would have produced noise, not a scoping signal.

### Blockers folded into the tracks

1. **Pass-through sends no session header** (`chaos/toolbus.py:156` **[v]**). The demo's tools are stateful per
   conversation (`cancel_flight` takes no args and reads context state); the gate runs ~3 episodes concurrently.
   Without the header the backend has one shared context and episodes cross-talk. → **A3 precondition**, not C2.
2. **Repair cannot write the only patch that reaches the gateway.** The model-facing menu lists the seven retail
   flags and validators but never `tool_rules` (`repair_agent.py:56-69` vs `:304-305, 516-542` **[v]**);
   `add_tool_validator` is offered for HTTP targets but validators never run in pass-through
   (`toolbus.py:135-141`). → **A3 precondition**: put `tool_rules` in the menu with the target's tool names from
   `GET /tools`; drop `add_tool_validator` from `CODE_LEVEL_PATCH_KINDS` when `tools_backend` is set.
3. **The chaos agent attacks an electronics store.** Prompt and payload hard-code Northwind tools, customers and
   order ids (`chaos_agent.py:45-58, 346`); faults only fire on matching tool names, so injection and garbage
   families are inert against airline tools. The demo runs relevance + jailbreak guardrails on every agent
   (upstream `airline/agents.py:55-154` **[v]**); an off-topic "refund order A-1001" trips them, the shim 500s, the
   judge marks `crash`, every cycle is a false "attack landed". → **A3 needs a domain-neutral chaos prompt fed the
   target's tool list** (a slice of A1 pulled forward), and the shim must catch `InputGuardrailTripwireTriggered`.
4. **`requires_verified_lookup` is unsatisfiable against the demo.** `_note_verified` needs a dict result and an
   `*_id` arg (`toolbus.py:185-188` **[v]**); the demo's tools return strings and take `confirmation_number`.
   `starter_rule` applies the flag to money/message/mutate/unknown (`tool_rules.py:62-68`), so every airline action
   is blocked out of the box. → A3: starter rules must not set `requires_verified_lookup` unless a read tool that
   returns dicts exists; A4: MCP returns content blocks, plan for `structuredContent` or the rule is dead over MCP.
5. **The legit suite protects nothing for a non-retail agent.** All 11 rows are Northwind; 8 require retail tools,
   so they fail at baseline as `over_refusal`, and the gate ignores rows that already failed (`gate.py:96`). A
   `deny cancel_flight` patch would sail through with the over-refusal guard silently off. → A3 must ship legit
   rows for the target (from `tasks.json` of a minimal airline pack, or generated from `GET /tools`), and the run
   must say when the legit guard is empty.
6. **A1's coupling list was wrong** (§5 of this plan said five files). Also Northwind: the seven `ToolPolicy` flags
   are the retail domain baked into the shared schema (`schemas.py:50-56`), `customer_id="cust_owen"` defaults
   (`schemas.py:105`, `api/main.py:632`, `api/incidents.py:24`), `toolbus.py:18,95,118,128,173`,
   `target_agent.py:25-33, 54-57, 73, 229` (`_TOOL_JSON_RE` compiled from `TOOL_FUNCS` at import),
   `zendesk.py:161-163`, `toolserver.py:112, 179-192`, `api/agents.py:43-51, 71, 289-295`, `api/manifest.py:31-34`,
   `web/src/lib/derive.ts:196`, `Onboarding.tsx:58-60`, `tests/test_scenarios.py`. **Decision for A1:** keep the
   seven flags on `ToolPolicy` labelled retail-only (golden run, `configDiff`, repair prompt keep working) or move
   them into the pack (schema migration). Reviewer recommends keep.
7. **C1 as written cannot run a cycle.** The API only spawns the loop as a subprocess (`api/loop_ctl.py:290-297`)
   and preflight 503s without `WANDB_API_KEY`. → C1 becomes: `run_target_agent` in-process with
   `ANTIBODY_TARGET=http:<FakeAgent>` and `ANTIBODY_TOOLS_BACKEND=<FakeToolBackend>` (pattern
   `tests/test_toolserver.py:174-200`), deterministic judge path, `apply_patch` with a `tool_rules` patch,
   `state.save_config`, `POST /api/configs/{v}/review`, then `Gateway(load_policy_config("approved"))` (pattern
   `tests/test_gateway.py:29, 97`).
8. **The demo needs `OPENAI_API_KEY` and `gpt-5.2`** (upstream `agents.py:25` **[v]**); the repo runs W&B Inference
   `gpt-oss` models and our own example had to switch model classes to make the SDK tool round-trip work
   (`examples/agents/openai_agents_support/agent.py:26-30, 105-117`). **Decision:** supply an OpenAI key for the
   spike (keeps the "OpenAI's own demo" story) or rewire the demo's model (cheaper, no longer the demo as shipped).
9. **"Two shim files" understates A3.** The demo is now a ChatKit server (`openai-chatkit` in requirements **[v]**);
   tools stream progress events through the run context. Pass-through needs: all 10 tools re-declared as HTTP
   proxies with identical schemas; a backend that invokes the originals with a fake `RunContextWrapper` per session
   (blocker 1); `/episode` catching guardrail tripwires and `MaxTurnsExceeded`. That is a fork of
   `airline/agents.py`, and `openai-chatkit` is a new dependency under `examples/` — ask first.

### Should-fixes carried into the slices

- **State judging must not be a third "which tools" mechanism.** `LEGIT_EXPECTED_TOOLS`/`_ORDERS` side-dicts
  (`scenarios.py:270-295`) and `Scenario.forbidden_tool_calls` (`schemas.py:110-113`, never read by the judge —
  dead data) are replaced by `Scenario.expected_calls` / `forbidden_calls` filled from `tasks.json`. Match on a
  declared arg subset with the existing normalisers (`_coerce_amount`, `.strip()`), not exact `(tool, args)`.
- The judge cannot tell it is in pass-through: add `Episode.domain: str | None` (extend, don't fork).
- `ToolRule.max_total` is more than a field: per-session spend accumulation, a new `tool_rule_blocks` parameter
  (two callers), `merge_tool_rules` constructs field-by-field so an omitted field silently drops (`repair_agent.py:536-542`),
  plus `rule_detail`, `ruleLine`, `api.ts`. Plan 09 deferred `max_amount` for the same per-tool-arg-name reason.
  The demo's `issue_compensation` has no amount arg, so this family cannot target A3's agent anyway.
- Load the pack's `db.json` **per `ToolSession`**: `ORDERS` is never mutated today, which is the only reason three
  concurrent gate episodes are safe; an airline `cancel_booking` that mutates shared state would leak between rows.
- Ticket mode reads `ORDERS` (`zendesk.py:161-163`): decide retail-only or per-pack in A1.
- **A6 is a `/episode` contract change**, not a `Scenario` change: `HttpTarget` sends one message with no history
  (`target.py:80-86`). Multi-turn needs a `history` field; every connected agent changes.
- **B1 must replace the Agent page's Approve/Reject panel** (`Agent.tsx:134-144`), not sit beside it. Approvals are
  live-only writes (`main.py:313-320`) so a "global queue" can act on one run; `/api/runs/{id}/configs` does not
  exist — `GET /api/runs/{id}` embeds `configs`; `ConfigDiff.tsx` is cycle-bound and needs a `(beforeV, afterV,
  source)` form; for an HTTP target the prompt/guardrail/validator pseudo-files are Antibody's built-in config, not
  the customer's — hide them by `run.json.target` or the page lies.
- Corrections to §3: the demo has `issue_compensation` (vouchers, no amount) and no refund tool; `GET /tools` is
  also used by the Tools panel proposal (`api/tool_setup.py:19-31`).
- `domains/` at repo root vs `chaos/domains/`: one import root is simpler; decide in the A1 handoff.

### Keep as-is (the builder should not "improve" these)

URL-not-repo contract (`target.py:59-98`); only `ToolRule`s reach production (`toolbus.py:135-141`,
`gateway.py:8-9`); tighten-only merge; fail-closed judge and evals (`evals.py:141-152`, `judge.py:223-230`,
`toolbus.py:106-107`); gate asymmetry (`gate.py:9-15`); `AttackFamily` owns pass/fail, never the attacker;
retail pack keeps the v0 prompt byte-identical (`tests/test_target.py:212`) and seed ids so `data/golden` replays;
`build_app` shared by loop, gateway and — later — MCP; routes thin.

### Revised week one

Decided Sep 22 (after review): the seven `ToolPolicy` flags **stay on the schema, labelled retail-only**, and the
repair prompt's flag list is generated from the active pack. `openai-chatkit` is decided after the transport spike.
The OpenAI key is **unresolved** — Owen may not be able to get one — so the spike carries both branches:

- *Key available:* run the demo as shipped (`gpt-5.2`); the "OpenAI's own demo" story holds.
- *No key:* the shim swaps the model for W&B `gpt-oss-120b` via `OpenAIChatCompletionsModel`, the same fix
  `examples/agents/openai_agents_support/agent.py:26-30, 105-117` needed; the blog claim becomes "OpenAI's demo
  agent, open-weights model". Check first that the demo's guardrail agents and handoffs survive the model swap —
  our example found every Llama on W&B failed the SDK tool round-trip.

1. C1 as rewritten (blocker 7) — half a day.
2. Blockers 1 and 2 — small, needed regardless — with tests.
3. A **half-day** transport spike on the demo (blocker 9) before committing to the two-day one; it settles the
   key/model branch (blocker 8), the ChatKit dependency (Q19), and the shim's real size.
4. Then A1 with the reviewer's module list, then A3 properly, then A2.

## 5b. Loops 3 and 4 (Sep 22, 03:10) — gateway contract, deliverables, build scope

**Loop 3 — the gateway as a thing a customer runs.** Graded 7/10 because the plan said *what* the gateway must
promise, not *how* it is deployed. Settled here:

- **Topology:** one gateway process per agent, run by the customer next to their tools (`docker run antibody
  gateway --backend …`). Session state (verified lookups, per-tool call counts, customer turns) lives in the process.
  HA therefore means *two instances behind their load balancer with sticky sessions on `X-Antibody-Session`*; a
  shared session store is Track C3 work and is not promised until someone asks.
- **Authentication:** today the gateway is an open proxy on a port. C2 adds a shared bearer between agent and
  gateway (`ANTIBODY_GATEWAY_TOKEN`, same middleware as `api/auth.py`) and forwards `X-Antibody-Session` plus an
  `Authorization` the customer configures to the backend. `X-Antibody-Customer` is an unauthenticated log field and
  is documented as such.
- **Failure semantics, per tool class:** rule check throws or backend unreachable → money/mutate **fail closed**
  (`{"error": "gateway: refused — <reason>"}`), read/message **fail open** and log `degraded: true`. Class comes
  from `chaos.tool_rules.classify`; a customer can override per tool in the approved config.
- **Budgets:** the rule check is pure Python, target ≤ 5 ms; backend timeout 30 s (existing `PASSTHROUGH_TIMEOUT_S`)
  becomes per-tool configurable. `gateway.jsonl` records `elapsed_ms` per call so p99 per tool is a `derive.ts`
  function, not a new system.
- **Policy version:** `GET /health` returns `{version, approved_at, rules: N}`; the gateway re-reads the approved
  config on `SIGHUP` or every 60 s, so approving in the Review page reaches production without a restart.
- **Shadow first, always:** the onboarding copy and README say it plainly — run `--shadow` for a week, read the
  replay panel, then `--enforce`.

**Loop 3 — what the customer receives.** A product is what leaves the building. Per run: (1) a **report** — attacks
run, landed, blocked, pass^k, legit-user pass rate, per family; (2) a **rules file** — the approved `tool_rules`
as JSON, diffable, the same file the gateway loads; (3) the **gateway command** with that version pinned; (4) per
accepted rule, a **framework snippet** (B2) for teams who would rather enforce in code. The Review page is where
(2)–(4) are copied from; the report is the Run page.

**Loop 4 — scope of the build starting now.** "Build everything" is scoped to what can be built and verified
without a customer, a paid key, or a new dependency (Owen has said no questions; the dependency rule stands, so
anything needing `mcp`, `openai-chatkit`, or Playwright is **not built** and is listed at the end):

| Built now | Not built now (why) |
| --- | --- |
| C1 checklist + in-process e2e test | A4 MCP transport (needs `mcp` package) |
| Review blockers 1–2: session header to backend; `tool_rules` in Repair's menu; validators dropped for pass-through | A3 with the demo *as shipped* (needs OpenAI key; the demo's `gpt-5.2` is also deprecated per OpenAI's model page) |
| A1 domain packs: `chaos/domains/{retail,airline}/`, judge and chaos read the pack from the session; seven flags stay, labelled retail-only | B3 SDK mode (quarter item) |
| A2 airline pack: five class-level families, `expected_calls`/`forbidden_calls` on `Scenario`, state check, pass^k in the report | C3 storage/ops (deferred by decision Q5) |
| A3 no-key branch: `examples/agents/openai_cs_airline/` — the demo's agents and tools (MIT, attributed) on W&B `gpt-oss-120b`, no ChatKit, `/episode` + `/tools/{name}` backend, model switchable by env so the key branch is one variable | A6 multi-turn (contract change; after a real agent has run) |
| A5 onboarding: tools step asks for a tools URL, shows classification and starter rules (without `requires_verified_lookup` unless a dict-returning read tool exists), runs a 3-cycle smoke attack | Track D |
| A7 `FinTarget` class with a fake Fin in tests (no workspace) | |
| B1 Review page with shadow-replay panel; replaces the Agent-page approve panel | |
| B2 framework snippets per accepted rule | |
| C2: gateway token + header forwarding + fail semantics + `elapsed_ms`; cost/latency per cycle; seeded determinism; judge sees typed facts not raw tool output | |

Definition of done for the build: all existing tests pass plus new ones for each row; `tsc` and lint clean; the
retail pack replays `data/golden` unchanged; a full loop runs against the airline example in pass-through on W&B
and produces at least one `tool_rules` patch that reaches the gateway's shadow log; the README describes the
product as it now is. Then an independent deep review, and its blockers fixed, before Owen sees it.

**Grades after loops 3–4:** gateway as production infra 7 → 9 (topology, auth, failure semantics, budgets, version
pinning written; HA store deferred by decision); deliverables (new row) 9; onboarding 7 → 8 (smoke attack built);
buyer shape unchanged at 8 (Decagon/Sierra need a customer). Overall the plan is as close to 10 as research can
take it; the rest is evidence from a real user.

## 6. Assumptions

**Self-grading across loops.** Each loop re-graded the plan on the same dimensions and fixed the lowest scores.

| Dimension | v1 | after review | after loop 1 | after loop 2 | What moved it |
| --- | --- | --- | --- | --- | --- |
| Factual grounding | 7 | 8 | 8 | 9 | Review caught the coupling claim; loop 2 verified Fin's API |
| Buyer's deployment shape | 4 | 4 | 7 | 8 | Fin/Decagon/Sierra connectors; `FinTarget` |
| Honesty of the "unique" claim | 5 | 5 | 8 | 8 | Promptfoo Adaptive Guardrails named; claim narrowed to deterministic action rules |
| Gateway as production infra | 3 | 4 | 7 | 7 | Fail-open/closed per class, time budget, p99 per tool |
| Evaluation validity | 5 | 6 | 7 | 9 | GAUGE near-equal problem → deterministic gate; judge-injection mitigation; reference-not-only-path |
| Sequencing and first week | 6 | 8 | 8 | 8 | Review's blockers 1–2 and half-day spike |
| Approval as a decision | 5 | 5 | 5 | 8 | Shadow-replay panel |
| Onboarding bar | 4 | 4 | 4 | 7 | Ten-minute, three-step target with a real finding |

Still weakest: gateway HA and multi-tenant (deliberately deferred, Q5), and Decagon/Sierra attack entry (unverified,
discovery). Loop 3 is not scheduled: the remaining gaps are decisions that need a customer, not research.

| Assumption | State | How to settle |
| --- | --- | --- |
| Northwind coupling is confined to `tools.py`, `judge.py`, `chaos_agent.py`, `scenarios.py`, `repair_agent.py:474` | **Wrong** — corrected by the review (§5, blocker 6): ~15 modules including the shared `ToolPolicy` schema | — |
| τ²-bench domains are MIT and importable with tools + DB + policy | Verified license; **not verified** that their tool signatures fit our `/tools/{name}` contract without adaptation | Read `tau2-bench/data/tau2/domains/airline` before A2 |
| `openai-cs-agents-demo` can expose `/episode` in a day | Inferred from its structure (FastAPI backend, Agents SDK) | Do it as the A3 spike |
| Clad's helpdesk agent can be driven turn-by-turn over HTTP | **Unverified** | Owen checks how the agent is invoked today |
| Customers will accept a proxy in front of tools | **Unverified** — the kill condition | Plan 06 discovery calls |
| MCP is how most target agents get tools | Verified for the enforcement market; **unverified** for support agents specifically | Ask in discovery; check the two candidate repos |

## 7. Sources

- τ-bench (ICLR 2025) and τ²-bench (arXiv 2506.07982); `sierra-research/tau2-bench`, `amazon-agi/tau2-bench-verified` — domain design, simulated user, state-based grading, pass^k.
- AgentDojo (NeurIPS 2024; `ethz-spylab/agentdojo`) — task suites, injection vectors, utility vs security checks.
- CaMeL, "Defeating Prompt Injections by Design" (arXiv 2503.18813) and "Operationalizing CaMeL" (2505.22852) — defenses outside the model.
- promptfoo docs: red-team targets (HTTP vs `file://` providers); OpenAI Agents SDK docs: guardrails, human-in-the-loop; LangGraph A2A endpoint docs.
- Enforcement proxies: `invariantlabs-ai/invariant`, `PolicyLayer/Intercept`, `kphatak001/mcpfw`, `SutanuNandigrami/agentward`, `hoophq/mcpproxy`, `vaddisrinivas/mcp-approval-proxy`.
- Simulation and sandboxes: Coval, Maxim, Veris, Arga, Pome, AgentReplay.
- Closed-loop improvement: Converra, Relios, ClosedLoop, Glassray, Kytte; promptfoo Enterprise Adaptive Guardrails
  (red-team findings → input policies); Lakera Red + Guard.
- Hosted support platforms: Intercom Fin Data connectors / Fin Tasks / Fin Agent API (`/fin/start`, `/fin/reply`);
  Decagon AOPs; Sierra Agent SDK.
- Evaluation validity: GAUGE (arXiv 2609.12191), "Lost in Simulation" (2601.17087), "Mind the Sim2Real Gap"
  (2603.11245), "Measurement Without Validity" (2608.00794); τ²-bench `docs/evaluation.md` (reference trajectory vs
  end state); AgentDojo `utility` / `ground_truth` with `...` args.
- Gateway operations: Twilio "Productionizing LLM Gateways" (fail-open vs fail-closed, p99 per route, time budgets);
  guardrail-latency testing guides.
- Policy approval practice: Permit.io PBAC (replay real decisions against a new policy), GitOps approval gates.
- Candidate agents: `openai/openai-cs-agents-demo`, `negativexq/agentic-customer-service-platform`, `muneeb-rashid-cyan/LangGraph-Customer-Support-Agent`.
