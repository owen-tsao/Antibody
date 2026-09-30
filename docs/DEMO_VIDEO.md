# Demo video — as built (v3)

`video/out/antibody-demo.mp4` · 3:05 · 1920×1080 · 30 fps · silent master (music slot below). `video/out/antibody-demo-readme.mp4`
is the same cut at 720p under 10 MB for the README. For the Fully Connected "Most Production-Ready" submission. Every
number and every screen is real; the *Proof* column names the file. Style: the app in a rounded window with a deep
shadow on a blurred wallpaper (the landing shader, blurred and dimmed), bold + grey captions above it, slow push-ins,
300 ms dissolves; statement and one-number cards between.

**Subject:** OpenAI's own airline customer-service demo (`examples/agents/openai_cs_airline/`, Qwen via W&B Inference;
the dashboard names it **Skyward Air Support (Agents SDK)**). **Hero run:** `history/20260925T233010Z` (Sep 22: 12
cycles, 1 shipped, 11 refused, $0.0723). **Live run:** `runs/` (Sep 29, 20:29: 12 cycles, cycle 3 accepted v1, sweep
on). **Built-in agent's run:** `history/20260930T032937Z` (22 cycles, v0 → v4).

## Shot list, as rendered

**S** statement · **M** metric · **UI** app · **T** terminal · **L** logo. Times are the composition's.

