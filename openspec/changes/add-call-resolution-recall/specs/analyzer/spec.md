# analyzer spec delta

> Implementation note (2026-06-25): during implementation a structural audit found that the
> interface→implementation, override, and single-implementor-dispatch edge classes this proposal
> originally scoped (items 2 and 3) are **already delivered** by the shipped Class Hierarchy
> Analysis pass (`src/core/analyzer/cha.ts`, spec `add-type-hierarchy-resolved-dispatch`):
> `synthesizeVirtualDispatchEdges` resolves a `recv.m()` call over the receiver type's subtree —
> which includes interface implementors, because the subtree index is built from `implements`
> edges as well as `extends` — and `synthesizeOverrideEdges` emits base→override edges; both are
> `confidence: 'synthesized'` with a `synthesizedBy` rule (`cha-declared-type` / `cha-name-only` /
> `override`). A single-implementor injected dependency is the one-element case of that subtree
> dispatch. So this change ships the genuinely-missing class — **re-export / barrel resolution
> (item 1)** — plus the resolution-provenance disclosure (item 4), expressed by reusing the
> existing confidence channel. The interface/override/single-binding requirements below are
> therefore recorded as **already-satisfied** and cross-referenced, not re-implemented.

## ADDED Requirements

### Requirement: ReExportAndBarrelResolution

The import resolver SHALL follow re-export chains — `export { x } from`, `export * from` (and the
TypeScript ESM `.js`-specifier form of each) — through any depth of intermediate barrel module to a
symbol's true definition, so that a call to a symbol imported through a barrel resolves to the real
target rather than to the barrel or to nothing. Re-export cycles SHALL be detected and terminated, and
chain depth SHALL be bounded, so resolution never loops or runs away. The resolved import map SHALL be
applied during call-edge resolution (not only base-class resolution), so that cross-file calls resolve
at `import` confidence — or `re_export` confidence when the resolution crossed a re-export hop — instead
of falling through to the ambiguous name-only fallback. This resolution SHALL be gated to the languages
the registry marks `imports`-capable and SHALL contribute nothing (no error, no guess) where unsupported.

When no re-export chain applies, the resolved module SHALL be identical to the direct import target, so
non-barrel resolution — and directly-resolved edges — are unchanged.

#### Scenario: A call through a barrel resolves to the true definition

- **GIVEN** module `a` that calls `foo` imported from an `index` barrel, where the barrel re-exports
  `foo` from module `impl`
- **WHEN** the repository is analyzed
- **THEN** the call edge resolves to `foo` in `impl` at `re_export` confidence, and `foo` is not reported
  as dead code

#### Scenario: A direct import is labeled `import`, not `re_export`

- **GIVEN** module `a` that calls `foo` imported directly from module `impl` (no barrel hop)
- **WHEN** the repository is analyzed
- **THEN** the call edge resolves to `foo` in `impl` at `import` confidence

#### Scenario: A re-export cycle terminates

- **GIVEN** a set of barrels that re-export from one another in a cycle
- **WHEN** re-export chains are resolved
- **THEN** resolution detects the cycle and terminates rather than looping

#### Scenario: An imported call disambiguates to the imported definition

- **GIVEN** two modules each defining a function named `handler`, and a caller that imports `handler`
  from one of them
- **WHEN** the repository is analyzed
- **THEN** the call edge resolves to the imported module's `handler`, not the first same-named candidate

### Requirement: ResolutionProvenanceOnCallEdges

Every call edge SHALL carry a resolution provenance discernible from its `confidence` (and, for
synthesized edges, `synthesizedBy`) — reusing and extending the existing confidence-boundary
directly-resolved-vs-synthesized disclosure rather than adding a new channel. A re-export-resolved edge
SHALL be labeled `re_export` (a proven concrete target, costed as strongly-resolved, with the barrel hop
disclosed); a direct import SHALL be labeled `import`. A consumer of a reachability conclusion
(`analyze_impact`, `find_dead_code`, `select_tests`, `blast_radius`, `report_coverage_gaps`) SHALL
therefore be able to distinguish the part of the result that rests on proven direct edges from the part
that rests on candidate or synthesized edges. This change SHALL be additive: existing directly-resolved
edges SHALL NOT be dropped or have their resolution downgraded, and re-analysis SHALL remain
deterministic.

