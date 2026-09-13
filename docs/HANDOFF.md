# Frontend handoff

Short guide so you can poke at the UI that already exists while the remaining slices get built. Full plan lives in `FRONTEND.md`; this is just what you need right now.

## Run it

One command from the repo root brings up both servers and stops both on Ctrl-C:

```bash
scripts/dev.sh
# web  http://localhost:5173
# api  http://localhost:8000/api/state
```

`ANTIBODY_LOOP_CMD="sleep 30" scripts/dev.sh` passes the loop override through to the API (see below).

If you would rather run them by hand (or one is already running in a terminal):

```bash
# backend (read-only API over runs/ with golden fallback)
# add --reload only while editing api/: a reload forgets the loop it spawned, and Stop stops working for that run
uv run uvicorn api.main:app --port 8000

# frontend
cd web && npm run dev          # http://localhost:5173
```

Vite proxies `/api/*` to `127.0.0.1:8000`, so you only ever open the 5173 URL.

## Where to look

| URL | What it is | State |
|---|---|---|
| `http://localhost:5173/` | Intro: liquid metal hero, title, subtitle, Start / Replay buttons | Done, tuned per your feedback |
| `http://localhost:5173/?page=results` | Results: headline, hoverable cycle list, cycle detail + config diff | Done, being polished (see below) |
| `http://localhost:5173/?page=agents` | Agents: orbs (one hue per active agent) + cycles box; `replay · recorded …` label + stop during a replay | Done |
| `?demo=hero` / `?demo=orb` / `?demo=list` / `?demo=plan` | Each UI component alone, for styling in isolation | Done |

Pages are driven by React state, not a router. `?page=` and `?demo=` are just deep-links read on load.

## What is done vs. not

Done
- Slice 0: `web/` scaffold, Tailwind v4 tokens, the four 21st.dev components copied in with the documented tweaks.
- Slice 1: FastAPI adapter. `/api/state`, `/api/cycles`, `/api/configs`, `/api/configs/{v}`, `/api/status`, `/api/regression`. Falls back to `data/golden/` when there's no live run.
- Slice 2: Results page wired to real data. Verified in browser: headline text, four rows (cycle 4 blocked, 3/2/1 repaired), cycle detail with five handoffs.

