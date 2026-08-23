# Tasks — certify-derived-artifact-equivalence

## Implementation
- [x] One named equivalence suite that COMPOSES the existing per-change assertions rather than
      replacing them (analyze-twice byte-diff from PR #262, the condensation-vs-live checks from
      PR #290, the parallel-pool checks from PR #268, the bundle round-trip from PR #210)
- [x] Add the missing rows: cold ≡ warm on the serving path; cached ≡ cache-disabled on every
      serving path; incremental ≡ full rebuild after edit/add/delete/rename; memo-hit ≡ memo-miss
- [x] Assertions compare SERVED ANSWERS, not internal representations, so a representational
      refactor does not fail and an answer change cannot pass
- [x] Recovery matrix: deleting or corrupting each optional accelerator yields the same semantic
      projection through fallback/rebuild; an unavailable authoritative analysis store fails closed
      with explicit remediation and converges after its repair barrier
- [x] Freshness-key audit across `src/core/analyzer/pass1-fact-cache.ts`, `condensation.ts`,
      `index-bundle.ts`, `vector-index.ts`, `spec-vector-index.ts`, and
      `src/core/services/mcp-watcher.ts`: each is content-hash keyed, or names the change shape its
      signal cannot detect and offers a full-verification path
- [x] Envelope document generated from measured runs: certified repository size, objectives for
      cold analyze / warm query / single-file publication, and the measurement matrix; every figure
      labelled measured-or-extrapolated with its reference machine
- [x] Doc-claim guard: the published envelope figures are asserted against the generated
      measurements, in the shape `doc-claim-sync.test.ts` already establishes

## Verification
- [x] Every matrix row passes; each row fails loudly when an equivalence-breaking change is
      injected deliberately (a forced worker-order dependency, a memo that ignores a byte change)
- [x] Optional delete/corrupt runs produce byte-identical semantic projections; authoritative-store
      delete/corrupt runs fail closed before repair and match fresh analysis after the repair barrier
- [x] A size- and mtime-preserving in-place rewrite is either detected by a content hash or named
      in the artifact's disclosure and caught by the full-verification path
- [x] Suite runs in CI within a stated time budget on the certified size; the larger-size runs are
      opt-in and clearly labelled
- [x] The envelope document's figures match the generated measurements; an unlabelled figure fails
      the guard
- [x] Full suite green; no existing per-change equivalence test is deleted by this composition

## Spec
- [x] `analyzer` delta: ADD DerivedArtifactsAreDisposableAndAnswerEquivalent
- [x] `architecture` delta: ADD PerformanceClaimsHoldWithinAPublishedCertifiedEnvelope
- [x] Note in the proposal trail that the five open optimization changes each add a row to this
      matrix, and that landing this contract first is what makes them cheap to review
