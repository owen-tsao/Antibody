# Antibody web UI

The screen for the self-healing loop: four agent orbs that light up as the Chaos, Target, Judge and Repair agents take their turns, a per-cycle plan, and a results table with every attack, verdict, patch and gate decision.

Vite + React 19 + TypeScript + Tailwind. It talks only to the FastAPI adapter in `../api` (proxied at `/api`), which reads the loop's files and replays the recorded golden run.

```bash
npm install
npm run dev        # http://localhost:5173  (expects the API on :8000; `../scripts/dev.sh` starts both)
npm run build      # type-check + production bundle in dist/
npm run lint
```

`?demo=hero|orb|list|plan` renders one of the pasted UI components in isolation; it is a verification harness, not part of the product.

How the pages map to the loop, and the API contract they rely on, is in `../docs/FRONTEND.md`.
