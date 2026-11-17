# Tasks

## 1. Fact digest

- [ ] 1.1 Add `src/core/analyzer/fact-digest.ts` (new): a deterministic hash over one file's
      position-free facts (symbols, class membership, signatures, async flag, docstring, call
      edges, control-flow shape, imports) plus a `FACT_DIGEST_VERSION` constant. Test:
      `src/core/analyzer/fact-digest.test.ts` (new). Done when a comment or re-indent edit gives
      the same digest, and a signature, call, or import edit gives a different one.
- [ ] 1.2 Store the digest and its version per file in `src/core/services/edge-store.ts`, next to
      `file_hashes`. Test: `src/core/services/edge-store.test.ts`. Done when a version mismatch
      returns no stored digest for any file.

## 2. Cutoff

- [ ] 2.1 In `McpWatcher.handleBatch` (`src/core/services/mcp-watcher.ts`), after the changed file
      alone is parsed, compare digests. Equal: write the file's own records and skip the caller
      closure, rebinding discovery, and stale marks. Different: existing path. Test:
      `src/core/services/mcp-watcher-incremental.test.ts`. Done when a comment-only edit parses
      one file, marks no file stale, and a signature edit behaves as before.
- [ ] 2.2 Own-records check in `src/core/services/mcp-watcher-incremental.test.ts`: after a
      comment block is inserted at the top of a file and the edit cuts off, each symbol's line
      range matches the current source. Done when the test passes.
- [ ] 2.3 Use the same digest in the `openlore analyze` incremental path
      (`src/core/analyzer/artifact-generator.ts`). Test:
      `src/core/analyzer/hash-keyed-analyze.test.ts`. Done when the CLI and the watcher call one
      function from `fact-digest.ts`.

## 3. Freshness lease

- [ ] 3.1 In `src/core/services/mcp-handlers/epistemic-lease.ts`, when HEAD moved and every changed
      file cut off, keep the state and add "repo moved; extracted structure unchanged" to the
      note. `repoMovedSinceOrient` still becomes true. Test:
      `src/core/services/mcp-handlers/epistemic-lease.test.ts`. Done when a comment-only commit
      leaves `fresh` as `fresh`, and a structural commit moves it to `degraded` as today.
- [ ] 3.2 Anchor check in `src/core/services/mcp-handlers/memory.test.ts`: a comment inserted
      inside an anchored function still drifts that memory after a cut-off edit. Done when the
      test passes.

## 4. Proof and docs

- [ ] 4.1 Convergence check in `src/core/services/mcp-watcher-incremental.test.ts`: for
      comment-only, format-only, signature, and body edits, the graph after the watcher update
      equals the `analyze --force` graph. Done when all four are equal and cutoff fires only on
      the first two.
- [ ] 4.2 Measure the caller files parsed for one real formatting commit in this repository, with
      and without cutoff, and record both numbers in `docs/performance-envelope.md`. Done when the
      doc states measured numbers only.
- [ ] 4.3 Run `npx vitest run src/pi/extension.test.ts` (the MCP↔Pi parity guard; the lease note
      is prose, so no tool output shape changes) and `openspec validate add-incremental-early-cutoff`.
      Done when both pass.
