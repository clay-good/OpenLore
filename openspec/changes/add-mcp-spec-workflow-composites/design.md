## Context

See `proposal.md` for motivation. The completed agent-neutral change established a shared deterministic domain-evidence layer and documented Generate and Repair as compositions of atomic MCP tools. Pi then added native `openlore_prepare_spec_generation` and `openlore_prepare_spec_repair` entry points, demonstrating both the value of a one-call preparation workflow and the parity gap for generic MCP clients.

The existing architectural boundary remains controlling: OpenLore establishes structural observations; the host agent interprets business meaning, writes specification prose, and edits files. The new tools therefore compose evidence but do not become an internal LLM pipeline or an autonomous specification writer.

## Goals / Non-Goals

**Goals:**

- Make the efficient Pi preparation workflow available to any MCP-compatible coding agent.
- Produce one-call responses for ordinary domains while retaining deterministic bounded continuation for large domains.
- Centralize task-specific composition without duplicating the underlying evidence calculations.
- Preserve Repair for partial, stale, moved, deleted, and fully orphaned domain scopes.
- Keep skills and host adapters thin enough that their behavior can be tested for protocol parity.

**Non-Goals:**

- Generating prose, choosing reconciliation semantics, or editing specification files inside OpenLore.
- Adding ACP, provider SDKs, or an MCP file-writing tool.
- Removing or hiding the atomic MCP tools.
- Forcing Generate and Repair to return one identical evidence bundle.
- Replacing the standalone `openlore generate` facade or its configured-provider path.

## Decisions

### 1. Add two public preparation tools, not `generate` and `repair` commands

The MCP tools are named `prepare_spec_generation` and `prepare_spec_repair`. The `prepare_` prefix makes their read-only evidence role explicit and avoids implying that OpenLore authors or writes a specification.

Generation requires a current reconciled domain. Repair requires an existing spec but does not require a current domain, because absence of current domain evidence is itself relevant to orphan reconciliation.

**Alternative considered:** keep composition only in skills. Rejected because skills are not portable across all MCP hosts, add repeated round trips, and allow deterministic composition to diverge by client.

**Alternative considered:** expose MCP `generate`/`repair` tools that write specs. Rejected because it moves semantic authorship and editing into OpenLore and would recreate the internal-LLM architecture the agent-hosted path is intended to avoid.

### 2. Introduce one shared application composition layer

Both MCP handlers will call shared application services for generation and repair preparation. These services consume the canonical domain-evidence builder and the same audit, mapping, spec, drift, and structural-diff services used by the atomic handlers. They do not call the MCP transport recursively and do not reproduce analyzer logic.

Pi will call the public composite tools through its existing daemon transport. Its local entry points remain UX wrappers only: parameter collection, host guidance, and result rendering. This makes Pi a conformance consumer rather than a second implementation.

**Alternative considered:** have each composite handler call existing MCP handlers internally. Rejected because transport-shaped handlers mix argument validation, rendering, and service behavior; recursive dispatch also complicates cancellation and error attribution.

### 3. Use task-specific stable response envelopes

Both responses use a common envelope:

```text
workflow: generation | repair
domain: requested and resolved identity
provenance: analysis fingerprint + artifact timestamps
receipt:
  state: complete | partial | unavailable
  included: evidence section identifiers
  omitted: section + stable reason
  continuationCursor?: opaque cursor
  followUps?: atomic tool + prefilled arguments
evidence: workflow-specific structured payload
```

Generation evidence contains only code/domain information. Repair adds spec-state observations. The two payloads share identifiers and provenance but are not forced into a wasteful common superset.

Stable reason codes, rather than prose parsing, drive skills and parity tests. Human-readable messages accompany the codes.

### 4. Bound by deterministic partitions and use provenance-bound cursors

The first call should normally contain everything needed for one domain. When it cannot, the server reuses the domain-evidence partitioning rules and returns an opaque continuation cursor bound to:

