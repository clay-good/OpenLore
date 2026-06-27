# Modularize the call-graph builder behind a stable barrel

> Status: PROPOSED (2026-06-26). Spec-only change describing a behavior-preserving refactor.
> `src/core/analyzer/call-graph.ts` is 5,425 lines and is simultaneously the repository's most-imported
> file (155 importers) and a high-churn hotspot. This change proposes decomposing it into cohesive
> sibling modules **behind an unchanged public barrel**, so the 155 importers do not move and behavior
> is byte-identical. No feature, no dependency, no LLM. Medium priority — best done opportunistically
> while already working in the file, not as an urgent stop-the-world refactor.

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
