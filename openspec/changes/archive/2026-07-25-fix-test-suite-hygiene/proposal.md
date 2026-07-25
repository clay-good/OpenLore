# Test-suite hygiene: eliminate deprecation time bombs and the known flake

> Status: SHIPPED (2026-07-19). Notes on how it landed: (1) the five `vi.mock` calls (four in
> `unified-search.e2e.test.ts`, one in `gryph-bridge.test.ts`) moved to module top level — a
> zero-behavior change since vitest already hoisted them. (2) The deprecation-warning escalation is
> implemented as a deterministic guard test (`src/vitest-hygiene.test.ts`) that fails the moment any
> `vi.mock` appears indented (inside a block) anywhere under `src`/`test`/`examples` — more robust
> than scraping vitest's stderr, and it runs in the same CI `test:run` the repo already gates on.
> (3) The `mcp-watcher-parity` flake was NOT reproducible on current main: the test is already
> event-driven (it awaits `handleChange` → `handleBatch({ syncFlush: true })`, whose signature+vector
> writes run inline and are fully awaited; every comparison is over a `.sort()`ed edge signature; each
> test uses its own `mkdtemp` root). Intervening watcher hardening (the inline `syncFlush` path)
> resolved it. Verified deterministic across 18 clean runs (12 isolated + 6 full-suite); a comment now
> documents the guarantee so a future edit can't silently reintroduce a timer-based wait.

## The gap

1. **vi.mock hoisting deprecation.** `unified-search.e2e.test.ts` (four calls: `../vector-index.js`,
   `../spec-vector-index.js`, `node:fs/promises`, `node:child_process`) and `gryph-bridge.test.ts`
   place `vi.mock` calls below top level. Vitest currently warns on every CI run — "This will
   become an error in a future version" — so a routine vitest upgrade turns a green suite red.
2. **Known flake.** `mcp-watcher-parity.test.ts` is flaky under full-suite load (documented in the
   project's own working notes when it shipped). A flaky guard erodes trust in exactly the
   discipline (red = real) the honesty contract depends on.

## What changes

1. Move the `vi.mock` calls to module top level (their execution order is already hoisted — the
   change makes the code match its actual behavior, zero behavioral delta), and add
   `vitest` deprecation warnings to the CI failure condition (treat the warning channel as an
   error for this class) so the next deprecation is caught when introduced, not at upgrade time.
2. Diagnose and fix the watcher-parity flake: the test asserts convergence timing under load —
   either make its assertion event-driven (await the watcher's own completion signal instead of a
   time window) or isolate it into the serial pool. A flaky test may not be quarantined-and-
   forgotten: the fix lands with a loop-N-times-locally verification recorded in the PR.

## Why this is in scope

CI green is a load-bearing claim in this repo (the README badges it; the benchmark honesty
contract leans on it). Both items are cheap now and expensive later.

## Impact

- Two test files re-ordered; one flake fix; CI config for warning escalation.
- Specs: `project` — 1 ADDED requirement (TestSuiteHasNoKnownTimeBombs).
- Risk: none; behavior-preserving test refactors.
