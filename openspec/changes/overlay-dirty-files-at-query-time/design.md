# Design

## Context

See `proposal.md` — Why. Two existing mechanisms make this cheap:

- `src/core/services/mcp-handlers/freshness.ts` already computes the stale set per query
  (`staleFiles`, `repairableStaleFiles`) with bounded concurrent IO, and already knows how to
  schedule a repair.
- `src/core/analyzer/pass1-fact-cache.ts` memoizes Pass-1 extraction by
  `(file path, sha256(language + content), extractor stamp)`, justified by Pass 1 being a pure
  function of `(language, content)`. Re-extracting a dirty file is therefore idempotent and, after
  the first query, free.

The gap is only that the stale set feeds a message instead of feeding an extraction.

## Goals / Non-Goals

**Goals:**

- Answer from the working tree for the files the user is actually editing, at bounded cost.
- Keep the fallback identical to today's behavior, so the change can only improve an answer or leave
  it unchanged.

**Non-Goals:**

- No graph re-linking. Incoming call edges from unchanged files are not recomputed — that is a
  whole-graph operation and belongs to the watcher's incremental update.
- No index write. The overlay is per-query and read-only; persistence stays the watcher's job.
- No behavior change when the index is fresh: the overlay path is not entered at all.

## Decisions

**1. The overlay is symbol-level, never edge-level.**
Re-extracting a file gives its symbols, signatures, spans and imports soundly. Resolving *callers*
means re-resolving every other file that might name those symbols, which is the analysis the watcher
exists to do. Overlaying symbols while leaving edges indexed is a coherent, explainable contract:
"what is in this file, now" is current; "who calls into it" is as of the index. The spec makes that
limit disclosed rather than implicit.
*Alternative considered:* overlay edges out of the dirty file too (its own call sites). Deferred:
sound for outgoing edges whose target resolution needs no other file, but the resolution path is
shared with the builder and would need its own bounding. Not required for the failure this change
addresses.

**2. Bounds are explicit constants, and exceeding them means "do what we do today".**
A file cap, a byte cap and a time budget. Exceeding any of them returns the current answer plus a
stated reason. That keeps the worst case exactly the status quo — the property that makes this safe
to turn on by default.

**3. Provenance is a label on the result, not a separate response section.**
The codebase already labels evidence per result (retrieval evidence, edge provenance); an overlay
label follows the same pattern and lets the existing completeness flag stay the single answer-level
signal.

**4. `symbol-span` is the first consumer, because it has the sharpest failure.**
It already tells the caller its offsets are untrustworthy when the file is stale — an admission that
the answer is unusable. With the overlay it becomes usable, which is a bigger win than nudging
search ranking.

**5. The overlay reconciles the ranked answer; it does not re-rank.**
The overlay runs at the handler, after ranking, and does three things to the answer: it drops rows
whose symbol no longer exists on disk (the index remembering a deleted function), it surfaces
symbols the index has never seen, and it narrows the staleness notice to what it could not cover.

Symbols it surfaces are returned AFTER the ranked rows, labelled with their provenance and carrying
NO score. Ranking them properly would mean re-scoring the BM25 corpus on the query path — the hot
path — and a fabricated score would be worse than none: a caller could not tell the ranker's
judgment from a placeholder. So the answer stays honest about which half it came from.
*Alternative considered:* contribute rows before ranking, inside `VectorIndex.search`, so working-tree
symbols compete with indexed ones. Rejected for this change: it re-tokenizes the corpus per query and
widens the regression surface of the search path for a gain (ordering of new symbols) smaller than
the one this change already delivers. It remains available as its own change.

## Risks / Trade-offs

- **Latency on a large dirty set** → capped by construction; the first query after a big edit pays
  the extraction once and the fact cache absorbs the rest.
- **A half-written file mid-save parses to something odd** → the extractor's existing failure path
  applies and the file is reported as not overlaid; the query still answers.
- **Two sources of truth for one file within one answer** → prevented by suppressing indexed rows
  for any file the overlay covered; the spec's coherent-row-set rule is the test.
- **Divergence from the watcher's own incremental update** → both read the same Pass-1 path, so a
  file overlaid at query time and later indexed by the watcher yields the same facts.

## Measured

Overlay cost on a synthetic repository (30 files, 40 functions each), macOS x64:

| Stale set | Cold | Warm (memo hit) | Outcome |
|-----------|------|-----------------|---------|
| 1 file | 118.9 ms | 0.8 ms | overlaid |
| 10 files | 26.0 ms | 3.2 ms | overlaid |
| 30 files (over the cap) | 0.1 ms | 0.0 ms | skipped — answered from the index |

The 1-file figure is dominated by first-use grammar initialization, not per-file work: ten files cost
*less* in total because the grammar is already loaded (~2.6 ms/file thereafter). The over-cap row is
the property that matters — exceeding a bound costs nothing and returns today's behavior.

## Migration Plan

Additive and default-on, with the fallback equal to current behavior. No artifact or schema change.
Rollback is disabling the overlay entry point, which returns the exact behavior that ships today.
