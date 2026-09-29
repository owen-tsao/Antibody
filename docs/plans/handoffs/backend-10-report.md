# backend-10 — production-fit review fixes

Lane: fix the five findings and the one-line nits from `review-2-production-fit.md`. Nothing committed; the
working tree holds the change. Counts at the end: **480 tests pass** (was 474), web build clean, lint 0 errors.

Verification commands (all green on macOS 15, Python 3.12, Node from `web/`):

```
uv run pytest -q                 # 480 passed — no env -u needed any more, see F5
npm --prefix web run build
npm --prefix web run lint        # 0 errors, the same 6 pre-existing warnings in vendored ui/ files
```

## F1 — Review page after an API outage

**Root cause.** `readRuns` in `web/src/pages/Review.tsx` wrapped every per-run fetch in `.catch(() => null)`, so
when the API was down `usePoll` received a successful, empty read. The page then had no error to show, treated
every version as undecided (Approve/Reject on a rejected v3), and because the read was a one-shot keyed on the
run list, it never fetched again when the API came back.

**Fix.** The `.catch` is gone: a failed read rejects, `usePoll` records the error, and the page shows the same
`ApiDown` line every other page does. `Shell` now exposes `down` (its own poll has failed) in `ShellData`; the
Review page watches the `down → up` edge and calls `reread()` / `rereadPair()` once, so recovery needs no reload.
The read also has a slow 30 s poll as a backstop. Approve/Reject are replaced by the plain decision pill whenever
`down` is true or the approvals read has an error (`frozen` in `StripActions`), with a one-line reason.

**Test.** No unit layer for this (it is the interaction of two polls); browser-checked instead.

**Evidence.** With the page open on v2 · pending: `pkill -f "uvicorn api.main"` → within one poll the sidebar and
the file pane both read `api unreachable · retry`, the header shows `pending` instead of Approve/Reject, and the
tree keeps its last-good marks (v3 still `rejected`, not `pending`). Restart the API → file content, gate numbers
and the Approve/Reject buttons return without a reload.

## F2 — Home at narrow widths with the sidebar open

**Root cause.** Two rules stacked: the Home grid put the 400 px side column beside the hero from `lg` (1024 px)
on, and `Facts` chose four columns from the `sm` *viewport* breakpoint. At 1024 px with the 256 px sidebar the
hero column was ~300 px, so four facts had ~50 px each. Moving the side column to `xl` alone was not enough: at
1280 (~500 px hero) and even 1440 (668 px hero) the longest value, `3 of 5 known attacks` (149 px), still clipped.

**Fix.** `Home.tsx`: the side column joins the hero at `xl` (1280) instead of `lg`. `components/Facts.tsx`: the
strip is a `@container`, and four facts sit two-by-two until the strip's own box is 48 rem (`@3xl`) wide — the
width is measured against the strip, not the viewport, which is what the viewport rule got wrong. Five-cell
strips (all numbers) keep the previous viewport rule. Tailwind 4 has container queries built in; no dependency.

**Test.** Layout only; browser-checked.

**Evidence** (sidebar open, `Emulation.setDeviceMetricsOverride`): 1024 → single column, facts 2×2, title one
line; 1280 → two columns, facts 2×2, nothing truncated; 1440 → two columns, facts 2×2 (`gridTemplateColumns`
`321px 321px`, every `dd.scrollWidth <= clientWidth`). Sidebar collapsed at 1440 → four across, no truncation.
Neighbours: Run's Versions panel (3 and 5 cells) and About strip render as before at 1440.

## F3 — Agent page Shadow log showed the whole install's log

**Root cause.** `api.gateway(tail)` had no way to say whose rows it wanted; `GET /api/gateway` returned the last
N rows of the one `history/gateway.jsonl` regardless of which backend the gateway sat in front of, and the page
labelled that "this agent's tools".

