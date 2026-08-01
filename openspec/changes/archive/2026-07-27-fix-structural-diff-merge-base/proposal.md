# structural_diff must read old content at the merge-base, not the base ref's tip

> Status: SHIPPED (2026-07-19, PR fix-structural-diff-merge-base). Both paths now read old content
> at the merge-base of the base ref and the new state (working-tree path: `merge-base(base, HEAD)`;
> two-ref path: three-dot file list + `merge-base(base, headRef)`), ported from the impact
> certificate's `oldContentRef` helper. `safeBuild` now discloses a snapshot build failure as a
> soundness caveat instead of silently comparing an empty graph. Regression tests
> (`structural-diff-mergebase.test.ts`) pin the advanced-base, footprint-escape, two-ref, no-drift,
> and parse-crash scenarios; verified to fail against the pre-fix code. Originally proposed
> (2026-07-08, e2e audit fifth pass): `structural_diff`'s changed-file list is merge-base-scoped
> (three-dot), but its OLD snapshots were read at the base ref's TIP — on any PR whose base advanced
> past the branch point, main-side drift was misattributed to the change. The repo already ships the
> fix three times over (`oldContentRef` in the impact certificate); port it.

## The defect(s)

1. **Merge-base file list, tip-content snapshots.** The working-tree path builds its changed-file
   list via `getChangedFiles` (`src/core/services/mcp-handlers/structural-diff.ts:119`), which
   diffs three-dot — `` `${resolvedBase}...HEAD` `` (`src/core/drift/git-diff.ts:390`), i.e.
   merge-base semantics. But old content is read at the resolved ref's TIP:
   `structural-diff.ts:167` is `await fileAtRef(absDir, resolvedBase, oldSrcPath)`, and
   `fileAtRef` (`:73-82`) is `git show ${ref}:${path}` with `ref = resolvedBase` — zero
   `merge-base` hits anywhere in the file (verified). On any open PR whose base has advanced past
   the branch point, a file changed on BOTH sides yields an old snapshot containing main-side
   edits: a teammate's new function on main is reported REMOVED (with stale callers computed
   against it); their signature change is reported as YOURS. The explicit `headRef` path has the
   same defect from the other side — `:107` diffs two-dot (`` `${resolvedBase}..${input.headRef}` ``),
   so main-side-only files enter the delta outright.
2. **The footprint-escape extension inherits it.** `computeModifiedSymbols`
   (`structural-diff.ts:420`) slices the SAME old/new snapshots to derive the realized
   write-footprint — main-side drift becomes false `out-of-scope-write` / `removed` escapes and
   false footprint-escape findings, which an operator's `enforcement.policy` can be configured to
   BLOCK on. A misattributed delta is advisory noise; a misattributed escape is a blocked commit.
3. **The bundled review Action publishes the wrong delta.** `openlore review`
   (`src/cli/commands/review.ts:100`) drives `handleStructuralDiff` directly, and the GitHub
   Action posts the result as the sticky PR comment — the primary human-facing surface of this
   tool carries the misattribution.
4. **Folded minor — a parse crash becomes an authoritative empty delta.** `safeBuild`
   (`structural-diff.ts:488-495`) is `catch { return emptyGraph(); }`: a snapshot whose build
   crashes silently compares as zero functions, so every symbol in it reads as added or removed
   with no caveat. Extends `add-parse-health-boundary-disclosure` by naming this site — the delta
   must carry a disclosed parse-failure boundary, never a clean-looking empty graph.
5. **Note (not fixed here):** `structural_diff` resolves the base via `resolveBaseRef` (`:100`)
   without disclosing a fallback when the requested ref did not resolve — the same class
   `fix-cli-conclusion-honesty` fixes for its siblings; that change owns the discipline.

The discipline already exists in-repo. `impact-certificate.ts:262-279` documents and fixes the
identical hazard with its `oldContentRef()` helper — "`getChangedFiles` diffs against the
MERGE-BASE (three-dot `base...HEAD`), so the differential has to read old content from that same
point — not the base ref's TIP". `public-surface.ts:210-219` carries the same `mergeBase()`
helper ("so old content is read from the branch point"). `interference-map.ts:571` diffs
`` `${mergeBase}..${branch}` `` for every branch it assesses. `structural_diff` — the oldest and
most-composed differential — is the one left behind.

## What changes

- **Port `oldContentRef` into `structural_diff`.** The working-tree path reads old content at
  `merge-base(resolvedBase, HEAD)` (falling back to the ref tip when no common ancestor exists,
  mirroring `getChangedFiles`' own three-dot → two-dot fallback). The explicit two-ref path
  (`:107`) computes `merge-base(resolvedBase, headRef)`, uses three-dot semantics for the file
  list, and reads old content at that merge-base. `computeModifiedSymbols` and the escape block
  consume the corrected snapshots for free — no signature change.
- **Disclose a snapshot build failure.** `safeBuild` reports which side crashed; the response
  carries a `soundness` caveat naming the failed snapshot instead of comparing against a silent
  `emptyGraph()` (the `add-parse-health-boundary-disclosure` posture, applied at this site).
- **Regression tests** pin the scenario that motivates the fix: base advanced past the branch
  point, a file changed on both sides → the delta contains ONLY branch-side changes; a
  main-side-added function is neither "removed" nor an escape.

## Why this is in scope

Deterministic, local, git-native precision work on an existing conclusion tool — decision
`c6d1ad07`'s substrate thesis is that structural answers are grounded, and a delta that blends a
teammate's commits into "your change" is ungrounded at the root. The honest-boundaries doctrine
makes it worse today: the tool speaks confidently (`soundness`, escape classifications, governance
findings) over a snapshot mismatch its own siblings document as a known hazard. And because
footprint-escape findings feed `enforcement.policy`, the blocking-is-opt-in promise currently
rests on wrong evidence. No new capability, no new constant — the fix is literally a helper the
repo already maintains in two other files.

## Impact

- Files: `src/core/services/mcp-handlers/structural-diff.ts` (old-content ref resolution for both
  paths, `safeBuild` disclosure); tests alongside. Consumers fixed for free: the footprint-escape
  block, `openlore review` / the GitHub Action, `blast_radius` compositions.
- Specs: `mcp-handlers` — 1 ADDED requirement (StructuralDiffReadsOldContentAtTheMergeBase).
- Tool surface: unchanged (no new tool, no payload-budget impact).
- Risk: low. Behavior changes only when base has advanced past the branch point — exactly the
  case that is wrong today; the no-drift case reads the same content from the merge-base SHA.