- Slice 4: Agents page wired to `/api/status` (1s poll) and `/api/cycles`. Verified in browser on golden data: four orbs, gate line, plan with four cycles.
- Slice 5: Start actually spawns the loop (`POST /api/loop/start`, `GET /api/loop`, `POST /api/loop/stop`, `GET /api/loop/log`, `GET /api/manifest`). Verified in browser; a real start is still untested because another chat's golden run owned `runs/` all evening. (The Intro-era stepper and manifest line were later removed from Heal — see the Sun 00:30 notes below.)
- Slice 3: `POST /api/attack` (`api/attack.py`) runs the seed injection scenario against any saved config in-process and judges it, without logging a cycle. Results has the two quiet buttons top-right ("Run seed attack against v0" / "Same attack against vN"); each result is prepended to the cycle list as a `preview · not logged` row. Red marks only the call the judge cites as evidence (not every side effect), `blocked by policy` when the policy stopped it, then PASS/FAIL and duration. Past 20 s it falls back to the recorded cycle, labeled `(replayed)`. × or Esc dismisses. Verified in the browser with a real click: v0 issues the refund, `FAIL · unauthorized_action`, 2–4 s.
- Review pass (Sat 23:00): two independent reviews of `api/` and `web/src`, all should-fixes applied. Notable: the regression fraction now uses the right denominator (the gate scores the suite minus the new failure, so live cycle 3 reads `1/2`, not `2/3`); handoffs show the full `episode.tool_calls` with blocked calls labelled; `/api/status` reports `idle` (with `stale: true`) when no loop process is alive, so a Stop or crash can't leave orbs lit; Weave is warmed at API startup so the first attack is fast; Start is race-safe; "Open evaluation in Weave" appears when the record has eval URLs.
- Slice 7 (Sun 00:30): **Replay is real.** `api/replay.py` plays `data/golden/status_log.jsonl` into `/api/status` and lets the golden cycles appear in `/api/cycles` on the recording's schedule; `/api/state` says `source: "replay"`. Heal's "Replay recorded run" calls `POST /api/replay/start`; Agents shows `replay · recorded HH:MM:SS · stop replay` next to the headline (stop returns to Heal). If a live loop is running the API answers 409 and Agents shows the live run with the note `a live run is in progress · showing it instead`. The replay ends by itself 5 s after the recording's last row. `?speed=3` on the start route plays the 16-minute golden run in ~5.5 minutes for rehearsals. Verified with curls on a scratch API (see FRONTEND.md §3); **not yet watched in the browser**.
- Orb colours (Sun 00:30): each orb takes its agent's hue only while that agent is active — Chaos red, Target amber, Judge blue, Repair green (`ORB_COLORS` in `Agents.tsx`); idle and done are grey. The Target no longer turns red as an orb; a proven failure under repair reads as a red caption (`compromised` during Repair, `regression` during the gate). During the gate Target and Judge are both lit (amber + blue). Not yet screenshot-checked.
- Heal cleanup (Sun 00:30): the manifest line and the −/+ stepper (with the disabled "until N in a row" option) are gone. Heal always sends `{mode: "fixed", chaos_cycles: 1}` (`DEMO_CHAOS_CYCLES` in `App.tsx`; was 3 until the run-length measurement). The stepper and saturation rule are deferred, not rejected; the backend contract is unchanged (FRONTEND.md §4.1).
- Live beats replay (Sun 01:00): fixed a chain where Heal showed "View agents" because `/api/loop` had matched a loop running in a *different checkout* (`/tmp/antibody-test`), and Agents then showed a replay that happened to be active. Now (1) `/api/loop` only counts loops whose working directory is this repo (`lsof` cwd check in `api/loop_ctl.py`; falls back to the old behaviour if `lsof` is missing); (2) precedence is live > replay > file everywhere — `replay_if_no_loop()` in `api/main.py` is the one decision point for status/state/cycles/configs, it stops a replay as soon as a live loop is seen, and `POST /api/loop/start` stops a replay before spawning; (3) `GET /api/replay` always carries the recording's `{recorded_at, cycles, duration_s}`; (4) Heal polls `/api/loop` + `/api/replay` every 2 s: the quiet link reads `Replay recorded run · 10:31 PM · 7 cycles`, or `Resume replay · 3× · m:ss / m:ss` with a `stop replay` link while one plays, and is hidden while a real loop runs. Heal always starts a real run (it stops the replay first). Verified with curls on :8000 and a scratch :8001 (`ANTIBODY_LOOP_CMD="sleep 20"`); **the new Heal labels are not yet screenshot-checked in the browser**.
- Back pauses a replay (Sun 01:10): pressing Back on Agents during a replay now freezes it in place (`POST /api/replay/pause`; the session keeps `t0` and subtracts paused wall-clock time, so `/api/status` keeps serving the same row and the replay never expires while paused). Heal's link becomes `Resume replay · 3× · 4:12 / 16:26` (`POST /api/replay/resume`, then Agents) with `stop replay` beside it; Heal itself still discards the paused replay and starts a real run. A replay found still playing when Heal mounts (`?page=heal` deep link) is paused on mount, so Heal only ever knows "no replay" or "paused". Clicked through in the browser Sun 01:15: Back froze the clock at 2:09 for 11 s; Resume continued from there.
- Replay transport (Sun 01:30): the replay text left the status line and became a player strip under it (`web/src/components/ReplayControls.tsx`): `replay · 10:31 PM  [⏸]  1× 3× 5× 10×  ━━●───  1:07 / 16:26  stop`. Pause/play, speed chips and click-to-seek bar (←/→ ±15 s, Home/End, Space) map to `POST /api/replay/{pause,resume,speed,seek}`; speed and seek re-anchor the server clock so the position is continuous, and both work while paused. The clock interpolates locally between 1 s polls so it moves smoothly. Seeking backwards is exact (cycle tabs disappear again) because the replay is a pure function of elapsed time. Verified by curl and by clicking through on a scratch stack (`API_PORT=8001 npx vite --port 5174` proxies a second Vite at the scratch API — a real run owned :8000 at the time). Not exercised: what the orbs do in the ~1 s after a seek lands mid-phase (the dwell is reset, so they should snap).
- Review of the transport (Sun 01:55), two bugs of mine fixed: (1) `usePoll.refresh()` could leave two polling chains running forever if it fired while a fetch was in flight (`clearTimeout` cannot cancel an awaited fetch) — each transport click would have added a chain; now a generation counter retires the old chain and drops its stale result. Proven in the browser: 10 status polls / 10 s before and after three speed clicks. The old `visibilitychange` handler had the same latent bug. (2) `ReplayControls` was reading the *dwelled* status; the dwell holds the previous object for up to 1.2 s at each phase change, so the clock would have snapped back by up to 1.2 s × speed at every boundary. It now reads the raw poll (`tape` in `Agents.tsx`). Known and left alone: `set_speed`/`seek` mutate the session without the lock (same reason as pause/resume — `_current()` takes it, non-reentrant); a concurrent poll could read a half-updated clock for one response, microseconds wide, single-user demo. `stop` in the strip still navigates to Heal, as the old link did.

