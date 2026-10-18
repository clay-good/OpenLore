# Tasks — add-memory-anchor-verdicts

## Implementation
- [x] `types/index.ts`: additive span fields on `StructuralAnchor` (span text baseline hash +
      recorded offsets); old anchors keep exact current behavior
- [x] `anchor-adapter.ts`: `resolveInputAnchors` (:241-246) accepts an optional `span` hint —
      exact-text located within the resolved symbol's body (`nodeSpanText`, one slicing source);
      unlocatable/ambiguous at record time → recorded symbol-level with disclosure
- [x] `anchor.ts`: span verdict in `anchorFreshness` — unique exact-text match ⇒ fresh
      (relocated ok); none ⇒ drifted; multiple ⇒ orphaned + candidate locations (the
      possiblyMovedTo discipline, types/index.ts:706-714); aggregate rule (:205-215) unchanged
- [x] `continuity-carry-forward.ts`: after a symbol carry, re-locate the span in the new body by
      the same exact-text rule; ambiguous ⇒ needs-human-reselection, never a guess
      (done at freshness time, in the carried node's body; analyze also re-baselines a span
      anchor's whole-symbol hash while its span is verified, so an edit outside the span does
      not stop the next clean rename from carrying it)
- [x] Span search runs only where the stored offsets describe the file on disk (the watcher's
      file hash or the full analyze's Pass-1 key); otherwise the whole-symbol hash decides
- [x] CRLF and LF line endings match each other in span text (notes.json is committed and
      checkouts may convert line endings); spans are stored LF
- [x] Continuity tries every baseline hash recorded for a symbol (anchors on one symbol can
      hold different bodies), pooling candidates so ambiguity still yields no pair
- [x] `memory.ts`: additive `outcome` on `summarizeVerdict` (:567-593) — silently-carried /
      re-pointed-with-provenance / needs-human-reselection — mapped from existing states; no
      change to authoritative filtering (:382)
- [x] `enforcement-policy.ts:81`: register `memory-anchor-lost` (advisory default, source
      `memory-freshness`, GovernanceFinding shape); emit one finding per
      needs-human-reselection memory; surface through `openlore enforce`
- [x] `mcp.ts:2003-2012`: remember schema gains optional `span` (memory preset + full only)

## Verification
- [x] Span survives an unrelated edit in the same function (memory stays fresh) — the false-drift
      case whole-symbol anchoring fails today
- [x] Span edited ⇒ drifted; span duplicated in the body ⇒ orphaned with candidates, never
      re-attached; symbol renamed + span intact ⇒ re-pointed-with-provenance
- [x] Multi-state gap (symbol renamed while unindexed, no continuity pair) ⇒
      needs-human-reselection with the adjacency-limit reason disclosed
- [x] `openlore enforce` lists `memory-anchor-lost` findings; advisory by default; blocking only
      via `enforcement.policy`; the registry-shape tests in enforcement-policy.test.ts cover the new code; memory-anchor-verdicts.test.ts covers its behavior
- [x] Old stores load unchanged (no span ⇒ byte-identical verdict behavior)
- [x] tools/list full ceiling re-measured (88,000 B, mcp-presets.test.ts:581); substrate default
      prefix byte-identical; full suite green

## Spec
- [x] `mcp-handlers` delta: ADD SubSymbolSpanAnchors, AnchorLossIsAnActionableWorkItem
