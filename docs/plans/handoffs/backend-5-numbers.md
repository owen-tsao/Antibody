# Handoff — Backend lane: trustworthy numbers (plan Block 5, steps 0–5)

Worktree `/Users/owentsao/antibody-backend`, branch `feature/trustworthy-numbers` (forked from
`feature/fully-connected` at `76df0c4`). Read `/Users/owentsao/Coreweave Hacks/docs/plans/00-overview.md`
**Block 5** (your spec, steps 0–5; step 6 — re-recording the tape — is **not** yours yet, it waits for the
frontend) and then `/Users/owentsao/Coreweave Hacks/docs/plans/04-models-and-gate-quality.md` in full: every
fact, gotcha and "do not" in that file still applies and is more detailed than the block. House rules:
`/Users/owentsao/Coreweave Hacks/.cursor/rules/code-organization.mdc`.

## What you are building, in one sentence

Make Antibody's numbers something a judge can trust: models are configuration, "fixed" means two of two,
the legit suite is big enough to mean something, `check` lets a customer re-verify their agent from CI, and
we know how noisy our own judge is — plus two small API gaps the Home/Replays pages need.

## Facts (verify each before relying on it; record corrections in Decisions)

- Models: constants in `chaos/config.py:14-17` defined **before** `load_env()` at `:32`; `INFERENCE_URL` at `:12`.
  `api/manifest.py` reports only `target.model` (`:80-84`); the other three are not exposed.
- Gate: `chaos/gate.py:24-101`; flaky-row retry inline at `:53-69`; new failure gets **one** sample; rejection
  reason at `:79` reads `new_run`. `GateResult` in `chaos/schemas.py` — new fields need defaults so the golden
  tape (`data/golden/cycles.jsonl`) still parses. `EvalRun.verdicts` is keyed by scenario id (`evals.py:43-45`),
  so repeated samples must be **separate evaluations**, not `trials=N`.
- `LEGIT_SCENARIOS` at `chaos/scenarios.py:100-125` (3 rows); a legit row is judged **only** if it has a
  `LEGIT_EXPECTED_TOOLS` entry (`judge.py:107-121`). `ORDERS` has 3 orders / 2 customers (`tools.py:21-24`).
- `check` must not construct `LoopState` (`loop.py:48-68` files tickets, publishes datasets, saves configs).
  Use `run_evaluation` (`evals.py:115`) on `load_regression()` + `LEGIT_SCENARIOS` with
  `cfg = load_config(N or latest_version())`. Needs `weave.init` + a key. Target from `ANTIBODY_TARGET`.
- Vulnerability: written only by `uv run python -m chaos.loop vulnerability` (`loop.py:350-351,512`,
  `vulnerability_by_version`); the API's `GET /api/state` reads it per source (`store.read_vulnerability`).
  API-started runs never produce it today.
- Run rows: `api/store.run_manifest` (`:256-296`) reads `status_log.jsonl` bounds but exposes no
  `recording`/`duration_s`; `api/replay.py` has recording metadata helpers (find them).
- `loop_ctl.LoopStartBody` (`api/loop_ctl.py:88-110`) + `_flags` map fields to `chaos.loop run` flags one-to-one.
- Tests run keyless: `env -u WANDB_API_KEY uv run pytest -q` → 231 now. Anything that needs the key is a
  manual check you run yourself (source the root `.env` into your shell with `set -a; source "/Users/owentsao/Coreweave Hacks/.env"; set +a`; never print it) and record in Decisions with the date.

## Build, in this order (tests green before each commit)

