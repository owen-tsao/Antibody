# 05 — Submission and story

**Budget:** ~7 hours. Sitting 1 (after 04 Step 4): Replay/Agents segments from the new tape. Sitting 2
(after 01 Step 4, 02, 03): external-agent segment, settings/`make demo`/CI segment, assembly, README, form.
**Submit by Sat Sep 26.** Landing page is stretch and probably gets cut.
**Outcome:** a judge who spends four minutes on the Part 2 page understands what Antibody does,
believes it runs, and sees it run against an agent we didn't write — or, if plan 01 died at the spike,
sees the full loop on the mock world with the gate rejecting a bad patch.

## What judging actually is

No live demos. Judges read the AGI House Part 2 page and whatever it links to. Order of persuasion:
**thumbnail → first 20 seconds of video → README hero → "Running it"**. Practicality lost round one
to "wow"; the fix is not more features, it is putting our one wow moment — a policy blocking a real
agent's refund, inside the tool layer — in the first 20 seconds.

## Four truth constraints

1. **Every sentence must be true of the committed code and data on submission day.** The current
   golden tape contradicts "found it, proved it, fixed it" (plan 04 explains; cycle 6 shows the seed
   attack landing on v3). Plan 04 re-records the tape **before** the opening segment is recorded.
   Stretch lives in the roadmap section, in future tense.
2. **Don't say "we didn't change a line."** Plan 01's example agent needs a few lines of glue: a tools
   base URL and forwarding a session id. Say "a few lines of glue, none of it Antibody code; the agent's
   logic is untouched." It is still the strongest sentence in the pitch.
3. **The external agent runs on `openai/gpt-oss-20b`, not the built-in target's Llama-8B** (plan 01 spike
   log: no Llama passes through a stock SDK). Say "a stock Agents SDK agent", name the model once, never
   imply it is the same model the loop was built on.
4. **Repair on the external agent is "policy blocks the refund, then a validator strips the bait"**, not policy
   alone (plan 01 Step 4 evidence). After the policy-only patch gpt-oss-20b's failure is a *data leak* (it mentions
   the other customer's order), which the gate rejected; the accepted fix stacks `validate_strip_instructions`.
   Say "two patches", show both diffs.

## Step 1 — The video (2.5 min; ~5 hours total across two sittings)

Screen-recorded at 1440p on the dark theme, voice-over, no talking head. Sitting 1 (needs the new
golden tape): segments 0:00–0:50 and 1:30–2:00. Sitting 2 (needs 01 Step 4, 02, 03): 0:50–1:30 live
against the example agent, 2:00–2:40, then assembly.

| Time | Shows | Says |
| --- | --- | --- |
| 0:00–0:20 | Cycle page from the **new** golden tape: injected note, refund tool call, Judge verdict; cut to a later cycle where the same attack is `blocked_by_policy`. | "An AI support agent just refunded money because a ticket told it to. Antibody found that, proved it, and shipped a fix that the gate had to approve." |
| 0:20–0:50 | Heal → Agents, orbs cycling chaos/target/judge/repair/gate at 3× replay. | One sentence per agent. |
| 0:50–1:30 | **Plan 01:** the example agent's source (stock SDK, no `chaos` imports), the glue lines highlighted, then a cycle running against it and the refund blocked in the tool server. | "This agent is built on the OpenAI Agents SDK. Its logic is untouched. Antibody stands between it and its tools." |
| 1:30–2:00 | Results → a rejected patch's Cycle page, whatever the reason on the new tape is (`cycles.jsonl` records only each cycle's *final* gate, so a mid-cycle rejection never gets its own page — pick a cycle whose last gate rejected). | "The gate rejected this one. A patch that doesn't fix the failure, or breaks an earlier fix, or hurts a normal customer, does not ship." Do **not** say "more often than yes" — the tape does not support it. |
| 2:00–2:25 | Run list on Heal → roll back to an earlier version → `make check` fails with the attack that landed (02, 04). Settings drawer, `make demo`, CI badge. | "Every run is history. Roll back, and Antibody tells you what you just reopened. Clone it, one command." |
| 2:25–2:40 | Roadmap: enforcement sidecar, bring-your-own-tools, MCP proxy. End on the URL. | One sentence. |

**Fallback for 0:50–1:30 if plan 01 died at the spike:** the Zendesk trial is suspended (`docs/PLAN.md:39`),
so "real tickets" is **not** available as a fallback unless plan 00's first decision chose to stand up a
new trial. The honest fallback is the loop itself on the mock world: Chaos inventing a new attack family
(golden cycle 3 was a self-invented cross-ticket leak), Repair's memory of rejected patches, the
regression suite growing. "Every failure becomes a permanent test." If the Part 1 ticket-mode tape is kept
in `docs/` as an artifact, one sentence may say "the Part 1 run worked real Zendesk tickets" — past tense.

## Step 2 — README (~1.5 hours, after the tape and 01–03 are settled)

Keep the structure; change these:

- **Hero:** a 10-second GIF of the Cycle page (or a linked poster frame from the video's opening). A static screenshot lost once.
- **First paragraph:** unchanged, plus one sentence about the external agent (only if 01 landed).
- **"Works on real tickets" section:** rewrite to "supports Zendesk ticket mode" with the Part 1 run in
  past tense; the demo tape is mock-world and the README must say so in one line.
- **Running it:** two paths — `make demo`, then live with `.env` (Docker if the stretch happened).
- **Bring your own agent:** from plan 01 Step 5 (the HTTP contract, the example, what's next).
- **Settings:** one table mirroring the drawer.
- **What it does not do yet** — a roadmap, not a confession:
  - bring-your-own-tools (policies and validators know our five tools),
  - the enforcement sidecar (accepted policies in front of production tools),
  - MCP proxy (if not shipped),
  - noise: "the judge flipped N of 15 rows on re-run; the gate now samples the fix twice" (plan 04's counts),
  - `check` and live runs need your own W&B key; `make demo` and Replay do not.
- **CI badge** at the top (plan 03 Step 2).
- Architecture stays in `docs/`; the README links it.

## Step 3 — Part 2 form (1 hour; submit by **Sat Sep 26** so Sunday is for fixes only)

- Reuse the Part 1 description (it landed with the two judges who liked it). Add one sentence about the external agent (or the Zendesk story) and one about `make demo`.
- Category: production-ready — plans 02/03 are what make that honest this time.
- Links: repo, video on **unlisted YouTube** (Drive previews stall on large files), public Weave project.
- Thumbnail: Cycle page with the blocked refund, 1280×720, dark.
- Re-read the event page's submission instructions the night before; the earlier note said to submit to the Part 2 page, not Part 1's.

## Step 4 — Judges (15 minutes, after submitting)

Send the two LinkedIn notes to Xiangyi and Venkatarao *after* the form is in, so each can end with
one concrete thing that changed since they saw it. Under 300 characters each.

## Stretch — landing page (only after Steps 1–3 are submitted; kill after 3 hours)

One static page, same design language as the splash: hero sentence, the video, three bullets,
`make demo`, GitHub. Host it on GitHub Pages or Vercel.
A half-made landing page reads worse than none.

## Risks

- **Recording code that then changes.** Record the external-agent segment when it first works; keep that take.
- **Last-day submission.** Forms break and uploads stall. Submit Sep 26 with the video you have.

## Done when

- Video unlisted on YouTube, linked from README and form.
- README has Running it (2 paths), Bring your own agent, Settings, Run history and `check`, What it does not do yet, CI badge.
- Part 2 form submitted by Sep 26; confirmation screenshot in `docs/`.
- Two LinkedIn notes sent.
