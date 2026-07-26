# Ground generated specs in the graph: every requirement cites symbols, and the graph — not another model — checks the citation

> Status: PROPOSED (2026-07-25, known-limitations closure #3 of 6). The README's limitation
> reads "LLM spec quality varies — review complex business logic before treating it as
> authoritative," and today the only check on a generated spec is **another LLM**: the
> verification engine asks a model for a `specAccuracyScore` and a `requirementCoverageScore`
> (`src/core/verifier/verification-engine.ts:46`, `:528-533`) and reports the result as the
> quality metric. That is an LLM in the guardrail path, checking an LLM — precisely what the
> north star forbids everywhere else in the product. This change makes generated requirements
> **cite the symbols they describe** and makes a **deterministic checker over the call graph**
> the authority on whether the citation holds. The LLM keeps writing prose; it stops being the
> judge of its own prose.

## The gap

- **The authority is a model.** `getPrediction` (`verification-engine.ts:513-535`) shows the
  model the spec and the file and asks it to score how well the spec describes the file; that
  score flows into `comparePurpose` and `analyzeRequirementCoverage` (`:463-466`) and then into
  `overallScore` (`:469`). The engine's own comment states the LLM-as-judge design replaced a
  "brittle Jaccard keyword-overlap." Both options were text-similarity heuristics. The one
  source of ground truth the product owns — the call graph, with every symbol, signature, caller,
  and file it actually contains — is never consulted about a requirement's claims.
- **A requirement has no anchor, so nothing about it can be checked or maintained.**
  `parseSpecRequirements` (`verification-engine.ts:797-813`) recovers only
  `{ name, description }` from `### Requirement:` blocks. There is no record of which functions,
  files, or edges a requirement was generated *from*. Consequently: a requirement naming a
  function that does not exist reads exactly like a correct one; a requirement whose subject was
  deleted three refactors ago cannot be distinguished from one still true; and the drift
  detector must re-derive the association it was never told.
- **The rest of the substrate already solved this problem.** Memories and decisions are
  **anchored to symbols** and self-invalidate — a renamed symbol carries its memory forward with
  `carriedAcross` provenance, an orphaned anchor is withheld from authoritative answers. Specs,
  the one artifact actually written by an LLM, are the only knowledge surface in the product with
  **no anchor at all**.
- **The field has converged on exactly this discipline.** "Citation Discipline in
  Spec-Driven Development" (arXiv 2606.30689) reports that requiring artifacts to cite specific
  identifiers turns hallucination detection into an automated set-difference — a check that is
  language-agnostic and needs no second model. The RAG-traceability literature (LiSSA; TVR,
  arXiv 2504.15427) reaches the same place from the requirements-engineering side: generation
  may be probabilistic, but the *link* must be verifiable. OpenLore is unusually well-placed to
  do this, because it already owns the verifier the citation must be checked against.

## What changes

**1. Generated requirements carry a symbol citation.** The generation prompt and output schema
(`src/core/generator/prompts.ts`, `schemas.ts`, the pipeline stages) require every requirement to
list the concrete symbols it describes — `name::path` identifiers drawn from the graph slice the
generator was given. The citation is emitted into the spec in a machine-readable, human-legible
line under the requirement, in the same style the corpus already uses for decision provenance
(`> Decision recorded: <id>`), so it survives the OpenSpec format and the corpus-lint check:

```
### Requirement: EdgeStoreIsNeverDroppedOnRead
> Grounded in: EdgeStore.open::src/core/services/edge-store.ts, EdgeStore.dbPath::src/core/services/edge-store.ts
```

**2. A deterministic grounding checker becomes the authority.** A new check — no LLM, no network
— resolves every citation against the graph and classifies each requirement:

| Verdict | Meaning |
|---|---|
| `grounded` | every cited symbol resolves to a live symbol in the graph |
| `partially-grounded` | some citations resolve; the unresolved ones are named |
| `ungrounded` | no citation resolves — the requirement describes symbols the repository does not contain |
| `uncited` | the requirement carries no citation (every pre-existing hand-written requirement, and anything a model declined to cite) |

`uncited` is a **distinct verdict, never folded into `ungrounded`** — absence of a citation is not
evidence of falsehood, and the corpus is full of legitimately hand-written requirements. The
checker reports counts and per-requirement verdicts; it never rewrites or deletes a requirement.

**3. Citation moves the drift detector from inference to lookup.** A cited requirement whose
symbols were renamed or moved is carried forward by the **existing symbol-identity continuity**
machinery (the same mechanism that keeps memories anchored across refactors), and a citation whose
symbol vanished becomes a precise, per-requirement drift signal instead of a domain-level
similarity guess.

**4. LLM-judged scores keep their provenance and lose their authority.** The verification engine
continues to run when a key is configured, but its scores are labeled as LLM-judged (extending
`harden-llm-output-contract`'s labeling rule) and are **reported beside**, never merged into, the
deterministic grounding verdict. A repository with no API key gets the grounding report — the
first spec-quality signal available with no key at all.

**5. One registered finding, advisory by default.** `spec-requirement-ungrounded` in
`FINDING_CODE_REGISTRY`, source-declared severity `warning`, so a team can class it `blocking` in
`enforcement.policy` and refuse to land a spec asserting things about symbols that do not exist.
Surfaced through `openlore drift`, `openlore enforce`, and `check_spec_drift`.

**Explicitly NOT built:** judging whether a grounded requirement is *semantically correct* — that
remains a human's job and the README will keep saying so. Grounding proves the requirement is
**about code that exists**; it does not prove the prose is right. No second model, no
"confidence score" blend, no auto-deletion of ungrounded requirements, and no change to the
OpenSpec format beyond one provenance line the format already accommodates.

## Why this is in scope

"No LLM in the retrieval or guardrail path" is the north star's load-bearing sentence, and spec
verification is the one place the product violates it. This makes the graph — the thing OpenLore
is uniquely good at — the checker, gives generated specs the same anchored, self-invalidating
property that memories and decisions already have, and converts "review before treating as
authoritative" from a blanket warning into a per-requirement verdict that tells a reviewer
*which* requirements to look at first.

## Impact

- **Files:** `src/core/generator/prompts.ts` + `schemas.ts` (citation in the output contract),
  the generation stages and `openspec-format-generator.ts` (emit the provenance line),
  `openspec-writer.ts` (preserve it on merge), a new deterministic `spec-grounding.ts` checker,
  `verification-engine.ts` (report beside, not merged), the drift path (`check_spec_drift`,
  `openlore drift`), `enforcement-policy.ts` (one finding code), the corpus-lint check, and
  `docs/drift-detection.md` / `docs/pipeline.md`.
- **Specs:** `generator` — 2 ADDED (GeneratedRequirementsCiteTheSymbolsTheyDescribe,
  CitationsSurviveWriteAndMerge); `verifier` — 2 ADDED
  (SpecGroundingIsCheckedDeterministicallyAgainstTheGraph,
  LlmJudgedScoresAreLabeledAndNeverAuthoritative).
- **Tool surface:** unchanged — no new MCP tool; `check_spec_drift` gains a grounding section and
  the CLI gains `openlore drift --grounding` output. (`openlore verify` keeps its shape.)
- **Backward compatibility:** every existing requirement is `uncited` and nothing about it
  changes; the grounding report is additive and advisory by default.
- **Risk:** (a) *models omit citations* — mitigated by the schema-checked output contract
  (existing `completeJSON` path) plus the `uncited` verdict, which degrades to today's behavior
  rather than failing. (b) *citation churn on refactor* — mitigated by routing citations through
  the shipped symbol-identity continuity carry-forward. (c) *reviewers reading `grounded` as
  "correct"* — mitigated by the spec's explicit statement that grounding is an existence proof,
  and by the same wording in the CLI output and the README.
