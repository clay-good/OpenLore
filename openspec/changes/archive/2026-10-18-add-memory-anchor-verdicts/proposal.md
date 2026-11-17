# Sub-symbol anchors and a named anchor-lost work item: memories about one line stop drifting with the whole function

> Status: PROPOSED (2026-07-03, e2e audit pass 3). Two borrowings from Swimm's Auto-sync
> (https://swimm.io/blog/how-does-swimm-s-auto-sync-feature-work — deterministic multi-signal
> snippet re-anchoring with a tri-state outcome): (a) `remember` can anchor to an exact text span
> WITHIN a symbol, so a comment edit elsewhere in a large function no longer drifts a memory
> about one specific line; (b) the anchor-lost state becomes a named, machine-actionable work
> item — a registered `memory-anchor-lost` governance finding — instead of only a prose note.

## The gap

- **The finest anchor is the whole symbol.** A `remember` anchor hint is `{ symbol?, file? }`
  (`memory.ts:53-56`, tool schema `mcp.ts:2003-2012`); `resolveInputAnchors`
  (`anchor-adapter.ts:241-246`) resolves it to a symbol- or file-level `StructuralAnchor` whose
  `contentHash` covers the entire function span (`types/index.ts:675-697`, hashed via `hashSpan`,
  `anchor.ts:27`). So a memory about ONE line of a 200-line function is invalidated by ANY edit
  to the function (`anchorFreshness` compares the whole-span hash) — the false-drift rate scales
  with function size, exactly the problem Swimm's snippet-level re-anchoring solves.
- **The third state is described, never named as work.** Recall's per-anchor vocabulary is
  `fresh`/`drifted`/`orphaned` plus `carriedAcross` / `possiblyMovedTo` provenance
  (`memory.ts:176`, `summarizeVerdict` `:567-593`); orphans are segregated into
  `needsReanchoring` (`memory.ts:383`) with a prose note (`:409-411`). That maps onto Swimm's
  tri-state — silently-carried / re-pointed / needs-human-reselection — but the third state has
  no stable finding code, so `openlore enforce` and CI cannot track lost anchors as a burndown
  the way `stale-decision-reference` already is (`FINDING_CODE_REGISTRY`,
  `enforcement-policy.ts:81,111`).

## What changes

- **(a) Sub-symbol span anchors.** An anchor hint gains an optional `span`: an exact text snippet
  within the anchored symbol. The stored anchor keeps the symbol identity fields and adds a
  span-level `contentHash` baseline. Freshness re-locates the span by exact-text match within the
  symbol's current body: a unique match (same or new offset) is `fresh`; no match is `drifted`;
  multiple matches are ambiguous → the anchor orphans with candidate locations, the existing
  `possiblyMovedTo` discipline (`types/index.ts:706-714`) — never a silent re-attach to a guess.
  Continuity carry-forward (`continuity-carry-forward.ts`) extends naturally: after a
  rename/move re-points the symbol, the span re-locates inside the new body by the same
  exact-text rule. No similarity score, no threshold — the continuity module's own discipline
  (`continuity.ts:29-35`).
- **(b) The tri-state verdict, formalized and enforceable.** Recall's anchor verdicts gain an
  additive `outcome` label mapping existing states — `silently-carried` (byte-identical or
  exact-relocated span), `re-pointed-with-provenance` (the shipped `carriedAcross`),
  `needs-human-reselection` (orphaned, including ambiguous span/move) — with no change to
  authoritative filtering (orphans stay withheld, `memory.ts:382`). A new
  **`memory-anchor-lost`** finding code is registered in `FINDING_CODE_REGISTRY`
  (`enforcement-policy.ts:81`), advisory default, emitted in the unified `GovernanceFinding`
  shape, one per needs-human-reselection memory — so `openlore enforce`
  (`src/cli/commands/enforce.ts`) / CI can surface unreconciled anchors as a burndown, and an
  operator can opt into blocking via `enforcement.policy`. Swimm's "reselect the snippet" task,
  made native.
- **Honest limits, disclosed:** continuity matches between ADJACENT indexed states
  (`continuity.ts:9-17`) — a rename that happened across multiple unindexed states cannot be
  followed and lands in `needs-human-reselection` with that reason (Swimm's own depth caveat, in
  our indexing terms). A span anchor on a symbol with no readable body is recorded symbol-level
  with disclosure, never silently span-less.

## Why this is in scope

Both halves tighten the memory face's core invariant — freshness verdicts that are honest at the
grain the fact actually lives at — using only existing machinery (exact-text matching, the
possiblyMovedTo discipline, the finding registry). No LLM, no scores, no default-surface change:
memory tools stay in the opt-in `memory` preset (`mcp.ts:2167-2169`).

## Impact

- Files: `src/core/decisions/anchor-adapter.ts` (span resolution + re-location),
  `src/core/decisions/anchor.ts` (span verdict), `src/core/decisions/continuity-carry-forward.ts`
  (span re-location after carry), `src/core/services/mcp-handlers/memory.ts` (+`outcome`,
  finding emission), `enforcement-policy.ts` (+`memory-anchor-lost`), `mcp.ts` (remember schema
  +`span`), `types/index.ts` (anchor field).
- Specs: `mcp-handlers` — 2 ADDED (SubSymbolSpanAnchors, AnchorLossIsAnActionableWorkItem).
- Tool surface: no new tool; remember gains one optional schema prop (memory preset + full
  only) — the tools/list full ceiling (88,000 B, `mcp-presets.test.ts:581`) is re-measured; the
  default `substrate` prefix carries neither tool and is unchanged.
- Risk: low-medium. Store schema growth is additive (old anchors keep exact behavior); the
  exact-text rule can orphan a span the author would consider "the same" after an edit — by
  design, that fails toward distrust (the existing FreshnessFailsSafeTowardDistrust posture).
