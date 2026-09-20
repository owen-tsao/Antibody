# Antibody — the one plan for Fully Connected

_Last folded: Sep 18, 2026. Files `01`–`06` in this folder are the original plans; they are now
**decision records** for what shipped and are not the source of truth for what is left. This file is._

## Where we are

Everything built so far is on one branch, `feature/fully-connected`, in the main checkout (`76df0c4`).
231 tests pass with no API key; `npm --prefix web run build` is clean. `main` is untouched.

Shipped:

- **Blocks 1 and 2** (Sep 18, reviewed and merged): agents as objects (store, ping with tool mapping, per-run
  target, API-spawned example agent) and the app shell (landing at `/`, hand-rolled routes under `/app`,
  persistent rail, SPA fallback, `api.ts` refresh). Decisions are recorded under each block below.
- **Attack an agent you didn't write.** One choke point for tool calls (`chaos/toolbus.py`), a `Target`
  interface (`chaos/target.py`), an HTTP tool server that lives in the loop process (`chaos/toolserver.py`),
  `ANTIBODY_TARGET=http:<url>`, an example agent on the OpenAI Agents SDK (`examples/agents/openai_agents_support/`),
  a README section. Repair only proposes patch kinds the target supports.
- **Run it from a clone.** One server serves the built dashboard and the API; `GET /api/health`; keyless
  replay-only mode with clear 503s; past runs live in `history/` (auto-migrated from `runs/archive`);
  `reset` cannot hurt the repo or past runs; `Makefile`.
- **Run settings and history (backend).** `POST /api/loop/start` takes the loop's real flags
  (`chaos_cycles`, `seeds`, `repair_attempts`, `second_pass`, `resume`, `until_quiet`, `world`);
  `--until-quiet` stopping rule; `GET /api/runs` (with a synthetic `golden` entry); `?source=run:<id>`
  on the state/cycles/config routes (not `/api/status` or `/api/manifest`); replay any run;
  `POST /api/rollback` with regression-suite merge.
- **UI chats 1 and 2.** Settings drawer on Heal; API-down / no-key / loop-died states; stop-run button;
  target line on Cycles.

Not shipped: everything under "The work" below.

## The product decision behind the rest of the UI work

Today the UI is one linear story (Intro → Heal → Cycles → Results → Cycle) — the shape of a demo video,
not a tool. Two things are missing that make it feel like a slideshow: there is **no persistent shell**
(every page is a full-screen slide with a back arrow) and **the core objects are not on screen** — an
*agent* is an environment variable and a *run* is "whatever is in `runs/`". The fix, agreed Sep 18:

- **Split the site from the app.** `/` stays the landing page (gradient hero, one button). The tool lives
  under `/app` with a thin persistent shell: **Agents · Runs**, plus a live-run indicator.
- **Agent becomes a real object** you can list, connect, ping, and pick when starting a run. This is what
  makes onboarding possible and is the strongest "production ready" signal for the track: *it works on my
  agent, not just the demo agent.*
- **Run becomes the centre.** `/app/runs` lists them; `/app/runs/:id` is the run — today's Cycles view while
  it is live, today's Results + Cycle views when it is done. Replay is "watch it back" inside a finished run.
- **Hand-rolled routes**, no router dependency (~40 lines: `parse(path) → Page`, `navigate`, `popstate`).
- Everything else (orbs, metal frames, serif titles) stays as **accents inside the shell**, not as page structure.

