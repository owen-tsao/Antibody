# 06 — Customer discovery: five conversations before writing more code than this

**Budget:** ~6 hours over two weeks (outreach writing, calls, notes); ~10 if all five calls land. No code.
Runs in parallel with everything else, and is the first plan to shrink (to three calls) if code runs long.
**Outcome:** by Sep 28, a one-page note saying whether anyone with a support agent in production
would pay for this, what they would pay for, and what they said no to.

The first draft said ten conversations, six with strangers. From cold outreach in 13 days around
school, the realistic yield is three to five. Target **five, three with strangers**; book fifteen.
The kill condition below is unchanged — it is about what is heard, not how many heard it.

## Why this is in the engineering plan set

Plans 01–05 make Antibody a real tool. Whether it is a real *company* depends on facts we do not
have: who owns the risk of an agent refunding money it shouldn't, what they do about it today, and
whether "stand between the agent and its tools" is a sentence they would let us do to their system.
Writing more features before knowing that is the mistake we already made once.

## The kill condition, stated first

If after five conversations **no one** describes a real incident (an agent took a wrong action with a
customer-visible consequence) **and no one** would let an external tool sit in front of their agent's
tools, then Antibody is a portfolio project and a possible Sentinel feature, not a startup. That
is a fine outcome; it just should be known before Sep 28, not after another month.

## Who to talk to (target: 5, book 15)

In order of how much their answer matters:

1. **People running an LLM support agent in production** (Intercom Fin, Decagon, Sierra customers; in-house builds). Titles: Head of Support, Support Ops, "AI lead" at a Series A–C company. Two or three conversations.
2. **People building agent frameworks or agent-eval tooling** (Braintrust, LangSmith, Weave users, Composio). They know what buyers ask for. One or two conversations.
3. **Security or trust people at companies deploying agents.** They own the "who approved this tool call" question. One conversation.

Sources: the two CoreWeave judges (they liked it; ask for one intro each), AGI House Part 2 attendees, LinkedIn second-degree via the school network, the Weave community Slack, Composio's Discord.

## The script (20 minutes, listen 80%)

Do not demo first. Ask, then show if they ask.

1. "Walk me through the last time your agent did something it shouldn't have with a customer." (Incident or not? Consequence?)
2. "How did you find out?" (Customer complaint, log review, luck?)
3. "What did you change, and how did you know the change didn't break something else?" (This is the gate. Do they have one?)
4. "Who signs off on a prompt or policy change to the agent today?" (Buyer and blocker.)
5. "If a tool sat between your agent and its tools — saw every call, could block some — who would need to approve that?" (The pluggable-target objection, tested directly.)
6. "What do you pay for today around agent quality or safety?" (Budget line exists or not.)
7. Only then: 90-second demo, Cycle page with the blocked refund. "Would this have caught your incident?"

Write the answers within an hour of the call, in `docs/discovery/NN-<company>.md`, using the same seven headings. No editorialising in the notes; that goes in the summary.

## Cadence

- **First:** send 15 asks. Templates: 3 sentences, mention CoreWeave Hacks, ask for 20 minutes.
- **Then:** two to three calls a week. Block the slots now. Yield from cold asks is ~1 in 3; fifteen asks is the floor, not the ceiling.
- **Last:** write `docs/discovery/summary.md`: incidents heard (count), gate exists today (count), would allow a tool proxy (count), budget exists (count), quotes, and the verdict against the kill condition.

## What to do with the answer

- **Incidents + would allow proxy + budget:** Antibody continues after Sep 26; plan 01's sidecar becomes the product; Sentinel merges in.
- **Incidents but "would never let a proxy in":** the product is the *eval/red-team* half only (run in staging against a copy). Plan 01's HTTP adapter matters more than MCP.
- **No incidents:** stop. Keep the repo as a portfolio piece; put the learnings in the README's roadmap as "what we learned" — judges respect that too.

## Risks

- **Asking friends.** Friends say yes. At least three of five must be strangers.
- **Demo-first.** Showing the product first turns the call into feedback on the UI. Ask first.
- **Not doing it.** This is the plan most likely to be skipped for code. It is also the only one whose output changes what happens after Sep 28.

## Done when

- Five conversation notes in `docs/discovery/`, at least three with strangers.
- `docs/discovery/summary.md` with counts, quotes, and a verdict against the kill condition.
