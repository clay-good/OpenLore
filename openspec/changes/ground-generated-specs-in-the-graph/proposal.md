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
2. **Colliding anchor proposals.** An operation and a sub-component operation of the same name share
   an anchor key, so the later proposal silently overwrote the earlier one's verified anchor.
3. **`stale` over-claims.** The index calls any absent cited symbol "gone" — including symbols in a
   language whose exports are never extracted (Go, Rust, …), or in a file the analysis skipped. Those
   are not evidence of removal.

## What Changes

| Fix | Where |
|---|---|
| Anchor written below the normative text; colliding proposals write no anchor | `openspec-format-generator.ts`, `spec-link-service.ts` |
| Verifier skips anchor, continuation, and provenance-blockquote lines (a normative blockquote stays) | `verification-engine.ts` |
| `not-assessed` anchor/requirement state with a named boundary (`language-not-extracted`, `file-not-analyzed`), only for an analyzed or existing regular file (real path, case); own stat, refresh listing, not an orphan; index version 7; cache re-assesses before serving | `spec-link-index.ts`, `spec-link-service.ts` (`buildFileAssessor`), `mapping.ts` |
| `extractsExports` derived from the parser's own extension dispatch | `import-parser.ts` |

## Deliberately NOT built (superseded or deferred)

| Original item | Disposition |
|---|---|
| A parallel `spec-grounding.ts` checker with 7 verdicts | Superseded by the link index's states |
| Unblending `overallScore` | Superseded: the synced `LlmJudgedScoresCarryProvenance` permits a disclosed composite, which ships |
| Mapping onto `adopt-spec-link-status-vocabulary` | Obsolete for now: that change is unbuilt and defines no matching states |
| Multi-symbol anchor writing, slice recording, out-of-slice dropping | Deferred: the read side already accepts multiple anchors; the writer gates each proposal against the whole graph |
| `spec-requirement-ungrounded` finding, continuity-based rename bridging, no-key report clause | Deferred to follow-ups |
| Recovering `#### Requirement:` sub-component requirements | **Withdrawn after review**: the OpenSpec format and eight other in-repo parsers count only `###`; indexing `####` added 185 unanchored requirements and duplicate names on this repository's own corpus |
| A repair-stream section listing `not-assessed` requirements | Out of scope: `get_mapping` and `mapping refresh` list them; a new page section would shift already-thin response budgets |
| `stale` for a symbol that exists but is not exported (a private helper, a class method) | Pre-existing: the export inventory is the resolution basis; unchanged here |
| A parse-health lower-bound boundary | **Withdrawn after review**: parse health records tree-sitter regions, while exports come from the regex import parser, which they do not affect |
| Citation-regression reporting, byte-identical regenerated provenance, uncited-by-construction and missing-citation-field reporting, stale-index `not-assessed`, a report naming excluded languages/files, the "grounded ≠ correct" statement, external-validator and dogfood tasks, drift/pipeline/CLI docs, API/drift-summary/Pi parity | Deferred with the grounding checker they belonged to; the anchor layout was separately confirmed to pass `openspec validate --specs --strict` during review |

## Impact

- **Specs:** `generator` — 2 ADDED; `verifier` — 1 ADDED.
- **Artifacts:** `mapping.json` schema version 6 → 7 (a v6 cache is rebuilt).
- **Tool surface:** unchanged; `get_mapping` now serves `not-assessed` and `stats.notAssessed`.
