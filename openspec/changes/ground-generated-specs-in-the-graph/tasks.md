# Tasks — ground-generated-specs-in-the-graph

## Implementation

- [ ] Output contract: add the per-requirement `citedSymbols` field to the generation schema
      (`src/core/generator/schemas.ts`) and the prompt (`prompts.ts`), instructing the model to
      cite only `name::path` identifiers present in the supplied graph slice
- [ ] Route the generation parse through the schema-guarded `completeJSON` path so a missing or
      malformed citation field degrades to `uncited` instead of crashing or fabricating
- [ ] Emit the provenance line (`> Grounded in: <name::path>, …`) under each generated
      requirement in `openspec-format-generator.ts`; stable symbol ordering for byte-determinism
- [ ] `openspec-writer.ts`: preserve provenance lines through replace and merge; never add one to
      a hand-written requirement
- [ ] Extend `parseSpecRequirements` (`verification-engine.ts:797-813`) to recover the citation
      alongside `{ name, description }`
- [ ] New `src/core/verifier/spec-grounding.ts`: resolve citations against the graph → verdict
      per requirement (`grounded` · `partially-grounded` · `ungrounded` · `uncited`), naming
      unresolved citations; no LLM, no network, read-only
- [ ] Route citation resolution through the shipped symbol-identity continuity carry-forward, and
      disclose `carriedAcross` when a citation resolved via a rename/move
- [ ] `verification-engine.ts`: report the grounding verdict beside the LLM-judged scores; label
      every LLM-judged field; never blend them into `overallScore`
- [ ] Produce the full grounding report when no provider is configured, stating that LLM-judged
      scores were not computed
- [ ] Surface grounding in `check_spec_drift`, `openlore drift`, and the corpus-lint check; make
      a vanished citation a precise per-requirement drift signal
- [ ] Register `spec-requirement-ungrounded` in `FINDING_CODE_REGISTRY` (severity `warning`,
      advisory by default) and wire it through `openlore enforce`

## Verification

- [ ] Generation test: a requirement over a known slice emits a provenance line with the expected
      `name::path` symbols, byte-identical across two runs
- [ ] Degradation test: a response omitting the citation field yields an `uncited` requirement, a
      completed run, and a reported omission — never a fabricated citation
- [ ] Writer tests: merge preserves provenance lines; hand-written requirements gain none;
      corpus-lint accepts the line
- [ ] Grounding tests, one per verdict, including the explicit guard that `uncited` is never
      counted as `ungrounded` and that the reported denominator is the full requirement set
- [ ] Rename test: a cited symbol renamed between analyses stays `grounded` with a disclosed
      carry-forward
- [ ] No-key test: full grounding report produced with no provider configured; LLM-judged fields
      stated as not computed, not zeroed
- [ ] Separation test: no rendered field blends an LLM-judged score with a deterministic one
- [ ] Honesty test: a requirement citing live symbols but describing them wrongly is `grounded`,
      and the rendered output states grounding ≠ correctness
- [ ] Finding-registry test covers the new code; `openlore enforce` blocks only when the policy
      classes it blocking
- [ ] Dogfood: run the grounding check over this repository's own corpus and record the verdict
      distribution in the change's README notes
- [ ] Full suite green; docs updated (`drift-detection.md`, `pipeline.md`, `cli-reference.md`)
