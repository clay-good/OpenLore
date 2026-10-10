# Tasks: Kotlin reference corpus conformance

## Implementation
- [ ] Reference project fixture with the shapes listed in the proposal; excluded from the
      repository's own analysis and from clone detection
- [ ] Expectations ledger (typed data) with `asserted` and `known-gap` states; each gap names its
      change
- [ ] Conformance test: analyze the fixture once; check every ledger entry; fail on a gap that
      holds
- [ ] Kotlin capability-target test over the language-support registry
- [ ] Seed the ledger from the defects recorded in `KOTLIN-TOTAL-SUPPORT-2026-10.md`, including the
      four wrong edges as `known-gap` absences
- [ ] Add four pinned Kotlin repositories to the live-data harness
- [ ] Generate the Kotlin section of `docs/language-support.md` from the ledger; add to the
      doc-claim sync guard

## Conformance
- [ ] The conformance test runs in the default lane (plain `.test.ts`, not integration)
- [ ] Meta-test: a ledger entry with an unknown state or an unknown change name fails
- [ ] Analysis of the fixture stays inside the deterministic work budget

## Verification
- [ ] Ledger at landing matches the behavior of the current build exactly
- [ ] Full suite green

## Spec
- [ ] `analyzer` delta: ADD KotlinSupportIsProvenByAReferenceProjectLedger
