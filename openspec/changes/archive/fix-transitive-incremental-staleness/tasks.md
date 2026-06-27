# Tasks — Fix transitive (depth-N) staleness in incremental updates

> Status: IMPLEMENTED (2026-06-23). Substrate correctness fix; no new MCP tool, no LLM. Re-runs existing
> tree-sitter edge resolution over a correctly-chosen file set. No `record_decision` was wired in this
> session's lean MCP surface; the design (converge-or-flag strategy, the `INCREMENTAL_CLOSURE_BUDGET`
> work budget, the additive `stale_files` metadata table, and freshness mapping stale→`drifted`) is
> captured in `proposal.md` "As built" and handled at the pre-commit decisions gate.

## 1. Parity oracle first (write the failing test) — DONE
- [x] Fixture with a multi-hop `A→B→C` chain plus a file `X` whose previously-unresolved call should
      resolve to a symbol newly added in the changed file. → `mcp-watcher-parity.test.ts` (Scenario 2 =
      the newly-resolvable case; Scenario 3 = direct callers past the old limit of 10).
- [x] Property test: after an incremental update, the graph over the affected region equals the
      `analyze --force` graph for that region. Built from a from-scratch `CallGraphBuilder.build` oracle;
      the tests FAILED against the pre-fix depth-1 behavior (confirmed before the fix).

## 2. Change-driven reverse-dependency closure — DONE
- [x] Compute the dirty set from the batch's actually-changed symbols/edges (diff new vs old node names
      of the changed file in `mcp-watcher.handleBatch`).
- [x] Walk the reverse-dependency closure via `EdgeStore.getCallerFiles` (direct callers) PLUS
      `EdgeStore.getExternalConsumerFiles` and `EdgeStore.getNameOnlyConsumerFiles` (prior non-callers
      an added symbol now binds or whose ambiguous `name_only` winner it flips); replace the fixed
      `CALLER_REPARSE_LIMIT` with `this.closureBudget`. Consumer discovery runs even when the budget is
      full (overflow → stale), so it is never silently skipped. One expansion is provably sufficient
      (the added/removed symbol set is fixed by the batch), so no iteration loop is required. Tiebreak
      determinism: `FunctionRegistryTrie.findBySimpleName` sorts candidates by symbol id so incremental
      and full builds pick the same duplicate-name target.
- [x] Apply edge replacement (`deleteEdgesForFile` / `deleteOutgoingEdgesForFile` / `insertEdges`)
      across the whole recomputed closure, not just depth-1.
- [x] Handle the newly-introduced-symbol case — re-resolve previously-`external` call sites that could
      now bind a new symbol, re-parsed alongside the changed file so they resolve internally. Fixed a
      latent seed bug in `CallGraphBuilder.build` (stale subset nodes no longer leak into resolution).
- [x] Test: §1 parity passes for both the `A→B→C` and the `X`-resolves-new-symbol cases.

## 3. Bounded budget + explicit stale region — DONE
- [x] `INCREMENTAL_CLOSURE_BUDGET` (constant, default 40; overridable per-watcher via `closureBudget`)
      caps per-batch closure work.
- [x] On budget exceed, mark the un-recomputed region `stale` in graph metadata (new additive
      `stale_files` table; sound over-approximation — mark more, never under-report).
- [x] Test: a hub change exceeding the budget marks its region `stale` and serves no part of it as
      current.

## 4. Freshness honors the stale region — DONE
- [x] `anchorFreshness` (`anchor.ts`) + `makeFreshnessView` (`anchor-adapter.ts`) treat a symbol whose
      file is in the marked-stale region as non-authoritative: an otherwise-`fresh` symbol is downgraded
      to `drifted` with an `AnchorVerdict.staleRegion` marker.
- [x] Test: a memory/anchor over an unchanged symbol in a stale region is not reported `fresh`.
- [~] Conclusion-shaped tools that read the graph honor the stale flag: surfaced via the freshness-
      verdict path that `recall`/`orient` already use. Threading stale-region awareness into
      blast-radius/impact conclusions is deferred (documented, not silently dropped).

## 5. Self-healing tail — DONE
- [x] Stale regions reconcile opportunistically as later edits touch them (a recomputed file's mark
      clears in the same atomic swap); no manual `analyze --force` required for the touched parts.
- [x] `analyze --force` clears all stale markings (`clearAll` now wipes `stale_files`) — ground truth.
- [x] Test: a stale region shrinks after subsequent edits; a full analyze clears it. Dogfooded on the
      real compiled CLI + SQLite db.

## 6. Docs — DONE
- [x] Updated the README incremental-watch description and the "depth-1 only" caveat to describe the
      converge-or-flag behavior, the budget, and the explicit stale flag.
