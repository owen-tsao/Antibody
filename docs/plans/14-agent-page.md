# Plan 14 — the Agent page is the thing you protect

Owen, Sep 29: "clicking into the agent cards in the agent tab should show something else instead of just its run
history … the layout and surfaces need to be premium. I don't want just the same data/details being displayed again."

Written on Sep 29, the submission day; built the same evening. Deviations from the plan are marked **built:** inline.
After the first build Owen asked for one screen: the status cells moved onto the card in the display face the
title used to have (the page header already names the agent), the page became viewport-bound at `xl` like Home,
*Rules in force* (rules beside the donut, the gateway's live traffic folded in underneath for connected agents)
and *What every run found* became two panels that scroll inside, the Runs link moved into the findings aside, and
*Past attacks* was removed — the regression suite is global (`GET /api/regression` takes no agent), so it was never
this page's.

## Why the page feels like a duplicate

Every page after a run tells you about *that run*. Nothing tells you about *the agent*:

| page | its job today |
| --- | --- |
| Run | one test's story |
| Runs | the ledger |
| Review | the decisions |
| Agent | the last run again, then Tools, Shadow log, Past attacks |

"Is the retail agent protected right now?" has no page. Home answers it for the latest run. That is the gap, and
it is why Agent reads as Runs with a picture.

## The one idea

A run is a *test*; an agent is the *patient*. The Agent page is the chart at the foot of the bed: what it is
running on now, what has been tried, what is happening to it live, and what you still have to decide. It shows
nothing a run page shows — no cycle list, no verdict headline, no compare table.

## What the real data says (checked Sep 29, 19 runs on disk)

Before designing a "protection over time" chart, I read every run's vulnerability sweep. Twelve of nineteen runs
have one, and **every one starts the built-in agent back at baseline**: `v0: 6 → v3: 3` (Sep 13), `v0: 5 → v4: 1`
(Sep 20), `v0: 8 → v4: 5` (Sep 25), `v0: 7 → v4: 2` (Sep 27). No fix has ever been approved, so nothing carries
forward; each run rediscovers the same holes. A trend line would be a lie — the agent is not getting safer between
runs, because the human step has never been taken.

That is not a reason to drop the section. It *is* the section. The most important thing the page can say about
this agent is: *four runs found the same seven holes; a fix that closes five of them has been waiting since
Sep 27.* The kill condition was "if the trend reads as noise, shrink it" — it read as something better than a
trend: a reason to act.

## The page, top to bottom

```
Demo agent                                                              [ Heal ]
built in · retail · in-process · 16 runs

RUNNING ON            GATEWAY            LAST TESTED           NEXT TEST
Baseline              shadow · v0        2 days ago            —
1 fix waiting →       41 calls · 24 h    7 attacks got through  no schedule →

What every run found                                    ← replaces "trend"; the honest version
  Sep 27   7 got through   Fix 4 would block 5   pending →        (live run: decidable)
  Sep 25   8 got through   Fix 4 would block 3   never decided
  Sep 22   7 got through   Fix 3 would block 6   never decided
  Sep 20   5 got through   Fix 4 would block 4   never decided
  (one line per run with a sweep; rows open the run; only the live run's fix can still be approved)

Live traffic                              41 calls in 24 h · 3 would have been blocked
  14:02   lookup_order   cust_maya   would block · another customer's order
  …                                                            (the shadow log, promoted)

Rules in force · Baseline                 3 tools · 0 rules            what Fix 4 adds →
  lookup_order   —
  issue_refund   —
  send_email     —
  (the approved config's tool_rules; the link opens the pending version in Review)

Past attacks · 7                                                          (unchanged)

Runs · 16 · last Sep 27 →                                       (one line; the ledger is Runs)
```

### Each block, what it answers, where the data comes from (all in `api.ts` today)

1. **Running on / Gateway / Last tested / Next test** — *am I protected?* `approvals.certified` (0 = baseline)
   — which belongs to the **live run**, not to the agent: versions restart at v0 every run and `approvals.json`
   is archived with the run. If the live run targeted a different agent, this cell says `nothing in force ·
   last run was <other agent>`; the airline example agent reads that way today. Then
   the newest `GatewayEvent.mode` and `config_version` — which can disagree with `certified`, and the strip
   says so when they do (`gateway still on v0 · approved v2`); the agent's newest run; `Schedule.next_at` for
   `schedule.agent === id`. Every field exists.
2. **What every run found** — *what keeps happening?* Per run: `vulnerability.landed[v0]` (got through) and the
   verdict's fix + status from `runVerdict` (already derived for the Run page; reuse, do not fork). One
   `/api/state?source=run:<id>` per run: 16 reads today, paginate at 30. If it grows, a server-side summary on
   `GET /api/runs` (`landed_v0`, `best_fix`) — not before.
   **Constraint found in review (`api/store.py` `review_inbox`, `api/main.py` `review_config`):** a decision can
   only be recorded on the *live* run's versions; an older run's undecided version is `archived` — viewable, not
   approvable. So `pending →` appears on the live run's row only. Older rows say `never decided` with no link, and
   the panel's aside says what to do about it: `Heal again to get a fix you can approve`. Do not render a link
   that 404s.
3. **Live traffic** — *what is it doing to real calls?* The existing Shadow log panel, first-class. `gateway(tail,
   backend)`. When there is no tools backend the block says so in one line and stays small; it does not
   disappear, because "no gateway in front of this agent" is the finding.
4. **Rules in force** — *what exactly is it enforcing?* `config(certified).tool_policy.tool_rules`, read-only,
   one row per tool the agent lists (`agent.tools`), `—` where no rule exists. The link to the pending version
   reuses `reviewVersion(runId, v)`. The current "Tools" panel (proposed starter rules + apply) folds under this
   block as its action: *in force* above, *proposed* below, one surface.
5. **Past attacks** — unchanged.
6. **Runs** — one line. The run picker and the embedded `RunResults` go. The Run page owns them.

## Surfaces — "premium" means fewer, bigger, quieter

- The header is the `AgentCard` (`ratio="video"`, as on Agents) with the name and subline inside; nothing else
  competes with it. **Heal** is the page's one filled button (`primaryButton`), on the header row.
- The status strip is the Home facts `dl` (`homeStats` pattern): four cells, eyebrow labels, 15 px values, no
  borders between cells. Where a cell has a second line (`1 fix waiting →`) it is a 12.5 px link in `--muted`.
- Every block is one `Panel` on `--card`. Four panels, not seven. Nothing is a table with a header row except
  the rules list, which needs its columns.
- Emphasis budget: the card, the button, and — only when a fix is pending — the pending links in *What every run
  found*. Everything else is `--fg` 13 px 500 for titles, `--muted` for lines, `--faint` for meta.
- No `.u-line` on this page except the *pending →* links; they are the action.

## Two visuals (Owen, Sep 29 — the source for both is archived in the component library)

Both were chosen because they are monochrome and because the page has something true for each to show. Neither
is a trend chart; that one stays dead (see "What the real data says").

### Dither donut — the *suite* and how much of it the version in force stops

Where: the right half of the **Rules in force** panel, beside the rules list; 180 px, with the legend rows
from the source taking the place of the plan rows.

- Segments are the pack's attack **families** (retail has four); the segment's share is how many of the suite's
  attacks belong to it. The dither density inside a segment is the part that version blocks: dense = blocked,
  sparse = still gets through (the source already varies dot size by `fullness`; that becomes the blocked share
  instead of a radial gradient). Legend row: `Prompt injection · 3 attacks · 1 blocked`.
- The source's period tabs (Week/Month/Quarter/Year) become a two-stop version rail — **Baseline** and the
  pending fix — reusing `VersionRail` (today a private function in `RunResults.tsx`; export it, do not copy it). Switching redraws with the same 500 ms morph; that morph *is* the
  comparison a reviewer is being asked to make.
- Data: `matrixRows`/`matrixCell` on the agent's newest run (already derived for Compare). No new endpoint.
- Palette: the source's five greys (`#FFFFFF … #64748B`) map to `--fg`, `--muted`, `--faint`, plus two steps
  between; the blue icon tile and the blue active tab go. `Users` from lucide becomes the family's mark from
  Phosphor (already installed).
- Dependencies: the source imports `motion/react` — **use `framer-motion`**, already in `package.json`, which
  exports `motion`, `useSpring`, `useTransform`, `useReducedMotion` identically; do not add `motion`. It also
  imports `useCanvasSetup` from a utils file the prompt did not include: write it (a `ResizeObserver` for the
  cached rect, an `IntersectionObserver` + `visibilitychange` for `isVisible`, `matchMedia` for reduced
  motion — ~40 lines). **Built:** the only thing the source used motion for was the animated legend numbers,
  which the legend here does not have, so the component imports no motion library at all; `useCanvasSetup`
  lives in `hooks/` like every other hook (the repo's rule beats the source's folder) and reads reduced motion
  from `useMotionPref`, so the Display preference applies.
- Kill condition: if the agent's suite has fewer than two families, the donut is one ring and says nothing;
  render the legend rows alone.

### Partition bar — one line per run in *What every run found*

Where: each row of the **What every run found** panel carries a 2 px bar under its text: got through vs.
what the fix would block, so the eye reads the shape of every run before the numbers.

- Two segments: `num={gotThrough - wouldBlock}` in `variant="muted"` and `num={wouldBlock}` in `default`. The
  title/value children are not used — the row's own text is the label — so only `PartitionBar` and
  `PartitionBarSegment` are kept; `PartitionBarSegmentTitle`/`Value` are deleted (one call site, no children).
- `size="sm"` (`h-2`) is still too tall for a row; add an `xs` variant at `h-0.5`. **Built:** the component was
  cut to one size (`h-0.5`) and two tones, ~25 lines; the cva variants went with the shadcn tokens.
- Its variants use shadcn tokens (`bg-primary`, `bg-destructive`, `text-slate-500`) this app does not define;
  map `default` → `bg-[var(--fg)]`, `muted` → `bg-[var(--faint)]`, drop the rest. `class-variance-authority`
  and `cn` from `@/lib/utils` are already here.
- The bar's total is the run's suite, so two runs with different suites (7 vs 9 attacks) are the same width and
  read as *shares*, which is honest; the numbers beside them stay absolute.

### Both

- Component-library rule: two call sites or a genuinely separate object. The donut is a separate object (a
  canvas). The bar has one call site today; it earns a file because Compare's `this attack` row is the obvious
  second one — add it there only if it helps, not to justify the file.
- Neither animates for `prefers-reduced-motion`; the donut source already handles it, the bar has nothing to
  animate.

## Derive (`lib/derive.ts`), all pure

- `agentStatus(agent, approvals, gatewayLog, runs, schedules): Fact[]` — the four cells, with the disagreement
  line when the gateway's `config_version !== certified`.
- `runFindings(runs, statesByRun, approvalsByRun): { runId, at, gotThrough, fix, status }[]` — one row per run
  with a sweep, newest first, built on `runVerdict`.
- `rulesInForce(config, tools): { tool, rule: ToolRule | null }[]`.
- `agentRunsLine(runs): string` — `16 runs · last Sep 27`.

## Out of scope, named so nobody builds it by accident

A trend chart (the donut and the bar above show composition, not time). Multi-agent comparison. Editing rules on this page (Review does that). Anything that needs a new
endpoint on day one.

## Kill conditions

- If `What every run found` has fewer than two rows for the agent, the block collapses to one sentence
  (`Tested once · 7 attacks got through · Fix 4 pending →`). Never an empty table.
- If `agentStatus` cannot be derived without a new endpoint, ship the page without the strip rather than add
  one under deadline pressure.

## Order of work

1. `derive.ts` functions + tests by reading (the Fact shapes are the contract).
2. Strip the run picker and `RunResults` from `Agent.tsx`; header + status strip.
3. *What every run found* with the partition bar; then fold Tools into *Rules in force*; then promote the Shadow log.
4. The donut last — it is the most work and the page must stand without it.
5. Screenshots of Demo agent (16 runs), the airline example agent (3 runs, no sweeps — exercises the collapse),
   and a freshly added agent (nothing at all). Build, lint, tests. Independent review before it is called done.
