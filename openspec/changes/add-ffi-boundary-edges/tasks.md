# Tasks — add-ffi-boundary-edges

## 1. Binding sites

- [ ] 1.1 New `src/core/analyzer/ffi-bindings.ts`: recognize the four declared binding kinds in the
      existing walk (`src/core/analyzer/call-graph-extract.ts`) and emit a fact with file, line,
      kind and bound name. Test: new `ffi-bindings.test.ts`, one fixture per kind. Done when each
      fixture yields the right bound name, including an explicit `js_name` / `name` override.
- [ ] 1.2 Count computed foreign names (`dlsym`, computed `getattr`) as unresolved-binding sites
      in the same module. Test: `ffi-bindings.test.ts`. Done when such a site yields a count and
      no fact.

## 2. Join

- [ ] 2.1 Join pass in `src/core/analyzer/call-graph.ts`: an unresolved or `external::` call whose
      name equals exactly one bound name becomes a `synthesized` edge with
      `synthesizedBy: 'ffi-<kind>'`. Test: `src/core/analyzer/call-graph.test.ts`. Done when the
      bound function gains the caller, a near-miss name does not, and two candidate bindings
      yield no edge and a disclosed ambiguity.
- [ ] 2.2 Skip the pass when fewer than two bound languages are present. Test:
      `call-graph.test.ts`. Done when a single-language repository produces a byte-identical graph.
- [ ] 2.3 Keep the incremental path equal to a full analyze in
      `src/core/services/mcp-watcher.ts`. Test: `mcp-watcher-parity.test.ts`. Done when editing a
      binding file yields the same edges as a fresh analyze.

## 3. Readers

- [ ] 3.1 Dead code and the `dead` claim: a function called only through a binding is not a clean
      candidate. Tests: `src/core/services/mcp-handlers/reachability-synthesis.test.ts`,
      `claim-verification.test.ts`. Done when a napi-exported Rust function called from
      TypeScript is not listed, and the reason names the rule.
- [ ] 3.2 `blast_radius` and `orient` cross the seam, and unresolved-binding sites reach the
      confidence boundary (`confidence-boundary.ts`). Tests: `blast-radius.test.ts`,
      `orient.test.ts`, `completeness-invariant.test.ts`. Done when the TypeScript callers appear
      with the `ffi-napi` rule counted in `synthesizedEdges`.

## 4. Registry and docs

- [ ] 4.1 Add `ffiBridges` to `CAPABILITIES` in `src/core/analyzer/language-support.ts`, derived
      from the extractors. Tests: `language-support.test.ts`, `src/pi/extension.test.ts` (MCP↔Pi
      parity for the matrix). Done when the cell is on only where an extractor ran.
- [ ] 4.2 Document the four kinds and the limits in `docs/language-support.md` and
      `docs/reachability-dead-code.md`. Done when both list what is not claimed.
