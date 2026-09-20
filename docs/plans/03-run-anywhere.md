# 03 — Run anywhere: one command from a fresh clone, tests + CI

**Budget:** ~7 hours. Step 1 first (it depends on nothing and everything else in lane B builds on it);
then tests + CI; the fresh-clone test is the last thing before submitting. The Dockerfile is stretch and
the hosted deploy is **dropped** to pay for plan 02 Part B (run history + rollback) — judges get the video
and `make demo`; almost none will click a hosted link.
**Outcome:** `git clone … && make demo` opens the dashboard with Replay preloaded on a machine with
no `.env`. CI is green on `main`, which is the most legible "production-ready" signal a repo page can show.

## Facts this plan rests on

- Starting the app today is two processes from `scripts/dev.sh`: uvicorn on 8000 and Vite on 5173
  proxying `/api` (`web/vite.config.ts:15`).
- FastAPI serves **no static files**; no health route; no CORS; no Dockerfile; no `.github/`; **no tests**.
- `web/dist/` builds (`tsc -b && vite build`) but nothing serves it. The app fetches relative
  `/api/...` (`api.ts:281,287`), so the built app must be same-origin with the API.
- Replay needs only `data/golden/` (committed, ~80 KB) — no key. Live needs `WANDB_API_KEY`.
- `loop_ctl` already degrades without `pgrep`/`lsof` (`loop_ctl.py:114,149–154` catch the missing
  binary). **Do not** set `ANTIBODY_IGNORE_EXTERNAL_LOOP` on the demo server (`api/main.py:21` says so).
- `warm_weave` (`attack.py:83–95`) calls `weave.init` in a daemon thread at startup even with no key.
- `POST /api/attack` checks the key only when tracing is enabled (`main.py:300`); with
  `ANTIBODY_NO_WEAVE=1` and no key it falls through to `get_client()` → `SystemExit` → HTTP 500.
- `runs/` and `cycles.jsonl` are written to the repo root (`state.py:19–22`).

## Step 1 — Serve the built app; health; key guards; Makefile (~3 h — do it all in one pass)