- workflow and domain;
- analysis fingerprint;
- deterministic partition index;
- applicable response budget/version.

A cursor from stale analysis is rejected with a typed `analysis-changed` state and restart guidance. No server-side session is required. There is no silent string truncation after the structured receipt is built.

Atomic-tool follow-ups are used for evidence that is unavailable or genuinely requires targeted expansion; pagination is used for evidence that merely exceeds the response bound.

**Alternative considered:** return a single unbounded bundle. Rejected because large domains can exceed host or provider context limits and recreate the earlier chunking failure at the MCP boundary.

### 5. Build Repair structural scope from current and historical evidence

Repair first resolves the existing spec and mapping before requesting structural changes. Its file scope is the normalized union of:

- current reconciled defining and supporting files;
- source paths parsed from the existing spec's source header and technical notes where supported by the canonical spec parser;
- paths in mapping entries for the target domain.

The union is passed to the already file-scoped structural-diff service before category limits and summary computation. Missing current evidence does not abort Repair. If no path can be recovered, structural change is returned as unavailable/empty-scope with an explicit reason while spec, audit, mapping, and drift observations remain available.

This also resolves the current Pi limitation where deleted or moved files can disappear from a current-domain-only structural scope.

### 6. Expose composites in the default and full MCP surfaces

The two high-level tools are added to the ordinary default surface and the full surface. The explicit navigation-only preset remains narrow and may omit them. This adds only two task-oriented entry points to the default tool set while removing the need for an agent to discover and sequence many lower-level tools for common specification work.

Tool annotations mark both composites read-only and non-destructive. Existing atomic tools and presets remain backward compatible.

**Alternative considered:** expose them only in `full`. Rejected because an unqualified MCP setup—the common configuration—would still lack workflow parity and installed skills could refer to unavailable tools.

### 7. Treat skills as thin authoring policies

The supported Generate and Repair skills will:

1. call the appropriate composite;
2. honor the receipt and fetch continuation pages;
3. use indicated atomic follow-ups only for partial/unavailable sections;
4. author or reconcile one OpenSpec file with the host's native editing capability;
5. validate the result through the host's existing OpenSpec workflow.

They must not classify files, infer domains, rebuild coverage, or recreate the composite call sequence. A shared protocol checklist and conformance tests keep Codex/Claude/Pi-facing instructions aligned even when packaging formats differ.

### 8. Preserve standalone generation as a separate facade over shared evidence

`openlore generate` continues to use the shared domain evidence and its configured LLM stages. It does not call the MCP composites. Parity means equivalent deterministic inputs and provenance for the same domain, not identical host-side prose or execution paths.

## Risks / Trade-offs

- **[Default MCP surface grows by two tools]** → Keep them high-level, read-only, clearly named, and leave the explicit navigation preset unchanged.
- **[Composite payloads become too large]** → Enforce deterministic partitions, provenance-bound cursors, and explicit receipts before rendering.
- **[Atomic and composite behavior diverges]** → Share application services and add equivalence contract tests over the same fixture.
- **[Repair historical paths are parsed inconsistently]** → Reuse canonical spec and mapping parsers; disclose unsupported or unavailable historical evidence rather than guessing paths from prose.
- **[Skills drift between hosts]** → Keep all deterministic behavior server-side and test host packages against one closed protocol checklist.
- **[A stale continuation mixes analyses]** → Bind cursors to the analysis fingerprint and reject them after analysis changes.

## Migration Plan

1. Add shared response and receipt types without changing existing atomic contracts.
2. Implement the shared generation composition and register the generation MCP tool.
3. Implement Repair sequencing, historical-path union, and the repair MCP tool.
4. Add both tools to default/full surface selection and live-data/tool-contract coverage.
5. Replace Pi's local compositions with calls to the public tools while retaining its existing entry-point names for compatibility.
6. Update and package thin host skills, then add cross-host parity tests.
7. Keep all atomic tools throughout migration; rollback removes the composites and restores Pi's prior wrappers without deleting analysis artifacts or specs.
