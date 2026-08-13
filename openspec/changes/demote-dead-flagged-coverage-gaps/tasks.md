## 1. Reachability-aware ranking

- [x] 1.1 Add a dead-flag tier ahead of the existing label/fan-in comparators in `gaps.sort`, keeping the comparator total and deterministic.
- [x] 1.2 Tests: a dead-flagged hub ranks below a live unlabelled gap; intra-group order is byte-identical to today; ranking is stable across repeated runs.

## 2. Typed dead-flag reason

- [x] 2.1 Extend `CoverageGap` with an additive `deadReason` (`no-callers` | `dead-via-unreachable-callers`), derived from the existing dead set and the node's fan-in — no new traversal.
- [x] 2.2 Add the undecided-reachability caveat, emitted only when at least one returned gap carries `dead-via-unreachable-callers`.
- [x] 2.3 Tests: fan-in zero yields `no-callers`; fan-in above zero inside the dead set yields `dead-via-unreachable-callers`; the caveat appears only when the reason is present.

## 3. Page composition

- [x] 3.1 Report live and dead-flagged counts for the returned page and for the omitted remainder in the truncation receipt.
- [x] 3.2 Render the split in `openlore coverage-gaps` output.
- [x] 3.3 Tests: composition counts sum to the total gap set; truncation never returns a dead-flagged gap ahead of a live one.

## 4. Verification

- [x] 4.1 Run the tests reaching `handleCoverageGaps` and the CLI command.
- [x] 4.2 Re-run against a repository with dynamic dispatch and confirm the head of the ranking is live gaps.
