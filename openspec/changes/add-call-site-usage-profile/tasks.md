# Tasks — add-call-site-usage-profile

## 1. The count

- [ ] 1.1 New `src/core/analyzer/call-site-profile.ts`: for one symbol, read its resolved call
      sites from the graph, parse each call expression, and count the four facets. Test: new
      `call-site-profile.test.ts`. Done when a fixture with 20 call sites matches hand counts.
- [ ] 1.2 Honest gaps in the same module: spread or dynamic arguments counted as `uncountable`;
      synthesized and `name_only` edges left out with a count; other languages return nothing.
      Test: `call-site-profile.test.ts`. Done when no facet total silently drops a site.
- [ ] 1.3 Evidence floor and examples: reuse `STYLE_EVIDENCE_FLOOR`; pick up to 3 examples in the
      fixed order. Test: `call-site-profile.test.ts`. Done when a symbol with 2 call sites yields
      no profile and example order is stable across runs.

## 2. Surfaces

- [ ] 2.1 Add `callProfile` to target functions in `src/core/services/mcp-handlers/orient.ts`,
      inside the existing token budget. Test: `orient.test.ts`. Done when the field appears only
      above the floor and the response stays within budget.
- [ ] 2.2 Print the one-line profile in `src/cli/commands/orient-inject.ts` when the injection has
      room. Test: the existing inject test beside it. Done when the block stays under its bound.
- [ ] 2.3 In `src/core/services/mcp-handlers/blast-radius.ts`, attach `callProfile` to a changed
      function whose parameter list differs from the merge-base (parsed the same way on both
      sides). Test: `blast-radius.test.ts`. Done when an added required parameter yields the
      profile and a body-only edit does not.
- [ ] 2.4 Classify the uncountable and excluded counts in `confidence-boundary.ts`. Test:
      `completeness-invariant.test.ts`. Done when the test passes.

## 3. Guards and docs

- [ ] 3.1 MCP↔Pi parity for the new field. Test: `src/pi/extension.test.ts`. Done when it passes.
- [ ] 3.2 Document `callProfile` in `docs/mcp-tools.md` with one example and the limits. Done when
      the doc says "observed counts, not a rule".
