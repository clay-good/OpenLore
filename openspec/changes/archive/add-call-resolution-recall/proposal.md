# Call resolution recall: resolve the edges OpenLore silently misses, so its negative conclusions hold

> Status: IMPLEMENTED (2026-06-25) — branch `feat/call-resolution-recall`. Part of the
> `FEATURE-UPDATES.md` set. Raises call-graph completeness by resolving common edge classes the analyzer
> currently misses — re-exports/barrels, interface→implementation and overrides, and
> statically-resolvable indirection — in-process, with every recovered edge labeled by how it was
> resolved and every irresolvable one disclosed. No graph-schema change, no spawned language server, no
> LLM. **Scope deviation (recorded below): a structural audit found items 2 and 3
> (interface/override candidates, single-binding indirection) are already delivered by the shipped CHA
> pass (`add-type-hierarchy-resolved-dispatch`). This change therefore ships the genuinely-missing class —
> re-export / barrel resolution (item 1) — plus the resolution-provenance label (item 4, a new
> `re_export` confidence), and cross-references the rest as already-satisfied.** See "Implementation
> status" at the foot.

## Why

This is the least glamorous proposal in the set and the most important, because it sits under all the
others. Every conclusion OpenLore is trusted for is a statement about the call graph:
`find_dead_code` says "nothing reaches X," `select_tests` says "these are all the reaching tests,"
`analyze_impact` and `blast_radius` say "this is the full set affected." Each of those is a **negative
or completeness claim**, and a negative claim is only as sound as the graph is complete. If the graph
silently misses an edge, "nothing reaches X" becomes a *false* negative — the most dangerous kind of
error for a tool whose entire value proposition is honesty. A competitor invests heavily here precisely
because breadth without resolution accuracy produces confident wrong answers.

OpenLore already resolves direct calls and has partial import and type resolution
(`import-resolver-bridge.ts`, `type-inference-engine.ts`, `cpp-header-resolver.ts`). But three common
patterns routinely defeat it, and each one silently drops real edges:

1. **Re-exports / barrels.** An import that comes through an `index` barrel which re-exports the symbol
   from elsewhere (`export { foo } from './impl'`, `export * from './x'`) — the call resolves to the
   barrel, or to nothing, instead of to the true definition. In a codebase organized around barrels (the
   norm in large TypeScript projects), a large fraction of cross-module edges run through exactly this
   path.
2. **Interface → implementation and overrides.** A call to an interface method, an abstract method, or a
   base-class method that subclasses override links to the declaration only, so every concrete
   implementation looks unreachable through that call site — `find_dead_code` then reports live
   implementations as dead.
3. **Statically-resolvable indirection.** Common dependency-injection and factory patterns where a single
   concrete binding is visible in-repo (a handler registered once, a constructor-injected dependency with
   one in-repo implementor) — resolvable deterministically, currently dropped.

Closing these raises the floor under every conclusion tool at once.

## What changes

1. **Re-export / barrel resolution.** The import resolver SHALL follow re-export chains
   (`export { x } from`, `export * from`, default re-exports) to the symbol's true definition, so a call
   imported through any depth of barrel resolves to the real target. Cycles in re-export graphs are
   detected and terminated, not followed forever.

2. **Interface→implementation and override edges (as labeled candidates).** A call to an interface or
   abstract method SHALL additionally link to the in-repo implementations of that method as **candidate
   edges**, and an override SHALL link to the declaration it overrides. Because a call site to an
   interface may dispatch to any implementor, these are emitted as **labeled candidates**
   (`resolution: interface-candidate` / `override`), never as a single guessed concrete target — so
   reachability can include them while a consumer can still distinguish a proven direct edge from a
   candidate one.

3. **Statically-resolvable indirection only.** Indirection (DI, factory, single-binding registries) SHALL
   be resolved **only when exactly one concrete in-repo target is statically determinable**. Multi-binding
   or runtime-determined indirection SHALL remain unresolved — disclosed, not guessed.

4. **Every recovered edge is labeled by how it was resolved (honesty).** Each call edge SHALL carry a
   resolution provenance: `direct`, `re-export`, `interface-candidate`, `override`, or
   `single-binding`. This reuses and extends the existing confidence-boundary "directly-resolved vs.
   synthesized" disclosure rather than adding a new channel, so a consumer of `analyze_impact` can see
   which part of a blast radius rests on proven edges and which on candidates. Truly dynamic dispatch
   (computed member access, reflection, runtime string dispatch) stays **unresolved** and is reported as a
   known-unknowable boundary — the existing posture — never invented.

5. **Gated per language, fail-soft.** Each resolution class is gated through the
   `add-declarative-language-support-registry` capability flags, so it applies only where the analyzer
   can do it soundly and contributes nothing (no error, no guess) where it cannot — the established
   fail-soft contract. Determinism is preserved: resolution is a pure function of the indexed sources.

## Decision

