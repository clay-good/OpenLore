# Modularize the call-graph builder behind a stable barrel

> Status: SUBSTANTIALLY COMPLETE — intentionally bounded (2026-06-27). Behavior-preserving refactor,
> taken in safe slices (the proposal explicitly wants this opportunistic, not a stop-the-world rewrite).
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
> **Slice 3b — `call-graph-external.ts` (DONE).** The EXTERNAL NODE HELPER section (`classifyExternal`,
> the `EXTERNAL_*` regex/set tables, `getOrCreateExternalNode`) moved out — pure external-call
> classification + leaf-node interning, depending only on the `ExternalKind`/`FunctionNode` types. All
> file-internal; only `getOrCreateExternalNode` is imported back, `classifyExternal` + the tables stay
> private to the new module. The now-unused internal `ExternalKind` binding was dropped (still
> re-exported on the barrel). call-graph.ts: 4,951 → 4,887 lines. Oracle first extended to exercise
> `externalKind` across http/db/unknown; before/after identical (SHA-256 `3a118017…`). (An additional
> clean section-banner seam beyond the proposal's illustrative module list.)
>
> **Slice 3c — `call-graph-complexity.ts` (DONE).** The CYCLOMATIC COMPLEXITY section
> (`computeCyclomaticComplexity` + the `CC_PATTERN_*` regex tables) moved out — a pure, dependency-free
> McCabe estimator. `computeCyclomaticComplexity` was exported (though no external importer), so it is
> imported back AND re-exported on the barrel to preserve the surface exactly; the patterns stay private.
> call-graph.ts: 4,887 → 4,879 lines. Oracle first extended to exercise `cyclomaticComplexity > 1` via
> branchy TS + Python fixtures; before/after identical (SHA-256 `7b765f31…`).
>
> **Slice 3d — `call-graph-cfg.ts` (DONE).** The CFG / DATA-FLOW OVERLAY HELPER section (`buildCfgFor`)
> moved out — a pure, fail-soft wrapper around `buildFunctionCfg` (./cfg.js) that body-resolves a
> declaration wrapper (const-arrow, decorated-Python def) before building the per-function CFG overlay.
> File-internal (referenced only in test comments, never imported), so imported back, not re-exported;
> the now-unused `buildFunctionCfg` import was dropped from `call-graph.ts`. call-graph.ts: 4,879 → 4,846
> lines. The oracle was first extended to serialize the full `cfgs` overlay (blocks/edges/defUse/params)
> and to exercise the arrow + decorated body-digging paths; before/after identical (SHA-256 `34c7bce5…`).
>
> **Slice 3e — `call-graph-builtins.ts` (DONE).** The callee-filtering sub-part of the grab-bag CONSTANTS
> section (the `*_IGNORED` per-language tables, `IGNORED_BY_LANGUAGE`/`ALL_IGNORED_CALLEES`, the
> `isIgnoredCallee` predicate, and `SELF_CALL_RECEIVERS`/`isSelfReceiver`) moved out — pure data + string
> predicates, zero deps, zero state. File-internal; only the two predicates are imported back, the tables
> stay private. `HUB_THRESHOLD` and the style-tally helper stay put (different concerns). call-graph.ts:
> 4,846 → 4,741 lines. The oracle was first extended with ignored-builtin calls (print/len/JSON/Math) so
> `isIgnoredCallee`'s drop-or-keep outcome is captured; before/after identical (SHA-256 `5fbe0719…`).
>
> **Each slice is verified the same four ways:** export surface byte-for-byte identical (multi-line-aware
> diff), build/lint/typecheck clean, full suite green (279 files / 5534 tests), and the byte-level
> snapshot oracle hashes identically before/after. `call-graph.ts` is now **5,425 → 4,745 lines** (−680,
> `wc -l`) across six extracted sibling modules (types, extract, external, complexity, cfg, builtins). (The
> per-slice end counts above are the post-extraction assembly snapshots that match each commit message; the
> few-line differences from the running `wc -l` are the import-back lines re-added at the top of the barrel.)
>
> **Scope decision (2026-06-27): this change is SUBSTANTIALLY COMPLETE and intentionally bounded.** The
> spec's deliverable — the `StableCallGraphBarrel` *invariant* plus a proven, repeatable,
> byte-identical-verified extraction methodology — is satisfied (demonstrated six times). That invariant
> governs HOW to extract, not a mandate to extract every section, and the illustrative module table below
> is "for example," not a checklist. All the clean, low-risk, single-concern seams are now out. The three
> remaining candidates are deliberately NOT taken here, on a value-vs-risk basis (the dominant real
> benefit is merge-contention + cognitive-load relief, which tracks churn — not recompile blast radius,
> which TypeScript's transitive rebuild largely negates):
> - **`call-graph-nodes.ts` — WON'T DO.** A 27-fan-in hub (`findEnclosingFunction`) plus mutable CFG
>   side-table machinery (`ensureUniqueNodeIds`/`materializeCfgByNodeId`) and IaC coupling
>   (`linkCodeToInfra`). Low-churn *core* machinery, so little merge-contention value, and the highest-risk
>   code in the file — a CFG side-table regression already occurred here earlier in this PR's history.
>   Relocating it behind the barrel would not reduce its coupling, only move it: net-negative ROI.
> - **`grammar-loader.ts` — DEFERRED (and NOT the clean leaf the table below implies).** On inspection,
>   grammar loading is TWO subsystems split across the file — the native parser singletons + ~13 getters
>   (~200 lines) AND a separate `_grammarHandleCache`/`warnUnavailable` handle system (~120 lines, ~1,500
>   lines away) — tied together by the shared `__resetGrammarCacheForTests` reset that a test imports.
>   Extracting it cleanly is a two-location, stateful job, not a small slice; worth doing only when
>   someone is already working in grammar loading.
> - **`call-graph-dispatch.ts` — DEFERRED (opportunistic).** The largest, highest-churn remaining section
>   (dynamic-dispatch edge synthesis) — the best *future* size + merge-contention payoff, but a big,
>   careful job whose verification needs the snapshot oracle first extended to cover synthesized edges.
>
> The barrel pattern + the snapshot-oracle recipe are documented here and across the slice commits, so any
> deferred extraction can be picked up opportunistically later — exactly the trigger this proposal always
> wanted. (The SERIALIZATION HELPER section also stays out of scope: its `extractFileStyle` calls the
> in-file language extractors, so extracting it would create a circular import.)

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
