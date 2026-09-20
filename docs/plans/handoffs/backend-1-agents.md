# Handoff — Backend lane: agents as objects (plan Block 1)

You are working in the Antibody repo, worktree `/Users/owentsao/antibody-backend`, branch
`feature/agents-backend` (forked from `feature/fully-connected` at `8d34857`). Read
`docs/plans/00-overview.md` fully first — "The product decision", the **Scope** paragraph, and **Block 1**
are your spec; this file adds the facts you need and the boundaries. Plan `01-pluggable-target.md` is the
decision record for the target/tool-server code you are extending.

## What you are building, in one sentence

The app remembers the agents a user has connected (name + URL), can ping them, can tell which of the
sandbox storefront's tools they use, can start a run against a chosen one without anyone touching the
terminal or `ANTIBODY_TARGET`, and can spawn the example agent on request.

## Facts

- `chaos/target.py`: `TARGET_ENV = "ANTIBODY_TARGET"`, `resolve_target(name)` → `BuiltinTarget` |
  `HttpTarget`; canonical external name is `f"http:{url}"`; `HttpTarget.run_episode` (`:75`) calls
  `toolserver.tools_url()` **which binds 127.0.0.1:8765 in the calling process** — never call it from the
  API. `_post_json(url, body, timeout)` (`:113`) is the HTTP client with `ProxyHandler({})` and no redirects;
  rename it `post_json` and reuse it.
- Episode request shape the agent expects (`target.py:62`): `{session_id, message, customer_id,
  customer_email, tools_url}`; reply `{reply}`.
- `chaos/tools.py:62,103`: `TOOL_FUNCS` has the five storefront tool names.
- `api/loop_ctl.py`: `LoopStartBody` (`:88`, Pydantic, `model_validator` for cross-field rules → 400 via
  `api/main.py`'s handler scoped to `/api/loop/start`), `_env_overrides(body)` (`:261`) builds the child's env
  additions, `start(body)` (`:322`) under `runs_lock`, pid handling `_killpg`, `stop()`, `log_tail()`.
  Follow this module's pattern for the example-agent spawner (own module `api/example_agent.py`).
- `chaos/config.py:29`: `load_env()` uses `setdefault`, so an `.env` value of `ANTIBODY_TARGET` is inherited by
  children unless you set it **explicitly** in the child's env — always set it, including `builtin`.
- `chaos/loop.py:387`: `run.json.target` = `os.environ.get("ANTIBODY_TARGET") or "builtin"` — **verbatim**, not
  canonical. The README's example uses the bare `http://127.0.0.1:8790`; normalise with `resolve_target(x).name`
  on both sides when joining. `api/rollback.py:74-75` compares raw strings — fix it the same way.
- `api/store.py` is read-only by design; `chaos/state.py:save_regression` (`:104-119`) is the mkstemp +
  `os.replace` write pattern. `HISTORY_DIR` from `chaos.state`.
- `chaos/state.py:296-305`: `_migrate_legacy_archive` runs only from `archive_previous_run`/`reset`.
- `GET /api/runs` (`api/main.py:290`) returns rows incl. `target` (verbatim string), synthetic `golden`, and the
  live run under `id: "live"` (`store.py:279-282`).
- `tests/test_toolserver.py:212-225`: `FakeAgent` + `fake_agent` fixture — an HTTP stub agent. Move to
  `tests/conftest.py` for reuse.
- Example agent: `examples/agents/openai_agents_support/agent.py`, FastAPI, `POST /episode` at `:128`, own venv
  (`uv run` in that folder syncs it), listens on 8790, needs `WANDB_API_KEY`. Add `GET /tools` → `[{name, description}]`.
- Tests run keyless: `env -u WANDB_API_KEY uv run pytest -q` → 189 passing now.

## Build, in this order (each step compiles and its tests pass before the next)

1. **`api/agents.py`** — store at `HISTORY_DIR / "agents.json"`; rows `{id, name, transport, url, created_at,
   last_ping, tools}`; synthetic `builtin` first (never stored, never deletable) and synthetic `example`
   (`url http://127.0.0.1:8790`, `running` from `api/example_agent.py`). `list_agents()`, `add_agent(name, url)`
   (validate `http(s)://`, ≤ 2 KB, dedupe by canonical name → 409), `delete_agent(id)`, `resolve_agent(id)` →
   canonical target string, `agent_for_target(raw) -> {id, name} | None` (normalised join).
2. **Ping** — `ping(agent) -> {ok, latency_ms, reply_preview | error, tools, mapping}`: bare `post_json(url + "/episode",
   {...hello...}, timeout=10)` with `session_id = secrets.token_urlsafe(16)`, a fixed hello message, the demo
   customer id/email from `chaos/tools.py`, and `tools_url = "http://127.0.0.1:8765/tools"` (nothing listening —
   fine). Then `GET url + "/tools"` (2 s timeout; any failure → `tools: null`). `mapping = {known, unknown}`
   against `TOOL_FUNCS`. Persist `last_ping` + `tools` on stored rows. Never records an episode.
3. **Routes** in `api/main.py` (thin): `GET /api/agents`, `POST /api/agents` (201), `DELETE /api/agents/{id}`
   (404 builtin/example/unknown; 409 while `loop_ctl.is_running()`), `POST /api/agents/{id}/ping`,
   `POST /api/agents/example/start` (202; 503 no key — reuse `attack.missing_api_key()`; 409 if 8790 bound),
   `POST /api/agents/example/stop`.
4. **Target from request** — `LoopStartBody.target: str | None` (agent id). In `start()`, resolve via
   `agents.resolve_agent` (unknown → `ValueError` → 400 through the existing handler path; check how `_rules`
   errors are mapped and match it), set `env["ANTIBODY_TARGET"] = canonical` **always** (`builtin` when None
   resolves to builtin). Record the canonical string in the `loop_settings.json` sidecar body.
5. **Runs join** — `GET /api/runs` rows and `GET /api/runs/{id}` gain `agent: {id, name} | null`. Fix
   `api/rollback.py` comparison to use canonical names.
6. **Startup migration** — call the legacy-archive migration once at API startup (FastAPI lifespan or module
   import in `api/main.py`, whichever `chaos.state` already supports safely; it must be a no-op when there is
   nothing to migrate).
7. **`api/example_agent.py`** — spawn/stop/status for the example agent, modelled on `loop_ctl`
   (pid file under `runs/` or `HISTORY_DIR`, log to `runs/example_agent.log`, `running` = port 8790 answers
   `GET /tools`). Add `GET /tools` to the example agent.
8. **Manifest** — `GET /api/manifest` unchanged in shape; add nothing per-source.
9. **Tests** — `tests/test_agents.py`: store round-trip and dedupe; ping ok / refused / timeout / non-JSON /
   tools present vs absent (extend `FakeAgent` with `GET /tools`); start with `target` sets child env explicitly
   (patch `Popen`, inspect `env`); 400 unknown id; 409 delete while running; runs join with bare and canonical
   forms; example start 503 without key. `TestClient` for routes.
10. **Docs** — `.env.example` note on `ANTIBODY_TARGET` making an external agent the API's default (seed-attack
    preview 501s, rollback refuses built-in runs); example agent README mentions `GET /tools`; append
    `## Decisions` to `docs/plans/00-overview.md` under Block 1 for anything you chose that the plan left open.