**Improve recall with labeled candidates and single-binding-only indirection — never trade soundness for
recall.** The guiding rule: it is acceptable to *add* a labeled candidate edge that a consumer can
discount, and it is acceptable to leave a dynamic call unresolved and disclosed; it is **not** acceptable
to emit a single concrete edge the analyzer is guessing. So interface dispatch yields candidates (plural,
labeled), indirection resolves only when the target is unique and static, and everything else is
disclosed as unresolved. This raises completeness for the conclusions that depend on it while keeping the
"never assert an edge we cannot justify" invariant that makes those conclusions trustworthy.

## Scope contract — do not break these things

This change must NOT:
- Emit a single guessed concrete target for a polymorphic or runtime-determined call. Candidates
  (labeled) or unresolved (disclosed) only.
- Spawn a language server or run a type checker/compiler. Resolution is static and in-process.
- Drop or relabel existing direct edges. The change is additive recall plus provenance labels.
- Follow re-export or inheritance cycles without termination. Cycles are detected and bounded.
- Apply a resolution class to a language whose registry record does not back it. Fail-soft.
- Use an LLM or introduce non-determinism.

## Out of scope (deferred)

Cross-language call resolution (e.g. an FFI or a build-tool-generated binding); full data-flow-based
points-to analysis (the CFG overlay covers intraprocedural data flow; whole-program points-to is a much
larger effort); multi-binding DI resolution beyond the single-binding case; and resolution that would
require executing build tooling or a package manager.

## Implementation status

**Shipped (item 1 + item 4):**
- **Re-export-aware import map** — `buildResolvedImportMap()` in `src/core/analyzer/import-resolver-bridge.ts`
  follows `export { x } from`, `export * from`, and the TS ESM `.js`-specifier forms through any depth of
  barrel to a symbol's true definition module, with re-export-cycle detection and a depth bound
  (`REEXPORT_MAX_DEPTH`). It is a strict superset of `buildBaseImportMap`: when no re-export chain applies
  the resolved module is identical to the direct target.
- **Threaded into Pass 2 call-edge resolution** — `CallGraphBuilder.build()` now derives the resolved map
  internally (production callers never threaded one, so Strategy-3 import resolution was *dormant*) and
  applies it to call edges, with an anchored prefix match (`x.` / `x/`) instead of a bare `startsWith`.
  The same map is reused for base-class resolution (Pass 7) and CHA receiver-type resolution.
- **`re_export` resolution provenance** — a new `EdgeConfidence` value (cost 1, strongly-resolved) labels
  edges whose name was followed through a re-export chain; a direct import stays `import`. Provenance flows
  through the existing confidence-boundary channel, so `analyze_impact` / `find_dead_code` / `select_tests`
  / `blast_radius` / `report_coverage_gaps` distinguish proven vs candidate without a new channel.
- **Python relative-import resolution** — a full-product dogfood on a real Python repo surfaced that
  Python imports produced *zero* `import` edges: the leading-dot module form (`from .impl import x`,
  `from ..pkg.mod import y`) was not resolved by the shared path join, and function-level (deferred)
  imports were skipped by the parser's line-anchored regex. Fixed both (`resolvePythonRelative` +
  allowing indented imports in `parsePythonImports`), completing the Pass-2 import threading for the
  `imports`-capable language it was already gated to. Dogfood: `import` 0 → 102, `name_only` 156 → 58 on
  that repo; the registry's Python `imports` capability is now functional.
- **Incremental-watcher parity** — an adversarial parity test surfaced that a barrel a caller imports
  through is absent from an incremental rebuild's subset (it is neither the changed file nor a caller), so
  re-export edges silently degraded to `name_only` on the next edit. `collectReExportBarrels`
  (`import-resolver-bridge.ts`) follows the chain and `buildGraphSubset` pulls the barrel files into the
  build for export-indexing only (their own edges are filtered out), so an incremental rebuild converges
  to `analyze --force` on barrel edges (parity oracle Scenario 4).

**Already satisfied (items 2 & 3 — not re-implemented):** the interface→implementation, override, and
single-implementor-dispatch edge classes are delivered by the shipped CHA pass
(`src/core/analyzer/cha.ts`, `add-type-hierarchy-resolved-dispatch`). See the `## ALREADY SATISFIED`
section of the analyzer spec delta for the cross-reference.

**Tests** (`src/core/analyzer/call-resolution-recall.test.ts`, 12 cases): named-barrel, `export *`, depth-N
chain, direct-import-stays-`import`, cross-file disambiguation, re-export-cycle termination, determinism,
the superset property over `buildBaseImportMap`, and a regression gate asserting same-file edges keep
their label and only the barrel-crossed edge wears `re_export`. Full suite green (5063 tests); lint,
typecheck, build clean.

**Dogfood** (`DOGFOOD-call-resolution-recall.md`): re-analyzing this repo, ambiguous `name_only` call
edges fell from **1067 → 87** (−92%), precise cross-file edges rose from **0 → 1326 `import` + 21
`re_export`**, and `external` (unresolved) fell **8742 → 8563**; strongly-resolved `type_inference` edges
were unchanged (85 → 85). A previously-`name_only` call such as `spec-pipeline.ts → isTestFile` (imported
through the `artifact-generator` barrel that re-exports it from `test-file.ts`) now resolves to the true
definition at `re_export` confidence.
