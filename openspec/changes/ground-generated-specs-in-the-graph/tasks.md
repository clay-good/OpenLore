# Tasks — ground-generated-specs-in-the-graph

> Premise corrected after review: `mapping.json` (`mapping-generator.ts:38-56`) and the
> `> Implementation:` line (`openspec-format-generator.ts:827-846`) ALREADY anchor requirements
> to symbols. This change makes that anchor graph-checked; it does NOT add a second anchor.

## Implementation

- [ ] **Fix the latent parser defect first:** `emitImplementationHint` is emitted immediately
      after the heading (`openspec-format-generator.ts:455`, `:508`, `:522`), and
      `parseSpecRequirements` (`verification-engine.ts:797-813`) takes the first non-empty line
      within 4 lines as the *description* — so today every generated requirement's description IS
      the provenance line. Move the hint below the `The system SHALL …` line and make the parser
      skip `>`-prefixed lines
- [ ] Extend `parseSpecRequirements` to recover `#### Requirement:` (sub-component) headings too,
      or the denominator silently omits them
- [ ] `RequirementMapping.functions` → carry ALL cited symbols into the emitted line (today only
      the best-scoring survives, `:840-844`); canonical id form `<symbol>::<path>` where
      `<symbol>` is the id's symbol part (`Class.method`, scope-qualified for nested)
- [ ] Citation field in the schema/prompt for the **slice-bearing stage only**
      (`stages/stage3-services.ts:41-44`); template paths stay uncited-by-construction
- [ ] Record the per-requirement slice; drop out-of-slice citations at write time
- [ ] New read-only `src/core/verifier/spec-grounding.ts`: 7 verdicts (`grounded`,
      `partially-grounded`, `ungrounded`, `ambiguous`, `unresolved-boundary`, `not-assessed`,
      `uncited`); exact canonical-id resolution, no fuzzy matching
- [ ] Boundary detection: unextracted language (per the capability registry), parse-health
      lower-bound file, stale index → `not-assessed`, never `ungrounded`
- [ ] Rename handling: re-resolve at READ time against the continuity map. Do **not** extend
      `continuity-carry-forward.ts` — its contract (`:21-23`) excludes specs by construction and
      it writes stores; no snapshot / ambiguous move / no normalized hash → `unresolved-boundary`
- [ ] `verification-engine.ts`: report grounding beside the LLM-judged scores; unblend
      `overallScore` (`:874-892`, 85% LLM-judged) — **breaking change**, rename or retire it
- [ ] Register `spec-requirement-ungrounded` with `defaultClass: 'advisory'` only; severity rides
      the emitted finding and must NOT influence classing (`enforcement-policy.ts:43-44`, `:71-73`)
- [ ] Map the verdicts onto `adopt-spec-link-status-vocabulary`'s link-status vocabulary rather
      than shipping a second one; disambiguate the name from
      `add-structural-claim-verification`'s "grounding certificate"
- [ ] API parity: `src/api/verify.ts` and `src/api/generate.ts` (`:239-271` owns the
      mapping/format wiring)
- [ ] Drift surfaces: a new issue kind must render in the CLI summary, the pre-commit hook's
      embedded summary, AND `kindLabel` — all three, or it reproduces the "no issues found while
      exiting non-zero" defect
- [ ] MCP↔Pi parity: `check_spec_drift` gains a grounding section → update `src/pi/extension.ts`
      or state why parity is skipped

## Verification

- [ ] Parser regression test: a generated requirement's recovered description is its `SHALL` text
      (this test fails today — it is the latent defect)
- [ ] Sub-component requirements appear in the grounding denominator
- [ ] One test per verdict, including the explicit guards that `uncited`, `ambiguous`,
      `unresolved-boundary`, and `not-assessed` are never counted as `ungrounded` and never emit a
      finding
- [ ] Unextracted-language test: a citation into a non-extracted language → `not-assessed`
- [ ] Fresh-clone rename test: no snapshot → `unresolved-boundary`, not `ungrounded`
- [ ] Out-of-slice citation is absent from the written line
- [ ] Byte-identical provenance across two runs with the same slice and citations
- [ ] Honesty test: cited-but-wrong prose is `grounded`, and the output states grounding ≠
      correctness
- [ ] **Verify the provenance line survives the external `@fission-ai/openspec` validator** —
      a task, not an assumption (the in-repo compat checks only warn)
- [ ] Dogfood on this corpus: expect ~100% `uncited` and **zero** false `ungrounded`; record the
      distribution. Zero signal here is the expected, correct outcome
- [ ] Full suite green; docs updated (`drift-detection.md`, `pipeline.md`, `cli-reference.md`)
