# Tasks — add deprecation propagation

## Implementation (narrowed MVP, 2026-10-18)
- [x] Extraction where the walk already reads doc comments/decorators (`extractDeprecation` in
      `call-graph-extract.ts`): JSDoc `@deprecated` (past `export`/modifiers and `const x =`), Go
      `Deprecated:` paragraph, Python PEP 702 decorators. Structural conventions only
- [x] `FunctionNode.deprecation` (hint, `''` when none); persisted in `nodes.deprecation`
      (EdgeStore schema v13, bounded on read and write)
- [x] `deprecationMarkers` capability derived from `DEPRECATION_MARKER_LANGUAGES`
- [x] `deprecated-symbol-use` in `FINDING_CODE_REGISTRY`, advisory default, new edges only
- [x] `structural_diff` `deprecatedCalls` (caller, target, file:line, hint, resolution) +
      classified findings + `gated`; summary `deprecatedCallsAdded`; caveat names what is checked

## Deferred
- `blast_radius` field
- Migration-hint resolution to an indexed symbol (`unresolved` labeling, candidates)
- Java/Kotlin `@Deprecated` annotation; Python `.. deprecated::` docstring directive
- Coordination note for public-surface "newly deprecated export"

## Verification
- [x] `deprecation-markers.test.ts`: each marker detected with hint; prose, plain comments, a block
      not immediately before, `@deprecated_alias`, mid-paragraph Go not detected; registry claims
      exactly the covered set; the live extractor records a marker in every covered language
- [x] `structural-diff-deprecation.test.ts`: new call flagged (advisory); pre-existing call not;
      unmarked target not; unchanged-file target via the index by unique name, ambiguity not
      guessed; operator policy makes it blocking (`gated`); EdgeStore round-trip
- [x] tools/list payload and standing budgets re-asserted

## Spec
- [x] `analyzer` delta: ADD DeprecationMarkersAreExtractedInTheExistingWalk
- [x] `mcp-handlers` delta: ADD DeprecatedSymbolUseIsAnAdvisoryFinding
