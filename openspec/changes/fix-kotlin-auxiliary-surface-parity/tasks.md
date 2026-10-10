# Tasks: Kotlin auxiliary surface parity

## Implementation
- [ ] Decisions gate: source-change detection from the canonical language map
- [ ] `SCANNED_SOURCE_EXTENSIONS`: add `.kt`, `.kts`
- [ ] AST chunker: Kotlin declaration-level chunks
- [ ] Code shaper: Kotlin log patterns
- [ ] Extraction worker: Kotlin grammar probe
- [ ] `getKotlinParser`: soft load with the existing unavailable-grammar receipt
- [ ] Legacy JVM import helper: match `.kt` or delete it if unused
- [ ] Tool descriptions and docs: add Kotlin to language filters; correct the JUnit claim

## Conformance
- [ ] Parity guard test with an exemption table; fails on a new Java-only list
- [ ] Fixture per row: decisions gate sees a `.kt` change; oversized `.kt` disclosed; chunk
      boundaries on declarations; log lines stripped
- [ ] Grammar-absent test: analysis completes and warns once when the Kotlin grammar cannot load

## Verification
- [ ] Guard run on the final tree: zero unexplained sites
- [ ] Full suite green

## Spec
- [ ] `analyzer` delta: ADD JvmSiblingLanguageListsStayInParity
