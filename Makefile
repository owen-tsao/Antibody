# Antibody — one command from a fresh clone.
#
#   make setup   install Python (uv) and web (npm) dependencies
#   make demo    build the dashboard, serve it on one port, open the browser (no .env needed: Replay works)
#   make dev     API on :8000 + Vite on :5173 with hot reload (scripts/dev.sh)
#   make run     run the self-healing loop from the CLI; extra flags via ARGS="--seeds 1 --chaos-cycles 1"
#   make test    pytest + web build + web lint (what CI runs)
#   make golden  snapshot the current run into data/golden/ as the demo fallback

PORT ?= 8000
URL  := http://localhost:$(PORT)
ARGS ?=

.PHONY: setup build dev serve demo run test golden

setup:
	uv sync
	npm --prefix web ci

build:
	npm --prefix web run build

dev:
	scripts/dev.sh

serve:
	uv run uvicorn api.main:app --port $(PORT)

# Serve in the background, wait for /api/health, open the browser, then hand the terminal to the
# server so Ctrl-C stops it. The open step is best-effort: no opener found just prints the URL.
demo: build
	@uv run uvicorn api.main:app --port $(PORT) & \
	pid=$$!; \
	trap 'kill $$pid 2>/dev/null' INT TERM; \
	for i in $$(seq 1 60); do \
	  if curl -fsS "$(URL)/api/health" >/dev/null 2>&1; then break; fi; \
	  if ! kill -0 $$pid 2>/dev/null; then echo "server exited before /api/health answered"; exit 1; fi; \
	  sleep 0.5; \
	done; \
	echo; echo "  Antibody  $(URL)"; echo; \
	if command -v open >/dev/null 2>&1; then open "$(URL)"; \
	elif command -v xdg-open >/dev/null 2>&1; then xdg-open "$(URL)" >/dev/null 2>&1; \
	else echo "  open $(URL) in your browser"; fi; \
	wait $$pid

run:
	uv run python -m chaos.loop run $(ARGS)

test:
	uv run pytest
	npm --prefix web run build
	npm --prefix web run lint

golden:
	uv run python -m chaos.loop golden
