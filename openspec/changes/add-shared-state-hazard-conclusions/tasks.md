# Tasks — add shared-state hazard conclusions

## Implementation
- [ ] Extract module-level mutable bindings during the existing walk (TS/JS `let`/`var` + mutated
      module objects; Python module globals assigned outside a function; Go package-level `var`)
- [ ] Join to the persisted CFG/def-use overlay: per binding, line-precise reader and writer sites
      with enclosing function
- [ ] Backward reachability for writers (callers) + reaching tests, reusing the shipped traversals
- [ ] Detect `read → await → write` on one binding inside a single function; report
      `interleaved-update` with all three lines
- [ ] `boundaries`: aliased/dynamic writes, unresolved receivers, unanalyzable callees, truncation,
      index staleness — each counted and located where possible
- [ ] Unsupported language → explicit `unsupported` result, never an empty hazard set
- [ ] `analyze_shared_state` handler + `openlore shared-state` CLI; register family + conclusion
      class; cross-reference `analyze_error_propagation` (and effect purity if it ships)
- [ ] No governance finding code is registered by this change; output is advisory census only

## Verification
- [ ] Census: a module counter written by two functions and read by three lists all five sites
- [ ] Blast radius: an indirect caller of a writer appears; an unrelated function does not
- [ ] `interleaved-update` fires on read/await/write of one binding and does NOT fire when the
      await is outside the read-write pair or the binding differs
- [ ] Lower-bound honesty: a write through an alias is absent from the writer set AND present in
      `boundaries`; the result never states the binding is unshared or safe
- [ ] Unsupported language fixture (Ruby) returns `unsupported`, not an empty result
- [ ] Scoping: `--symbol` and `--file-pattern` restrict the census; truncation emits a receipt
- [ ] Conclusion-shape assertion + tool-contract test pass

## Spec
- [ ] `mcp-handlers` delta: ADD SharedStateConclusionsAreASoundLowerBoundNotARaceVerdict
