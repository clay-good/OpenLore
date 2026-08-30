# Incremental bundle catch-up: apply a stale ancestor bundle, then re-analyze only the delta

> Status: PROPOSED (2026-07-03, e2e audit). Builds the optimization the bundle importer itself
> defers: a `.olbundle` built at an ancestor commit currently triggers a full local rebuild;
> instead, apply it and incrementally re-analyze exactly the files changed since its commit, using
> the watcher's existing converge-or-flag machinery. Local, deterministic, integrity story
> unchanged.

## The gap

`openlore import` validates a bundle through a five-step ladder and treats currency as
all-or-nothing (`src/cli/commands/import.ts:1-17`): commit == HEAD imports as-is; a bundle built at
an **ancestor** commit rebuilds from scratch — the header names the gap explicitly: "stale
(ancestor) / diverged → full local rebuild (**incremental-delta is a deferred optimization**)"
(`import.ts:14`; decision logic in `currencyDecision`, `import.ts:84`, ancestor → `rebuild` with
reason `stale`). For the artifact's primary use — CI publishing a bundle that teammates/agents
import minutes-to-hours later — the ancestor case is the *common* case, and the full rebuild
forfeits nearly all of the bundle's value: a repo 3 commits ahead re-analyzes thousands of files to
catch up on a handful.

The machinery to do better already exists and is disciplined: the watcher's incremental update
performs change-driven re-analysis with a reverse-dependency closure, converging with
`analyze --force` or marking the remainder explicitly stale when over budget
(fix-transitive-incremental-staleness; `src/core/services/mcp-watcher.ts:479-556` — direct-caller
closure, added-symbol rebinding discovery, budget-bounded with explicit stale flags).

## What changes

**The ancestor path becomes: apply, then catch up.**

1. **Integrity unchanged, first:** the existing validation ladder runs untouched — format version,
   payload byte-integrity, schema version, graph-digest attestation (`import.ts:6-12`). Only a
   bundle that passes everything AND whose commit is a verified ancestor of HEAD takes the new
   path; any validation failure still degrades to full rebuild.
2. **Exact delta set:** the catch-up file set is `git diff --name-only <bundleCommit>..HEAD`
   intersected with the indexed set (the analyzer's include/exclude rules), plus working-tree
   modifications against HEAD — never a heuristic. Deleted files are removed from the imported
   index; added files enter the re-analyze set.
3. **Same converge-or-flag discipline:** the delta is re-analyzed through the same code path the
   watcher uses — reverse-dependency closure over the imported graph, added-symbol rebinding,
   bounded by the same work budget; when the closure exceeds budget, the remainder is marked
   **explicitly stale** exactly as the watcher does, never silently served as fresh. The imported
   graph is therefore either converged-with-`analyze --force` or honestly flagged — the same
   invariant the watcher already guarantees.
4. **Diverged bundles unchanged:** a non-ancestor commit still full-rebuilds, with the existing
   disclosed reason (`unrelated-commit`) — reconciling a diverged graph incrementally would
   require merging two histories, which is out of scope and stated so.
5. **Disclosure:** the import report states the path taken (fresh / delta / rebuild), the delta
   file count, the closure size, and any explicit-stale remainder — so "imported + caught up"
   is never conflated with "verified current at HEAD".

No new store, no new constants: the work budget, closure logic, and staleness flags are the
watcher's; the ancestor check is `currencyDecision`'s existing fact.

## Why this is in scope

This is the named deferred optimization of a shipped capability, built entirely from two existing
disciplines (the bundle validation ladder + the watcher's converge-or-flag incremental update). It
serves the north star's local-first economics — the expensive full parse happens once (in CI),
consumers pay only for their divergence — while preserving the honesty contract: every shortcut is
either converged or explicitly flagged, and the disclosure names which.

## Impact

- `src/cli/commands/import.ts` (ancestor branch: apply + catch-up instead of rebuild),
  reuse/factor the watcher's closure path (`mcp-watcher.ts`) so import and watcher share one
  implementation (no duplicated closure logic); export side (`src/cli/export/bundle.ts`)
  unchanged.
- Specs: `analyzer` — 1 ADDED requirement (IncrementalBundleCatchUp).
- Risk: correctness of catch-up vs. full rebuild (mitigated: an equivalence test asserts
  delta-import converges to the same graph as `analyze --force` at HEAD for in-budget deltas —
  the watcher's own convergence oracle); large deltas degenerating (mitigated: over-budget
  closure falls back to the explicit-stale flags, and a delta larger than a documented fraction
  of the indexed set may simply choose the existing full rebuild, disclosed).
