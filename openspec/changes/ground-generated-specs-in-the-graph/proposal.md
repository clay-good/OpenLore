# Check the anchor the corpus already has: resolve requirement→symbol citations against the graph

> Status: PROPOSED (2026-07-25, known-limitations closure #3 of 6; **premise corrected
> 2026-07-25 after adversarial review** — the original draft claimed specs have "no anchor at
> all," which is false: `mapping.json` and the `> Implementation:` line already exist. The real
> gap is that the anchor is produced by *name similarity* and is **never resolved against the
> graph**, so nothing ever reports when it stops pointing at real code). This change makes the
> existing anchor checked, rather than adding a second parallel one.

## The gap

- **The authority on spec quality is a model judging a model.** `overallScore`
  (`verification-engine.ts:874-892`) is `purpose*0.50 + coverage*0.35 + imports*0.05 +
  exports*0.10` — **85% LLM-judged**, from `specAccuracyScore` / `requirementCoverageScore`
  produced by a judge prompt (`:528-533`). Deterministic sub-checks do exist
  (`analyzeImportCoverage`, `compareExports`, and the CI corpus lint), so "the only check is an
  LLM" would be too strong; the accurate and still-damning claim is that **the score presented as
  the verdict is overwhelmingly LLM-judged**, in the one place the product otherwise forbids a
  model in the guardrail path.
- **The anchor that exists is not checked, and is built by string similarity.**
  `RequirementMapping { requirement, service, domain, specFile, functions: FunctionRef[] }`
  (`mapping-generator.ts:38-56`) records requirement→function refs with a confidence tier
  (`'llm' | 'semantic' | 'heuristic'`), and `emitImplementationHint`
  (`openspec-format-generator.ts:827-846`, called at `:455`, `:508`, `:522`) writes one
  `> Implementation:` line per requirement. But the mapping is derived from `similarityScore`
  (`mapping-generator.ts:77-94`) or a model-supplied `functionName` (`prompts.ts:79`) — it is
  **never resolved against the call graph**, only the single best-scoring function survives into
  the spec (`:840-844`), and nothing anywhere reports when a hint stops resolving. The corpus
  therefore carries anchors that decay silently.
- **The hint is emitted in the wrong place, and it breaks the parser.**
  `emitImplementationHint` writes immediately after the requirement heading, *before* the
  `The system SHALL …` line. `parseSpecRequirements` (`verification-engine.ts:797-813`) takes the
  first non-empty line within 4 lines of the heading as the requirement's **description** — so
  for every generated requirement the description is currently the provenance line. This is a
  live latent defect that any grounding work must fix before it can read the corpus.
- **The field has converged on citation discipline.** Requiring artifacts to cite identifiers
  turns hallucination detection into an automated set-difference (arXiv 2606.30689); the
  RAG-traceability line (LiSSA, TVR — arXiv 2504.15427) reaches the same place. OpenLore is
  unusually well-placed because it already owns the resolver the citation must be checked
  against.

## What changes

**1. The existing anchor becomes multi-symbol and graph-resolved.** The `> Implementation:` line
is extended (not duplicated) to carry every cited symbol rather than only the best-scoring one,
written in the repository's canonical id form. **No second provenance line type is introduced** —
a reader and a parser see one anchor per requirement.

**2. The anchor moves below the normative text, and the parser learns to skip it.** The
provenance line is emitted **after** the `The system SHALL …` line, matching where the decision
syncer already puts `> Decision recorded:` (`syncer.ts:255-262`). `parseSpecRequirements` skips
`>`-prefixed provenance lines when recovering a description, and recovers requirements at **both**
`### Requirement:` and the nested `#### Requirement:` (sub-component) levels, so the grounding
denominator covers every requirement the corpus contains.

**3. Citation is required only where a slice exists.** Four of the six emission paths are pure
templates or model responses with no symbol slice — entity validations, the endpoint fallback,
the domain-overview fallback, and the overview's capability/data-flow requirements. Only service
operations receive a signature slice (`stages/stage3-services.ts:41-44`). Requirements emitted
without a slice are `uncited`-by-construction and are **distinguished in the report** from a
citation the model declined to supply.

**4. Out-of-slice citations are dropped at write time, never graded later.** The slice supplied
for a requirement is recorded, and the writer drops any cited symbol not in it *before* the line
is written — so a model cannot inflate its own grounding rate by citing a convenient hub. This
follows the precedent of refusing malformed input at record time rather than storing it as
consumable.

**5. A deterministic checker with an honest verdict set** — no LLM, no key, no network:

