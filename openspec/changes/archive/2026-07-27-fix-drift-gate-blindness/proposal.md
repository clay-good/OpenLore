# Fix drift-gate blindness: uncommitted work always counts +0/-0, and ADR updates never suppress adr-gap

> Status: SHIPPED (2026-07-19, PR fix-drift-gate-blindness). Both holes closed: (a) `getChangedFiles`
> now gathers `git diff --cached --numstat` and `git diff --numstat` and merges them per path (summed)
> into the range numstat when `includeUnstaged` is set, so staged/working-tree changes carry real line
> counts into `computeSeverity` and messages — no more forced +0/-0 → info; (b) a single exported
> `normalizeADRId` helper is applied to both the extracted changed-ADR ids and the map-key comparison
> in `detectADRGaps`, so "ADR-23"/"ADR-023"/"ADR-0023" resolve equal and updating a zero-padded ADR
> suppresses its `adr-gap`. Both fixes live-dogfooded on this repo (a real working-tree change reported
> `+46/-0` at `warning`; touching zero-padded ADR-0003 suppressed only its gap). Full suite green.
>
> Original defect summary (as PROPOSED, 2026-07-08, e2e audit fifth pass): two live-reproduced
> correctness holes that made the drift gate blind exactly when it matters — line counts for
> staged/uncommitted changes were always zero (so gap severity could never reach the hook's own
> threshold), and the ADR-updated suppression compared two id formats that never matched.

## The defects

- **(a) Staged/uncommitted changes always get additions:0/deletions:0 — live-reproduced.**
  `getChangedFiles` merges staged (`git diff --cached --name-status`,
  `src/core/drift/git-diff.ts:414-428`) and working-tree (`:430-448`) files into the changeset
  when `includeUnstaged: true` — which both callers pass (`src/cli/commands/drift.ts:463`,
  `src/core/services/mcp-handlers/analysis.ts:356`). But line stats come ONLY from the commit
  range: `git diff --numstat ${resolvedBase}...HEAD` (`git-diff.ts:451-457`, two-dot fallback
  `:460-465`) — no `--cached` and no working-tree numstat. Every uncommitted file then falls
  through `git-diff.ts:476`:
  `const stats = numstatMap.get(path) ?? { additions: 0, deletions: 0 };`.
  Gap severity is a pure function of those zeros (`src/core/drift/drift-detector.ts:130-137`:
  `totalChanges > 30` + high-value → `error`, `> 5` → `warning`, else `info`) — so uncommitted
  work is ALWAYS `info`. The installed pre-commit hook runs
  `openlore drift --fail-on warning` (`drift.ts:134`), and info < warning: **the drift hook
  structurally cannot block on the very changes being committed.** It also prints visibly false
  output — "changed (+0/-0 lines) but spec ... was not updated" (`drift-detector.ts:206`).
  Live repro: a 40-line staged change → severity `info`.
- **(b) ADR changed-file suppression never fires.** `extractChangedADRIds` strips leading zeros
  (`drift-detector.ts:350`: `` ids.add(`ADR-${match[1].replace(/^0+/, '') || '0'}`) `` →
  "ADR-23"), while `parseADRHeader` captures the id verbatim from the title
  (`src/core/drift/spec-mapper.ts:369-373`, regex `/^#\s+(ADR-\d+):\s*(.+)/m` → "ADR-0023"),
  which is what `buildADRMap.byId` keys on. The syncer writes zero-padded names
  (`src/core/decisions/syncer.ts:241` `padStart(4, '0')`, `:247` `# ADR-${num}:`) — all 23 ADRs
  in this repo are zero-padded. So `drift-detector.ts:382`
  `if (changedADRIds.has(id)) continue;` compares "ADR-0023" against a set of "ADR-23" and
  never matches: updating an ADR alongside governed code still reports `adr-gap`. Unit tests
  mask it by testing the halves in incompatible formats — `drift-detector.test.ts:1134` expects
  `'ADR-1'` from extraction, while `:1177` hand-feeds `new Set(['ADR-001'])` to the detector.

## What changes

1. **Numstat covers what the file list covers.** When `includeUnstaged` is set, gather
   `git diff --cached --numstat` and `git diff --numstat` alongside the range numstat and merge
   per path (summed), so staged and working-tree changes carry their real line counts into
   severity and messages. Deterministic git plumbing only; no new tuning constants — the
   existing `computeSeverity` thresholds finally see real inputs.
2. **One ADR id normalization, applied on both sides.** A single `normalizeADRId` helper used by
   both `extractChangedADRIds` and the `byId` comparison (or the map key), so "ADR-23",
   "ADR-023", and "ADR-0023" resolve identically. Tests updated to drive both halves through the
   SAME format, including a zero-padded end-to-end case.
3. The false "+0/-0" message text fixes itself via (1); a regression test pins that a staged-only
   change reports non-zero counts.

**Coordination note for `fix-commit-gate-delivery`:** the drift hook installer
(`drift.ts:173-207`) hard-codes `.git/hooks/pre-commit` too — a THIRD hooksPath-ignoring
installer that change's "both installers" wording (enforce.ts + decisions.ts) does not name. Not
fixed here; flagged so its `git rev-parse --git-path hooks` fix extends to drift.ts as well.

Verified NOT covered by filed changes: `fix-git-path-quoting` addresses path encoding only;
`fix-commit-gate-delivery` addresses hook delivery (hooksPath), not what the gate measures.

## Why this is in scope

The drift gate is deterministic, local plumbing — exactly the substrate thesis (decision
`c6d1ad07`). Both defects are honesty failures of the worst class: a protection that reports
itself present while being blind. (a) makes the gate print a number it knows is wrong (+0/-0)
and a severity that can never cross its own threshold; (b) silently punishes the user who did
the right thing (updated the ADR). Fixing them changes measurement, not policy — blocking stays
opt-in via `--fail-on`, unchanged.

## Impact

- Files: `src/core/drift/git-diff.ts` (staged/working-tree numstat + merge),
  `src/core/drift/drift-detector.ts` (ADR id normalization at `:350`/`:382`),
  `src/core/drift/spec-mapper.ts` (normalize at parse or key time — one canonical form),
  `git-diff.test.ts` + `drift-detector.test.ts` (format-parity tests replacing the masking ones).
- Specs: `drift` — 2 ADDED requirements (UncommittedChangesCarryRealLineCounts,
  ADRIdentityIsNormalizedAcrossDriftDetection).
- Risks: severity distribution shifts upward for uncommitted work — intended; repos gating at
  `--fail-on warning` may newly block on real drift (that is the gate working, and
  `--no-verify` remains). ADR suppression newly firing REMOVES false positives. A file staged
  and also modified in the working tree gets summed counts (slight over-count) — acceptable for
  threshold purposes and disclosed in the merge helper's doc.
