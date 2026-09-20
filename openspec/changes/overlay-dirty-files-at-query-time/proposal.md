# Proposal

## Why

OpenLore already knows, at query time, exactly which files the index is behind on — it computes the
stale set and discloses it (`buildStaleServingDisclosure`, `freshness.ts:414`) — and then answers
from the stale index anyway. The agent is told "results may omit recent edits" about the very files
it is editing, which is the worst case: the symbols most likely to matter are the ones just changed.
The disclosure is honest but inert; every session pays for it with a warning it cannot act on except
by stopping to re-analyze.

The facts needed to fix it are already in place. Pass-1 extraction is a pure function of
`(language, content)` and is memoized by content hash (`pass1-fact-cache.ts`), so re-extracting a
handful of dirty files at query time is bounded, cacheable work — not a re-analysis.

## What Changes

- Query-time surfaces re-extract the **stale set only** (the files already identified as behind) and
  overlay those facts on the cached graph before answering: symbols added, removed or moved in a
  dirty file are reflected in the answer.
- The overlay is bounded and fails soft: a cap on the number of files and the bytes re-extracted, a
  time budget, and — when the budget is exceeded — the current behavior (answer from the index,
  disclose the staleness) rather than a slow or failed query.
- Overlaid facts carry their own provenance: a result whose evidence came from the live overlay is
  labelled, so a caller can tell an indexed fact from a just-read one, and the existing
  completeness flag reflects what the overlay could not cover.
- The overlay is symbol- and span-level only: names, signatures, spans, and the file's own imports.
  Call edges *into* the changed symbols from unchanged files stay as the index has them, and that
  limit is disclosed rather than silently implied.
- Surfaces that report exact positions (`symbol-span`) prefer the overlay, which removes the case
  where offsets from a stale index are handed to an editing agent as untrustworthy.

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `analyzer`: the staleness facts already computed at query time gain a bounded live-overlay path,
  with fail-soft budgets and labelled provenance.
- `mcp-handlers`: the surfaces that disclose staleness SHALL serve overlaid facts for the stale set
  when the overlay succeeded, and SHALL distinguish overlaid evidence from indexed evidence.

## Impact

- `src/core/services/mcp-handlers/freshness.ts` — stale set feeds the overlay, not only the notice
- `src/core/analyzer/pass1-fact-cache.ts` — reused unchanged as the overlay's extraction path
- `src/core/services/mcp-handlers/symbol-span.ts` — prefers overlaid spans
- `src/core/services/mcp-handlers/orient.ts`, `semantic.ts` — overlaid symbols in results, provenance
  label, completeness flag
- No index write: the overlay is read-only and per-query; the watcher remains the path that persists