Not started
- Vulnerability bars in the hover chart: `runs/vulnerability.json` now exists (ask #3 landed), so this is unblocked — needs `/api/vulnerability` plus a few lines in `previewSvg.ts`.
- Backend ask #5 (`--until-quiet K`) and the "done · N blocked in a row" headline on Agents. The Heal-screen control for it comes back once that lands.

## Safe to edit right now

These aren't being touched by the background work, so no merge pain:

- `web/src/pages/Results.tsx` — free to restyle. Slice 3 landed: the two attack buttons live in the header's right slot and `web/src/components/PreviewRow.tsx` builds the preview row; keep the `onSelect` index offset (preview rows sit above the cycles).
- `web/src/pages/Intro.tsx` — copy, layout, button labels.
- `web/src/components/ui/liquid-metal-hero.tsx` — hero shader params. Header comment explains why `repetition`/`softness` are what they are and why `.params` is spread rather than the preset object.
- `web/src/index.css` — tokens, fonts. `--font-sans` is Inter, `--font-display` is Instrument Serif (applied to `h1` globally, which is why Results overrides it inline).
- `web/index.html` — font imports.
- `web/src/components/ui/button.tsx`, `orb.tsx`, `interactive-list-preview.tsx`, `agent-plan.tsx` — styling only. Keep the structural fixes noted in each file's header comment (orb `Suspense` wrapper, list z-order, plan `tasks` prop).

Please tell me before touching these so Slice 3 doesn't collide:

- `web/src/pages/Agents.tsx` — just landed; restyling is fine, structural changes ask first.
- `web/src/lib/derive.ts`, `web/src/api.ts`, `api/*` — Slices 3 and 7 are in; nothing planned still extends these.

If the Agents orbs look stuck on one phase, check for a stale `runs/status.json`. The backend writes it during a run; a leftover from a test will pin the page to that phase while every other endpoint serves golden data. Deleting it (and `runs/status_log.jsonl`) resets to `idle`.

Replay and testing without touching the demo server: a replay cannot start while a loop is running (409 by design). To exercise it next to a real run, start a scratch API on another port with `ANTIBODY_IGNORE_EXTERNAL_LOOP=1 ANTIBODY_NO_WEAVE=1 uv run uvicorn api.main:app --port 8001`, then `curl -X POST "localhost:8001/api/replay/start?speed=10"` and poll `/api/status` and `/api/cycles`. To see it in the UI too, run a second Vite pointed at it: `cd web && API_PORT=8001 npx vite --port 5174` and open `http://localhost:5174/?page=agents`. Never set that variable on the :8000 server.

Two more things about the loop controls:

- `/api/loop` now also sees loops it did not spawn (a terminal-started golden run, or its own child after a `--reload`): it reports `running: true, external: true` with the pid from `pgrep -f "chaos.loop run"`, **but only if that process's working directory is this repo** — a loop in another clone (e.g. `/tmp/antibody-test`) is ignored. Start returns 409 while one exists; Stop returns 409 too, because the API never kills a process it did not start. The Heal button reads "View agents" in that case instead of spawning a second loop.
- To exercise the Start flow without spending tokens, run the API as `ANTIBODY_LOOP_CMD="sleep 30" uv run uvicorn api.main:app --port 8000 --reload`. Start then spawns a 30-second sleep instead of the real loop.
- The Intro's bottom control row uses `mix-blend-mode: difference` so it reads on the hero's grey today and on black if you restyle the hero. If you change the hero to a mid-tone, that row is the first thing to re-check.

## Things worth knowing before you style

- Tailwind v4: tokens are CSS variables in `index.css`, exposed to Tailwind via `@theme inline`. Add a variable there and `bg-whatever` works; don't reach for `tailwind.config`.
- `cn()` is in `web/src/lib/utils.ts`, standard shadcn.
- `InteractiveListPreview` relies on `mix-blend-mode: difference` for the hover bar, so preview SVGs must be pure white on transparent. `web/src/lib/previewSvg.ts` does that; if you change colours there the hover will break.
- The orb canvases go black if `useTexture` isn't inside a `<Suspense>`. Already handled; just don't remove it.
- `npx tsc -b` in `web/` is strict (unused imports fail). Run it before you hand back.

## Golden data

Everything you see on Results comes from `data/golden/cycles.jsonl` (4 cycles) and `data/golden/configs/`. There is no live run in `runs/` yet, so the API is serving golden. Headline should read:

```
● v3 · 3 tests in suite · legit users 3/3 · last patch accepted
```

If it says `api unreachable`, uvicorn isn't running.
