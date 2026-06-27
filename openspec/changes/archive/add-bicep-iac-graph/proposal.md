# Bicep graph: Azure Bicep resource/module dependency edges on the existing IaC projector

> Status: IMPLEMENTED (2026-06-24) — branch `feat/bicep-iac-graph`. Closes the first-listed item on
> spec-07's "Out of scope (future specs)" line: *Bicep, ARM JSON, Kustomize, …*. Builds directly on
> the spec-07 IaC subsystem (`src/core/analyzer/iac/`): the normalized
> `IacResource`/`IacReference`/`IacGraph` intermediate and the single `project.ts` projector onto
> `FunctionNode`/`CallEdge`/`ClassNode`. No graph-schema, MCP-tool, or `orient` changes.
> Decision recorded before code (see "Decision" below). See "Implementation status" at the foot.

## Why

OpenLore already ingests the major IaC ecosystems — Terraform, Kubernetes, Helm, CloudFormation,
Ansible, Pulumi, CDK, CDKTF (and, in flight, Docker) — by projecting a normalized resource graph onto
the existing call-graph primitives, so `orient`, `search_code`, `get_subgraph`, `analyze_impact`, and
`blast_radius` answer "who depends on this?" over infrastructure with zero tool changes.

**Azure has no first-class coverage.** AWS is reachable through CloudFormation and CDK; the
multi-cloud/generic path is Terraform and Pulumi. But **Bicep** — Microsoft's purpose-built DSL and the
language Azure teams actually write today (ARM JSON is increasingly the compiled output, not the source)
— is invisible. A `.bicep` file produces zero nodes: every resource, module, and the dependency wiring
between them is dark. "If I change this storage account / this module, what breaks?" is exactly a
graph-reachability question, and for a coding agent editing Azure infrastructure the answer is currently
"the tool sees nothing."

Bicep is the first-listed item under spec-07's explicit "Out of scope (future specs)" — a deliberate
follow-up, not a new direction. It maps cleanly onto the existing primitives; it is
dependency-graph-shaped, dependent → dependency, just like the rest of IaC:

| Bicep concept | OpenLore graph primitive |
|---|---|
| A `resource <name> 'type@version' = { … }` | a node (`FunctionNode`), typed by the resource type |
| A `resource <name> 'type' existing = { … }` | a node, kind `data` (a reference to a pre-existing resource) |
| A `param` / `var` / `output` declaration | a node (`variable` / `value` / `output`) |
| A `module <name> 'path' = { … }` | a node **and** a `ClassNode` grouping |
| A registry/remote module (`br/…`, `ts/…`) | an external node (`isExternal`) |
| `parent: <res>` / `dependsOn: [ … ]` | an edge, child/dependent → dependency (`references`/`depends_on`) |
| A symbol used in a property value (`x: stg.id`) | an edge, the declaring symbol → the referenced symbol |
| `module 'm' …` whose params reference resources | edges, module → each referenced symbol |
| A **local** `module './net.bicep'` | edges, module → every resource declared in `net.bicep` (cross-file) |

The high-value edge is the **cross-file** one: a local module's path resolves to the target `.bicep`
file, and the module is linked to the resources that file declares. So a single `analyze_impact` on a
shared module surfaces every resource it deploys, and `analyze_impact` on a resource surfaces the
outputs, vars, and sibling resources that depend on it — end to end, deterministically, no LLM.

## What changes

1. **One new IaC language tag** — `Bicep` — added to the `IacLanguage` union and `IAC_LANGUAGES` (the
   single source of truth for IaC dispatch and gating). It rides the existing projector, so
   `isIacLanguage` already treats it as infra everywhere (dead-code roots, cross-domain linking, graph
   handlers, SCIP export).