**Fix.** One filter, `chaos.gateway.for_backend(rows, backend)`, used by both `read_log` (the Shadow log) and
`replay` (Review's "would have blocked N of M"). Rows written before the field existed carry no `backend` and match
no filter. `GET /api/gateway?backend=<url>` is the new optional query param; the command line it returns names
that backend. `Agent.tsx` passes `agent.tools_backend` and does not poll at all when the agent has none — the
panel shows the "no tools backend" empty state.

**Test.** `tests/test_gateway.py::test_api_log_is_scoped_to_one_backend_the_way_the_replay_is` (mixed log of two
backends plus a legacy row; each backend sees only its own rows, the legacy row is in neither, no param returns
all). The existing replay test covers the same function from the other side.

**Evidence.** Live install log has 5 legacy rows (no `backend`). Airline agent (`http://127.0.0.1:8793`):
Shadow log reads `no traffic yet` with `python -m chaos.gateway --backend http://127.0.0.1:8793 …` — before the
fix it listed those 5 unattributed rows. Example agent (no backend): `no tools backend`, and the API log shows the
UI issued only `GET /api/gateway?tail=200&backend=http%3A%2F%2F127.0.0.1%3A8793` requests, none unscoped.

## F4 — 422 responses echoed the request body

**Root cause.** Nothing capped request size before FastAPI parsed the body, and FastAPI's default
`RequestValidationError` response includes each error's `input` — for a bad top-level shape, that is the whole
body. A 5 MB paste to `/api/scenarios/import` came back as ~11 MB.

**Fix** (`api/main.py`, one place). `BodyCap`, a pure ASGI middleware registered on the app: 1 MiB default
(`MAX_BODY_BYTES`), 256 KiB for `/api/scenarios/import` (`BODY_CAPS`; `incidents.py` already refuses >200 KB
after parsing, so this is a front-door version of the same rule). It answers 413 with a short JSON detail from
`Content-Length` before the route runs, and for chunked bodies counts the streamed bytes and cuts off at the cap —
sends the 413 itself and hands the app an `http.disconnect`. The 422 handler (`_validation_errors`) drops `input`
from every error when the body was over `ECHO_MAX_BYTES` (4 KiB); small bodies keep the helpful echo.

**Tests.** `tests/test_incidents.py`: `test_oversize_bodies_are_413_before_parsing_on_every_route` (the import
route's tighter cap via `Content-Length` and chunked, the default cap on another route one byte over and one byte
under), `test_a_streamed_body_is_cut_off_at_the_cap_across_chunks` (the ASGI counting path fed chunks that only
together cross the line: 413 goes out, the app gets a disconnect, later app output is dropped),
`test_a_422_on_a_big_body_does_not_echo_the_paste` (a 30 KB paste and a 10 KB wrong-field body → 422 under 1 KB with
no `input`; a small body keeps it).

**Evidence.** Against the live API: `POST /api/scenarios/import` with `Content-Length: 5000000` →
`413 {"detail":"request body is larger than 262144 bytes"}`.

## F5 — a test wrote into the real `runs/approvals.json`

**Root cause.** `chaos.state` resolves `RUNS_DIR` / `HISTORY_DIR` from the environment **at import**, and
`api.store` / `api.loop_ctl` copy them at import too. A per-test monkeypatch of one module could not cover the
others, so any test that forgot one patch wrote to the checkout. Separately, `env -u WANDB_API_KEY` never made the
suite keyless: `load_env()` re-read `.env` at import and put the key back.

**Fix.** `tests/conftest.py` runs before any test module imports `chaos`: it creates one scratch directory for the
session, sets `ANTIBODY_RUNS_DIR`, `ANTIBODY_HISTORY_DIR`, `ANTIBODY_NO_DOTENV=1`, drops `WANDB_API_KEY`, and only
then imports `chaos.state`. A session-wide autouse fixture asserts `state.RUNS_DIR`, `state.HISTORY_DIR`,
`state.CYCLES_PATH`, `store.HISTORY_DIR` and `loop_ctl.RUNS_DIR` are all under the scratch dir (and that the key
is absent), and removes the scratch dir at the end. `chaos/config.py`: `load_env()` returns early when
`ANTIBODY_NO_DOTENV` is set. `docs/SMOKE.md`, `.env.example`, `README.md` and the test docstrings that said
`env -u WANDB_API_KEY` now say the suite is keyless as written and how to run a keyless API
(`ANTIBODY_NO_DOTENV=1 uv run uvicorn …`).

**Tests.** The autouse fixture itself (fails the session if any module escaped), plus
`tests/test_loop_ctl.py`: one test that `load_env` is a no-op under the flag and fills gaps without it, one that
`state` paths live under `conftest.SCRATCH`.

**Evidence.** `runs/approvals.json` mtime unchanged across two full runs of the suite (17:31 before, unchanged
after). Scratch dir is gone after the session (`ls $TMPDIR/antibody-tests-*` → none). macOS wrinkle handled:
`/var/…` is a symlink to `/private/var/…`, so the scratch path is `.resolve()`d before comparing.

## Nits

Done (one-liners):

- N1 `diffHeadline` says `v1 vs v0 · first proposal` when the version itself is decided.
- N2 `Page.tsx` eyebrow is `shrink-0`; the title truncates, not the section name.
- N5 `derive.ts`: `legitCoverageLine`, `PSEUDO_FILES`, `domainLabel`, `hasReviewable` no longer exported; `api.ts`:
  the ten unreferenced type exports are now module-private.
- N6 `.env.example` gains one comment naming the dev/test knobs and the files that read them.
- N7 folded into F5 (`ANTIBODY_NO_DOTENV`); `docs/SMOKE.md` says the true keyless recipe.
- N8, N9, N10 were already fixed by the reviewer.

Skipped:

- N3 (`radial-orbital-timeline.tsx` vendored leftovers) — a real cleanup of a third-party component, not a
  one-liner; better as its own small lane with a visual check.
- N4 (raw `502 Bad Gateway` text after a decision fails during an outage) — mostly moot now that Approve/Reject
  are off while the API is down, but the race (API dies between the poll and the click) still shows the raw
  message once. Wording-only; left for the same UI lane as N3.

## Observations, not changed

- Run page "About this run" strip: a long agent name (`Example airline agent (OpenAI CS demo)`) truncates in its
  cell at 1440 with the sidebar open. Pre-existing, has a hover title; the six-cell strip keeps the old rule.
- Lint's 6 warnings are all in vendored `components/ui/*` files and predate this lane.

## Not tested

- Linux/CI: the suite ran on macOS only; the conftest scratch path logic uses `tempfile` + `.resolve()`, which is
  the same on Linux, but CI has not run this tree.
- The Shadow log's positive path (rows *with* a matching backend showing on the Agent page) is covered by the
  endpoint test, not by the browser — producing real rows means running a gateway against the checkout's own
  `history/`, which this lane deliberately did not touch.
