# Tasks: Kotlin reference corpus conformance

## Implementation
- [x] Reference project fixture with the shapes listed in the proposal. It follows the existing
      fixture convention (`fixtures/kotlin/App.kt`): the repository has no checked-in analysis
      exclusion list, so no exclusion was added
- [x] Expectations ledger (typed data) with `asserted` and `known-gap` states; each gap names its
      change
- [x] Conformance test: analyze the fixture once; check every ledger entry; fail on a gap that
      holds
- [x] Kotlin capability-target test over the language-support registry
- [x] Seed the ledger from the defects recorded in `KOTLIN-TOTAL-SUPPORT-2026-10.md`, including the
      four wrong edges as `known-gap` absences
- [x] Add four pinned Kotlin repositories to the live-data harness
- [x] Generate the Kotlin section of `docs/language-support.md` from the ledger; add to the
      doc-claim sync guard

## Conformance
- [x] The conformance test runs in the default lane (plain `.test.ts`, not integration)
- [x] Meta-test: a ledger entry with an unknown state or an unknown change name fails
- [x] Analysis of the fixture stays inside the deterministic work budget

## Verification
- [x] Ledger at landing matches the behavior of the current build exactly
- [x] Full suite green

## Spec
- [x] `analyzer` delta: ADD KotlinSupportIsProvenByAReferenceProjectLedger
