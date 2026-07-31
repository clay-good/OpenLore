# Add FFI boundary edges: the graph stops lying at the language seam

> Status: PROPOSED (2026-07-27, ecosystem research sweep). Extract cross-language binding
> declarations (N-API/napi-rs, pyo3, cgo `//export`, JNI naming, wasm-bindgen, ctypes) into a
> confidence-tiered `ffi::` edge lane, so dead-code and blast-radius conclusions in polyglot
> repos stop reporting false "no callers" at the seam. This is the residue the known-limitations
> pass named and no open change covers: "cross-language bridges … stay uncovered". Prior art on
> the blind spot: https://www.usenix.org/system/files/sec22-li-wen.pdf,
> https://arxiv.org/pdf/2602.00303.

## The gap

In a polyglot repo the call graph ends at the binding boundary with a silent lower bound in the
worst direction: a Rust function exported through napi and called from every TypeScript request
path has *zero* in-graph callers — `find_dead_code` lists it as a candidate, `blast_radius`
scopes its change at nothing, `select_tests` selects nothing. The 2026-07-25 limitations audit
explicitly verified this residue and left it uncovered by any proposal (the dynamic-boundary
pair covers single-language reflection only). The substrate already has the two patterns this
needs: synthetic provenance-labeled edges with per-rule names (`CallEdge.synthesizedBy`,
`src/core/analyzer/call-graph-types.ts:158-160`) and the `external::` leaf convention
(`call-graph-external.ts:74`).

## What changes

- **Binding-site extraction in the existing walk**: per-binding-kind extractors recognize the
  *declared* boundary constructs — attribute/macro-declared exports (pyo3 `#[pyfunction]`,
  napi-rs `#[napi]`, wasm-bindgen, cgo `//export`), registration calls (N-API
  `exports.Set`-style), and convention-named symbols (JNI `Java_pkg_Cls_method`) — emitting
  boundary facts with file/line receipts.
- **A joined `ffi::` edge lane, confidence-tiered like everything else**: a caller-side foreign
  call joined to a binding-side declaration by exact bound name yields an edge with confidence
  reflecting its evidence class — attribute-declared bindings above convention-name matches,
  both below resolved same-language edges, all labeled with the producing rule (the
  `synthesizedBy` discipline). No joinable pair, no edge.
- **Honesty at the undecidable rim**: string-computed foreign names (`dlsym`, `getattr`-built,
  reflection-loaded) are *counted and disclosed* as unresolved-binding boundaries on affected
  conclusions — the confidence-boundary contract — never guessed. Repos with fewer than two
  bound languages skip the pass entirely (no cost, no claims).
- **Consumers inherit the fix for free**: `find_dead_code` demotes bound-but-foreign-called
  symbols from clean candidates (the framework-entry-point treatment), `blast_radius` and
  `select_tests` cross the seam with the edge's confidence carried, and `get_language_support`
  gains an honest per-language `ffiBridges` capability row derived from the live extractors.

Deliberately NOT borrowed from the polyglot-analysis literature: dynamic/hybrid analysis
(runtime tracing is a settled won't-do), whole-program cross-language dataflow (PolyCruise's
lane; OpenLore adds edges, not taint), and marshaling/type-compatibility checking at the
boundary (a type-checker's job).

## Why this is in scope

Closes a named, verified, uncovered honesty gap in the graph itself — the substrate every
conclusion reads — using two shipped mechanisms (synthesis provenance, external leaves) and the
capability-registry discipline for scope truth. Deterministic extraction of declared constructs;
the undecidable rest becomes a disclosed boundary instead of a silent absence.

## Impact

- Touches: per-language extractors (binding-site recognition in the existing AST walk),
  edge-join pass, `find_dead_code` / reachability consumers, the language-support registry
  (`ffiBridges` column derived, never asserted), capability conformance fixtures per supported
  binding kind.
- No new tool; conclusions change only where they were wrong (a bound symbol stops being
  cleanly dead).
- Specs: `analyzer` — 1 ADDED requirement.
- Risk: binding-kind breadth pressure (mitigated: closed initial set with fixtures — napi/pyo3/
  cgo/JNI-name/wasm-bindgen — everything else is a disclosed non-claim via the registry);
  false edges from name collisions in convention matching (mitigated: convention matches carry
  the lower confidence tier and require the language pair to be present; ambiguity refuses per
  the no-first-match rule).
