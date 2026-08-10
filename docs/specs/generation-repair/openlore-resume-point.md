# OpenLore — Resume Point (Generate + Repair Architecture)

Read this first when resuming. It summarizes what's decided, what's next, and
which of the three companion documents to read for detail.

## Companion documents

1. [`openlore-unified-hlspec-v2.md`](openlore-unified-hlspec-v2.md) (content is v4) — the architecture itself.
   This is the one to read in full when resuming.
2. [`openlore-capability-audit.md`](openlore-capability-audit.md) — the evidence: what the current MCP surface
   already does (§A-D), and the per-stage read of the six-stage generation
   pipeline (§E). Reference when touching any specific tool or stage.
3. [`openlore-generation-repair-hlspec.md`](openlore-generation-repair-hlspec.md) (v1) — superseded, kept for history
   only. Not needed to resume work; v4 is self-contained.

## What's decided (architecture — treat as settled, don't re-litigate)

- **Generate vs Repair boundary**: Generate = no spec exists yet for the
  scope. Repair = a spec exists but doesn't fully match the code — Repair
  handles partial coverage too (add + correct in one pass over one file,
  never split between Generate and Repair on the same file).
- **Four reconciliation states are the host agent's job, not OpenLore's**:
  OpenLore reports observations (`covered`, `uncovered_function`,
  `stale_mapping`, `orphan_requirement`, `structural_change`). The host agent
  maps those to `consistent` / `stale` / `missing` (judgment call) /
  `orphaned`. OpenLore never infers business intent from structure.
- **Division of responsibility**: OpenLore = deterministic observations.
  Host agent = semantic interpretation + reconciliation + editing. OpenSpec
  = spec format + change/evolution workflow.
- **Same evidence layer, task-specific composition** — not one fixed bundle
  shared identically by Generate and Repair.
- **No new MCP primitive** (`detect_drift()`, `repair_context()`, etc.) unless
  the composed-primitives workflow (`orient` → `audit_spec_coverage` →
  `get_spec`/`get_mapping`/`check_spec_drift` → `structural_diff`/
  `get_subgraph` → host agent reconciles → edit) demonstrates a concrete
  information/performance gap in practice.
- **ACP is out of scope entirely** — not for cost reasons alone; the target
  architecture doesn't need it. An MCP-compatible host agent consumes
  OpenLore's MCP surface, not a provider OpenLore calls into. The standalone
  facade already supports Claude via direct Anthropic API
  (`provider: "anthropic"`), fully separate from ACP, if a standalone-with-
  Claude comparison is ever wanted later — not currently planned.
- **Stages 5-6 of the generation pipeline don't need rework** — they're
  already single full-context calls over an aggregated deterministic bundle,
  i.e. already the target shape. Only stages 1-4 have the per-file/chunk
  fragmentation problem.

## What's verified in the actual source (not assumed)

- Stage2 (entities), stage3 (services), stage4 (api) all loop per file/chunk,
  each seeing only its own chunk + a same-file deterministic hint (schema/
  signature/route respectively), with naive name/path-only dedup across
  files. Stage1 (survey) is chunked too, merged via "highest confidence
  wins." Stage5/6 are single calls, no chunking.
- **`get_mapping` is not reconstructible from code+specs+graph alone** — its
  `requirement` field comes from `pipeline.services[].operations[].name`,
  i.e. a prior `openlore generate` LLM run's output, persisted to
  `mapping.json`.
- **`audit_spec_coverage` fails silently without `mapping.json`**: absent
  file → `uncoveredFunctions` reports every function as uncovered (false
  positives, no error) and `orphanRequirements` returns empty (signal
  vanishes silently). Only `staleDomains` is independent of `mapping.json`
  (comes from spec-vs-source mtime comparison).
- **`check_spec_drift` is independent** — parses the `"> Source files: ..."`
  header directly out of each `spec.md`, no `mapping.json` dependency.

## Next work session: what to actually do

Two things, explicitly agreed to be done **together**, not sequentially:

1. **Rework stages 1-4** of `src/core/generator/stages/` to aggregate per
   `repoStructure.domains` instead of per file/chunk, following stage5's
   shape. Deterministic inventory data becomes authoritative input, not a
   hint the LLM can override — the LLM's role narrows to purpose/
   relationships/descriptions/business meaning. Reconcile/dedup only after
   aggregation, not per-file.
2. **Update `MappingGenerator`** (`src/core/generator/mapping-generator.ts`)
   to match whatever new output shape stages 1-4 produce, and resolve the
   `mapping.json` silent-failure problem at the same time (§7.1 in v4): either
   make `audit_spec_coverage` fail loudly / flag degraded results when
   `mapping.json` is missing or stale, or give it a fallback that derives
   "covered" from spec content directly instead of solely from the persisted
   artifact. Not decided which — pick one when implementing, informed by
   whatever the reworked stage output looks like.

Concrete checklist, in order:

1. Read current `stage1-survey.ts` in full against `repoStructure.domains` —
   confirm exactly which parts of its output stop being needed once file-role
   classification is deterministic.
2. Rework stage1 → per-domain, deterministic-first.
3. Rework stage2/3/4 the same way, in that order (stage3/services is the one
   with the most genuine LLM-judgment content — most care needed there not to
   over-strip it).
4. Update `mapping-generator.ts`'s `generate()` to consume the new shape.
5. Decide and implement the `mapping.json`-missing behavior in
   `audit_spec_coverage` (`src/api/audit.ts`).
6. Test standalone output (`openlore generate`) with the existing configured
   provider on a real domain, compare to the pre-rework output and to the
   Mistral→Claude-rewrite baseline already observed.
7. Only after that: reuse the same evidence shape for the agent-hosted
   (MCP-compatible host / Pi) path — no new tool unless step 6-7 reveals a genuine
   gap.

## Explicitly not re-open when resuming

- Whether Generate/Repair should be unified — yes, decided.
- Whether to add `detect_drift()`/`repair_context()` — no, not unless the
  composed workflow proves insufficient in practice.
- Whether to pursue ACP — no.
- Whether stage5/6 need rework — no.
- Whether more "empirical validation" is needed before starting — no, this
  was explicitly dropped; go straight to implementation.

## Implementation progress — 2026-08-10

Implemented but not yet final-reviewed:

- A shared deterministic `DomainEvidenceBundle`, including stable `undomained`
  fallback and oversized-domain file-boundary partitions. Stages 1–4 now use
  it; stages 2–4 aggregate by domain and retain deterministic locations,
  signatures, and route identities.
- Version-2 `mapping.json` with a source-analysis fingerprint. Audit now emits
  explicit `mappingCoverage` (`available` / `missing` / `invalid` / `stale`)
  and withholds mapping-derived gaps when provenance is unavailable, rather
  than reporting every function as uncovered.
- MCP `get_architecture_overview` exposes the same domain evidence. Pi has
  `openlore_prepare_spec_generation` and
  `openlore_prepare_spec_repair`, which compose existing daemon calls only;
  Pi writes/reconciles specs itself.
- Docs now state that the evidence representation is shared but Generate and
  Repair compose task-specific subsets.

Verified: targeted tests (52), `npm run typecheck`, `npm run build`, and
strict OpenSpec validation pass. `generate --dry-run --domains generator` also
passes. A real Mistral generation to `/private/tmp/openlore-generation-validation`
needs rerunning: sandbox networking fails; the authorized retry was interrupted.
Before declaring this complete: finish tasks 2.4, 4.1/4.2/4.4, 5.1/5.2, then
perform the mandatory diff/code review.
