## Why

On an external repository (pi-outpost), `report_coverage_gaps` returned 264 gaps over 413 in-scope symbols, and the head of the ranking was dominated by `index.ts` symbols carrying `alsoFlaggedDead` — including `send`, with fan-in 26, presented simultaneously as load-bearing and as dead. The cause is known and disclosed in the caveats: the repository dispatches over a WebSocket, so the edges that reach those symbols are invisible to static analysis.

The disclosure is correct and the verdict is sound. The *ranking* is not: `alsoFlaggedDead` plays no part in `gaps.sort` (`coverage-gaps.ts:211-218`), so a symbol whose reachability the tool itself could not establish outranks a symbol whose gap is certain. An agent working the list top-down spends its budget on ghosts, and the tool's honesty ends up funding the wrong work.

A second signal is being thrown away. A symbol with zero resolved callers and a symbol with 26 resolved callers that is *still* in the dead set are two different facts: the first has no caller, the second has callers that are themselves unreachable from any entry point — the exact signature of a dispatch edge the analysis cannot see. Today both collapse into one boolean.

## What Changes

- Rank gaps flagged `alsoFlaggedDead` below every live gap, whatever their significance signals. Tiering stays deterministic and label-based: live load-bearing, then live, then dead-flagged load-bearing, then dead-flagged. No composite score, no new tuning constant.
- Split `alsoFlaggedDead` into a stable reason: `no-callers` (fan-in zero) versus `dead-via-unreachable-callers` (fan-in above zero, still unreachable from an entry point). The boolean is kept for compatibility.
- State in the result that a `dead-via-unreachable-callers` gap is the signature of an inbound edge static analysis could not resolve — a reachability the tool cannot decide, not evidence the code is unused.
- Report the composition of the returned page (live versus dead-flagged counts), so a caller can see at a glance that most of a large gap set is undecidable reachability rather than untested load-bearing code.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `mcp-handlers`: `report_coverage_gaps` gains reachability-aware ranking, a typed dead-flag reason, and page composition counts.

## Impact

- `src/core/services/mcp-handlers/coverage-gaps.ts` ranking and `CoverageGap` shape (additive fields), plus `coverage-gaps.test.ts`.
- `src/cli/commands/coverage-gaps.ts` rendering.
- Consumers reading `alsoFlaggedDead` keep working; the boolean is unchanged in meaning.
