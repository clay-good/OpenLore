# Tasks — add-service-contract-certification

## Implementation
- [ ] Schema discovery + readers: OpenAPI (root-key detection), `.proto`, GraphQL SDL → one
      normalized element model; parse failures per file recorded, candidates listed
- [ ] Closed rule table + differ: breaking | dangerous | non-breaking | potentially-breaking
      per changed element; unprovable ⇒ potentially-breaking (conservative construction stated
      in output); unassessed element classes enumerated per file
- [ ] Consumer join: route-keyed client call sites from the cross-service HTTP projection
      (federation by stable id) + declared generated-client imports; per consumer file:line +
      reaching tests; external/unindexed consumers disclosed as unknowable, never absent
- [ ] `certify_service_contract` handler + `openlore certify-service-contract` CLI; base-ref
      resolution via the shared disclosed helper (fatal-on-bad-base, certification discipline)
- [ ] Wiring checklist: conclusion classification (family `change`), `full` preset, Pi
      surfaced-or-excluded, lease weights, docs table row, adjacent cross-references

## Verification
- [ ] Fixtures per format: removed operation, field-turned-required, narrowed type, additive
      optional, deprecation; each classified per the table
- [ ] Consumer join: a breaking route change names its client call site + reaching tests; an
      unmatched route discloses the boundary
- [ ] Unparseable schema → not-assessed + disclosure, never "no changes"
- [ ] No-base invocation returns the surface listing; bad base is fatal with the shared message
- [ ] Full suite green

## Spec
- [ ] `analyzer` delta: ADD ContractSchemasAreDiscoveredAndNormalized
- [ ] `mcp-handlers` delta: ADD ContractVerdictsJoinConsumersConservatively
