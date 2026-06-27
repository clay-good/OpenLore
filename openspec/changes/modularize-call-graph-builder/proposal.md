# Modularize the call-graph builder behind a stable barrel

> Status: IN PROGRESS (first slice landed 2026-06-27). Behavior-preserving refactor, taken in safe
> slices (the proposal explicitly wants this opportunistic, not a stop-the-world rewrite).
> `src/core/analyzer/call-graph.ts` was 5,425 lines and is the repository's most-imported file
> (155 importers) and a high-churn hotspot. It is being decomposed into cohesive sibling modules
> **behind an unchanged public barrel**, so the 155 importers do not move and behavior is byte-identical.
> No feature, no dependency, no LLM.
>
> **Slice 1 — `call-graph-types.ts` (DONE).** The full TYPES section (the edge/node/class model,
> `CallGraphResult`/`SerializedCallGraph`, `CALL_DISTANCE_COSTS`/`callDistance`, the layer helpers
> `layerOf`/`classifyLayerEdge`) moved out behind the barrel; `call-graph.ts` re-exports every public
> name (`RawEdge`/`CALL_DISTANCE_FALLBACK` stay internal, off the surface). call-graph.ts: 5,425 → 5,150
> lines. Snapshot `131ba4c6…`. A `stable call-graph barrel` test locks the re-export invariant.
>
> **Slice 3 — `call-graph-extract.ts` (DONE).** The DOCSTRING / SIGNATURE EXTRACTION HELPERS section
> (`extractDocstringBefore`, `extractDeclaration`) moved out — two pure string-scanning functions with
> zero dependency on the rest of the analyzer. They were file-internal (never on `call-graph.ts`'s
> public surface), so they are imported back, NOT re-exported: the surface is unchanged. Taken before
> slice 2 as the safest small slice. call-graph.ts: 5,150 → 4,951 lines. The snapshot oracle was first
> strengthened to serialize each node's `docstring` + `signature` (so both moved functions are exercised
> across TS + Python), then captured before/after: identical (SHA-256 `58107ac0…`).
>
> **Each slice is verified the same four ways:** export surface byte-for-byte identical (multi-line-aware
> diff), build/lint/typecheck clean, full suite green (279 files / 5534 tests), and the byte-level
> snapshot oracle hashes identically before/after. Remaining slices (`call-graph-nodes.ts`,
> `call-graph-dispatch.ts`, `grammar-loader.ts`) are unstarted — one per commit, same gates.

## The gap

`call-graph.ts` has become a god file. The evidence:

- **5,425 lines** — by far the largest source file (next is `mcp.ts` at 2,555).
- **155 importers** — the single most-imported file in the repository, so any edit to it has the
  widest possible recompile/blast radius.
- **High churn** — it sits on nearly every analyzer change, which means many unrelated reasons to edit
  one file, and frequent merge contention (the current branch already hit a CFG side-table regression
  while re-keying nodes inside it).

The file is not *tangled*, though — it already carries clear `// ===` section banners that mark natural
seams: the type/edge model, node-identity and CFG materialization, docstring/declaration extraction,
CFG building, query/dedup/dispatch-synthesis, and grammar loading. The seams are drawn; the modules are
just not yet separate files. That is what makes this a low-risk mechanical extraction rather than a
redesign.

## Is it worth doing?

Yes — but as **medium priority**, opportunistically. The cost of the file is real (blast radius, merge
contention, cognitive load), and the seams already exist, so the extraction is cheap and safe. But
there is no behavior bug forcing it, and a careless split that changes the *public import surface*
would touch 155 files for no functional gain. So the discipline matters more than the urgency: do it
behind a stable barrel, preserve every export, change no behavior, and land it when already in the
file.

## What changes (the refactor this spec governs)

Decompose `call-graph.ts` along its existing section banners into cohesive sibling modules, for example:

| New module | Moves out of `call-graph.ts` |
|---|---|
| `call-graph-types.ts` | edge/node/class types, `CallGraphResult`, `SerializedCallGraph`, `CALL_DISTANCE_COSTS`, `callDistance`, layer helpers |
| `call-graph-nodes.ts` | `ensureUniqueNodeIds`, `materializeCfgByNodeId`, `findEnclosingFunction`, `linkCodeToInfra` |
| `call-graph-extract.ts` | `extractDocstringBefore`, `extractDeclaration` |
| `call-graph-dispatch.ts` | `dedupeOverlappingCalls`, `synthesizeJavaSuperCalls`, `safeQuery` and the dispatch-synthesis helpers |
| `grammar-loader.ts` | grammar cache/load, `warnUnavailable`, `__resetGrammarCacheForTests` |

`call-graph.ts` retains the `CallGraphBuilder` orchestrator and **re-exports every symbol the modules
move**, so it remains the stable public barrel. No importer of `call-graph.ts` changes.

The single hard invariant: **the public import surface and the runtime behavior are unchanged.** Every
name currently importable from `call-graph.ts` stays importable from `call-graph.ts`; the extracted
build produces byte-identical graph output for a fixed repository state.

## Why this is in scope

Pure internal hygiene on the substrate's most central file. No new capability, dependency, LLM, or
persisted artifact. It makes the substrate cheaper and safer to evolve, which directly serves the
north star (`overview/spec.md`, `c6d1ad07`) by lowering the cost of every future analyzer change.

## Impact

- Specs: `analyzer` (1 ADDED requirement fixing the stable-barrel + behavior-preservation invariant).
- Code (the refactor itself, a later change): move functions into sibling modules; re-export from
  `call-graph.ts`; no importer edits; existing analyzer tests must pass unchanged as the regression
  oracle (a graph snapshot before/after SHALL be byte-identical).
- Risk: low *if* the barrel invariant holds; the risk to manage is an accidental change to the import
  surface or to extraction ordering. The existing analyzer test suite is the guardrail.
- Priority: medium. Do opportunistically; do not block feature work on it.