2. **A `bicep.ts` extractor.** A single `extractBicep(files)` parses `.bicep` files with a tolerant,
   hand-rolled scanner (the same parser-choice rationale as Terraform's HCL scanner — see Decision) and
   returns a normalized `IacGraph`:
   - **Nodes** for every `resource` (typed by `Microsoft.Foo/bar`, `@version` stripped), `param`, `var`,
     `output`, and `module`. `existing` resources are kind `data`. Nested child resources (a `resource`
     declared inside another resource's body) become their own nodes with an implicit `parent` edge to
     the enclosing resource. A loop declaration (`= [for … : { … }]`) yields a **single** node (matching
     Terraform `count`/`for_each`), noted in the signature.
   - **File-scoped addresses.** Bicep resolves bare identifiers (`stg`, `location`) against a **flat
     per-file symbol table** — there are no `var.`/`type.name` prefixes as in Terraform, so the same
     symbolic name (`location`, `name`) recurs across files. Addresses are therefore scoped by file
     (`<filePath>::<symbol>`); references resolve **within the file only**, so two files each declaring
     `param location` never cross-link. The single legitimate cross-file path is a local `module`, handled
     explicitly (below).
   - **Edges (dependent → dependency).** `parent:` → child → parent. `dependsOn: [ … ]` → dependent →
     each listed symbol (`depends_on`). Every other bare symbol that appears in a declaration's value and
     matches a same-file declared symbol → declaring symbol → referenced symbol (`references`), including
     symbols inside `${…}` string interpolations, `.property` access bases (`stg.id` → `stg`), both sides
     of the `::` nested-resource accessor (`vnet::subnet`), and spread sources (`{ ...commonTags }`).
     Property **keys** (`name:`), function names (`resourceGroup()`), and string literal text are not
     references.
   - **Modules.** A `module 'path'` whose path starts with `./`/`../` or is a bare relative `*.bicep` is
     **local**: it links (cross-file) to every resource declared in the resolved target file and lists
     them as `ClassNode` members. A `br/…`, `br:…`, `ts/…`, or `ts:…` path is a **remote/registry**
     module → an external node. Module `params:` reference same-file symbols like any other body.
   - **Determinism & honesty.** Output is sorted by the projector, so re-analysis is byte-identical.
     Unresolvable references emit **no edge** (`TODO(spec-07-followup): dynamic …`), never a wrong one —
     the projector drops any reference whose target is not a declared node, so a candidate that matches no
     symbol is silently dropped rather than invented.

3. **Detection by extension in `detectLanguage`, like Terraform.** `.bicep` is unambiguous, so it is
   recognized in `detectLanguage` (the same path `.tf` uses), not the YAML `classifyYaml` router and not
   the Dockerfile name-matcher. `CALL_GRAPH_LANGS` gains `Bicep` so the files reach the IaC projection
   pass. `extractSignatures` gains a `Bicep` case so resources/params/modules are also `search_code`-able
   as signatures (matching how Terraform contributes signatures).

## Decision

**Parser choice: a tolerant, hand-rolled Bicep block scanner — no tree-sitter / no native grammar.**
Rationale, identical to the Terraform HCL decision (`src/core/analyzer/iac/terraform.ts` header):
`tree-sitter-bicep`/the Bicep compiler are heavy, native, or .NET-bound build/install surfaces, and IaC
extraction only needs declaration boundaries + symbol-reference detection, not a full AST or type
checker. A pure-JS scanner keeps the dependency tree flat and install-clean, is fully deterministic, and
never evaluates Bicep (no compile, no ARM emit, no Azure API). Consequence: deeply dynamic constructs
(computed symbol names, fully-templated module paths) resolve to no edge by design rather than being
guessed — consistent with every other IaC ecosystem.

## Scope contract — do not break these things

This change must NOT:
- Change the `FunctionNode` / `CallEdge` / `ClassNode` schema, the MCP tools, or `orient`. Bicep rides
  the existing primitives, exactly like spec-07.
- Regress any existing language or IaC ecosystem. All current extractors and tests stay green.
- Cross-link symbols between files. Bicep's flat per-file namespace means addresses are file-scoped; the
  only cross-file edges are explicit local `module` links.
- Evaluate anything: no `bicep build`, no ARM template emit, no Azure API or registry calls. Static
  parse only.
- Over-promise precision. Emit only statically-resolvable edges; for the rest emit nothing and leave a
  `TODO(spec-07-followup): …`.

## Out of scope (deferred)

ARM JSON templates (the compiled output; a natural CloudFormation-shaped follow-up), Bicep `import`/user
-defined functions and types, `.bicepparam` parameter files, decorators as metadata, cross-file `module`
**output** type-resolution (we link the module to the file's resources, not to specific output symbols),
and incremental-watch of `.bicep` files (matches all IaC today — full re-analyze picks up changes).

## Implementation status

Tracked in `tasks.md`. Verified by `src/core/analyzer/iac/bicep.test.ts` (unit) and the IaC
`integration.test.ts` (end-to-end through `CallGraphBuilder`), plus a dogfood run recorded in
`DOGFOOD-bicep-iac-graph.md`.
