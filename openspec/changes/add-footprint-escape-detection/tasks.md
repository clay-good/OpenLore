# Tasks — Footprint escape detection

## 1. Optional declared-footprint input
- [x] Extend `structural_diff` input with an optional `declaredFootprint` (proposal-1 shape) and an
      optional `peerFootprints` list. Absent → behavior unchanged (additive, dormant).

## 2. Escape set
- [x] Compute the actual footprint of the diff (reuse existing `structural_diff` machinery).
- [x] escape-set = actual modified symbols/files ∉ declared write-set.
- [x] Classify each escape: out-of-scope write | read-set intrusion | scope-creep-within-file.

## 3. Newly-opened conflicts
- [x] For each escaped symbol, intersect with supplied `peerFootprints` write-sets → newly-opened WAW;
      name the conflicting peer task id(s). Mirror the `change_impact_certificate` "newly opened"
      differential.

## 3b. Registry-collision resolution (back-side of shared-append)
- [x] When two diffs touch the same registration symbol, inspect the actual edits: disjoint additions
      (new branches/elements, non-overlapping) → report `resolved-by-merge`, not a conflict.
- [x] An edit that modifies an existing member, or two genuinely overlapping additions → real WAW.
- [x] Flag the case where a seed was declared `append` at plan time but the diff actually modified
      existing code (a mis-declared append).

## 4. Statelessness, gating, honesty
- [x] No stored roster; declared + peer footprints are per-call inputs.
- [x] Surface the "diff escaped declared footprint" / "escape created new WAW" findings via
      `enforcement.policy`; advisory by default.
- [x] Attach the disclosure: structural escapes only; semantic conflicts can still slip through.

## 5. Tests
- [x] In-scope diff → empty escape set.
- [x] Out-of-scope write → flagged out-of-scope.
- [x] Modifying a read-set-only symbol → read-set intrusion.
- [x] Out-of-scope write hitting a peer write-set → newly-opened WAW naming the peer.
- [x] Two disjoint additions to the same registry symbol → resolved-by-merge, not a conflict.
- [x] A modification of an existing registry member (declared `append`) → real WAW + mis-declared-append flag.
- [x] No `declaredFootprint` → `structural_diff` output byte-identical to today.
- [x] Determinism.

## 6. Verify
- [x] `npm run lint`, `npm run typecheck`, `npm run test:run`, `npm run build` green.
- [x] No new MCP tool; `tool-contract.test.ts` unaffected.

## 7. Docs
- [x] Document the declared-vs-actual escape check, the escape classes, newly-opened-conflict
      reporting, advisory/opt-in gating, the stateless input contract, and the
      structural-only-not-semantic disclosure. Cross-link `plan_parallel_work` re-plan on escape.
