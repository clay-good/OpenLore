# Tasks — add-service-contract-certification (OpenAPI phase)

- [x] Discovery: OpenAPI 3.x / Swagger 2.0, YAML and JSON, from `git ls-files` (tracked and untracked, not ignored); vendored and build directories skipped; a spec that cannot be parsed is listed `notAssessed`
- [x] Reader → normalized model (operations, params, request and 2xx response properties, enum values); local `$ref` bounded; external `$ref`, callbacks, webhooks listed as outside the model; YAML alias expansion bounded
- [x] Closed rule table + differ; operations matched by address across files
- [x] Parity against the route inventory, with and without the base path; dynamic paths disclosed
- [x] Consumer join over in-repo client call sites (`extractHttpCalls` + `buildHttpEdges`)
- [x] `certify_service_contract` handler and `openlore certify-service-contract` CLI; base via `resolveBaseRefDisclosed`, error on an unresolved base unless the fallback is allowed
- [x] Register `contract-breaking`, `contract-declared-unimplemented`, `contract-implemented-undeclared` (advisory)
- [x] Wiring: conclusion, family `change`, `full` preset, Pi exclusion with reason, lease weight, live-data driver, docs rows, CLI/MCP parity, base-ref parity
- [x] Tests: reader, rule table, parity, handler on a temporary repository; full suite green
- [x] Moved to `add-contract-graph-projection`: graph nodes and edges, `orient`/`blast_radius` fields, reaching tests and federated consumers, payload check, protobuf, GraphQL