## Verify first (hour one, kill conditions)

- Start the example agent by hand (`cd examples/agents/openai_agents_support && uv run python agent.py`, needs the
  key in your env — read it from the repo root `.env` with `set -a; source ../../../.env; set +a`; never print it)
  and send the bare hello with `curl`. Confirm it replies without a tool server running. Record the reply shape
  in Decisions. If it hangs instead of replying, report before building the ping on it.

## Boundaries

- **Owns:** `api/agents.py` (new), `api/example_agent.py` (new), `api/main.py` (routes + startup hook only),
  `api/loop_ctl.py`, `api/rollback.py`, `api/store.py` (read helpers only), `chaos/target.py` (rename only),
  `chaos/state.py` (migration hook only), `examples/agents/openai_agents_support/**`, `tests/**`, `.env.example`.
- **Do not touch:** anything in `web/`, `chaos/loop.py`, `chaos/gate.py`, `chaos/judge.py`, `README.md`
  (the frontend lane and later blocks own those). Do not add a dependency. Do not read or print `.env`.
- **Git:** commit on `feature/agents-backend` in small single-topic commits with plain-language messages
  (what changed and why; no file lists). **Never push, never touch other branches.**

## Done when

- `env -u WANDB_API_KEY uv run pytest -q` green with your tests added; import-time no-key run of the API works.
- `curl -X POST localhost:8000/api/agents -d '{"name":"x","url":"http://127.0.0.1:8790"}'` → 201; ping against
  the running example agent → `ok: true`, `tools` listed, `mapping.known` has 5 entries.
- `POST /api/loop/start` with `{"target": "<id>"}` spawns a loop whose `run.json.target` is the canonical string
  and `GET /api/runs` names the agent.
- `POST /api/agents/example/start` brings 8790 up with no terminal involved.
- Report back: commits, decisions, the ping reply shape, anything not tested, and the exact `api.ts` type
  delta the frontend needs (`Agent`, `PingResult`, `LoopStartBody.target`, `RunRow.agent`).
