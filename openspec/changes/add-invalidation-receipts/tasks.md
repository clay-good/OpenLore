# Tasks — add-invalidation-receipts

## 1. Receipt

- [ ] 1.1 Add the optional `invalidation` field and the closed cause set to `AnchoredMemory` in
      `src/types/index.ts`; tolerate old records in `src/core/decisions/memory-store.ts`. Test:
      `src/core/services/mcp-handlers/bitemporal-memory.test.ts`. Done when a legacy record loads
      unchanged.
- [ ] 1.2 New `src/core/decisions/invalidation-receipt.ts`: the bounded walk over the anchored
      file's commits, oldest first, with a fixed commit cap; return the commit and cause, or
      `unknown` with a reason. Test: new `invalidation-receipt.test.ts` on a temporary git
      repository. Done when deleting the symbol in commit C yields `symbol-deleted` at C, and an
      edit elsewhere in the file yields no receipt.
- [ ] 1.3 Unknown cases in the same module: shallow clone, missing `validFromCommit`, cap reached,
      uncommitted edit. Test: `invalidation-receipt.test.ts`. Done when each yields
      `commit: "unknown"` with its reason and no SHA.

## 2. Writers

- [ ] 2.1 Write the receipt once at analyze, next to the carry-forward pass in
      `src/core/decisions/continuity-carry-forward.ts`. Test: its existing test file. Done when a
      second analyze leaves the stored receipt byte-identical.
- [ ] 2.2 Write it from the watcher's staleness path in `src/core/services/mcp-watcher.ts`. Test:
      `mcp-watcher.test.ts`. Done when the watcher and analyze produce the same receipt.
- [ ] 2.3 Supersession in `src/core/services/mcp-handlers/memory.ts` also records
      `cause: superseded-by <id>`. Test: `bitemporal-memory.test.ts`. Done when today's
      `invalidatedByCommit` value is unchanged.

## 3. Readers

- [ ] 3.1 `recall` in `memory.ts` attaches the receipt to drifted and orphaned results, computes
      it for the response when none is stored, and does not write. Tests:
      `memory-anchor-verdicts.test.ts`, `bitemporal-memory.test.ts`. Done when `asOf` before C
      serves the memory and `asOf` after C reports the interval closed at C with its cause.
- [ ] 3.2 Carry the receipt in `staleTriggeredMemories`
      (`src/core/services/mcp-handlers/memory-triggers.ts`). Tests: `memory-triggers.test.ts`,
      `orient-memory-freshness.test.ts`. Done when `orient` and `blast_radius` show it.
- [ ] 3.3 Classify the `unknown` receipt in `confidence-boundary.ts`. Test:
      `completeness-invariant.test.ts`. Done when the test passes.

## 4. Guards and docs

- [ ] 4.1 MCP↔Pi parity for the new field. Test: `src/pi/extension.test.ts`. Done when it passes.
- [ ] 4.2 Document the receipt and the unknown cases in `docs/mcp-tools.md` and
      `docs/drift-detection.md`. Done when the docs show one receipt and one `unknown` example.
