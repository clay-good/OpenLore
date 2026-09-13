# Check the anchor the corpus already has — narrowed to what is still unbuilt

> Status: BUILT (2026-09-12), **narrowed**. A pre-build evidence audit found most of this proposal
> superseded by the shipped deterministic spec link index (`harden-spec-workflow-lifecycle`,
> #346/#419): specs already carry an exact `- **Implementation**: \`name::path\`` anchor, the index
> resolves it against the graph as linked/ambiguous/unmapped/stale with no similarity matching, and
> the verifier already publishes the composition and provenance of its LLM-judged scores.

## Why

Three live defects remained in that shipped path:

1. **The verifier describes a requirement by its anchor.** The generator writes the anchor between
   the heading and the `SHALL` text, and `parseSpecRequirements` takes the first non-empty line after
   the heading — so every anchored requirement's "description" was the anchor line.
2. **Sub-component requirements are invisible.** Neither the verifier nor the link index recovered
   `#### Requirement:` blocks, and the generator threw away their verified anchors.
3. **`stale` over-claims.** The index calls any absent cited symbol "gone" — including symbols in a
   language whose exports are never extracted (Go, Rust, …), in a file the analysis skipped, or in a
   file that parsed with errors. Those are not evidence of removal.

## What Changes

| Fix | Where |
|---|---|
| Anchor written below the normative text; sub-component requirements anchored | `openspec-format-generator.ts` |
| `#### Requirement:` recovered by both parsers; verifier skips provenance lines | `spec-mapper.ts`, `verification-engine.ts` |
| `not-assessed` anchor/requirement state with a named boundary; own stat, refresh listing, not an orphan; index version 7 | `spec-link-index.ts`, `spec-link-service.ts` (`buildFileAssessor`), `mapping.ts` |
| `extractsExports` derived from the parser's own extension dispatch | `import-parser.ts` |

## Deliberately NOT built (superseded or deferred)

| Original item | Disposition |
|---|---|
| A parallel `spec-grounding.ts` checker with 7 verdicts | Superseded by the link index's states |
| Unblending `overallScore` | Superseded: the synced `LlmJudgedScoresCarryProvenance` permits a disclosed composite, which ships |
| Mapping onto `adopt-spec-link-status-vocabulary` | Obsolete for now: that change is unbuilt and defines no matching states |
| Multi-symbol anchor writing, slice recording, out-of-slice dropping | Deferred: the read side already accepts multiple anchors; the writer gates each proposal against the whole graph |
| `spec-requirement-ungrounded` finding, continuity-based rename bridging, no-key report clause | Deferred to follow-ups |

## Impact

- **Specs:** `generator` — 2 ADDED; `verifier` — 1 ADDED.
- **Artifacts:** `mapping.json` schema version 6 → 7 (a v6 cache is rebuilt).
- **Tool surface:** unchanged; `get_mapping` now serves `not-assessed` and `stats.notAssessed`.
