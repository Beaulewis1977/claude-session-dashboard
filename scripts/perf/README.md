# Performance harness

Measures the app on **a copy** of real data, before and after a change. Nothing
here runs in `npm test` or CI, nothing is written to the app's data, and the
output is numbers only (no titles, paths, text or keys). Keep result folders
outside the repo.

## Main process (`bench-main.bench.ts`)

Usage reports, limits, trends, the Codex fork dedupe and the session search
index, on a copy of the app's data folder: `usage/`, `settings.json`,
`limits-history.ndjson` and, for the search index, `cache/sessions-v*.json`.

```powershell
$env:CSD_BENCH_DATA = 'C:\path\to\copy'   # a copy, never %APPDATA% itself
$env:CSD_BENCH_OUT = 'C:\path\to\results'  # bench-main.txt goes here
npx vitest run --config scripts/perf/vitest.config.mjs
```

- `CSD_BENCH_N` repeats each timing (default 5).
- `CSD_BENCH_ALLOC_TOP=1` lists the top allocation sites of each sampled call.
- The `hash:` lines are hashes of the results (records, readings, turns, 181
  reports at a fixed "now", speed trends): two runs of the same data must print
  the same ones before and after a change that keeps results exact.
- MB figures are Node's (no pointer compression): the app (Electron) uses about
  half for the same objects.

## The built app (`perf-ui.mjs`)

Starts the built app (`out/`, so `npm run build` first) with Playwright and
times opening Usage, its tabs and ranges, the biggest sessions and a spread of
others in the viewer, plus memory per process. It uses the real data folder,
so close the installed app first (it holds the single-instance lock).

```powershell
node scripts/perf/perf-ui.mjs (Get-Location).Path C:\path\to\results
```

- `--fixtures` runs on the sample data instead.
- `CSD_PERF_ONLY=viewer` only opens sessions in the viewer.
- For each opened session it prints what the viewer was sent (by kind of
  content), how it was drawn, and the viewer's DOM estimate against the nodes
  each drawn turn really has (`calibration` in `perf-ui.json`: the data the
  weights in `src/renderer/src/lib/dom-estimate.ts` are fitted to).
- With `CSD_TIMING=1` (set by the script) the app logs slow IPC calls, event
  loop stalls and, every 10 s, main-process memory and each worker thread's heap.
