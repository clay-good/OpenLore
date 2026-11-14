# Tasks: history that follows a symbol

## 1. Identity chains

- [ ] 1.1 New `src/core/provenance/identity-chains.ts`: for a set of files, walk the commits that touch them and apply `computeContinuity` from `src/core/analyzer/continuity.ts` pair-wise; return a chain per symbol with the matcher's receipt on each link. Test: new `src/core/provenance/identity-chains.test.ts`. Done when a rename fixture and a move-across-files fixture each yield one chain, and two runs give byte-identical output.
- [ ] 1.2 In `identity-chains.ts`, end the chain on an ambiguous match and memoize the result by content hash. Test: `identity-chains.test.ts`. Done when two same-name candidates end the chain with a stated break, and an unchanged range is a memo hit that reads no file outside the queried set.

## 2. Churn and coupling follow the chain

- [ ] 2.1 Aggregate churn and co-change over chains in `src/core/provenance/change-coupling.ts`, with a disclosure of each followed link. Test: `src/core/provenance/change-coupling.test.ts`. Done when churn before a rename is counted for the renamed file and a co-change group survives a move.
- [ ] 2.2 Use the chain-aware churn in `src/core/services/mcp-handlers/briefing-since.ts` and narrow the standing rename caveat to the symbols where a chain ended. Test: `briefing-since.test.ts`. Done when a renamed hub with long prior churn is no longer tiered `surprising-change` and the followed rename is named.

## 3. Symbol history

- [ ] 3.1 New `src/core/provenance/symbol-history.ts`: `git log -L` over the symbol's line span, bounded by `PROVENANCE_MAX_COMMITS`, with `parsePrNumber` from `src/core/provenance/git-provenance.ts`; continue across chain links; label commits over `COUPLING_BULK_THRESHOLD`. Test: new `src/core/provenance/symbol-history.test.ts`. Done when a fixture repo returns the introducing commit, the last non-bulk change with its PR number, and history from before a rename.
- [ ] 3.2 In `symbol-history.ts`, report "introduced no later than" for a shallow or truncated scan, a `horizon` where a chain ends, and no history for a symbol with no body span. Test: `symbol-history.test.ts`. Done when a shallow-clone fixture gives no birth date and a bodyless symbol gives a stated "not computed".

## 4. Delivery on existing answers

- [ ] 4.1 Add `history` to the functions in `src/core/services/mcp-handlers/orient.ts` (skipped in lean mode) and `src/core/services/mcp-handlers/blast-radius.ts`. Tests: `orient.test.ts`, `blast-radius.test.ts`. Done when both answers carry `introduced`, `lastChanged` and `followedRenames`, and the token budget test of `orient` still passes.
- [ ] 4.2 Classify `history.horizon` and the "no later than" form in `src/core/services/mcp-handlers/confidence-boundary.ts`. Test: `completeness-invariant.test.ts`. Done when the invariant test passes.

## 5. Parity and docs

- [ ] 5.1 Update the MCP↔Pi parity guard for the new `orient` and `blast_radius` field in `src/pi/extension.test.ts`. Done when the parity test passes.
- [ ] 5.2 Document chains, the `history` field and the limits in `docs/provenance.md` and `docs/change-coupling.md`. Done when `src/doc-claim-sync.test.ts` passes.