- `api/main.py`, after every `/api` route: `app.mount("/", StaticFiles(directory=ROOT/"web/dist", html=True))`
  **only if the directory exists**. Starlette matches routes in order and `mount` appends, so
  `/api/*` wins. `html=True` serves `index.html` for `/`; the app routes purely by query string
  (`?page=…&n=…`, `App.tsx:44–48`), so no SPA fallback is needed (and `StaticFiles` doesn't provide one).
- `GET /api/health` → `{ok, version, live_exists, golden_exists, has_api_key, weave}`. Never echoes the key.
  The Makefile waits on it; the Heal/Agents no-key banners read `has_api_key` (already shipped in `7a04986`).
- `warm_weave`: early return with one log line when the key is missing — "no WANDB_API_KEY: Replay only".
- **Key guards** (30 min, same pass): `/api/attack` key check made unconditional; `POST /api/loop/start`
  returns 503 without a key (plan 02 A1). Both protect anyone who clones without a key. **Same pass**, the Results
  seed-attack button reads `has_api_key` from `/api/health` and hides itself — otherwise the local
  dashboard shows a raw 503 until plan 02 lands.
- `ANTIBODY_RUNS_DIR` override in `state.py`. Two paths, not one: `RUNS_DIR` **and** `CYCLES_PATH`, which
  today is `ROOT/cycles.jsonl` (`state.py:22`). Same pass: introduce `HISTORY_DIR` (default `ROOT/history`,
  override `ANTIBODY_HISTORY_DIR`), rename `ARCHIVE_DIR` to it (`state.py:68`), point `archive_previous_run`
  at it, drop `snapshot_golden`'s `ignore("archive")` (`:100`), and **move the existing `runs/archive/*`
  folders into `history/` once** so the next `reset` does not delete them. Plan 02 Part B builds on this. `api/store.py` and `chaos/status.py` import these constants, so they
  pick the override up for free.
- `web/package.json`: `"engines": {"node": ">=20"}`.

`Makefile` (no new dependency):

```make
setup:   uv sync && npm --prefix web ci
build:   npm --prefix web run build
dev:     scripts/dev.sh
serve:   uv run uvicorn api.main:app --port 8000
demo:    build, then serve, then open the URL (macOS `open`, Linux `xdg-open`; fall back to printing it)
run:     uv run python -m chaos.loop run $(ARGS)
test:    uv run pytest && npm --prefix web run build && npm --prefix web run lint
golden:  uv run python -m chaos.loop golden
```

`make demo` with no `.env` must open Heal with the Replay link working and the Heal orb disabled with the plan 02 message.

## Stretch — Dockerfile (~2 h, only after Steps 1–3)

Multi-stage: `node:22-alpine` builds `web/dist`; `python:3.12-slim` installs from `uv.lock` (copy
`pyproject.toml`, `uv.lock`, `.python-version`), copies `chaos/`, `api/`, `data/golden/`, `web/dist`.
Final stage has **no `uv` on PATH** so `loop_ctl._command` uses `sys.executable` (`loop_ctl.py:186–188`).
`CMD` in shell form so `$PORT` expands. `ANTIBODY_RUNS_DIR=/data/runs`. Check the built image size
first — `three` and the shader packages make `web/dist` heavier than the Python side.

## Dropped — Hosted demo

Was: Fly.io or Railway, Replay-only, no key. Dropped in favour of plan 02 Part B. If it comes back later:
deploy with **no key** and `ANTIBODY_NO_WEAVE=1`, do not auto-play on load, health check on `/api/health`.
The key guards in Step 1 were designed for this and stay regardless — they also protect anyone who
clones the repo without a key.

## Step 2 — Tests + GitHub Action (~3 h)

There are zero tests. Ten pytest cases on pure functions are the cheapest credible production signal:

- `policy_blocks`: refund without intent; refund on another customer's order; email to non-owner; ticket out of scope.
- `_deterministic_checks`: crash; forbidden tool call; leaked planted note.
- `validate_strip_instructions`, `validate_record_matches_request`.
- `run_gate` with `run_evaluation` stubbed: accept; reject-on-regression; flaky-row forgiveness.
- The plan 01 golden-episode replay through `call_tool` (ticket tools stubbed from recorded results; no creds needed).
- `replay.status_at` at t=0, mid-tape, past the end (`ended: true`).

`.github/workflows/ci.yml`: `uv sync`, `uv run pytest`, `npm ci && npm run build && npm run lint` in `web/`.
Badge in the README. Dependency: `pytest` as a dev dependency — **ask before adding**.

## Step 3 — Fresh-clone test (last thing before submitting)

On a machine or clean account that has never seen the repo: `git clone`, `make setup`, `make demo`,
press Replay, watch a tape. Then add `.env` with only the key and `make run ARGS="--seeds 1 --chaos-cycles 1"`.
Time both. Every friction point goes into README "Running it"; the code ones get fixed before submitting.

## Risks

- **`uv` and Node versions.** README states minimums (pin `uv` in the Dockerfile if the stretch happens).
- **Google Fonts offline.** Check the fallback stack in `index.css` renders legibly.
- **Fresh-clone friction.** Step 3 is uncosted (~1 h); budget it.

## Done when

- `make demo` on a fresh clone with no `.env` opens the dashboard and Replay plays; Heal is disabled with a message.
- `GET /api/health` returns `{ok: true, has_api_key: false}` with no key; `/api/attack` returns 503, not 500.
- CI green on `main` with ≥ 10 tests; README shows the badge and the two "Running it" paths (`make demo`, live with `.env`).
- Stretch: `docker build . && docker run -p 8000:8000 …` plays Replay.

## Decisions

**Step 1 — shipped** on `feature/run-anywhere-base` (`cfa4d1b`, `c14b372`).

- `POST /api/attack` with an empty body is 422 (pydantic validates first); the 503 needs a well-formed body such as `{"scenario_id":"x"}`. Test it that way.
- `reset` never deletes a leftover `runs/archive` — only reachable if a legacy folder's name collides with one already in `history/`; it wipes everything else and says "move it by hand". Stray files (`.DS_Store`) do not count as leftovers.
- `snapshot_golden` also runs the migration first; with `ignore("archive")` gone, an unmigrated checkout running `golden` would otherwise copy every old run into `data/golden/`.
- `health.weave` is a string (`no_key | disabled | warming | ready`), not a bool; `api.ts` types it `unknown`.
- Default `CYCLES_PATH` stays `ROOT/cycles.jsonl`; it moves inside the runs dir only when `ANTIBODY_RUNS_DIR` is set, so existing live files are not orphaned.
- Not tested: `make demo`/`setup`/`build` end to end (no `node_modules` in the worktree), the static mount with a real Vite build, and the migration on the real 8 archives — that happens on the user's next `reset` or run.
- `pytest` as a dev dependency: **approved** by the user (Step 2 may add it).

**Step 1 review fixes — shipped** (`f31f851`, with 02 A1 fixes in the same commit). Import-time refusal when
`HISTORY_DIR` is inside `RUNS_DIR`, equals it, or `RUNS_DIR` contains the repo (`ANTIBODY_RUNS_DIR=.` would have made
`reset` delete the repo). Archive migration is atomic per folder (`.incoming-<name>` staging then `os.replace`;
cross-device copy failures remove the partial and leave the source). The emptied `runs/archive` is removed only
when leftovers ⊆ `{.DS_Store, Thumbs.db}`; symlinks are never followed. `make demo` opens with `uname -s = Darwin →
open`, else `xdg-open`, else prints the URL (Debian's `/usr/bin/open` is `openvt`). `health.golden_exists` checks
`status_log.jsonl` + `cycles.jsonl` (what replay needs). `health.weave` reports `failed` after a broken warm-up.
Not tested: a real second-volume migration (EXDEV path exercised by monkeypatch); Linux opener branch.

