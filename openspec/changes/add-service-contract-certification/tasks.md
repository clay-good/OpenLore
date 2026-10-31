# Tasks — add-service-contract-certification

## Phase 1 — OpenAPI / Swagger
- [ ] Discovery: OpenAPI 3.0/3.1 (`openapi:` root key) and Swagger 2.0 (`swagger:` root key), YAML
      and JSON; contract-like candidates that were not parsed are listed with the reason
- [ ] Reader → normalized element model (operations, params, request/response schemas, fields, enum
      values); local `$ref` resolved, remote `$ref` disclosed as a boundary (never fetched)
- [ ] Projection onto `FunctionNode`/`CallEdge`/`ClassNode` (`language: OpenAPI`), stable addresses,
      element → field and `$ref` edges; language-support capability `contractSchemas`
- [ ] Implements edges: route handlers from the existing HTTP route parser ↔ operations by method +
      normalized path template (`{id}` ≡ `:id` ≡ `<id>`), labeled `implements_endpoint`
- [ ] Parity pass: `declared-unimplemented`, `implemented-undeclared` (only under a path prefix the
      spec claims); dynamic handler paths disclosed
- [ ] Closed rule table + differ: breaking | dangerous | non-breaking | potentially-breaking;
      unassessed element classes enumerated per file
- [ ] Consumer join: HTTP projection client call sites (federation by stable id) + declared
      generated-client imports; file:line + reaching tests; external consumers disclosed
- [ ] `certify_service_contract` handler + `openlore certify-service-contract [--base <ref>]` CLI;
      base via `resolveBaseRefDisclosed` (fatal on bad base)
- [ ] `orient` additive field: the contract node for a handler in scope; `blast_radius` additive
      field: contract elements touched by the diff; both budgeted
- [ ] Register `contract-breaking`, `contract-declared-unimplemented`,
      `contract-implemented-undeclared` in `FINDING_CODE_REGISTRY` (advisory)
- [ ] Wiring checklist: conclusion classification (family `change`), `full` preset, Pi
      surfaced-or-excluded, lease weights, docs table row, adjacent cross-references

## Phase 2 — protobuf v3
- [ ] Reader (services, RPCs, messages, fields with numbers, enums); nested messages flattened to
      addressable fields; parse failure → not-assessed
- [ ] Implements edges from generated-server base classes / registration calls naming the RPC
- [ ] Rule table additions: field number/type change, `reserved` violations, removed RPC

## Phase 3 — GraphQL SDL
- [ ] Reader (types, fields, queries, mutations, enums); directives listed as unassessed
- [ ] Implements edges from resolver maps whose keys are literal type/field names

## Verification
- [ ] Fixtures per format: removed operation, field made required, narrowed type, additive optional,
      deprecation; each classified per the table
- [ ] Parity fixtures: a spec operation with no handler; a handler under a spec-claimed prefix with no
      operation; a handler with a dynamic path (disclosed, not a finding); a repo with no spec (no
      parity findings)
- [ ] Consumer join: a breaking route change names its client call site + reaching tests
- [ ] `orient` on a handler shows its operation; `blast_radius` on a spec edit lists the elements
- [ ] Unparseable schema → not-assessed + disclosure, never "no changes"
- [ ] Full suite green

## Spec
- [ ] `analyzer` delta: ADD ContractSchemasAreDiscoveredAndNormalized
- [ ] `analyzer` delta: ADD ContractElementsAreGraphNodesBoundToHandlers
- [ ] `mcp-handlers` delta: ADD ContractVerdictsJoinConsumersConservatively
- [ ] `mcp-handlers` delta: ADD ContractParityIsTwoWayAndScoped
