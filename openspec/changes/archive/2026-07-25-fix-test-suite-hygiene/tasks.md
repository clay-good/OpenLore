# Tasks — test-suite hygiene

## Implementation
- [x] Hoist vi.mock calls to top level: unified-search.e2e.test.ts (4), gryph-bridge.test.ts (1)
- [x] CI: escalate vitest deprecation warnings for the mock-hoisting class to failures
- [x] mcp-watcher-parity flake: event-driven convergence assertion (or serial-pool isolation),
      verified by a recorded loop-N run

## Verification
- [x] CI log free of vi.mock hoisting warnings
- [x] Watcher-parity green across N consecutive full-suite runs (N recorded in PR)

## Spec
- [x] `project` delta: ADD TestSuiteHasNoKnownTimeBombs