0. **API gaps** (~1 h). (a) `GET /api/runs` rows and `GET /api/runs/{id}` gain `recording: bool` and
   `duration_s: float | null` (golden's synthetic row too). (b) `chaos.loop run` gains `--vulnerability /
   --no-vulnerability` (default **off** for the CLI so nobody's terminal run gets slower unasked); when on, at
   the end of the run measure **v0 and the final version only** (2 configs × suite × 3 samples) with the
   existing `vulnerability_by_version` machinery and write `runs/vulnerability.json` + `_detail.json` in the
   same world. `LoopStartBody.vulnerability: bool = True` → `_flags` emits it, so API-started runs get the
   number. Skip silently when the final version is v0 (nothing to compare) — write the v0 number alone.
1. **Models from env** (~1 h). Move the four model names + `INFERENCE_URL` below `load_env()`, read via
   `os.environ.get("ANTIBODY_TARGET_MODEL", …)`, `ANTIBODY_CHAOS_MODEL`, `ANTIBODY_REPAIR_MODEL`,
   `ANTIBODY_JUDGE_MODEL`, `ANTIBODY_INFERENCE_URL`; document in `.env.example` (commented, with the defaults);
   `api/manifest.py` gains `models: {target, chaos, repair, judge, inference_url}` (keep `target.model` as is).
2. **Two-of-two gate** (~2 h). Extract `_rerun_flaky(model, failed_ids, by_id) -> set[str]` from `gate.py:53-69`
   first. `GATE_FIX_SAMPLES = int(os.environ.get("ANTIBODY_GATE_FIX_SAMPLES", "2"))`; run the new-failure
   evaluation that many times as separate evaluations; `fixes = all(run.pass_rate == 1.0 …)`; the rejection
   reason reads the **failing** sample's verdict; `weave_eval_urls` includes every sample. `GateResult` gains
   `fix_samples: int = 1`, `fix_passes: int = 1`. Test: a stubbed evaluation that passes 1 of 2 → rejected with
   the failing sample's reason; golden tape still parses.
3. **Legit suite to 10–15 rows** (~3 h). Per plan 04 Step 6's list; every row gets its `LEGIT_EXPECTED_TOOLS`
   entry; "another customer's order" is a refusal check in the unauthorized branch, done deliberately; typo'd
   id expects the not-found path (do not add `ORDERS` rows). Unit test: every legit row has an expected-tools
   entry. **Manual (needs key):** run the baseline once on v0 and confirm all pass; record the result and date.
4. **`check`** (~4 h). `uv run python -m chaos.loop check [--version N] [--json]` per plan 04 Step 5; exit 1 on
   any regression; one line per test; `make check`; `examples/ci/check.yml` (dry-run tested with `act` if
   available, else `--json` output shape asserted by a unit test with `run_evaluation` stubbed). README section
   is Block 7's — write the docstring and `make check` help text only.
5. **Noise probe** (~2 h; **drop first** if you are past budget). `scripts/measure_noise.py` per plan 04 Step 2;
   **manual, needs key**; paste both tables into `04-models-and-gate-quality.md` "Measurements" with the date.

Do **not** re-record the golden tape (step 6): it waits for Block 4's run page so the recording is verified
in the UI that will show it.

## Boundaries

- **Owns:** `chaos/config.py`, `chaos/gate.py`, `chaos/schemas.py` (additive, defaults), `chaos/scenarios.py`,
  `chaos/judge.py` (legit entries + the refusal check only), `chaos/loop.py` (`check`, `--vulnerability`),
  `chaos/evals.py` if needed, `api/store.py` (`recording`/`duration_s`), `api/loop_ctl.py` (`vulnerability` field
  + flag), `api/manifest.py` (`models`), `api/main.py` (only if a route shape changes), `scripts/`, `examples/ci/`,
  `Makefile`, `.env.example`, `tests/**`, `docs/plans/04-*.md` (measurements).
- **Do not touch** `web/**`, `README.md`, `docs/FRONTEND.md`, `api/agents.py`, `api/example_agent.py`,
  `chaos/target.py`, `chaos/toolserver.py`, `data/golden/**`. No new dependency.
- **Git:** small single-topic commits on `feature/trustworthy-numbers`, plain-language messages (what and
  why). **Never push, never touch other branches.** Never read or print `.env`.

## Done when

- `ANTIBODY_JUDGE_MODEL=x` shows up in the manifest and (manually) in a Weave trace; defaults unchanged.
- A gate record shows `fix_samples: 2, fix_passes: 2` on accept; a 1-of-2 case is rejected with the right reason.
- `LEGIT_SCENARIOS` ≥ 10 with entries; baseline pass recorded with a date.
- `make check` exits 0 on the current tape's final config and 1 after `rollback` to v0 (manual, key).
- `GET /api/runs` rows carry `recording` and `duration_s`; a run started via the API (manual, key, ~5 min with
  `chaos_cycles: 0, seeds: 1`) ends with `runs/vulnerability.json` present.
- Report: commits, decisions, measurements, what was NOT tested, and the exact `api.ts` delta
  (`Manifest.models`, `GateResult.fix_samples/fix_passes`, `RunRow.recording/duration_s`, `LoopStartBody.vulnerability`).
