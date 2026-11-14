# Callers across a language boundary appear in the graph

> Priority: P3 · Not built
> Reaches the agent through: `blast_radius`, `orient`, `verify_claim` (they become correct across a language seam)
> Why it helps the agent: it stops calling a Rust or Go function "dead" or "safe to change" when another language calls it through a binding.

## Problem

In a repository with two languages joined by a binding, the call graph ends at the binding. A Rust
function exported with `#[napi]` and called from every TypeScript request path has zero callers in
the graph. `blast_radius` says a change to it affects nothing, `orient` shows no callers, the
`dead` kind of `verify_claim` can hold, and no test is selected. This is a wrong answer in the
worst direction, and it is silent.

## What changes

- The existing AST walk records **declared** binding sites, from a closed first set:
  napi-rs `#[napi]`, pyo3 `#[pyfunction]` / `#[pymethods]`, wasm-bindgen `#[wasm_bindgen]`, and
  cgo `//export`. Each fact has file, line, and the bound name (the explicit `js_name` / `name`
  when given, else the kind's fixed naming rule, such as camelCase for napi-rs).
- A join pass adds an edge when an unresolved or external call in the other language has exactly
  that bound name, and exactly one binding declares it. The edge uses the existing `synthesized`
  confidence with `synthesizedBy: 'ffi-<kind>'`. No joinable pair, no edge.
- Every reader of the graph gets the fix with no change of its own: `blast_radius` and `orient`
  show the cross-language callers, `select_tests` reaches their tests, `find_dead_code` and the
  `dead` claim stop listing the bound function. `blast_radius` already counts synthesized edges
  by rule (`synthesizedEdges`), so the agent sees which callers rest on a binding.
- The language-support registry (`src/core/analyzer/language-support.ts`) gains an `ffiBridges`
  capability, derived from the live extractors.

## What does not change

- No new tool, command or field name. Answers change only where they were wrong.
- No runtime tracing, no data-flow across the boundary, no type check of the marshaled values.
- A repository with fewer than two bound languages skips the pass: no cost, no claims.
- Local only. Works without OpenSpec.

## Limits we disclose

- A foreign name built at run time (`dlsym`, `getattr` with a computed string) gets no edge. These
  sites are counted and disclosed through the confidence boundary of the affected answer.
- Two bindings with the same bound name: no edge, and the ambiguity is disclosed. No first match.
- The first set is four binding kinds. JNI names, N-API C registration, `ctypes` and others are
  not claimed; `ffiBridges` is off for them.
- The edges are a lower bound: a caller in a package outside the repository is not seen.

## Depends on

Shipped: synthesized edges with rule names, `external::` leaves
(`src/core/analyzer/call-graph-external.ts`), the confidence boundary, the capability registry.