#### Scenario: Existing directly-resolved edges are unchanged

- **GIVEN** a repository whose call graph includes same-file, self/cls, and type-inference edges
- **WHEN** it is re-analyzed with re-export resolution enabled
- **THEN** every such directly-resolved edge is still present with its resolution unchanged, and only the
  previously-ambiguous name-only cross-file edges are upgraded to `import` / `re_export`

#### Scenario: Re-analysis is deterministic

- **GIVEN** a fixed set of sources
- **WHEN** the call graph is built twice
- **THEN** the resolved edges (targets and provenance) are byte-identical

#### Scenario: An incremental rebuild converges to a full rebuild on barrel edges

- **GIVEN** a caller that calls a symbol imported through a re-export barrel, already indexed
- **WHEN** the symbol's defining file is edited and the incremental watcher rebuilds the affected region
- **THEN** the caller's edge still resolves to the true definition at `re_export` — matching what a full
  `analyze --force` produces — rather than degrading to `name_only` because the barrel was outside the
  rebuilt subset

> Note (deferred, all fail-soft — none ever binds a wrong target):
> - **Rename across a hop.** Aliased re-exports (`export { internalName as publicName } from`) and default
>   re-exports through a barrel (`export { default } from './impl'`, consumed under a chosen local name)
>   share one root cause — the binding name differs from the export name across the hop, so the chain is
>   not chased; the edge degrades to `name_only`/`external` rather than resolving. A *direct* default
>   import (`import widget from './impl'`) still resolves. Carrying the original name through a rename is a
>   follow-up.
> - **Depth bound.** Re-export chains deeper than the bound (`REEXPORT_MAX_DEPTH`) stop mid-chain and the
>   call degrades to `name_only` (which still finds a uniquely-named target); real barrels are 1–3 hops.

### Requirement: PythonRelativeImportResolution

Python relative imports — the leading-dot module form (`from .impl import x`, `from ..pkg.mod import y`,
where N leading dots mean N package levels up) — SHALL resolve to the imported module's true file so the
cross-file call binds at `import` confidence instead of the ambiguous name-only fallback. Imports written
inside a function body (deferred / cycle-breaking imports) SHALL be captured, not only module-top-level
ones. This is gated to the `imports`-capable languages and is fail-soft.

#### Scenario: A Python leading-dot relative call resolves precisely

- **GIVEN** `pkg/caller.py` that calls `do_work` imported via `from .impl import do_work`
- **WHEN** the repository is analyzed
- **THEN** the call edge resolves to `do_work` in `pkg/impl.py` at `import` confidence

#### Scenario: A function-level relative import is captured

- **GIVEN** a call whose relative import is written inside a function body to break an import cycle
- **WHEN** the repository is analyzed
- **THEN** the import is captured and the call resolves to its definition, not left as `name_only`

## ALREADY SATISFIED (cross-referenced, not re-implemented)

### Requirement: InterfaceAndOverrideCandidateEdges

Delivered by the shipped CHA pass (`add-type-hierarchy-resolved-dispatch`). A call to an interface or
overridable method links to its in-repo implementations / overrides as labeled candidate edges
(`confidence: 'synthesized'`, `synthesizedBy: 'cha-declared-type' | 'cha-name-only'`), and base→override
edges are emitted (`synthesizedBy: 'override'`). A single implementor is the one-element case of subtree
dispatch and is still labeled a candidate. No re-implementation in this change.

### Requirement: SingleBindingIndirectionOnly

A uniquely-bound injected/factory dependency is the single-implementor case of the CHA subtree dispatch
above and is already resolved as a labeled candidate; a multi-binding or runtime-determined indirection
is left unresolved and disclosed via the confidence-boundary `knownUnknowable` channel. No new mechanism
in this change.
