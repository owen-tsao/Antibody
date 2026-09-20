# Handoff — Frontend lane: app shell, routes, landing/app split (plan Block 2)

You are working in the Antibody repo, worktree `/Users/owentsao/antibody-frontend`, branch
`feature/app-shell` (forked from `feature/fully-connected` at `8d34857`). Read `docs/plans/00-overview.md`
fully first — "The product decision", the **Scope** paragraph, and **Block 2** are your spec; Blocks 3–4 are
what comes next on this same lane, so leave room for them. Then read `docs/FRONTEND.md`, `web/src/App.tsx`,
`web/src/api.ts`, and skim every file in `web/src/pages` and `web/src/components`. Follow
`.cursor/rules/code-organization.mdc` (reuse map, no one-off components) and the UI standard at
`~/.cursor/skills/my-ui-standard/SKILL.md` (monochrome, emphasis budget, alignment).

## What you are building, in one sentence

Turn the linear slideshow (Intro → Heal → Cycles → Results → Cycle) into a landing page at `/` and an app
under `/app` with a persistent shell and real paths — without yet building the new pages (Blocks 3–4 do that);
today's pages keep working at their new addresses.

## Facts

- Navigation today: `App.tsx` `page` state mirrored into `?page=` / `?n=` via `replaceState` (`:83-90`); pages
  receive callbacks (`onBack`, `onResults`, `onCycle`). `ErrorBoundary.tsx:36` hard-codes `?page=intro`.
  `docs/HANDOFF.md` and `docs/plans/handoffs/ui-1-*.md` embed `?page=` links; the README does not.
- Backend serves `web/dist` with `StaticFiles(html=True)` mounted at `/` (`api/main.py` ~`:512`). **That
  404s `/app/runs`** — `html=True` only serves `index.html` for directory URLs. You add a catch-all route in
  `api/main.py` returning `web/dist/index.html` for any non-`/api` path, registered **before** the mount.
  Verify with `TestClient` that `/app/runs` returns the HTML and `/api/health` still returns JSON. This is the
  only backend edit you may make.
- `SplashBackdrop` (gradient + liquid metal shaders) is mounted once for Intro + Heal and must unmount before
  the four orb canvases on Cycles mount (`App.tsx:162-164`, `docs/FRONTEND.md` §5). In the new layout it belongs
  to the landing page only.
- `usePoll` (`hooks/usePoll.ts`) is the only polling primitive; `api.ts` the only fetcher; `ApiDown` the only
  "API unreachable" surface; `.u-line` the quiet link style; `MetalFrame` the framed surface.
- `api.ts` is stale vs the backend: `LoopStartBody`/`LoopState`/`LoopStarted` carry retired `mode`,
  `quiet_streak`, `max_cycles` (`App.tsx:130-133` still sends `mode: "fixed"`); `Manifest` lacks `defaults`;
  no `RunRow`/`runs()`/`run(id)`/`rollback()`; `replayStart` lacks `recording`; read fetchers lack `source`.
  Backend shapes: `GET /api/runs` row and rollback/replay bodies in `docs/plans/handoffs/ui-3-run-history.md`
  (§ "row shape", § "Replay and rollback shapes"); `LoopStartBody` fields in `api/loop_ctl.py:88-104`;
  `Manifest.target` for external agents is `{name: "http:<url>", model: null, model_short: null, transport: "http", url}`.
  The backend lane is adding `GET /api/agents` etc. in parallel — **do not invent those types yet**; Block 3 adds
  them from the backend's reported delta.
- Build/lint: `npm --prefix web run build` and `npm --prefix web run lint` (pre-existing warnings in
  `components/ui/orb.tsx` are not yours). Node ≥ 20.

## Build, in this order (build + lint clean after each)

1. **`web/src/lib/routes.ts`** — `type Route = {kind: "landing"} | {kind: "agents"} | {kind: "agent-new"} |
   {kind: "runs"} | {kind: "run", id: string} | {kind: "cycle", id: string, n: number}`; `parse(pathname): Route`
   (`/app` → runs; unknown under `/app` → runs; unknown elsewhere → landing); `href(route): string`;
   `navigate(route)` = `pushState` + notify; `useRoute()` hook subscribing to `popstate` + the notifier. Legacy
   `?page=…&n=…` → one `replaceState` redirect to the equivalent path on first load (`intro`→`/`, `heal`→`/app/runs`,
   `agents`→`/app/runs/live`, `results`→`/app/runs/live`, `cycle`→`/app/runs/live/cycles/:n`). Pure functions in
   this file are unit-testable by reading; keep them tiny.
