# Bound analyze's console reports; stop leaking library warnings

`openlore analyze` floods the terminal with output nobody can read, and some of it is not even
ours. All three defects below were live-reproduced against pinned real-repo clones with a local
build. They are one class: output whose size is a property of the analyzed repository, or of a
dependency, rather than of what the user asked for.

## The gaps (all live-reproduced)

| # | Defect | Evidence |
|---|---|---|
| 1 | Unbounded single-line reports. A cycle is a strongly-connected component, so its chain can name every function in a package; a clone group can hold hundreds of generated accessors. Both were joined into one console line. | grpc/grpc-go @ `cbf30c41`: one `⚠ Cycle:` line of **36,445 characters** naming 1,347 symbols, **289** cycle lines in all, clone lines up to 8,333 characters; 81,381 bytes total. grpc/grpc @ `952c8d46`: longest line 50,713, 105,408 bytes, 358 cycle lines. |
| 2 | A third-party `[DEP0151] DeprecationWarning` leaks to the terminal, triggered by **our** grammar import: every `tree-sitter-*` package declares `"main": "bindings/node"` — a directory with no extension — which Node's ESM resolver still honors but deprecates. | grpc/grpc @ `952c8d46`: two 375-character `[DEP0151]` lines naming absolute `node_modules` paths. |
| 3 | The `yaml` library's own warnings leak to the terminal, from Helm templates our own Go-template masking turned into flow maps. | kubernetes-sigs/kustomize @ `10dc7fa0`: `Keys with collection values will be stringified … "{ .Name }"` four times. |

Found while in there, same class: the `Domains detected` inventory line (764 characters on grpc-go,
71 domains) and the `Workspace shards (detected)` detail line (739 characters on kustomize).

## What changes

1. **Rendering caps, disclosed.** A shared `src/utils/capped-list.ts` caps the printed chain
   (cycle: 8 symbols), the printed member list (clone group: 6 members), the number of cycle lines
   (10) and the flat inventories (8 names), each with the exact omitted count in the house
   `… and N more <noun>s` form. Nothing computed or stored changes: `refactor-priorities.json` and
   `duplicates.json` keep every participant, and both reports already print the artifact path.
2. **Grammar imports name their entry file.** `src/core/analyzer/grammar-entry.ts` resolves a
   grammar's real entry file with the CommonJS resolver — the exact path Node names in the warning —
   and imports that, at all 34 grammar import sites in `call-graph.ts`, `ast-chunker.ts` and
   `exception-flow.ts`. No Node warning is suppressed, no dependency added, no version changed.
3. **`yaml` diagnostics go through our logger.** Every OpenLore `yaml` parse passes
   `logLevel: 'error'` (warnings only — `'silent'` would also stop it throwing on a malformed
   document), so the library never writes to the terminal. The information is not
   discarded: `reportStringifiedCollectionKeys` re-derives the same fact from the parsed document
   and reports it on `logger.debug` — visible under `--verbose`, and now naming the file the
   library's warning never carried.

## Why this is in scope

`OutputContractsAreUniform` already made a legible CLI surface a shipped requirement; an
unreadable 36 KB line and a leaked dependency warning are the residuals a real-repo e2e sweep
found. The honesty rule is the design constraint: a cap must disclose its count, and a suppressed
warning must leave its information reachable.

## Impact

- `analyze`'s report renderers (two extracted pure functions, `renderCycleLine` /
  `renderCloneGroupLine`), the grammar import sites, and every non-contract `yaml` parse site.
- Specs: `cli` — 1 ADDED requirement (`ConsoleReportsAreBoundedAndDisclosed`).
- Risk: output-only, plus one new `Logger.isDebugEnabled()` helper. The caps are rendering-only;
  no artifact, no MCP payload and no computed value changes.
