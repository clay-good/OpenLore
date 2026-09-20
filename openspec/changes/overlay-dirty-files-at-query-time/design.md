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

**5. The overlay runs before ranking, not after.**
A symbol added in a dirty file must be rankable, not appended to a ranked list. Since retrieval reads
rows, the overlay contributes rows for the stale files and suppresses the indexed rows for those same
files, keeping one coherent row set per query.

## Risks / Trade-offs

- **Latency on a large dirty set** → capped by construction; the first query after a big edit pays
  the extraction once and the fact cache absorbs the rest.
- **A half-written file mid-save parses to something odd** → the extractor's existing failure path
  applies and the file is reported as not overlaid; the query still answers.
- **Two sources of truth for one file within one answer** → prevented by suppressing indexed rows
  for any file the overlay covered; the spec's coherent-row-set rule is the test.
- **Divergence from the watcher's own incremental update** → both read the same Pass-1 path, so a
  file overlaid at query time and later indexed by the watcher yields the same facts.

## Migration Plan

Additive and default-on, with the fallback equal to current behavior. No artifact or schema change.
Rollback is disabling the overlay entry point, which returns the exact behavior that ships today.
