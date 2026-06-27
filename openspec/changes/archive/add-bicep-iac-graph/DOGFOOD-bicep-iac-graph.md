# Dogfood — Bicep IaC graph

Real end-to-end `openlore analyze` on a throwaway repo (`/tmp/bicep-dogfood`) containing the two
fixture `.bicep` files plus one `app.ts`, then inspecting the produced `call-graph.db` (the same graph
every MCP tool reads). Run with `analyze . --no-embed` on `openlore@2.1.3` (this branch's build).

## Setup

```
infra/main.bicep
infra/modules/network.bicep
app.ts
```

`openlore analyze` reported **19 functions** indexed (18 Bicep nodes + 1 TS) and built the BM25 +
text-line indexes with no errors.

## Nodes (18, all tagged `Bicep`, clean bare-symbol names)

| name | type | file | external |
|------|------|------|----------|
| location | parameter | infra/main.bicep | |
| storageName | parameter | infra/main.bicep | |
| prefix | variable | infra/main.bicep | |
| fullName | variable | infra/main.bicep | |
| stg | Microsoft.Storage/storageAccounts | infra/main.bicep | |
| blob | blobServices | infra/main.bicep | |
| existingKv | Microsoft.KeyVault/vaults | infra/main.bicep | (data) |
| app | Microsoft.Web/sites | infra/main.bicep | |
| farm | Microsoft.Web/serverfarms | infra/main.bicep | (loop → 1 node) |
| network | module | infra/main.bicep | |
| shared | module | infra/main.bicep | **yes** |
| storageId / appName | output | infra/main.bicep | |
| location / prefix | parameter | infra/modules/network.bicep | |
| vnet | Microsoft.Network/virtualNetworks | infra/modules/network.bicep | |
| subnet | subnets | infra/modules/network.bicep | |
| vnetId | output | infra/modules/network.bicep | |

The `@apiVersion` is stripped from every resource type; `existing` → kind `data`; the `[for …]` loop is
a single node; the registry module `shared` (`br/public:…`) is the only external node.

## Edges (dependent → dependency) — every one correct

- **Cross-file local-module chain (the high-value edge):**
  `network → vnet [depends_on]`, `network → subnet [depends_on]` — `analyze_impact` on `vnet` surfaces
  the consuming module across files, deterministically.
- **File-scoped resolution proven:** `network → location/prefix` resolves to **main.bicep's** params;
  `vnet → location/prefix` resolves to **network.bicep's** own params. Despite both files declaring
  `param location`, there is **no cross-file `location` edge** in either direction.
- **Parent / dependsOn / symbol refs:** `blob → stg` (nested child → parent), `app → stg [depends_on]`
  **and** `app → stg [references]` (from `stg.id`), `app → existingKv/location/prefix`, `subnet → vnet`,
  `stg → fullName/location`, `fullName → prefix/storageName`.
- **Outputs:** `storageId → stg`, `appName → app`, `vnetId → vnet`.
- **No reversed parent→child edge** (`stg → blob` absent) and **no invented edges** for built-ins
  (`resourceGroup()`, `range()`, the loop var `i`) or the registry module.

## Conclusion

Bicep rides the existing IaC projector with zero MCP-tool changes: nodes are `search_code`-able, edges
power `analyze_impact`/`get_subgraph`/`blast_radius`, the cross-file module link makes a module's blast
radius traversable, and the flat per-file symbol namespace is resolved correctly (file-scoped). Verdict:
**ships.**

---

## Round 2 — adversarial review + a realistic 4-file Azure deployment (2026-06-24)

A second adversarial pass (empirically testing the compiled extractor against 15 real-world Bicep
constructs) found two **high-severity** dropped-edge bugs, both fixed:

1. **`::` nested-resource accessor** (`output id = vnet::subnet.id`) dropped the parent (`vnet`) — the
   `::` left operand was misread as an object property key. Fixed: `::` is never a key; both sides are refs.
2. **Spread operator** (`{ ...commonTags }`, `[ ...base ]`) dropped the spread source — the leading
   `...` collided with the `.property`-accessor exclusion. Fixed: consecutive dots are not member access.

The other 13 probed constructs were already correct (user-defined `type`/`func`, `loadTextContent`,
interpolated keys, `@batchSize` + loops, `targetScope`, `scope:`, `existing` + `scope:`, multi-line
arrays/objects, nested function calls, `mod.outputs.x`, `using`). No crashes on any malformed input.

Then dogfooded a realistic **subscription-scope, 4-file** deployment (`main.bicep` + `modules/`
{`storage`,`network`,`firewall`}.bicep) with decorators, `@allowed`/`@minLength`, a spread-merged tags
var, a **module loop** over a param array, a **conditional** (`= if (deployFirewall)`) module, a
**nested loop** subnet, an `existing` key vault, and `::` accessors. `openlore analyze` reported 34
functions and even flagged `sa` as a hub (fanIn=5). Graph (`call-graph.db`) verified:

- **Spread** `allTags → commonTags`; **`::`** `containerName → sa, blobService, container` (all 3 levels).
- **Cross-file module links** for every module incl. the **conditional** `firewall → fw` and the
  **loop** `network → vnet/subnet` — proving conditional and loop modules still link cross-file.
- **File-scoping holds at scale:** every `location` reference resolves within its own file; the *only*
  cross-file edges are local-module links (zero spurious symbol bleed across 4 files).
- **Loop nodes are single** (`network` module, `subnet` resource) with the signature note.

Both fixes are locked into the unit suite (`bicep.test.ts`) and the e2e path (`integration.test.ts`,
which now exercises spread + `::` through `CallGraphBuilder`). Re-verdict: **ships.**

---

## Round 3 — untested surfaces: watcher, real tools, robustness (2026-06-24)

Round 3 exercised the surfaces earlier rounds hadn't: the incremental watcher, the actual user-facing
tools (not just the raw SQLite graph), and degenerate inputs.

**Incremental watcher (`mcp --watch` / `serve`) — SAFE, now guarded.** Traced + empirically confirmed
that a `.bicep` change is treated **identically to `.tf`**: the watcher's `SOURCE_EXTENSIONS` gate
excludes all IaC, so the event is dropped at the boundary; and even via the direct `handleChange` seam
the edge-store stays untouched (IaC nodes live only in `llm-context.json`'s callGraph, which the watcher
never writes). No crash, no node-wipe, no churn. Locked in by a new parity test
(`mcp-watcher-parity.test.ts`: a `.bicep` and a `.tf` change mint no edge-store nodes and never wipe a
sibling code file's nodes).

**Real user-facing tools on a 4-file Bicep+TS repo — all WORK end-to-end** (ran the actual commands, not
DB inspection): `analyze`, `export scip` (exit 0; Bicep files present as UnspecifiedLanguage, ARM-typed
symbol names, no crash), `manifest emit` (lists `bicep: N files`), `orient`, `search_code`,
`analyze_impact` (classifies Bicep as `ecosystem: Bicep` / infrastructure, computes dependents),
`get_subgraph` + `trace_execution_path` (cross-file module traversal), and `blast-radius`
(`Layers crossed: Bicep`). No errors, stack traces, or empty-where-data-expected.

**Robustness probes (all green, locked into `bicep.test.ts`):** `.bicepparam` is **not** misclassified as
Bicep (stays `unknown` — parameter files are deferred); **forward references** resolve regardless of
declaration order; empty / comment-only / whitespace-only / unterminated-string / unterminated-brace /
unterminated-interpolation inputs **never crash** (graceful, partial graph); output is byte-identical
across repeated runs.

Two cosmetic items observed are **pre-existing and not Bicep-specific** (the analyze summary's
"internal call edges" line reads the import-graph count, which is 0 for any IaC-only tree; a blank
language row from an analyzed `.gitignore`) — both affect Terraform/all-IaC equally and are out of scope
for this change. Final verdict: **ships.**
