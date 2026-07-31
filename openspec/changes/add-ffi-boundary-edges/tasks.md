# Tasks — add FFI boundary edges

## Implementation
- [ ] Binding-site extractors in the existing walk: pyo3 `#[pyfunction]`/`#[pymethods]`,
      napi-rs `#[napi]`, wasm-bindgen, cgo `//export`, N-API registration calls, JNI
      convention names; boundary facts with file/line receipts
- [ ] Join pass: caller-side foreign call × binding declaration by exact bound name →
      `ffi::`-lane edge; confidence tiers (attribute-declared > convention-name; both below
      resolved same-language); `synthesizedBy`-style rule label on every edge; ambiguity
      refuses (no first-match binding)
- [ ] Undecidable rim: dlsym/getattr-computed names counted as unresolved-binding boundaries,
      surfaced via the confidence-boundary contract on affected conclusions
- [ ] Gate: repos with < 2 bound languages skip the pass
- [ ] Consumers: `find_dead_code` demotes foreign-called symbols from clean candidates;
      reachability/blast/test-selection cross the seam with confidence carried
- [ ] Language-support registry: `ffiBridges` capability derived from live extractors

## Verification
- [ ] Per binding kind, a conformance fixture: bound function gains the edge with the right
      tier and rule label; a near-miss name does not
- [ ] Dead-code fixture: napi-exported Rust function called from TS is no longer a clean dead
      candidate, with the demotion reason disclosed
- [ ] dlsym-style computed name → no edge, unresolved-binding boundary count on the conclusion
- [ ] Name-collision fixture (two candidate bindings) → refusal, disclosed
- [ ] Single-language repo → pass skipped, zero boundary claims
- [ ] Capability matrix reports `ffiBridges` only where an extractor actually ran

## Spec
- [ ] `analyzer` delta: ADD FfiBindingsBecomeConfidenceTieredEdges