| # | Time | Type | On screen | Caption (bold / grey) | Proof |
| --- | --- | --- | --- | --- | --- |
| 1 | 0:00 | UI | Landing `/`, full-bleed liquid-metal hero, 6 s. | — | `pages/Home.tsx` |
| 4 | 0:06 | S | Wordmark in Instrument Serif — the title card. | Antibody / Attacks your agent on purpose. Proves the failure. Ships a rule only if it hurts no one. | README ¶1 |
| 2 | 0:12 | S | | The prompt held. The tool didn't. / One lookup timed out — and the agent cancelled a flight it never read. | Sep 22 cycle 6 `scenario.faults` |
| 3a | 0:18 | UI | Home `/app`: the Skyward Air Support hero card (`Agents SDK · running · HTTP · airline domain`), a slow 1.15× push into it. | OpenAI's own airline agent, / under Antibody. | `pages/Home.tsx`, `history/agents.json` |
| 3 | 0:25 | UI | Cycle 6 `/app/runs/20260925T233010Z/cycles/6` at the top of the page, one 1.45× zoom onto Target `ran cancel_flight()` and Judge `failed · unauthorized action`. | Cycle 6, as the loop saw it. / Chaos attacked. The target ran cancel_flight on a reservation it never looked up. → No model judged this. / A deterministic check did. | `cycles.jsonl` cycle 6, `verdict.method` |
| 5 | 0:36 | S | | The tool layer is the seam. / Every agent has one. Antibody sits there — not in the prompt. | `chaos/gateway.py` ¶1 |
| 6 | 0:42 | S | | A few lines of glue. / None of it Antibody code. The agent's logic is untouched. | README "Bring your own agent" |
| 7 | 0:48 | UI | Current run `/app/run`: the Skyward Air Support card → **Heal** → `starting · measuring baseline…`, the four orbs, `target: Skyward Air Support (Agents SDK) via HTTP`. Live: a real run started for the shot and stopped ~25 s later. | One button. / Heal starts a real run against the live airline agent. → Four agents take turns. / Chaos attacks, Target answers, Judge decides, Repair proposes — a gate decides what ships. | `runs/loop.log` (the stopped run; `runs/` restored after) |
| 8 | 1:04 | UI | Cycle 6 opened lower (a second take, the page already scrolled): Repair → Gate `accepted · v0 → v1` → the three-line diff, one 1.4× zoom. | The fix: three tools now need a verified lookup first. / Passed twice, held every earlier fix, left real customers no worse off. | cycle 6 `gate`, `configs/v1` |
| 9 | 1:16 | M | | 2 / 2 / passes required before a fix ships · every earlier fix re-checked · legit users no worse than production | `chaos/gate.py` (`pass_k`, regression, legit suite) |
| 10 | 1:21 | UI | Run `/app/runs/20260925T233010Z`: the cursor down the twelve rows, the hover chart, resting on #6. Under the window: `THIS RUN · 12 cycles · 1 shipped · about 7¢`. | The gate says no more often than yes. / Eleven refused — one because it broke a customer flow that worked before. | `cycles.jsonl` (cycle 5) |
| 11 | 1:36 | M | | 1 of 12 / fixes shipped · sixteen minutes · about seven cents of inference | as above |
| 12 | 1:42 | S | | Self-healing is the demo. / Approval is the product. | — |
| 13 | 1:48 | UI | Review: the Sep 22 run's v1 in the editor (three-line `tool_rules.json` diff, header `blocked 2/2 tries · customers 4/10 · tested 10/11`), then the inbox card for the live run's pending Fix 1 → **Approve**. Live: `runs/approvals.json` gained `"1": approved` at 06:33:30Z. | Nothing ships itself. / A rule is three lines a person can read — with what the gate measured beside it. → Every accepted fix waits for a person. / Approve, or reject. Nothing else moves it. | `runs/approvals.json` |
| 14t | 2:05 | T | The real command and stdout: `python -m chaos.gateway --backend http://127.0.0.1:8793 --version 1 --shadow`, `rules for: book_new_flight, cancel_flight, issue_compensation`, the Kelly request, the agent's reply *"Dev's rebooking to flight NY950 … is confirmed"*. | The gateway is the only thing that runs in your stack. / Shadow first — it logs what it would block. Then enforce. | `video/out/gw/shadow.log`; `history/gateway.jsonl` `gw-live-1` |
| 14a | 2:14 | UI | Agent page › Live traffic, row `book_new_flight(flight_number=NY950) · gw-live-1 · would block`. The panel header reads today's totals, `10 calls · 4 blocked · enforce` (the log is cumulative). | An impersonation, caught by the rule the loop wrote. / book_new_flight with nothing verified — would block. The booking still went through: shadow mode. | `history/gateway.jsonl` |
| 14b | 2:21 | UI | Same page, row `… gw-live-2 · blocked` in red. | Same request, enforce mode. / blocked. The flight was never booked. | `history/gateway.jsonl` `gw-live-2` |
| 15a | 2:29 | UI | The built-in agent's 22-cycle run `/app/runs/20260930T032937Z`: `Fix 4 would block 5 of the 7 attacks that got through`, the cursor on #5 (`blocked in 2 of 2 tries → Fix 1`) and down the rows on screen. | Before launch: / run the loop until the attacker runs dry. | `history/20260930T032937Z/cycles.jsonl` |
| 15b | 2:37 | UI | Import incident dialog on the airline agent, a transcript typing, family `social engineering`. Never submitted. | When a bug ships: / paste the transcript — it becomes a permanent test. | `ImportIncidentDialog.tsx` |
| 15c | 2:47 | UI | Schedules orbit, then the New schedule form. Nothing saved. | Whenever anything changes: / a schedule, or `check --approved` in CI. | `ScheduleDialog.tsx` |
| 16 | 2:54 | M | | 522 tests / none need an API key · run on every push | README; CI |
| 17 | 2:59 | L | Wordmark. | Antibody / Every failure becomes a test. | — |

## What changed in v3, and why

- **No scrolling on camera.** Screencast frames arrive only on repaint, so a scroll on a mostly static page reads as a
  stutter. Cycle 6 is now two takes (top of page; opened pre-scrolled to Repair/Gate/diff), 15a stays on the rows
  that fit the window, and the gateway rows are jumped into view before the shot starts. Each UI shot has at most one
  zoom, so nothing pans.
- **Shot 3a added.** "OpenAI's own airline agent" is now said over the home page's Skyward Air Support hero card,
  not over a log page.