| Verdict | Meaning |
|---|---|
| `grounded` | every citation resolves to a live symbol |
| `partially-grounded` | some resolve; the unresolved ones are named |
| `ungrounded` | citations exist and the checker can **positively assert** the graph does not contain them |
| `ambiguous` | a citation matches more than one symbol (a collapsed overload set, or a bare name) — candidates named, never resolved by picking one |
| `unresolved-boundary` | a rename/move the continuity map could not bridge |
| `not-assessed` | the citation points into a language the graph does not extract, a parse-health lower-bound file, or was checked against a stale index |
| `uncited` | no citation (hand-written, or template-emitted) |

`uncited`, `ambiguous`, `unresolved-boundary`, and `not-assessed` are each **distinct from
`ungrounded` and never counted with it**, and none of them emits a finding. `ungrounded` is
reserved for a positive assertion of absence. The reported denominator is always the full
requirement set.

**6. Citations resolve at read time; the corpus is never rewritten.** Rename handling consults
the existing symbol-identity continuity map, with the carry-forward disclosed. Where continuity
is unavailable — no pre-rebuild snapshot (fresh clone or first analysis), an ambiguous move, or a
language with no normalized body extraction — the citation is `unresolved-boundary`, **not**
`ungrounded`, because the check cannot distinguish a deletion from a refactor it could not
bridge. `continuity-carry-forward.ts` is **not** extended: its contract (`:21-23`) excludes specs
by construction and it writes stores, which this read-only check must not do.

**7. LLM-judged provenance is filed as a modification, not a new rule.**
`harden-llm-output-contract` already specifies `LlmJudgedScoresCarryProvenance` (label + judging
model id + no blending). This change adds only the no-key clause to it rather than restating a
weaker duplicate.

**8. One registered finding, correctly shaped.** `spec-requirement-ungrounded` with
`defaultClass: 'advisory'`; severity rides the emitted finding and plays **no part** in classing
it (`enforcement-policy.ts:43-44`, `:71-73`). It covers requirements whose citation does not
resolve; it does **not** supersede the shipped CI corpus lint, which continues to fail the build
on the corpus-corruption classes it already gates.

**Explicitly NOT built:** judging whether a grounded requirement is semantically correct;
relevance checking beyond slice membership (not deterministically checkable, and the spec says
so); a second anchor artifact; any write to the spec corpus by the checker.

## Impact

- **Files:** `mapping-generator.ts` (multi-symbol refs), `openspec-format-generator.ts`
  (`emitImplementationHint` placement + multi-symbol + slice recording), `prompts.ts`/`schemas.ts`
  (citation in the slice-bearing stage only), `verification-engine.ts`
  (`parseSpecRequirements` provenance skip + `####` level; report beside, not merged), a new
  read-only `spec-grounding.ts`, the drift path, `enforcement-policy.ts`,
  **`src/api/verify.ts` and `src/api/generate.ts`** (API-layer parity — `generate.ts:239-271`
  owns the mapping/format wiring), the drift CLI summary + pre-commit summary + `kindLabel`
  (a new issue kind must render in all three), `src/pi/extension.ts` (MCP↔Pi parity for
  `check_spec_drift`'s new section, or a stated reason to skip), docs.
- **Specs:** `generator` — 2 ADDED; `verifier` — 1 ADDED + 1 MODIFIED
  (`LlmJudgedScoresCarryProvenance` gains the no-key clause).
- **Backward compatibility (breaking):** `overallScore` is 85% LLM-judged today; unblending it
  renames or retires that field, which is a breaking change to `openlore verify` output and
  `src/api/verify.ts`. This is stated, not hidden — the earlier claim that "`openlore verify`
  keeps its shape" was wrong.
- **Expected initial signal: zero.** This repository's corpus is hand-repaired and contains no
  generated requirements (`grep "Implementation: \`" openspec/specs/*/spec.md` → no matches), so
  it will report ~100% `uncited`. The dogfood task's purpose is to confirm **no false
  `ungrounded` verdicts**, not to find any.
- **Vocabulary coordination:** `adopt-spec-link-status-vocabulary` is concurrently defining a
  spec↔code link-status vocabulary and the `spec-*` finding family; these verdicts SHALL be
  mapped onto it rather than shipping a second vocabulary for the same relation. Note "grounding"
  already names something else in the corpus (`add-structural-claim-verification`'s
  grounding-certificate for `verify_claim` receipts) — the naming must be disambiguated.
- **Validator obligation:** that the provenance line survives the external `@fission-ai/openspec`
  validator is a **task to verify**, not a claim (the in-repo compat checks emit warnings only).
