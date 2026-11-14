# Comment and format edits stop marking the index stale

> Priority: P2 · Not built
> Reaches the agent through: the after-edit moment (the index is current sooner, with no false stale flags), and the freshness note on `orient`, `recall`, and `blast_radius`
> Why it helps the agent: after an edit that changed no structure, answers stay fresh and the agent is not told to re-orient for nothing.

## Problem

The watcher (`McpWatcher.handleBatch` in `src/core/services/mcp-watcher.ts`) skips a changed file
only when its bytes are identical. Any real byte change, even one comment, runs the full
reverse-dependency closure: caller files are parsed again, and files past the work budget
(`spendClosureBudget` in `src/core/analyzer/incremental-closure.ts`) are marked stale. A large
formatting commit can spend the whole budget and leave files flagged stale for no reason.

The freshness lease (`src/core/services/mcp-handlers/epistemic-lease.ts`) sets
`repoMovedSinceOrient` on every HEAD move and moves `fresh` to `degraded`. A comment-only commit
degrades the agent's freshness signal exactly like a refactor does.

## What changes

- **A per-file fact digest.** After a changed file is parsed again, hash the facts that other files
  consume, with byte positions left out: symbol names and class membership, signatures, async
  flag, docstring, call edges (caller, callee name, call type), control-flow shape, and imports.
  New module `src/core/analyzer/fact-digest.ts`.
- **Cutoff.** If the digest equals the stored digest, update only that file's own records (spans,
  line numbers, control-flow rows, content hash) and stop: no caller closure, no rebinding
  discovery, no stale flags. If the digest differs, today's path runs unchanged. The byte-identical
  skip stays as the first, cheaper gate.
- **Stored with a version stamp.** The digest and an algorithm version live in the edge store
  (`src/core/services/edge-store.ts`). A version mismatch discards every stored digest; digests of
  different versions are never compared.
- **The lease tells the two kinds of movement apart.** When HEAD moved but every changed file cut
  off, the note says "repo moved; extracted structure unchanged" and the state is not moved from
  `fresh` to `degraded`. The fact that HEAD moved is always stated.
- **One implementation.** The `openlore analyze` incremental path uses the same digest.

## What does not change

- No new tool, command, config key, or tuning constant. `repoMovedSinceOrient` keeps its name and
  still becomes true on every HEAD move.
- Anchored memory is untouched: `hashSpan` in `src/core/decisions/anchor.ts` is not normalized, so
  a comment inside an anchored function still marks that memory as drifted.
- A structural edit (signature, symbol, call, import) behaves exactly as today.
- Local, deterministic, no LLM. No spec framework is involved.

## Limits we disclose

- The digest is only as complete as its fact list. A fact some dependent reads but the digest omits
  would leave that dependent stale without a flag. The guard: for comment, format, signature, and
  body edits, the graph after cutoff must equal the graph from `analyze --force`.
- A body edit that adds or removes a call or changes control flow does not cut off.
- Cutoff decides only whether to propagate. It never recomputes part of a dependent.
- The saving is unmeasured until task 4.2 reports it on a real formatting commit.

## Depends on

Nothing. It builds on the shipped watcher closure, edge store, and freshness lease.
