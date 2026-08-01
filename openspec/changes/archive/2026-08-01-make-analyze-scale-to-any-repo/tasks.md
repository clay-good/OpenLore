# Tasks — make analyze scale to any repo size

> Status: **IMPLEMENTED** (2026-08-01). Code + tests landed; see the PR. Explicitly-deferred items
> stay unchecked by design.

## Adaptive heap sizing (CLI)
- [x] At CLI entry, before command dispatch: detect the memory budget — read the cgroup/container
      limit when present (`/sys/fs/cgroup/memory.max`, v1 `memory.limit_in_bytes`), else
      `os.totalmem()` (`src/cli/heap-sizing.ts` `detectMemoryBudgetBytes`)
- [x] If the current heap is below the target fraction of the budget AND the user has not set a heap
      (`--max-old-space-size`, `NODE_OPTIONS`) AND the opt-out is unset AND the re-exec marker is
      unset: re-exec `process.execPath` with the computed `--max-old-space-size`, passing argv/env
      through, setting the marker (`heap-sizing.ts` `planHeapReexec` + `maybeReexecForHeap`; wired via
      `src/cli/heap-bootstrap.ts`, imported first in `src/cli/index.ts`)
- [x] Marker (`OPENLORE_HEAP_REEXEC`) makes re-exec at-most-once; verified no loop under any outcome
      (unit test `planHeapReexec` marker cases + e2e "exactly one heap line")
- [x] Transparent to stdio: re-exec inherits stdio; the heap disclosure goes to stderr, so
      `openlore mcp` stdout stays clean JSON-RPC (verified e2e)
- [x] One-line disclosure of the chosen heap (stderr); documented opt-out (`OPENLORE_NO_AUTO_HEAP`)
- [x] Added the opt-out, the sizing fraction (`OPENLORE_HEAP_FRACTION`), and the explicit override
      (`OPENLORE_HEAP_MB`) to `docs/configuration.md`

## Pre-flight capacity estimate (analyzer)
- [x] Derive a conservative memory estimate from the repository size (file count + total source
      bytes, from `repoMap.allFiles`) before the heavy passes
      (`src/core/analyzer/memory-strategy.ts` `estimateGraphMemoryBytes`)
- [x] Map the estimate + available heap to a strategy: full fidelity vs. a degradation tier
      (`chooseMemoryTier` / `resolveMemoryStrategy`)
- [x] Estimate is deterministic for a given repository (no wall-clock/RAM inputs into the number
      itself — only into the strategy choice) — unit-tested

## Graceful-degradation ladder (analyzer)
- [x] Tier order defined (overlay → deep-analysis breadth) with heap-fraction thresholds
      (`shedComponentsFor`, `FULL_FIDELITY_HEAP_FRACTION`, `DEEP_ANALYSIS_SHED_HEAP_FRACTION`)
- [x] Each shed tier disclosed via the parse-health machinery (a `memoryDegradation` record on
      `ParseHealthReport`, emitted even when it is the only signal)
- [x] One CLI line summarizes what was reduced and why (`describeMemoryDegradation`, surfaced in
      `analyze.ts`)
- [x] A usable index (call graph + search) is always produced within the reduced tier — verified the
      base graph is untouched when the overlay is shed
- [x] No raw V8 fatal when the reduced tier fits (the overlay is not built; the base graph proceeds)

## Determinism guardrails (tests)
- [x] The base call graph is byte-identical with and without the overlay shed
      (`memory-degradation-ladder.test.ts`)
- [x] Degradation is a pure function of declared constraints (same budget + repo → same shed tiers +
      same disclosure) — `memory-strategy.test.ts`
- [x] A forced over-capacity tier produces a usable, disclosed, reduced index instead of a fatal
      (ladder test + e2e forced-tier run)
- [x] CLI: re-exec is at-most-once, respects user heap / `NODE_OPTIONS` / opt-out, and is transparent
      to stdio (`heap-sizing.test.ts` + e2e)
- [x] A full-fidelity run clears a stale `parse-health.json` from a prior degraded run (so two
      full-fidelity runs never differ on disk by history)

## Docs
- [x] `docs/configuration.md`: the honest promise — "works to your machine's capacity, degrades
      gracefully and transparently beyond it, never crashes" — the opt-out, and the env knobs
- [x] Noted the embeddable API path: host owns the heap; the degradation ladder still applies within it

## Explicitly deferred
- [ ] Out-of-core / streaming graph (graph larger than RAM) — its own proposal if ever needed
