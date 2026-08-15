## Context

`openlore generate` already receives a complete `RepoStructure` and `LLMContext`, but stages 1–4 invoke the LLM by file/chunk and reconcile only names or paths afterward. This loses domain-level relationships and lets LLM output select structural facts that static analysis already knows. The persisted mapping artifact also remains the only source for coverage correspondence, while `openloreAudit` silently treats its absence as an empty mapping.

The MCP server already exposes the evidence needed for agent-hosted Generate and Repair. The architecture must describe a protocol for any MCP client, not a Claude Code-specific skill or integration.

## Goals / Non-Goals

**Goals:**

- Aggregate stage 1–4 evidence by `repoStructure.domains`, with a deterministic fallback group for `undomained` files.
- Make static inventories authoritative for discovered schemas, signatures, routes, file/domain membership and endpoint identity; use the LLM only for semantic descriptions, relationships, purposes, scenarios and architectural meaning.
- Keep the current `PipelineResult` shape consumable by stages 5–6, formatting, ADR generation and RAG generation.
- Preserve a trustworthy mapping artifact and report unavailable or stale mapping-derived coverage explicitly.
- Define Generate and Repair as agent-neutral compositions of existing MCP tools.
- Make the native Pi extension a first-class host of that same protocol, through its existing warm-daemon transport.

**Non-Goals:**

- No new MCP composite tool, ACP integration, provider-specific SDK, or client-specific skill.
- No rework of stages 5–6 or change to OpenSpec's evolution workflow.
- No attempt by OpenLore to infer business intent or to auto-delete orphaned requirements.

## Decisions

### Domain evidence bundle is the stages 1–4 input contract

Build one bounded bundle per detected domain, plus one deterministic `undomained` bundle when necessary. Each bundle contains its member files; matching schema tables and fields; route method/path/handler facts; signatures; relevant graph/skeleton excerpts; and deterministic project/domain metadata. File classification is derived from those inventories and domain membership, not from stage 1 LLM file lists.

The LLM receives each bundle once per applicable stage. It may add semantic content but cannot introduce, rename or omit authoritative schema fields, signatures, routes, locations or domain membership. A post-response reconciliation attaches/validates each result against the bundle and rejects or removes structural references not present in it. This replaces chunk-level prompts and `seenNames`/`seenPaths` deduplication.

Alternative considered: retain file-level calls and improve cross-file deduplication. Rejected because it preserves the missing context and unnecessary structural rediscovery.

This representation is an OpenLore evidence-layer artifact, not an internal standalone-pipeline detail. The standalone pipeline consumes it before invoking its configured provider; MCP and Pi consumers receive it directly and perform their own semantic synthesis. Repair composes this same representation with spec-state observations rather than rebuilding structural analysis.

### Survey becomes deterministic-first metadata synthesis

Stage 1 derives `schemaFiles`, `serviceFiles`, `apiFiles` and suggested domains from the domain bundles and repository inventories. Its one aggregated LLM synthesis may describe project category, architecture pattern and domain summary, but its output does not control downstream file selection. The legacy chunking and highest-confidence merge path are removed.

### Stage outputs retain their public shape

Stages 2–4 continue producing `ExtractedEntity[]`, `ExtractedService[]` and `ExtractedEndpoint[]`; stage 3 operations retain exact `functionName` references drawn from the bundle signatures. `SpecGenerationPipeline`, stages 5–6 and downstream formatters therefore keep their current interface. Reconciliation occurs after each domain-level response and before values are merged into the existing arrays.

### Mapping provenance is explicit and coverage fails closed

`MappingArtifact` gains a format/version marker and a source-analysis fingerprint derived from the deterministic export/signature inventory used to generate it. The audit recomputes the same fingerprint from its current cached analysis. It returns `mappingCoverage` with state `available`, `missing`, `invalid`, or `stale`, plus a machine-readable reason and artifact path.

Only `available` allows uncovered-function, hub-gap, orphan-requirement counts and lists to be computed. For every other state, those mapping-derived fields are empty and their summary counts are zero; `staleDomains` remains populated because it is independent. The CLI and MCP handler render the unavailable state prominently instead of presenting zero coverage. This is backward-compatible at the field level while adding the status clients must honor.

Alternative considered: parse OpenSpec prose to rebuild coverage when the artifact is unavailable. Rejected for this change because requirement-to-function correspondence is not reliably encoded in spec prose; it would replace an explicit precondition with heuristic false confidence.

### Agent-neutral MCP protocol

Documentation names an **MCP-compatible host agent** as the consumer. Generate applies to a scope with no spec; Repair applies once a spec exists and performs additions and corrections together per spec file. Both use one deterministic evidence layer, but compose task-specific views: Generate requests forward code/inventory/context evidence and does not require spec state; Repair adds the existing spec, mapping, coverage, drift and structural-change evidence that applies to its target. OpenLore exposes only deterministic evidence and never labels a requirement as semantically missing, stale or safe to delete.

### Pi is a peer host, not an alternate evidence layer

The Pi extension becomes a reference host alongside generic MCP clients. It reaches the existing warm daemon via its established HTTP transport, calls the same underlying tool contracts and renders the same `mappingCoverage` disclosure. It exposes native Generate and Repair entry points that guide Pi through the documented task-specific composition, then uses Pi's normal editing capability to apply the resulting OpenSpec changes. Pi must not reimplement inventories, mappings, drift or semantic reconciliation server-side.

The current per-tool parity discipline extends to the Generate/Repair protocol: each required observation is surfaced by Pi or listed in its explicit exclusion list with a reason. This preserves Pi-specific ergonomics without creating a Pi-only architectural branch.

## Risks / Trade-offs

- [A large domain exceeds a provider context window] → deterministically partition it into stable sub-bundles, label the partition, then reconcile at the domain level; never revert to arbitrary AST chunks.
- [Static inventory is incomplete for an unsupported language/framework] → preserve the detected-file fallback group and disclose its inventory coverage in intermediate output.
- [Existing consumers ignore `mappingCoverage`] → retain existing report fields, update CLI/MCP documentation and add contract tests that require the status disclosure.
- [Cached analysis is stale] → fingerprint mismatch disables mapping-derived claims while the independently-derived stale-domain signal remains available.
