# Tasks — add call-site usage profile

## Implementation
- [ ] Symbol resolution per the `find_clones` discipline: not-found + candidates; ambiguous →
      `name::path` candidates; never an empty profile implying "never called"
- [ ] Census: resolved call sites from the EdgeStore (edge lines), re-read + parse each call
      expression; facets: arity distribution, literal-vs-variable per position, named/keyword
      options, result context (awaited/returned/assigned/discarded), enclosing try/error context
- [ ] Honesty: evidence-floor nulls per facet; spread/dynamic args → `uncountable` (disclosed);
      synthesized/low-confidence-edge sites excluded and disclosed; unsupported language →
      explicit `unsupported`
- [ ] Output `{ dominant, ratio, samples }` with file:line sample receipts; wording is observed
      frequency, never correctness
- [ ] `get_usage_profile` handler (family `navigate`, class `conclusion`; siblings:
      `get_style_fingerprint`, `get_subgraph`) + `openlore usage-profile --symbol <name>
      [--max <n>] [--json]`

## Verification
- [ ] Fixture with 20 call sites: dominant arity/option/await facets match hand counts, with
      receipts
- [ ] Below-floor facet → null, not a guess
- [ ] Spread-arg site → uncountable for arity, counted for result-context
- [ ] Unknown symbol → not-found + candidates; ambiguous name → path candidates
- [ ] Synthesized-edge site excluded with disclosure
- [ ] tools/list payload budget re-asserted or bumped with rationale

## Spec
- [ ] `mcp-handlers` delta: ADD CallSiteUsageProfileIsDescriptive