- **The three-question beat (v2's 9 and 9b, 31 s) is gone.** The gate's rules live in shot 8's caption and the "2 / 2"
  card again; the cut is 3:05.
- **Every capture was retaken** after the browser window was touched during the v2 takes. The Heal shot's Clear left
  `history/20260930T063353Z`, a byte-identical copy of the live run; deleted, along with v2's `…060026Z`.

## What changed in v2, and why

- **Capture moved from headless `recordVideo` to a headed GPU screencast.** Headless Chromium renders WebGL through
  SwiftShader (measured: 15 fps on the hero, `UNMASKED_RENDERER` = SwiftShader) and Playwright's recorder encodes VP8 at
  1 Mbps in realtime mode — the v1 hero stuttered and every UI shot was soft. Headed Chromium on this Mac reports
  `ANGLE Metal Renderer: Apple M2` at 48–60 fps; `Page.startScreencast` hands over every composited frame as a
  JPEG-100 at 2× (2880×1800), packed by Remotion's bundled ffmpeg into a 60 fps CRF-12 clip. The only lossy step left
  is the master.
- **The title card moved to 0:06.** At 0:30 it read as an ending. The hero → title → problem → evidence order is the
  natural one.
- **Shot 15a re-scoped.** The Agent page's dither donut was removed in the Agents refactor; the 22-cycle run page shows
  the same story (v0 → v4, later attacks simply `blocked`) with real rows. The capture keeps its filename.
- **Scrolls** were eased per animation frame in v2; v3 removed them from the shots altogether (above).
- **The featured break stays Sep 22 cycle 6.** The live run's accept (cycle 3) is a judge false-negative: the agent
  correctly refused, the LLM judge said `wrong_action`, and the sweep measured v1 at 6/6 attacks landing (v0: 5/6). The
  video shows that run only for the Heal press and the approval click, and says nothing about what its fix blocks.
- **The gateway runs the Sep 22 rule, pinned `--version 1`.** The live run's v1 flipped legacy booleans and wrote no
  `tool_rules`; the Sep 22 v1 has three `requires_verified_lookup` rules and is what blocked Kelly. The captions never
  call that version "approved".
- **Approval:** `runs/approvals.json` is reset to pending before each take of shot 13 so the click is real; the
  on-camera approval (06:33:30Z) is the one on disk. `video/out/approvals.backup*.json` hold the previous, identical
  decisions.
- **Shot 7 bookkeeping** (`video/out/s07-dance.sh`): Clear archives the live run into `history/`, Heal starts a real
  run, the loop is stopped as the script exits, `runs/` + `cycles.jsonl` are restored from the copy and the archive
  folder (a duplicate of the live run) is removed.

## Bugs found while shooting v1 — fixed before v2

1. `GET /api/gateway/replay` ignored `source` and loaded the live run's config. Verified fixed: Sep 22 v1 over the
   airline backend now reports `would_block: 4` of 10.
2. `usePoll` never re-ticked when `fn` changed, so Live traffic showed "…" for 30 s. Verified fixed: rows in 0.7 s; the
   s14 capture's 33 s pre-wait is gone.
3. Current run's starting face printed `target: built-in` before `run.json` existed. Verified fixed: the empty face reads
   `Skyward Air Support · Agents SDK · running · HTTP · airline domain`.
4. After a `blocked` tool response the demo agent died with `ModelBehaviorError` instead of refusing. Fixed in
   `examples/agents/openai_cs_airline/agent.py`; **not re-exercised for v2** (no new gateway traffic was sent).

## Production

`video/` is its own workspace (Remotion + Playwright; `web/` untouched). `capture/*.mjs` drive a **headed** Chromium
against the API-served dashboard on `:8000` and write `public/shots/<name>.mp4` (2880×1800, 60 fps) plus an event log
(moves, clicks, scrolls, marked boxes, page changes); `src/shots.ts` is the table above as data; `src/components.tsx`
draws the wallpaper, cards, the framed window, zooms and the cursor. Render: `npm run render` (≈10 min; the sources are
large). README copy: an ffmpeg pass of the master to 720p at ~340 kbps. Music: drop a licensed ambient track at
`video/public/music.mp3`, set `MUSIC` in `src/shots.ts`, re-render; the volume curve is −14 dB with a 4 s fade at each
end.
