# Tasks — refine-public-surface-certification (narrowed)

## Implementation
- [x] Stable rule codes on every classification: `classifySignatureChange` and the handler's
      change-kind sites (closed set of ten codes)
- [x] Register the eight breaking-classed codes in FINDING_CODE_REGISTRY (source `public-surface`,
      default `advisory`); `publicSurfaceFindings` emits one finding per breaking code per export in
      the diff verdict's `findings[]`
- [x] `suggestedBump` (breaking → major, else export-added → minor, else patch); `signature-unprovable`
      is never breaking-classed and emits no finding
- [x] Consumer disclosure states in-repo only (the false "sibling repos are also checked" sentence
      is removed)
- [x] CLI renders the bump and the rule codes

## Verification
- [x] Each signature rule code fires on its fixture; change-kind codes (removed, visibility-reduced,
      added, narrowed) on file-content fixtures
- [x] suggestedBump for breaking / additive / potentially-breaking-only diffs
- [x] Per-rule gating: a policy mapping `export-removed` to blocking leaves `param-type-narrowed`
      advisory; every breaking code is registered, no potentially-breaking code is
- [x] Full suite green

## Deferred (not in this change)
- `--accept` baseline with required justification and decision anchoring
  (AcceptedBreakageBaselineRequiresJustification)
- `breaking-consumed` / `breaking-unconsumed-in-index` split and the federation consumer union
  (ConsumerWeightedBreakingVerdicts)
- Running certify_public_surface inside `openlore enforce`

## Spec
- [x] `mcp-handlers` delta: ADD PublicSurfaceRuleCodesAndSuggestedBump