2. **`api.ts` refresh** — drop the retired fields; add `defaults` to `Manifest`; `Manifest.target` nullable
   model fields + `url?`; add `RunRow`, `runs()`, `run(id)`, `rollback(body)`, `recording?: string` on
   `replayStart`, optional `source` on `state/cycles/config/configs`. `App.tsx` stops sending `mode`.
3. **SPA catch-all** in `api/main.py` (see Facts) + a test in `tests/test_static.py` (or extend the existing
   static-serving test if there is one — check `tests/` first).
4. **`components/Shell.tsx`** — left rail ≥ md (wordmark → `/`, items **Agents**, **Runs**, active state by
   route), top bar below md; status pill from `usePoll(api.loop)` + `usePoll(api.replay)`:
   "running · cycle N" / "replaying" / hidden, linking to `/app/runs/live`. `ApiDown` renders once here when the
   polls fail. Inner content fades 120 ms on route change (`framer-motion`, respect reduced motion). No slide
   transitions. Page titles keep the serif `display` class at 48 px; everything else Inter.
5. **`App.tsx`** rewired on `useRoute()`: `landing` → today's `Intro` with the button navigating to `/app`
   (`SplashBackdrop` mounted only here); everything under `/app` inside `Shell`. **Temporary mapping so today's
   pages keep working until Blocks 3–4 replace them:** `runs` → today's `Heal` content (minus its Back link),
   `run` → today's `Agents` when `loop.running` or a replay is active, else today's `Results`; `cycle` → today's
   `Cycle`; `agents`/`agent-new` → a titled empty page with the copy from `emptyStateFor` (step 6). Page-level
   Back/Forward links are removed where the shell now provides the navigation; keep the pages' internal
   callbacks working by passing `navigate`-based handlers.
6. **`lib/derive.ts`** — `emptyStateFor(route, health)` returning `{title, body}` for agents/runs/no-key states
   (support-flavoured copy: "Connect your support agent", "No runs yet — start one against the demo agent").
7. **Delete** `web/src/demos/` and the `?demo=` harness in `App.tsx`; update `ErrorBoundary.tsx:36` to `/`;
   add a one-line "historical" note at the top of `docs/HANDOFF.md`. Do **not** delete `Heal.tsx`, `Intro.tsx`,
   `BackLink.tsx` yet — Block 4 does that once their content has moved.
8. **`docs/FRONTEND.md`** — add a "Routes" section (table: path → component → data it polls) and mark the
   `?page=` description as replaced. Full rewrite happens in Block 4; keep section numbering so Python docstring
   references (`api/main.py:13`, `api/store.py:5`, `api/manifest.py:1`) stay valid.

## Verify first (hour one)

- `TestClient(app).get("/app/runs")` returns `index.html`; `/api/health` still JSON; `/assets/...` still served.
  If routing order surprises you, mount static under `/assets` and serve `index.html` from an explicit route.
- Build the app (`npm --prefix web run build`) and load `http://localhost:8000/app/runs` through the API
  (`uv run uvicorn api.main:app`) — a hard refresh must not 404.

## Boundaries

- **Owns:** everything in `web/`, `docs/FRONTEND.md`, `docs/HANDOFF.md` (note only), the SPA catch-all in
  `api/main.py` and its test. **Do not touch** anything else in `api/`, `chaos/`, `examples/`, `README.md`.
- No new dependency. No new colours. Reuse before creating (see the rule file's reuse map).
- **Git:** commit on `feature/app-shell` in small single-topic commits with plain-language messages
  (what changed and why). **Never push, never touch other branches.**

## Done when

- `/` shows the landing; the button lands on `/app/runs` inside the shell; `/app/agents`, `/app/runs/live`,
  `/app/runs/live/cycles/3` all render (the last two with today's content) and survive a hard refresh through
  the API server; browser Back/Forward work; old `?page=heal` redirects.
- `npm --prefix web run build` and `lint` clean; `env -u WANDB_API_KEY uv run pytest -q` green.
- Replay still plays on `/app/runs/live` with transport controls, and the status pill says "replaying".
- Report back: commits, the routes table, anything not tested, and any decision the plan left open (append
  `## Decisions` under Block 2 in `docs/plans/00-overview.md`).