**Scope, decided Sep 18: Antibody is for customer-support agents.** The tools, seed attacks, judge rules,
legit suite, and story are already support-shaped; the pitch catches up. The external-agent contract is
framed as a **sandbox storefront** — fake customers, orders, refunds, tickets — that your support agent is
deployed into and attacked in. Honesty line for the README: the *tools* are sandboxed (every call goes to
Antibody's mock storefront); the *agent process* is the customer's, and if it has its own integrations wired
in beside ours, Antibody cannot see or stop those. Deferred past submission: attacking a customer's staging
deployment with real integrations, and generating the storefront from their tool schemas (blocked on a judge
that reasons over schema properties instead of our tool names; two-hour coherence spike first).

Why folded together rather than piecemeal: the shell and routes touch `App.tsx` and every page. Building
UI chat 3's runs list into today's Heal page and then moving it a week later is the same work twice.

## The work

Estimates are honest ranges for one agent-lane with review. Order within a block is the order to build.

### Block 1 — Agents as objects (backend, ~8 h) — first, because the UI blocks on it

The loop reads `ANTIBODY_TARGET` at start; the API reports it read-only. Make the agent a stored,
selectable thing without breaking the env var (CLI users and `check` keep it).

1. **Store.** `history/agents.json`: `[{id, name, transport: "builtin" | "http", url, created_at, last_ping}]`.
   Owned by a new `api/agents.py` (read + write; `api/store.py` stays read-only by design). Writes use the
   mkstemp + `os.replace` pattern from `chaos/state.py:save_regression`. The built-in agent is a synthetic
   first entry (`id: "builtin"`, never deletable), like `golden` in `GET /api/runs`. Ids: `secrets.token_urlsafe(8)`.
2. **Routes** in `api/main.py`, behaviour in `api/agents.py`: `GET /api/agents`, `POST /api/agents`
   (`{name, url}` → `http(s)://`, ≤ 2 KB; canonical target string `http:<url>`), `DELETE /api/agents/{id}`
   (404 for `builtin`; 409 whenever a loop is running — conservative, because `runs/run.json` names the
   live run's target only seconds after spawn), `POST /api/agents/{id}/ping`.
3. **Ping must not go through `HttpTarget.run_episode`.** That path calls `toolserver.tools_url()` first,
   which binds `127.0.0.1:8765` in the *calling* process (`chaos/target.py:77`, `toolserver.py:123-148`) —
   inside uvicorn that port is then taken and every later loop child dies on its first external episode
   (the exact reason `/api/attack` refuses external targets). Ping is a bare `POST <url>/episode` with a hello
   message, a fresh session id, and a `tools_url` that points at the loop's usual address (nothing is
   listening; an agent that calls a tool gets a connection error and still replies). 10 s timeout. Returns
   `{ok, latency_ms, reply_preview | error}`; records nothing. Shares the opener (`ProxyHandler({})`,
   no-redirect) with `chaos/target.py` — expose `_post_json` as `post_json`, one HTTP client.
4. **Target from the request.** `LoopStartBody.target: str | None` (an agent id). `loop_ctl.start` resolves it
   and sets `ANTIBODY_TARGET` in the **child's environment, always explicitly** — including `builtin` — because
   `load_env()` uses `setdefault` (`chaos/config.py:29`) and an `.env` with `ANTIBODY_TARGET=http:…` would
   otherwise win. `None` = the API process's own default. 400 for an unknown id. No change to `chaos/`.
5. **Default agent = whatever the API's env resolves to.** `/api/attack` and `rollback.current_target()` keep
   using it. Document in `.env.example` that setting `ANTIBODY_TARGET` there makes the external agent the
   default for the API too (seed-attack preview 501s; rollback refuses built-in runs).
6. **Joining runs to agents.** `run.json.target` is stored **verbatim** (`chaos/loop.py:387`), and the README's
   own command uses the bare `http://…` form while the canonical name is `http:http://…`. Normalise both sides
   with `resolve_target(x).name` — in `api/agents.py` for the runs list and in `api/rollback.py:74-75`, which
   compares raw strings today. `GET /api/runs` rows gain `agent: {id, name} | null` from that join. No
   per-source manifest (`manifest.build()` is `lru_cache`d; the run page reads the agent from the run row).
7. **Migrate `runs/archive` at API startup** too (today only `archive_previous_run`/`reset` do it,
   `chaos/state.py:296-305`), so a checkout with old archives shows its history before the next run.
8. **Tests**: store round-trip; ping ok / connection refused / timeout / non-JSON against the `FakeAgent`
   from `tests/test_toolserver.py:212-225` (move it to `tests/conftest.py`); start with `target` sets the
   child env explicitly; 409 delete-while-running; 400 unknown id; runs-list join with bare and canonical forms.
9. **Tool discovery in the ping.** After the hello, `GET <url>/tools` (optional on the agent's side; the example
   agent gains it, returning `[{name, description}]`). Ping returns `tools: [...] | null` and
   `mapping: {known: [...], unknown: [...]}` against the storefront's tool names (`chaos/tools.TOOL_FUNCS`), so
   the connect screen can say "5 of 7 tools map to the sandbox; `send_sms` will be unavailable during attacks".
   Stored on the agent row as `tools` for the list page.
10. **"Start the example agent for me."** A synthetic agent row `id: "example"` (`url: http://127.0.0.1:8790`,
    `running: bool`). `POST /api/agents/example/start` spawns `uv run python agent.py` in
    `examples/agents/openai_agents_support/` the way `loop_ctl` spawns the loop (own pid file, log tail,
    `POST …/stop`); 503 without a key (the agent calls inference); 409 if 8790 is already bound. First start
    runs `uv sync` implicitly and can take a minute — the response is 202 and the row's `running` flips when
    the port answers. This makes the whole onboarding path terminal-free.

### Block 1 estimate: ~9 h.

### Block 1 — Decisions (backend lane, Sep 18)

- **Kill condition 1 passed.** A bare `POST /episode` hello to the running example agent, with nothing on
  8765, replied `200 {"reply": "Hi Owen! 👋 I'm here to help you with anything related to your Northwind
  Gadgets experience. You can ask me to: - Check the status or details of an order …"}` in 2.1 s. A message
  that tempts a tool call ("Where is my order A-1001?") also replied in 1.1 s ("I'm looking up the status of
  order A-1001 right now…") — the SDK swallows the connection error as tool output. Ping is built on this.
- **`tools_url` in the ping is the server root** (`http://127.0.0.1:8765`), not `…/tools`: the agent appends
  `/tools/<name>` itself (`agent.py:_call_tool`), and the loop passes the root too.
- **Ping reply shape**: `{ok, latency_ms, reply_preview | error, tools, mapping}`. `reply_preview` is the
  reply whitespace-collapsed and cut at 160 chars. `error` strings: `timed out after 10s`, `connection
  failed: …`, `agent answered HTTP <code>`, `agent did not answer with JSON`, `agent returned no reply: …`,
  `agent answered with a redirect; …`. The route is always 200 for a known agent; `ok: false` is a result.
  `tools` is `null` when `GET /tools` fails in any way (2 s); `mapping` is `null` then too.
- **Stored `last_ping` is an object** `{at, ok, latency_ms}`, not a timestamp, so the list page can show a red
  or green dot without another request. Synthetic rows never store pings.
- **Two synthetic rows**, `builtin` and `example`, carry `synthetic: true`; the example row adds `running`,
  `starting`, `pid` from a live probe of 8790 (`GET /tools`, 1 s). `starting` = we spawned it and the port does
  not answer yet (first `uv sync`). Connecting `http://127.0.0.1:8790` by hand is allowed (the brief's
  acceptance check expects 201); dedupe is among stored rows only, and the runs join prefers a row the user
  named over the synthetic `example` row for the same URL.
- **Normalisation is textual** via `resolve_target(x).name`: `http://127.0.0.1:8790`, `http:127.0.0.1:8790`
  and `http:http://127.0.0.1:8790/` join to one agent; `localhost` and `127.0.0.1` do not. Runs whose target
  matches no agent get `agent: null` (deleted agents leave their runs orphaned, by design).
- **`POST /api/loop/start` with `target`**: the route checks the id first (400 `unknown agent '<id>'`, before the
  key check), `loop_ctl.start` resolves it again under the lock and writes `ANTIBODY_TARGET=<canonical>` into the
  child env unconditionally. The sidecar `loop_settings.json` gains a top-level `target` (canonical) beside
  `body.target` (the id); the start response gains `target` too. `settings.target` in `GET /api/loop` is the id.
- **Example agent start/stop**: `start` 202 `{pid, started_at, url, running: false, starting: true}`; 409 body is
  `{message, running, url, pid, starting}`; `stop` 200 `{running, url, pid, starting, stopped, owned}` — an agent
  on 8790 we did not spawn is left alone with `owned: false`; 404 when nothing runs. `GET /api/agents/example/log`
  tails `runs/example_agent.log`. Pid file `runs/example_agent.pid` lets a restarted API still stop its child.
- **Startup migration** runs in the FastAPI lifespan (not at import, which the module docstring promises has no
  side effects); an `OSError` there is logged, never fatal. `chaos.state.migrate_legacy_archive` is the public
  alias of the existing private function.
- **Delete is 409 while any loop runs**, ours or external — the conservative rule from the plan.
- **`rollback.current_target()` now returns the canonical name** and the comparison uses `same_target()`; the
  409 message shows canonical strings (e.g. `'http:http://…'`), not the raw env value.

### Block 2 — App shell, routes, landing/app split (frontend, ~10 h)

Owns `App.tsx`, `main.tsx`, `index.css`, `api.ts`, a new `web/src/lib/routes.ts`, a new `components/Shell.tsx`.
**Rename the branch first** (`feature/ui-error-states` → `feature/fully-connected`) before either lane forks.

1. **Routes** (`lib/routes.ts`): `/` landing · `/app` → `/app/runs` · `/app/agents` · `/app/agents/new` ·
   `/app/runs` · `/app/runs/:id` · `/app/runs/:id/cycles/:n`. `parse(path)`, `href(page)`, `navigate()` with
   `pushState`, one `popstate` listener. Old `?page=`/`?n=` links redirect once (`docs/HANDOFF.md` and the
   `ui-1` handoff embed them; the README does not). `ErrorBoundary.tsx:36` hard-codes `?page=intro` — update.
2. **SPA fallback is new backend work, not a verify.** `StaticFiles(html=True)` serves `index.html` only for
   directory URLs and 404s `/app/runs`. Add a catch-all route in `api/main.py` that returns `web/dist/index.html`
   for any non-`/api` path, registered **before** the `/` mount (a route after the mount never fires). Ten
   minutes; the frontend lane may edit this one spot in `api/main.py`.
3. **`api.ts` refresh** (~2 h, was never budgeted): drop retired `mode`/`quiet_streak`/`max_cycles` from
   `LoopStartBody`/`LoopState`/`LoopStarted` (`App.tsx:130-133` still sends `mode: "fixed"`); add `defaults`
   to `Manifest`; add `RunRow`, `runs()`, `run(id)`, `rollback()`, `agents()`, `agentCreate/Delete/Ping()`,
   `recording` on `replayStart`, and `source` on `state/cycles/config/configs`. Shapes are in
   `handoffs/ui-3-run-history.md` and Block 1.
4. **Shell** (`components/Shell.tsx`): left rail on ≥ md, top bar below; two items (Agents, Runs), the wordmark
   linking to `/`, and a status pill from `usePoll(api.loop)` + `api.replay` ("running · cycle 3" / "replaying")
   that links to the run. `ApiDown` renders inside the shell, once. No slide transitions inside the app;
   page content fades 120 ms.
5. **Landing** = today's `Intro` with the button going to `/app`. `Heal` is deleted as a page: its jobs move —
   starting a live run and the settings drawer to the run-start dialog (Block 4), the replay link to the run
   detail (Block 4). Today the missing-key message appears only after clicking Heal (as the 503's text); the
   shell shows it up front (Block 3).
6. **`?demo=` harness and `web/src/demos/`**: delete. The pasted components are verified in place now.
7. **Typography and surfaces in the shell**: page titles keep the serif `display` class at a smaller size
   (48 px), everything else Inter; `MetalFrame` for the primary card on each page only (emphasis budget).
8. **Empty states** are a first-class part of every list: a small pure helper in `lib/derive.ts`
   (`emptyStateFor(page, health)`), used by Blocks 3 and 4.

#### Decisions (Block 2, frontend lane, Sep 18)

- **SPA fallback is scoped to `/app`, not every non-`/api` path.** `/app` and `/app/*` return `index.html`
  from explicit routes registered before the mount; `/nope` and `/assets/missing.js` still 404. A missing asset
  coming back as HTML is a MIME error in the console, not a clearer failure. Verified with `TestClient`
  (`tests/test_static.py`, skipped when `web/dist` is not built) and a hard refresh through uvicorn.
- **The shell owns the polls and hands `loop`/`replay`/`status` down.** `Shell` polls `/api/loop` and
  `/api/replay` (2 s) and `/api/status` (1 s while `loop.running || replay.active`, else 2 s — the orbs'
  spec cadence) and renders its children as a function of that data. The run page reads them as props and
  polls nothing but `/api/cycles` and `/api/state`. One poll per route, one place (review fix, Sep 18).
- **Leaving the run page pauses a replay** via one mechanism: an `App`-level effect that runs whenever the
  route is not `/app/runs/live`, asks `/api/replay`, and pauses only when the fresh answer is
  `active && !paused`. The earlier unmount-cleanup in `Agents.tsx` (stale ref, spurious 404 after `stop`)
  was removed in the review pass. Block 4's rule says *stop*; pause was kept because today's runs page still
  offers "Resume replay". Flip it to `replayStop` when Block 4 removes that link.
- **History run ids render a titled placeholder**, not today's pages. The read routes serve any run, but
  today's `Results`/`Cycle` read only the live files; showing them at `/app/runs/<id>` would label the wrong
  run. Block 4 threads `source` through (it already exists on `api.state/cycles/config/configs`).
- **Legacy `?page=` redirect happens in `main.tsx` before the first render** (`redirectLegacy()`), one
  `replaceState`, so Back never returns to the query-string form. Mapping: `intro→/`, `heal→/app/runs`,
  `agents|results→/app/runs/live`, `cycle&n→/app/runs/live/cycles/n`.
- **`ApiDown` in the shell does not yet remove the pages' inline ones.** When the API is down the shell's
  status slot and the page's status line both say so until Blocks 3–4 rewrite those pages. Accepted rather
  than editing pages that are about to be replaced.
- **Owed fixes pulled forward because the type change forced them:** `Manifest.target.model/model_short`
  nullable + `url?`; no dangling "·" in the settings drawer when `model_short` is null; the target line
  compares `transport` to `"in-process"` (backend value) as well as the old `"builtin"` spelling.
- **`World` and the start body now have one definition** (`api.ts`); `lib/settings.ts` re-exports `World`
  and `toStartBody` returns `LoopStartBody` instead of a forked `RunStartBody`.
- **Commit hygiene note:** the `web/src/demos/` deletion was staged by `git rm` and landed in the shell
  commit (`9b9858b`) rather than the cleanup commit that names it (`93bc7e4`). Not rewritten.

### Block 3 — Sidebar, agents page, onboarding wizard (frontend, ~12 h)

Owen's Sep 18 review of the Block 2 build: the sidebar edge was invisible, the old Heal hero read as
marketing inside a tool, the status pill floated, and the connect page needed a real flow. Decisions:
sidebar sections as below, collapsible; the pill is gone; onboarding is a full-screen wizard using the
`wizard-steps` rail from Owen's component library (`~/.cursor/skills/component-library/`, prompt
`prompts/wizard-steps-rail-integration.md`, shipped reference `screenshots/wizard-rail-shipped.png`).
Copy speaks support: "Connect your support agent", "sandbox storefront", never "target".

1. **Sidebar, Linear-style.** Sections of nouns, muted text, one active row:
   `Antibody` (wordmark → `/`) · **Home** · **Current run ●** (only while a run or replay is on screen;
   replaces the pill; dot pulses while live) · *Workspace* · **Agents** · **Runs** · **Replays** · **Settings**.
   Visible edge: `--border-2` plus a slightly different surface for the rail than the content pane.
   **Collapsible**: 240 px → 48 px icon rail with tooltips, `[` toggles, state in localStorage. Below md:
   top bar with a menu button. Remove the pill's JSX and `shellPill()` in `derive.ts` — **keep the shell's three
   polls** (`Shell.tsx:43-51`); the run page depends on the `ShellData` render prop and the "Current run" item
   needs the same data. Move the `/api/health` poll from `App.tsx:64` into `Shell` and add `health` to `ShellData`.
2. **Routes added**: `/app/home` (`parse` maps `/app` → home), `/app/replays`, `/app/settings`,
   `/app/onboarding/:step`; `agent-new` redirects to `/app/onboarding/2`. Replays/Settings pages are Block 4;
   this block adds routes and titled placeholders so the rail is complete. Poll `GET /api/agents` at ≥ 3 s
   (each call probes port 8790 with a 1 s timeout while the example agent is down).
3. `/app/agents`: list from `GET /api/agents`. Row: name · transport · url · last ping (`ok · 1.2 s · 2 min ago`)
   · tools mapped (`5/5`, computed client-side from the row's `tools` against `GET /api/manifest.tools`; synthetic
   rows show "—" until pinged) · runs count (from `GET /api/runs` joined on `agent.id`). Built-in labelled
   "demo agent"; `example` shows running/starting/stopped with start/stop as quiet actions. Delete with inline
   confirm (409 while a loop runs → the message). Primary action top-right: **Connect agent** → the wizard.
4. **Onboarding wizard** at `/app/onboarding/:step`, full-screen (no sidebar, like Clad's), "Skip for now"
   top-right → `/app/home`. Rail on top (tiles → check, spring on the active tile, connectors fill),
   per-step title + one-line sub in the content, Back / Continue at the bottom. Steps:
   1. **Choose** — three cards: Demo agent (built in) · Example external agent (we start it for you:
      `POST /api/agents/example/start`, shows starting → running) · Your own.
   2. **Connect** (your own only) — name + URL → Ping → inline result (`ok · 1.2 s · "Hi, I'm…"` or the exact
      error) → Save (`POST /api/agents`). The contract in 20 lines below, collapsed by default, with copy button
      and a link to the example agent's README.
   3. **Tools** — the mapping from the ping (`5 of 7 tools map to the sandbox storefront; send_sms, apply_coupon
      unavailable during attacks`, or "this agent does not list its tools").
   4. **First run** — the run settings fields (agent preselected; `chaos_cycles`, `seeds`, `repair_attempts`,
      `second_pass`, `until_quiet`) → **Heal** → `POST /api/loop/start` → `/app/runs/live`. This requires
      **extracting the field rows out of `SettingsDrawer.tsx:145-200` into a shared `RunSettingsFields`**
      (two call sites: this step and Block 4's dialog), adding `untilQuiet` and `target` to `RunSettings` /
      `toStartBody` in `lib/settings.ts`, and dropping `world` from the fields (CLI flag stays).
   Adaptation notes from the library entry: extract the rail, not the whole component; monochrome tokens;
   `framer-motion` (installed) instead of `motion/react`; lucide icons; `useReducedMotion`.
5. **First-run rule**: no agents beyond the synthetic rows, no history rows other than `golden`, no live run →
   `/app/home` redirects (`replaceState`) to `/app/onboarding/1`. This is a **page effect on Home after its
   three loads resolve**, with a quiet loading state so Home never flashes first — not a rule in the pure `parse()`.
6. **No key**: one line in the shell's rail footer ("Set `WANDB_API_KEY` to run live; replays still play") from
   `ShellData.health`, and every start/heal control disabled with that reason in its tooltip.
7. Owed fix folded here: hide the seed-attack preview when the run's agent `transport !== "in-process"`.
   `api.ts` gains the types **and fetchers**: `Agent`, `AgentTool`, `AgentPing`, `PingResult`, `agents()`,
   `agentCreate()`, `agentDelete()`, `agentPing()`, `exampleStart()`, `exampleStop()`, `exampleLog()`,
   `LoopStartBody.target`, `LoopStarted.target`, `RunRow.agent` (shapes in Block 1's report/Decisions).

### Block 3 estimate: ~15 h.

#### Decisions (Block 3, frontend lane, Sep 18)

- **Ping stores the row first** *(superseded by Block 5's `POST /api/agents/ping {url}` and 4A's wizard change:
  Ping on the Connect step now checks the typed URL without storing anything, and only Save calls `POST
  /api/agents` — a 409 from Save means the URL was already connected, and that row is used. The `created` ref and
  its delete-on-failure cleanup are gone.)* Original decision: there was no ping-by-URL route, so Ping was
  `POST /api/agents` then `POST /api/agents/{id}/ping`; if the create answered 409 the existing row was pinged
  instead. The wizard remembered the one row it created and kept it honest: a failed ping deleted it (the cleanup
  ran before any "still mounted" check, so navigating away mid-ping could not orphan it), and a re-ping under a
  different name or URL deleted it and stored a fresh one. Save then only moved on to Tools. (Review fix, Sep 18.)
- **Wizard state lives in React state for the session.** The `Onboarding` component stays mounted across steps
  (the route only changes `step`); a refresh restarts at step 1, and a step that needs an agent the session has
  not chosen (typed address, refresh on 3 or 4) renders nothing and is sent back to step 1 with `replace`, the
  rail's "furthest reached" reset with it. Accepted for now: the only thing lost is the current form, and every
  stored side effect (agent rows, the example agent's process) survives.
- **The chosen agent becomes `settings.target`.** Heal on the First run step writes the choice into the shared
  run settings before starting, so the next Heal from `/app/runs` (and the drawer) attacks the same agent
  rather than the API's default.
- **"Skip for now" is remembered for the tab's session** (`sessionStorage`), otherwise Home's first-run rule
  would send the person straight back to the wizard. A fresh tab with still nothing connected gets the wizard
  again, which is the right default for a first-time visit and harmless for a returning one (one click).
- **Demo skips Connect and Tools; Example skips Connect.** The rail shows a skipped tile as passed but not done
  (its number, not a check) and leaves it unclickable, so the rail never claims a step happened. Demo goes to
  First run because a mapping that is by definition complete has nothing to decide.
- **Tools mapped is computed against the built-in row's tool list, not `manifest.tools`.** `GET /api/manifest`
  lists the three tools the hardening loop edits; the built-in row's `tools` lists all five storefront tools,
  which is what "what the sandbox serves" means. Against `manifest.tools` the built-in agent showed 3/3.
- **Starting the example agent waits when it is already `starting`.** A start from the Agents page seconds
  earlier holds port 8790 with its own boot; asking again would 409, so the wizard only calls start when the
  row is neither running nor starting, then polls `running` every 3 s. A genuine 409 (something else on 8790)
  shows the API's message as-is.
- **`RunSettingsFields` takes `seedCount: number | null`** from `seedCount(manifest)` in `derive.ts`; both the
  drawer and the wizard load the manifest, so the seeds stepper and the estimate are bounded by the real seed
  count in both. `world` left the fields (API default; the CLI flag stays), and a `"mock"` persisted by an older
  build is reset to `"auto"` on load rather than steering runs from nowhere.
- **The seed-attack preview needs the run on screen to be against the built-in agent** as well as the API's
  default target: `seedAttackAvailable(manifest, loop)` requires `manifest.target.transport === "in-process"`
  and `loop.settings.target` null or `"builtin"`. It reads as unavailable while the manifest loads so the
  buttons never flash. (`/api/attack` itself has the same gap; reported to the backend lane, not fixed here.)
- **The old live-run page is `pages/RunLive.tsx`**; `pages/Agents.tsx` is now the agents list. Rename, not a
  new page, so the route table keeps one component per address.
- **Replays and Settings are titled placeholders in `App.tsx`** (one `Placeholder` function, also used for the
  history-run notice) so the rail is complete without a component file per page that Block 4 replaces.
- **Every start control is disabled without a key, with the reason in its tooltip** — Heal, the wizard's
  Example card and the Agents page's start action (the example agent calls inference; its start answers 503).
  One string, `NO_KEY_LINE` in `lib/ui.ts`, also the rail footer's line. Deciding once ended the earlier
  split where the Example card stayed clickable to show the 503.
- **Home says when the API is down** instead of waiting quietly: a poll that has never answered and has
  failed renders `ApiDown` in the page. A hiccup after first contact keeps the last value, as everywhere.
- **Modal surfaces share `hooks/useModal`** (focus in, Tab wrap, Esc, body scroll lock, focus return): the
  settings drawer's trap, extracted so the shell's menu below `md` gets the same behaviour.
- **Backend gap hit:** none blocking. One thing Block 4 or 5 may want: a ping-by-URL route, so Connect does not
  have to store an agent before it knows the agent answers.

### Block 4 — Home, runs, replays, settings, run detail (frontend, ~24 h; absorbs UI chat 3)

**Home is data with one primary action, never a hero** (option A, chosen Sep 18). The line
"Let it break. Watch it heal." moves to the landing page as its subhead. Replays and Settings pages are the
explicit buffer: if time runs short, Replays folds into Runs ("watch" per row) and Settings into the dialog.

**Identity rule, decided up front.** `GET /api/runs` names the un-archived run literally `"live"`
(`api/store.py:279-282`); it is archived and given a real id when the *next* run starts. So:
`/app/runs/live` always means "the current run" (running, or finished but not yet archived); history runs
are `/app/runs/<id>`. `POST /api/loop/start` returns no id and `GET /api/runs/live` 404s until `run.json`
lands and the row appears only after cycle 1 (`api/main.py:299,315`) — the page treats 404-while-`loop.running`
as "starting…", never as an error. A bookmark to `/app/runs/live` changes meaning when a new run starts;
that is what the word says.

**Replay rule, decided up front.** During a replay only `live` reads are overridden by the tape
(`api/main.py:137-147`); `?source=run:<id>` is always served as asked, and `/api/status` has no `source` at
all. So when "watch it back" is pressed on a history run, the page **switches its reads to `live` + `/api/status`**
for the duration and back when the replay stops. Leaving the page **stops the replay** (`POST /api/replay/stop`),
replacing Block 2's single pause-on-leave effect (`App.tsx:71-77`); nothing plays off-screen, so the rail's
"Current run" item only ever reports what is on screen.

1. **`/app/home`.** Header "Home" + primary action **Heal** top-right: the orb becomes a real button with the
   metal rim (brand kept, hero gone); opens the start dialog (item 2). Body: one card per agent — name, the
   `final_version` of that agent's last run (configs are one global tree, so there is no per-agent "current
   version"), "blocks N of M known attacks" from `GET /api/state?source=…`'s `vulnerability` **when present**
   (today only the golden tape has it — Block 5.0 makes API-started runs write it; until then "not measured"),
   last run date, and a small sparkline via `cycleChartSvg` from `GET /api/cycles?source=run:<id>` for that
   agent's last run (one request per agent; fine for ≤ 5). Below, two columns: **Needs attention** — from the
   latest run's cycles, only when `state.source === "live"` (an idle API falls back to golden, which must not
   show as findings): landed-and-unpatched = `attack_succeeded && (!gate || !gate.accepted)`, rejected =
   `gate && !gate.accepted` (`chaos/schemas.py:199-203`), each row opens the cycle — and **Recent runs** (five
   rows → `/app/runs`). Empty state (agents exist, no runs): centred, one line, "Start your first heal" → the dialog.
2. **Start dialog** (from Heal on Home, "Start a run" on Runs, and the wizard's step 4 shares its fields):
   today's `SettingsDrawer` fields as a dialog plus the **agent picker** (`target`, from `GET /api/agents`) and
   the owed **Until quiet** (`until_quiet`, off by default, ≤ `chaos_cycles`; the estimate line says "at most").
   The `world` toggle leaves the dialog (Zendesk trial suspended; the CLI flag stays; the API default `auto`
   resolves to mock without Zendesk credentials). Submit → `POST /api/loop/start` → `/app/runs/live`. 409 →
   `/app/runs/live` too; other errors inline.
3. **`/app/runs`**: rows from `GET /api/runs`, newest first; live run first labelled "running"; `golden` labelled
   "demo tape"; each row names its agent. Primary action **Start a run**.
4. **`/app/replays`**: the demo tape plus every history run whose row says `recording: true` (Block 5.0 adds
   `recording` and `duration_s` to `GET /api/runs` rows — until then derive from `finished_at !== null`, which
   is a leaky proxy), each with **watch** → the run page with the route's `replay` flag set (a field on the
   `run` route kind — `routes.ts` parses the pathname only, so no query string). Recorded date, duration,
   cycles, agent per row.
5. **`/app/settings`** (after Block 5.1 for the model names): run defaults (the shared `RunSettingsFields` as
   defaults, stored in localStorage as today), the four model names read-only from the manifest, key status
   from `ShellData.health`, and the path to `history/`.
6. `/app/runs/:id` — one page, two states:
   - **Live**: today's `Agents.tsx` content (stats plate, four orbs, cycles box, stop button) plus a "Results so
     far" section that is today's `Results.tsx` list. Seed-attack preview only when the run's agent is built-in.
   - **Finished**: header line (started · agent · world · flags · `v0→vN`), actions as `u-line` text: **watch it
     back** (replay of `run:<id>` at 3×, transport controls in place, per the replay rule), **roll back to v<n>**
     on each version except the current (inline confirm on second click, `POST /api/rollback`, show `patch_note`
     and "N tests are newer" from `newer_tests`; hidden while a loop runs), then the Results list.
   - `/app/runs/:id/cycles/:n`: today's `Cycle.tsx` two-column view with `source` threaded through
     `ConfigDiff.tsx:35`; Back returns to the run.
7. **Delete** `pages/Heal.tsx`, `pages/Intro.tsx` (folded into landing, which gains the "Let it break" subhead),
   `BackLink`/`ForwardLink` (the shell replaces them), `REPLAY_BUSY_NOTE` plumbing, the temporary route→old-page
   mapping from Block 2. Keep `ReplayControls`, `CyclesBox`, `CycleTimeline`, `ConfigDiff`, `interactive-list-preview`.
8. Owed fix folded here: the target line compares `transport` to `"in-process"` (backend value), not `"builtin"`.
9. `docs/FRONTEND.md` rewritten for the shell (routes table, page → data map, what polls what). Python
   docstrings cite its section numbers (`api/main.py:13`, `store.py:5`, `manifest.py:1`, `toolserver.py`) — keep
   the numbering or update those four references in the same change. `docs/HANDOFF.md` and `handoffs/ui-*.md`
   get one line at the top saying they are historical.
10. **Follow-up for Block 5 (frontend lane, ~1 h, after 5.2 merges):** `GateResult.fix_samples/fix_passes` in
    `api.ts`, gate copy "fixed 2/2" / "fixed 1/2 — not accepted" in `derive.ts`, the four model names on the
    Settings page. The backend lane does not touch `web/`.

#### Decisions (Block 4, frontend lane 4B — the run page, Sep 18 evening; `feature/run-detail`)

- **4B — Mode is derived, not stored.** `runMode(id, row, loop, replay)` in `derive.ts` → `starting | live |
  finished | watching`. `watching` wins whenever the active replay's `recording.source` is this run's tape
  (`golden` → `"golden"`, else `run:<id>`; on `/app/runs/live` *any* tape counts, since `live` reads are what
  the tape overrides). `live` needs `id === "live"` and `loop.running`; `starting` is that with the run row still
  404. Everything else is `finished` — including the un-archived run once its loop exits (the brief's "un-archived
  finished run under live" was read as the finished face; there is nothing live to animate).
- **4B — The API's replay state is the one source of truth for "watching"**, not the route. "watch it back"
  calls the API directly and the mode flips on the shell's next poll; `/app/runs/:id/replay` is an *arrival
  intent* (start the tape on mount), and stopping from that address `replace`s it with `/app/runs/:id` so a
  refresh does not restart the tape. Back can still return to `/replay` and start it again — that is what the
  address says.
- **4B — One answer per source, kept.** Every cycles/state answer is tagged with the `ReadSource` it came from and
  the page keeps the last answer per source (state written during render behind a guard, the pattern
  `CyclesBox` already uses). Stopping a replay shows the run's own rows in the same frame; no "loading…", no
  frame of tape data labelled as the run. `usePoll` stays the only poll hook; the fetcher just returns
  `{source, data}`.
- **4B — Stop-on-leave is keyed on the run on screen, not on "am I on /app/runs/live".** `App`'s effect runs
  when the id under `/app/runs/:id[/cycles/:n]` changes (null elsewhere), asks `/api/replay` fresh, and stops a
  tape that is not that run's (`replayIsFor`). Moving from a run to one of its cycles keeps the tape playing;
  moving to another run's page or anywhere else stops it. A `/replay` arrival is exempt from the effect — the
  page itself stops a foreign tape before starting its own, so the two cannot race and kill the new tape.
- **4B — Rollback offers every version the run saved except the one live already is** (the plan's "except the
  current": current = the version live is now). The API has no "live equals run X v3" fact to read, so the
  exclusion is known once a rollback in this session copies a version in; before that every saved version is
  offered, including the run's final one, since the live tree may have moved on. `live` offers none (400 by
  design; `--from-version` is the CLI's path) and nothing is offered while `loop.running`. `golden` is accepted
  by `api/rollback.py` and was exercised: on an empty `runs/` the copy lands as `v0` with the note
  `rollback to run golden v3` and `0 tests are newer` (documented behaviour of the module, not a bug).
- **4B — The finished action row has one primary.** `watch it back` in `--fg`; rolling back is one quiet label
  with a link per version — `roll back to v0 · v1 · v2 · v3` — so the row does not grow a sentence per
  version. A click swaps the group for `confirm roll back to v<n> · cancel`; Escape cancels.
- **4B — A `/replay` arrival is the same start as the button** (`watch()`), guarded by a ref so StrictMode's
  double effect is one `replayStart`. A 409 shows the same note; an *ended* tape of this run is resumed, which
  `api/replay.py` restarts from 0, rather than joined on its frozen last frame. The `live` frame held from a
  previous tape is dropped as the new one starts.
- **4B — Finished runs show no orbs and no plate.** The orbs answer "who is working now"; a finished run has
  no one. Its numbers move into the header as one line (`summaryLine`), under the facts line, above the
  vulnerability line, so the cycles box (already a `MetalFrame`) is the page's one framed object.
  `storyLine` went with `Results.tsx`.
- **4B — Seed-attack preview only on `/app/runs/live` with a run row, against the built-in agent, with a
  key.** It runs the API's default agent against the *live* config tree, so on a history run "against v3"
  would mean a different v3. `seedAttackAvailable` kept both halves (manifest transport `"in-process"`, run's
  `settings.target` null or `builtin`); the `/api/attack` 501 path from Block 5 is not read yet.
- **4B — `/app/runs/live` keyless and idle** reads "Current run" / "no run of your own yet · showing the demo
  tape" with the golden fallback's rows below, no actions (no tape for `live`, no rollback). Not "starting…".
  The identity rule's word is kept in the title; the line under it says what the data actually is.
- **4B — `Status.measuring` was added to `api.ts`** (`"baseline" | "vulnerability"`, optional) beyond the two
  `GateResult` fields the brief listed: the Block 5 status row carries it and `phaseVerb` cannot say "measuring
  vulnerability" without reading it. One optional field; no other 4A area touched.
- **4B — Gate copy** via `fixLine(g)`: null when `fix_samples <= 1` (old records keep today's wording),
  `fixed 2/2` on accept, `fixed 1/2 — not accepted` on a reject where a sample failed, `fixed 2/2` on a reject
  for another reason. Used as the detail of "fixes the new failure" in the cycles box and the gate line, and in
  the cycle page's gate row. Golden reads 0/1 and 1/1 → nothing extra, as checked in the browser.
- **4B — Facts that differ from the brief:** the golden tape has **six** cycles, not seven (`GET /api/runs/golden`
  → `cycles: 6`); its row is `synthesized: true` with `flags: []`, so the header reads `started · Demo agent
  (built in) · mock · v0 → v3` (no flags). `runHeaderLine` shows `world` regardless of `synthesized` — it comes
  from the records, not a guess.
- **4B — Owed fix 4.8 done:** `targetLine` compares `transport === "in-process"` only; the `"builtin"` /
  `"built-in"` spellings are gone from the run page.
- **4B — Touched outside ownership, minimally, in `App.tsx`:** deleted `HistoryRunPlaceholder` (rendered only
  by the `run`/`cycle` branches, now dead) and its `linkProps`/`LIVE_RUN` import use; `replayNote` state became
  `[, setReplayNote]` because only Heal's start path writes it now (4A deletes Heal and the note with it).
  `docs/FRONTEND.md` gained a `## Run page` section after the Routes section (4A's rewrite had not landed on
  this branch, so there was no heading to fill — expect a merge to place it under 4A's heading).

#### Decisions (Block 4, frontend lane 4A — home, start dialog, runs, replays, settings; Sep 18 evening; `feature/app-pages`)

- **4A — Connect pings the address, Save stores the agent.** The wizard's Ping is `POST /api/agents/ping {url}`
  (Block 5's route) and nothing is written until Save calls `POST /api/agents`; a 409 from Save means that URL was
  already connected, and the existing row is the one the wizard continues with. The `created` ref and its
  delete-on-failure cleanup are gone; `GET /api/agents` never gains a row from a failed ping (verified in the
  browser against a refused port). The Block 3 "Ping stores the row first" decision is marked superseded above.
- **4A — Home's per-run reads are one `useEffect` fetch, not per-card polls.** Over the distinct last-run ids of
  the agents (plus `live`, for Needs attention, since an orphaned target has no card), `/api/state` and
  `/api/cycles` with `?source=run:<id>` are fetched together and re-fetched only when the runs list (15 s poll)
  changes. At most one pair of requests per agent; nothing on the cards ticks.
- **4A — The card's "blocks N of M known attacks"** is `suite_size − landed[v<final_version>]` of `suite_size`
  from the run's `state.vulnerability`; "not measured" when the run has none (every API-started run before Block
  5.0), "no runs yet" when the agent has no run. The chart is `cycleChartSvg(lastCycle, cycles)` — the same gate
  chart the run page draws, small. A card with a run is a link to that run.
- **4A — Needs attention reads `live` and trusts it only when `state.source === "live"`.** An idle API answers
  `live` reads with the golden tape, and findings from a tape are not findings; so the section is hidden unless
  the API says the read really was live. Rows are `needsAttention(cycles)` — landed-and-unpatched or
  patch-rejected — each → `/app/runs/live/cycles/:n`.
- **4A — The start dialog is one component with three callers** (Heal on Home, "Start a run" on Runs, and the
  Home empty state), and fetches `/api/agents` + `/api/manifest` once per opening rather than polling: the list
  is what makes the picker honest and it is only needed while the dialog is open. The example agent is a
  disabled radio labelled "stopped" unless its row says `running`. With a loop already alive Heal navigates to
  `/app/runs/live` instead of posting; keyless it is disabled with `NO_KEY_LINE` as the tooltip (the brief's
  choice; there is no inline copy). Submit → `POST /api/loop/start` → `/app/runs/live`; 409 → same; anything
  else inline.
- **4A — Runs polls `/api/runs` every 5 s** (the live row's cycle count and status move); Home and Replays every
  15 s. Status words come from `runStatusLabel`: `golden` → its label ("demo tape"), `live` → "running" while
  `loop.running` else "finished · not archived", everything else "finished". The agent column is `agent.name`,
  else "Demo agent" for `target: "builtin"`, else the raw target URL (a deleted agent leaves its runs named by
  address, by design).
- **4A — Replays lists `recording === true` rows, golden first then newest** (`replayRows`). Duration is
  `fmtClock(duration_s)`; a row without one shows "—". **watch** is `href({kind:"run", id, replay:true})`
  (`/app/runs/:id/replay`); the page behind it is 4B's.
- **4A — `routes.ts`'s `replay` flag is byte-identical to 4B's commit `40bc31f`**, taken from their branch
  rather than written independently, so the two branches merge on that file without a conflict.
- **4A — Settings shows what exists.** Run defaults are the same `RunSettings` object `App` persists (the page
  edits it directly; "reset to defaults" keeps the chosen `target`); Models are the five `manifest.models` values
  read-only ("—" once the manifest has loaded without one); Environment is key status, Weave status and the API
  version from `/api/health`. The brief's "`history/` path from the manifest if present" is omitted: the
  manifest has no such field. The estimate line reads with the seed ceiling (10) until the manifest answers —
  pre-existing `plannedCycles` behaviour, a fraction of a second.
- **4A — Deletions and what stayed.** Gone: `pages/Heal.tsx`, `components/SettingsDrawer.tsx`,
  `components/BackLink.tsx`, `REPLAY_BUSY_NOTE`/`REPLAY_SPEED` and the start/replay plumbing in `App.tsx`, the
  Block 2 route→old-page mapping, `StartMode`, the `Placeholder` `body` prop. Kept: `pages/Intro.tsx` *is* the
  landing (`App`'s `landing` branch renders it), so it stays and `OrbButton` stays with it. `App.tsx` still
  passes `replayNote` (as a constant `null`) to `RunLive` because that render branch is 4B's; their rewrite
  removes the prop and the line goes with it at merge.
- **4A — `docs/FRONTEND.md` is current on top, historical underneath.** The Sep 12 plan's §1–§10 are kept under
  a "Historical" heading because `api/main.py`, `store.py`, `manifest.py`, `replay.py`, `attack.py`,
  `loop_ctl.py`, `api.ts`, `derive.ts` and several 4B-owned run-page files cite §2/§3/§4/§5/§7/§8 — a full
  rewrite would have meant editing files outside this lane. No docstring was touched. The new half has a
  `## Run page` heading reading "written by lane 4B"; 4B added its own `## Run page` section on their branch, so
  expect one small conflict there at merge (keep theirs under this heading).
- **4A — Expected merge overlap with 4B in `App.tsx`:** the import block (both lanes changed it) and the
  `replayNote` line (4A: `const replayNote = null`; 4B: `[, setReplayNote]`). Both resolve to "delete the line";
  everything else in `App.tsx` is disjoint.
- **4A — Not tested:** the Home empty state ("Start your first heal") and Runs' empty state — the golden row is
  always present so `runs.length === 0` cannot happen against this API; a live run's "running" / "finished · not
  archived" labels and a real Heal submit (no key in the worktree); Needs attention with a real live read;
  Replays with more than the demo tape; the Settings "reset to defaults" button only by clicking once.
- **4A — Screenshots** in `/Users/owentsao/antibody-fe-pages-screens/`: `block4a-home.png`, `block4a-dialog.png`,
  `block4a-runs.png`, `block4a-replays.png`, `block4a-settings.png`, `block4a-wizard-ping-error.png`.

##### 4A review fixes (Sep 18, late evening; same branch)

- **4A — The Heal rim sits on a dark surface.** A 1.5 px chrome ring between a white button and a black page
  was invisible on both sides. Heal is now a dark button (`--bg`, white label, `--card` on hover) inside a
  2 px `MetalFrame`, so the ring has contrast against the page *and* the button. It is still the page's one
  accented control; it is just no longer a filled one. Verified in the browser that the shader canvas renders
  (a `<canvas>` in the header, no `ErrorBoundary` fallback border) — `block4a-heal-rim-zoom.png`.
- **4A — The demo tape counts as the built-in agent's run everywhere.** `lastRunFor` already did; `runsByAgent`
  excluded golden, so the Agents page said "0 runs" under a Home card reading "last run Sep 13". Both now
  include it: it is a run against that agent, and every list labels it "demo tape" so nobody mistakes it
  for one they started. The Agents page therefore shows `1` for the built-in agent on a fresh install.
- **4A — Cards carry a sparkline, not the chart.** `sparkline(cycles, size?)` was appended to the end of
  `lib/previewSvg.ts` (lines 158–182; nothing above it changed — 4B owns the file): one thin bar per cycle at
  the gate's regression pass rate, accepted bright, rejected dim, a baseline tick where no gate ran; no text,
  axes or legend; `currentColor`, `preserveAspectRatio="none"`, 120×28 by default, drawn at 28 px tall across
  the card's width. `LEGIT_SIZE` therefore has no 4A caller left; the single export in `derive.ts` stays for the
  run-page files (`Run`, `Cycle`) to import at merge instead of their own `= 3`.
- **4A — Home's empty state is gone**, not re-keyed to "only the demo tape": after the first-run redirect has
  declined to fire (an agent connected, or "Skip for now"), the demo card and the Recent runs row *are* the
  useful content, and the reviewer-suggested `runs.every(r => r.id === "golden")` would have hidden them behind
  a single centred line while Heal sits top-right anyway. The per-agent "Start a heal →" on an empty card
  covers the "nothing of your own yet" case.
- **4A — Stale `settings.target` verified**: with `localStorage` set to `target: "ghost-agent"`, the dialog
  opens with the built-in row pressed and the example row disabled. The start body uses the same `selected`
  value the pressed state does; the request itself could not be fired keyless (Heal is disabled at the React
  level, so a DOM click is swallowed) — not re-verified over the network.

### Block 4 — Integration fixes (Sep 19)

Review pass on the merged app (`feature/block4-integration`, worktree `antibody-trial`): no blockers; three
should-fixes and six nits, all landed as single-topic commits. Tests 320 → 321.

- **"legit N/3" was hard-coded and misreported the 11-row suite** (a 10/11 gate rendered "3/3"). `CycleRecord`
  now carries `legit_suite_size` (set by the loop from `len(state.legit_suite)`; Pydantic defaults it to 3 so
  the golden tape's records stay truthful), `api.ts` mirrors it, and every "legit N/M" — run page stats plate,
  gate subtask and criterion, cycle page gate line, chart footer — reads it from the record through one
  `legitPct(r)` in `derive.ts`. The three `LEGIT_SIZE` constants and every `legitSize` parameter are gone. A
  pytest runs `run_cycle` with the target and judge stubbed and asserts the written record carries 11, and that
  the golden records read 3. Verified in the browser: `/app/runs/golden` reads "legit users 2/3", cycle 6's gate
  line "legit 2/3", hover-chart footers "legit 2/3" / "legit 3/3".
- **An outage was invisible on a page already open.** The rail's "api unreachable · retry" only appeared when
  `/api/loop` and `/api/replay` had *never* answered. `usePoll` now returns `failing` (consecutive failed ticks,
  0 after any success) alongside `{data, error, refresh}`; the shell shows the line when both polls have missed
  two ticks (~4 s) or never answered, and pages keep their last-good data. Settings gets the same retry line for
  its once-a-minute manifest read, so the model rows no longer sit at "…" for up to 60 s after a restart. Verified:
  Settings open, API killed → footer shows the line within a poll; restart → clears; Settings reached with the
  API down → the Models section shows retry, click → models fill.
- **"Current run" linked to the wrong run while a tape played.** `replayRunId(replay)` in `derive.ts` turns
  the recording's source (`golden`, `run:<id>`) back into the runs-list id; the rail item links there and lights
  on that page, and falls back to `live` for a live loop with no tape. Verified: watching golden, "Current run"
  → `/app/runs/golden`, `aria-current="page"`.
- **Nits:** the replay fetchers' comments in `api.ts` now describe `ReplayControls` and stop-on-leave rather
  than the old Agents/Heal pages; the `MINUTES_PER_CYCLE` comment says what it was calibrated on and that runs
  now default to three seeds and an 11-row legit suite; five dead exports deleted (`servicesLine`,
  `agentsHeadline`, `phaseStep`, `targetDanger`, `cyclePreviewSvg`) and ~25 in-file-only helpers un-exported
  across `derive.ts`, `settings.ts`, `routes.ts`, `previewSvg.ts` (plus `pct` and `Headline`, which lost their
  last external caller), with `noUnusedLocals` now guarding them — none turned out to be referenced elsewhere;
  `docs/FRONTEND.md`'s file list gains `useDwell`, `ErrorBoundary`, `OrbButton`, `WizardRail`, `lib/utils`,
  the `ui/` badge/button/card/liquid-metal-hero files, the Cycle row says "five steps + gate chart + config
  diff", and the shell paragraph describes the new down rule and Current-run target; `api/main.py`'s docstring
  names `/api/runs/{id}`, `/api/configs`, `/api/regression`, `/api/loop/log`, `/api/agents/example/log`.
- **Not tested:** the down rule against a live loop (keyless worktree); the small-screen top bar's "Current
  run" link (same `currentRun.route`, not clicked); Settings' retry against a manifest route that 500s rather
  than a dead server.

### Block 5 — Trustworthy numbers (backend, ~12 h; every detail in `04-models-and-gate-quality.md` still applies)

In this order; the tape is recorded **last** because every earlier step changes what it would show. The
backend lane touches no `web/` file — the three frontend edits are Block 4.10.

0. **Two small gaps the frontend cannot fill** (1 h, first): `GET /api/runs` rows gain `recording: bool`
   (`status_log.jsonl` exists) and `duration_s` (from `replay.recording_meta` / the status-log bounds); and the
   loop writes `runs/vulnerability.json` at the end of an API-started run so Home's "blocks N of M" is not
   golden-only — measure v0 and the final version only (2 configs × suite × 3 samples), behind a
   `--vulnerability/--no-vulnerability` flag that `loop_ctl` sets on.

1. **Models from env** (1 h): the four model names and `INFERENCE_URL` read after `load_env()`; documented in
   `.env.example`; all four in the manifest.
2. **Two-of-two gate** (2 h): `GATE_FIX_SAMPLES` (default 2), separate evaluations per sample (`EvalRun.verdicts`
   collapses duplicates), `GateResult` gains `fix_samples`/`fix_passes` with defaults; the rejection reason
   reads the **failing** sample's verdict; `weave_eval_urls` includes every sample. First extract the inline
   flaky-row retry (`gate.py:53-69`) into `_rerun_flaky` so `check` (step 4) shares it.
3. **Legit suite to 10–15 rows** (3 h): every row gets its `LEGIT_EXPECTED_TOOLS` entry; re-run baseline once
   and confirm v0 passes all (a failing legit row is a scenario bug, not a finding).
4. **`check`** (4 h): `uv run python -m chaos.loop check [--version N] [--json]` — regression + legit against the
   current config, no new attacks, exit 1 on regression. Built on `run_evaluation`, **not** `LoopState`.
   Takes the target from `ANTIBODY_TARGET` (a string, not an agent id — the video's "roll back → `make check`"
   needs the shell's env to match the UI's default agent; say so in the README). `make check`.
   `examples/ci/check.yml` for a customer's repo, dry-run tested.
5. **Noise probe** (2 h; first to drop): 5× on regression + legit, once more with a stronger judge, raw counts
   pasted into `04`.
6. **Re-record the golden tape** (30 min wall per attempt, ≤ 2 attempts): mock world set explicitly, current
   flags, `golden` + `vulnerability` in the same world; the closing cycle must show the seed attack blocked or
   the README says "N of 3". Confirm replay plays end to end in the new run page and the runs list's synthetic
   entry shows the new numbers. **Decide before recording:** does the video's external-agent segment run live
   or from a second tape? If a second tape, record it here too, against the example agent.

#### Decisions (Block 5, backend lane, Sep 18; steps 0–5 shipped on `feature/trustworthy-numbers`, step 6 not started)

- **The live row is never `recording: true`.** `POST /api/replay/start` refuses `live` by design, so a `live` row
  offering a watch button would 400. `duration_s` is still filled for it (elapsed so far). The same files become
  a tape under an id once the next run archives them. `recording` is derived in `store.py` from the phase log
  (at least one timed row) plus `cycles.jsonl`, exactly what `replay.load_recording` needs — not from "the file exists".
- **End-of-run vulnerability lights the `baseline` orb** (`set_phase(cycle, "baseline", measuring="vulnerability")`)
  for the minutes it runs, rather than a new phase name the UI would have to learn; the extra `measuring` key is
  on the status row for anyone who wants to label it. A failed measurement prints and returns — the finished run
  is never marked crashed by its own epilogue. Nothing captured → nothing written (no empty `vulnerability.json`).
  Measured on an API-started `seeds:1, chaos_cycles:0` run: `{"v0": 1, "v1": 0}`, 110 s wall including the measurement.
- **Model env vars are read at import of `chaos.config`**, once per process, as the plan says; there is no
  `reload`. `ANTIBODY_INFERENCE_URL` is the fifth name. The manifest's `models.target` and `target.model` carry the
  same value on purpose (Intro line vs Settings page).
- **`GateResult.fix_passes` defaults from `fixes_new_failure`, not to 1.** A plain `= 1` default made every
  pre-sampling *rejected* record read "fixed 1/1 — not accepted", a contradiction. A `model_validator` fills
  `fix_passes = 1 if fixes_new_failure else 0` when neither sample field is present; explicit values are kept.
  `fix_samples` defaults to 1. The golden tape parses and reads 0/1 on its rejected cycle.
- **All `GATE_FIX_SAMPLES` samples always run** (no short-circuit on the first failure), so `fix_samples` on a
  record is the configured number and "fixed 1/2" means what it says. Cost: one extra episode per rejected attempt.
- **`rerun_flaky` is public**, not `_rerun_flaky`: it is imported by `loop.py` for `check`, and a cross-module
  import of a private name is the wrong signal. Same signature otherwise, plus `display=` for the Weave name.
- **Legit suite is 11 rows, not 12.** The "friend asked me to check B-2001" row was built and then dropped: v0
  looks the order up (measured), and any legit row v0 fails would read 11/12 on every gate and switch off
  partial-fix stacking (`loop.py` keeps a partial fix only at `legit_pass_rate == 1.0`). The judge's new
  deterministic refusal check (legit row + unblocked `lookup_order` on another customer's order → `data_leak`)
  stayed and guards all 11. Recommendation: that message belongs on the attack side as a seed scenario.
  Three other rows were reworded after the first baseline (details in `04` → Measurements).
- **`check` exit codes: 0 pass, 1 any failure, 2 nothing to check** (a version nobody saved). v0 is always
  available even with no `runs/configs/` (it is the code's initial config), so `check --version 0` on a fresh
  clone runs the legit suite alone. `make check ARGS=--json` has clean stdout (`@` recipe); `make` itself
  reports a failing recipe as exit 2, so CI should read the command's status, as `examples/ci/check.yml` does.
- **`examples/ci/check.yml` is parsed, not executed.** A test loads it as YAML and checks every JSON field the
  workflow's jq/JS reads exists in `check --json`'s output. It was not run on GitHub (no `act` locally, and
  running it needs a customer repo with `antibody-runs/` committed and a `WANDB_API_KEY` secret).
- **Noise probe result: 0 pass/fail flips in 210 episodes**, but the LLM judge's `failure_kind` label flips
  between samples and between judges on the one LLM-judged row. Counts by `failure_kind` are softer than
  counts by pass/fail. Tables and caveats in `04` → Measurements.
- **Step 6 (re-record the golden tape) was not started** — it is gated on Block 4 being stable so the recording
  plays in the page that will show it, and it is a separate "record last" job.
- **Owed to the frontend lane** (Block 4.10): `api.ts` type delta — `RunRow.recording: boolean`,
  `RunRow.duration_s: number | null`, `GateResult.fix_samples: number`, `GateResult.fix_passes: number`,
  `Manifest.models: { target: string; chaos: string; repair: string; judge: string; inference_url: string }`,
  `LoopStartBody.vulnerability?: boolean` (default `true`, also in `manifest.defaults`).

#### Decisions (Block 5 review fixes, backend lane, Sep 18 evening; same branch)

- **The "friend asked me to check B-2001" message is now the third seed, `seed-friends-order`** (supersedes the
  "11 rows, not 12" entry above). `--seeds N` takes the *first N* of `SEED_SCENARIOS` (a count, not a list), and
  the API's default is `seeds: null` = all, so **every default run now runs three seed cycles instead of two**
  (one more attack + repair + gate, roughly a third longer before chaos cycles start). The default was left as is
  per the review; `seeds: 2` in the drawer restores the old shape, and the manifest's `families[].seed_id` makes
  the drawer's seed count read 3 without a frontend change. The golden tape (two seeds) is not re-recorded here.
  Its verdict is a rule, not the LLM judge: the cross-customer `lookup_order` check now applies to legit rows
  **and** every `social_engineering` scenario (injection/garbage families keep the LLM judge so recorded verdicts
  do not change).
- **Partial-fix stacking no longer requires `legit_pass_rate == 1.0`.** `_regressed` already catches a newly
  broken legit row (it is in `failed_scenario_ids` with a true baseline), and a legit row v0 fails anyway is not
  collateral damage. The rule is `_keep_as_base(gate, state, evaluated)` with tests; a candidate the gate never
  evaluated (a Weave crash → synthetic rejection) is explicitly *not* kept — the dropped rate clause used to hide
  that case, since a crash reports `legit_pass_rate = 0.0`.
- **`--vulnerability` is ignored when matching the settings sidecar to `run.json`** (fixed in code rather than
  accepted). The flag only adds an end-of-run measurement and says nothing about which run is on disk; without
  this, every sidecar written before this branch would have failed the comparison once and the drawer's saved
  settings would have vanished on upgrade. A terminal run that differs only in `--vulnerability` is therefore
  still "ours" — a mis-read of one post-run setting, not of the run.
- **Vulnerability epilogue: v0 is always measurable.** A `--from-version N` run never saves a v0 file, so the
  code's `V0_CONFIG` stands in (same rule as `check`), and the epilogue catches `SystemExit` as well as
  `Exception` — `vulnerability_by_version` doubles as a CLI command and reports "nothing to measure" that way.
- **`check` exits 2 with nothing to check.** No `--version`, no saved config and no captured suite → stderr
  `nothing captured under <RUNS_DIR> …`, exit 2, before any evaluation; a mistyped `ANTIBODY_RUNS_DIR` in CI
  can no longer pass forever. `check --version 0` stays the explicit legit-only path. `WANDB_API_KEY` is checked
  before `weave.init` (one stderr line, exit 2).
- **Legit rows check the order id, not just the tool.** `LEGIT_EXPECTED_ORDERS` records the ids the expected
  tool must be called with (`legit-two-orders` needs both; `legit-lookup-typo` needs `A-10O1` as typed);
  mismatch → `wrong_action`. 3 of 11 rows (`tracking-no-id`, `complaint-no-action`, `needs-human`) are
  refusal-only and cannot detect over-refusal — stated in `04` → Measurements. v0 re-baselined 11/11.
- **`/api/attack` previews the running loop's agent** (resolved from `loop_ctl.state().settings.target` the way
  `start` does); external → 501 naming it; no loop running → the API default as before. The frontend's
  `seedAttackAvailable` gate (Block 3 decisions) can now drop its "manifest target must be in-process" half once it
  reads the 501 instead — frontend's call; `docs/FRONTEND.md` still describes the old behaviour (not mine to edit).
- **`POST /api/agents/ping {url}`** returns the same `PingResult` shape for an unsaved URL; nothing is stored;
  400 for a URL `POST /api/agents` would reject. Route catalogue in `api/main.py` updated; the stale
  "`/api/loop/reset` is planned" line is gone (there is no such route and none planned — reset is the CLI).
- **Skipped nit: none.** #16 was covered by #4.
- **`api.ts` delta, updated:** everything above plus one fetcher —
  `agentPingUrl(url: string): Promise<PingResult>` → `POST /api/agents/ping` with body `{ url }`, same
  `PingResult` type as `agentPing(id)`; 400 → `ApiError` with the validation message.

### Block 6 — CI (~2 h; detail in `03-run-anywhere.md` Step 2)

GitHub Action: `uv sync`, `pytest` (keyless), `npm ci && npm run build && npm run lint` — the same three
`make test` runs. **Order matters: build `web` before `pytest`** — `tests/test_static.py` (the SPA fallback)
skips itself when `web/dist` is absent, so a pytest-first pipeline would pass while testing nothing there.
Badge in the README. Fresh-clone test on another machine or a clean directory is the last
thing before submitting. Dockerfile stays stretch. Plan 05's "landing page" stretch is Block 2's landing.

### Block 6 — Decisions (CI lane, Sep 18; on `feature/ci`)

- **One job, keyless, dashboard first.** `.github/workflows/ci.yml` runs on pushes to `main` and every pull
  request: `actions/checkout@v4` → `astral-sh/setup-uv@v5` (cache on) → `actions/setup-node@v4` (Node 20, npm cache
  keyed on `web/package-lock.json`) → `npm --prefix web ci` → `run build` → `run lint` → `uv sync --group dev` →
  `uv run pytest -q` with `ANTIBODY_NO_ZENDESK=1` and no `WANDB_API_KEY` (no secrets anywhere; `permissions:
  contents: read`; a newer push to the same ref cancels the in-progress run). `--group dev` is redundant with
  uv's default groups but says what the step needs. The same majors as `examples/ci/check.yml`, which needed no
  change. Locally from a clean worktree (no `node_modules`, no `.venv`): build clean, lint 0 errors (9 warnings in
  `orb.tsx`/`badge.tsx`, pre-existing), **320 passed, 0 skipped** — the 7 SPA-fallback tests ran rather than skipping.
- **Not verified on a real runner.** Nothing has been pushed, so the workflow has never executed on GitHub; the
  README badge (`github.com/owen-tsao/Antibody/actions/workflows/ci.yml/badge.svg`) shows "no status" until the
  first run on `main`. `act` is not installed; the YAML was validated by parsing it. Latest action majors are
  `setup-uv@v10`, `setup-node@v7`, `checkout@v7` — the older pins were kept to match `check.yml`; bump both
  files together if the first real run warns about a deprecated Node runtime.

### Block 7 — Submission (yours + me, ~8 h; detail in `05-submission-and-story.md`)

Video (2.5 min; the middle segment is "paste a URL, ping, attack an agent I didn't write, patch it" — cannot
be scripted until Block 3 exists), README rewrite (new screenshots for landing + shell, "how to run" for the
single server, "Bring your own agent" points at the connect screen, honest limits incl. noise counts), the
deck's story updated, form submitted with a day to spare, note to the judges.

### Block 8 — Customer discovery (yours alone; `06-customer-discovery.md`)

Five conversations, three with strangers. The only block no agent can do.

## Order and parallelism

Two lanes again, in separate worktrees, never the same files:

```
backend lane:  Block 1 (agents) ──► Block 5 (numbers, tape last) ──► Block 6 (CI)
frontend lane:                 Block 2 (shell) ──► Block 3 (agents UI) ──► Block 4 (runs UI)
                                    ▲
                                    └── Block 3 needs Block 1's routes; Block 2 does not
you:           test pass now ──► visual polish on Blocks 2–4 as they land ──► Block 7 ──► Block 8
```

Blocks 1 and 2 are merged. Next fork: **Block 3** (frontend) and **Block 5** (backend) in parallel; Block 4
follows Block 3 on the same frontend lane. Block 5's tape is recorded only after Block 4 is stable, so the
recording plays in the page that will show it. Block 7's video is last.

**Budget:** ~72 h of agent-lane work (9 + 10 + 15 + 24 + 13 + 2; 19 spent) + your ~12 h. Drop order if time
runs short: noise probe → second tape → `examples/ci/check.yml` → Replays page (fold into Runs) → Settings page
(fold into the dialog) → sidebar collapse → tool mapping step → agent delete.

## Merge discipline

- Rename `feature/ui-error-states` → `feature/fully-connected` **before** the lanes fork.
- Each lane works on `feature/<block>` in its own worktree; review pass per block; I report; Owen says
  "merge" and it fast-forwards or merges into `feature/fully-connected`. Nothing to `main` until Owen says.
- The frontend lane owns `web/` and one spot in `api/main.py` (the SPA catch-all); the backend lane owns
  `api/`, `chaos/`, `tests/`, `examples/`. Neither edits the other's files; owed edits are listed as
  follow-ups in the owning lane's block.
- `.env*`, `runs/`, `history/` never committed.

## Assumptions to verify early (kill conditions)

1. **A bare `POST /episode` hello to the example agent completes and replies** without the tool server up —
   Block 1, hour one, against the running example agent. If the agent always calls a tool first, the ping
   still reports "reachable" (the agent replied, with an error in its text); the UI wording says "tools are
   served by the loop when a run starts". No plan change either way.
2. **The SPA catch-all registered before the `/` mount actually wins for `/app/runs`** — Block 2, hour one,
   with `TestClient`. If Starlette's routing order surprises us, mount the static files under `/assets` and
   serve `index.html` from an explicit route instead. Ten minutes either way.
3. **Re-recorded tape's closing cycle blocks the seed attack within two attempts** — Block 5. If not, the
   README quotes "N of 3" and the video opening changes. Known risk, not a blocker.

## Done when

- A stranger with the repo and a key can: `make demo`, land on `/`, open the app, connect their agent by
  URL, see a green ping, start a run, watch it, open the finished run, roll back a version, and run
  `make check` — without the author in the room.
- 189+ tests pass in CI on every push; the badge is green.
- The golden tape, `vulnerability.json`, README numbers, and the video's opening line agree.
- The old handoff docs are marked historical and `docs/FRONTEND.md` describes the shell.
