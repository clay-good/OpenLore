# OpenLore — Existing Capability Audit (Generation & Repair)

Source: clay-good/OpenLore, inspected directly (src/core/services/mcp-handlers/*,
src/core/generator/*, src/core/drift/*, docs/mcp-tools.md, docs/drift-detection.md,
docs/structural-diff.md, docs/coverage-gaps.md). Not based on tool names alone.

## A. Existing capability map

| Tool | Inputs (key ones) | Output | Implementation | Generation use | Repair use |
|---|---|---|---|---|---|
| `orient` | `directory`, `task` | Relevant functions, covering files/domains, call-graph neighbourhood, insertion points, spec sections + ADRs, pending/approved decisions, `suggestedTools` | One-shot orchestration over existing analysis/search indices; no LLM required for the default (keyword/BM25) path | Fast entry point to a domain before reading full spec | Fast entry point to locate what a drift finding actually touches |
| `get_spec` | `directory`, `domain` | Full text of one OpenSpec domain spec | Reads `openspec/specs/<domain>/spec.md` | Read spec before generating into it | Read the exact text to patch |
| `get_mapping` | `directory`, `domain?`, `orphansOnly?` | Requirement→function mapping (confidence) + `orphanFunctions` | Reads the **persisted artifact** written by a prior `openlore generate` (`mapping.json`); not recomputed live | Inspect prior generation's mapping | Direct source of **Missing** (function-level) candidates via `orphanFunctions` |
| `check_spec_drift` | `directory`, `base`, `files?`, `domains?`, `failOn`, `maxFiles` | Issues: `gap` / `stale` / `uncovered` / `orphaned-spec` / `adr-gap`, **file-level** | Static: diffs git-changed files against the spec's mapped source-file list. Deterministic, no LLM by default (`--use-llm` optional to re-classify gap severity) | n/a | Primary **file-level trigger**: "this spec-covered file changed, spec wasn't updated" — but does not say *what* changed |
| `structural_diff` | `directory`, `baseRef?`, `headRef?` | Added/removed functions, **signature changes** (before/after), **stale callers**, rename candidates, edge deltas | Deterministic graph diff (Layer 3, complement to git diff), no spec awareness | n/a | The **fine-grained evidence** `check_spec_drift` doesn't give: exactly which function/signature/call changed |
| `detect_changes` | `directory`, base ref | Recently changed functions ranked by blast radius (fan-in + transitive reach) | Git diff + call graph | n/a | Prioritization: which of the changed functions matter most |
| `audit_spec_coverage` | `directory`, `maxUncovered`, `hubThreshold` | Uncovered functions, hub gaps (high fan-in, no spec), **orphan requirements** (spec, no impl found), **stale domains** (source changed after spec) | Reads cached call graph + spec mapping, no LLM, ~200ms | Pre-check before `generate --domains X` | The single best **domain-level gap map**: covers Missing, Orphaned, and a coarse Stale signal in one call |
| `get_minimal_context` | `directory`, `functionName`, `filePath?` | Signature + body, direct callers/callees (signatures), covering tests | Reads cached call graph, per-function scoped, cheap | n/a | Evidence bundle for the specific function once a finding is scoped to it |
| `search_specs` / `search_unified` / `list_spec_domains` | `directory`, `query` | Semantic matches over spec sections (+ code for unified) | Requires spec index (`openlore analyze --reindex-specs`) | Locate the right domain before generating | Locate the exact requirement paragraph when drift/audit only give file/domain granularity |

**Conclusion of A:** every primitive needed to *find* and *evidence* a repair
already exists and is already MCP-exposed. Nothing in this list needs to be added.

## B. Current generation pipeline (`openlore generate`)

```
openlore analyze  →  writes cached artifacts (repoStructure, llmContext,
                      depGraph, refactorReport) to .openlore/analysis/
                            │
openlore generate (api/generate.ts)
                            │
                            ▼
                 loadAnalysisData()  — reads the cached artifacts above,
                                       does NOT re-analyze the repo
                            │
                            ▼
              SpecGenerationPipeline (spec-pipeline.ts)
                            │
        6 sequential LLM stages, each llm.completeJSON()
        against a JSON schema, over code-shaper/subgraph excerpts:
                            │
   stage1 survey → stage2 entities → stage3 services →
   stage4 api → stage5 architecture synthesis → stage6 ADR
                            │
                            ▼
              OpenSpecFormatGenerator  — PURE FORMATTING, no LLM call.
              Turns the 6 stages' structured JSON into OpenSpec markdown,
              resolves domain relationships (calls-into/called-by).
                            │
                            ▼
        OpenSpecWriter (writes files) + MappingGenerator (writes the
        artifact that get_mapping later reads) + optional ADRGenerator,
        RagManifestGenerator
```

**Where the LLM is actually involved:** only inside the 6 pipeline stages —
structured *extraction* from code excerpts into typed JSON (entities, services,
endpoints, architecture, ADRs), each with its own schema and prompt
(`stages/stage1-survey.ts` … `stage6-adr.ts`, `prompts.ts`, `schemas.ts`).
Formatting, mapping, and file-writing are deterministic and LLM-free.

**Implication:** this is not "assemble context, one LLM call, done." It's a
domain-specific, schema-driven, multi-stage extraction pipeline. None of it is
exposed via MCP today. Replacing it with a Claude Code workflow would mean
re-implementing six structured-extraction stages and their schemas — a real
rewrite, not a thin composition of existing tools. This is a separate, larger
question from repair and should stay out of scope for now.

## C. Current drift/coverage pipeline

Two independent, complementary passes — not one pipeline:

```
check_spec_drift:
  openspec/specs/*  →  buildSpecMap() / buildADRMap()  (spec's source-file list)
  git diff vs base   →  getChangedFiles()
                    ↓
              detectDrift()  →  gap / stale / uncovered / orphaned-spec / adr-gap
                                 (FILE granularity — "this file changed, spec didn't")

audit_spec_coverage:
  cached call graph  +  spec mapping (mapping.json)
                    ↓
              openloreAudit()  →  uncovered functions, hub gaps,
                                   orphan requirements, stale domains
                                   (FUNCTION + DOMAIN granularity)

structural_diff / detect_changes:
  git diff vs base (two refs)  →  graph diff — signature changes, stale callers,
                                   added/removed functions, edge deltas
                                   (has NO spec awareness — pure code-vs-code)
```

Neither `check_spec_drift` nor `audit_spec_coverage` currently *calls*
`structural_diff` to cite the specific structural change behind a `stale`/`gap`
finding — a host agent has to make that connection itself today.

## D. Minimal gap analysis

```
Missing spec for existing code
  → audit_spec_coverage (uncoveredFunctions, hubGaps) + get_mapping(orphansOnly)
  → EXISTING, no new primitive needed

Orphaned spec (spec, no code)
  → audit_spec_coverage (orphanRequirements)
  → EXISTING, no new primitive needed

Stale spec, file-level trigger
  → check_spec_drift (gap/stale)
  → EXISTING, no new primitive needed

Stale spec, "what exactly changed" evidence
  → structural_diff, scoped to the flagged file/base ref
  → EXISTING, no new primitive needed

Which spec paragraph to edit
  → get_spec (if domain known) or search_specs (if not)
  → EXISTING, no new primitive needed

Per-function context to write the patch
  → get_minimal_context
  → EXISTING, no new primitive needed
```

**Answer to the key question: no new MCP tool is required.** `detect_drift()`
and `repair_context()` from the earlier draft should be dropped. What's missing
is purely orchestration: correlating `check_spec_drift`/`audit_spec_coverage`
findings with `structural_diff` scope, `get_spec` domain, and
`get_minimal_context` function names, then handing the bundle to the host agent
to draft and write the patch. That's a **Claude Code skill**, not a new tool —
consistent with how `orient` already composes several existing indices into one
call without introducing new underlying primitives.

**Repair workflow (composition of existing tools only):**

```
1. audit_spec_coverage(directory)                         # domain-level gap map
2. check_spec_drift(directory, base)                       # file-level triggers
3. For each stale/gap finding:
     structural_diff(directory, baseRef: base)              # scoped evidence
     get_spec(directory, domain)                            # current text
     get_minimal_context(directory, functionName)           # per-function detail
4. Classify: Missing / Stale / Orphaned / Consistent
   (derived from steps 1-2, no new classification logic needed server-side)
5. Host agent drafts the patch from the evidence bundle and writes it
   (OpenLore does not need to own a write/generation call for this path)
```

**One thing worth flagging, not a recommendation:** if this workflow turns out
to be called often enough that re-running `audit_spec_coverage` +
`check_spec_drift` + per-finding `structural_diff` feels heavy, a thin
convenience tool that *only* scopes `structural_diff` to the files a drift/audit
pass already flagged could be considered later — but that's an optimization to
evaluate after real usage, not a prerequisite to ship agent-hosted repair.

## Note on generation (B revisited)

Given B, "avoid duplicating analysis/graph/retrieval in a Claude Code workflow"
is already true for **repair** — it uses only the read-only, already-MCP-exposed
layer. It is not yet true for **generation**, whose LLM work lives inside a
six-stage extraction pipeline that has no MCP surface at all. That's a separate,
larger decision than what's needed to ship repair, and this audit doesn't
recommend touching the standalone generation pipeline now.

## E. Per-stage audit (extends the stage2-only note above)

Full read of `src/core/generator/stages/stage1-survey.ts` through
`stage6-adr.ts`. Two clearly different shapes emerge:

| Stage | Loop shape | Deterministic grounding already used | What's genuinely LLM-shaped |
|---|---|---|---|
| 1 — survey | Per signature-chunk (`Promise.all`, then `mergeStage1Results` — dedup by set-union of file lists, "highest confidence" wins for metadata) | `buildStructuredHints()`: schemas, routes, uiComponents, envVars — all pulled from already-computed `repoStructure`/`llmContext`, labeled *"gives less capable models a head start"* | Project type/pattern classification prose; picking which files count as schema/service/api files for downstream routing |
| 2 — entities | Per file, per AST chunk | `schemasFor(file.path)` hint: *"use these field names and types directly"* | Entity descriptions, relationships, purpose |
| 3 — services | Per file, per AST chunk; dedup by name only (`seenNames`) | `signaturesFor(file.path)` hint for function-name grounding | Service **purpose** and **operations** — the most judgment-heavy stage; least reducible to deterministic detection |
| 4 — api | Per file, per AST chunk; dedup by `method:path` | `routesFor(file.path)` hint: *"use these method/path values directly"* | Endpoint **purpose** text; method/path themselves are already grounded |
| 5 — architecture | **Single call, no chunking** — one prompt aggregating stage1-4 outputs + `depGraph`/`callGraph`/`refactorReport` stats | Hub functions, entry points, layer violations, cycles — all deterministic, all pulled in as one bundle | Synthesis prose tying it together |
| 6 — adr | **Single call, no chunking** — expands stage5's `keyDecisions` list | none needed (input is already stage5's synthesized text) | Pure prose expansion, one decision → one ADR |

**Reading:** stages 1-4 share the same failure shape — a loop over
files/chunks, each call seeing only its own chunk plus a same-file
deterministic hint, dedup by name/path only (no cross-file reconciliation).
Stages 5-6 already look like the target evidence-layer pattern: aggregate
everything deterministic first, one full-context call, synthesize/expand. That
they're also the two stages with no chunking is probably not a coincidence —
they're the ones a single LLM call can hold in context at once.

**Implication for the v2 architecture:** stage5 and stage6 don't need much
rework to fit the evidence-layer model — they already are that model, just
running inside the standalone pipeline instead of being handed to a host
agent. The redesign work concentrates on stages 1-4: replacing the per-chunk
extraction loop (which only reconstructs what `get_schema_inventory` /
`get_route_inventory` / `get_signatures` already know structurally) with one
full-context pass per domain, similar in shape to stage5, feeding the same
kind of aggregated deterministic bundle instead of one file at a time.

**Still open, not resolved by this pass:** how `MappingGenerator` (consumes
stage3's `functionName`-tagged operations), `ADRGenerator` (consumes stage6),
and `RagManifestGenerator` (consumes entities/services/endpoints) would need
to change if stages 1-4 stop producing their current per-file output shape.
Not traced in this audit — needed before implementation starts.
