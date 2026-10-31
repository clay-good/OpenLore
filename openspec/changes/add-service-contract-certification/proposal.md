# Service contract graph: API schemas as graph nodes, bound to the code that implements and calls them

> Status: PROPOSED (2026-07-27, field research sweep — `FIELD-RESEARCH-2026-07.md`). Widened
> 2026-10-31 (`CONTRACT-GRAPH-AND-AGENT-LOOP-2026-10.md`): the schema elements become graph nodes
> that `orient` and `blast_radius` see, with a two-way parity check between schema and code, not
> only a diff verdict. Prior art: oasdiff's classified OpenAPI change rules, buf's protobuf
> breaking-change checks, graphql-inspector for SDL, and Specmatic/Pact for spec↔implementation
> conformance. The borrow is a closed deterministic rule table and the parity question; no tool's
> rule set, plugin system, registry, or runtime is used.

## The gap

- Services bind through **schema files**: an OpenAPI document, `.proto` definitions, a GraphQL SDL.
  OpenLore does not read any of them today (no OpenAPI, protobuf, or GraphQL parser exists in
  `src/`). A removed operation, a field made required, or a narrowed type ships with no structural
  signal.
- The shipped cross-service HTTP projection (`docs/cross-service-topology.md`) already links client
  call sites to server route handlers. It knows *who calls which route*. Schema-diff tools know *what
  broke* but have no consumer graph. Nobody joins the two.
- Nothing tells an agent that a route handler it is editing is **declared** in a spec, or that a spec
  operation has **no** handler. Both are common agent errors: changing a handler's shape without the
  spec, or adding a spec operation and forgetting the route.

## What changes

1. **Contract elements are graph nodes**, projected onto the existing primitives exactly the way IaC
   is (`FunctionNode` with `language` = `OpenAPI` / `Protobuf` / `GraphQL`; `className` = the element
   kind, from a closed list: `service`, `operation`, `message`, `field`, `query`, `mutation`, `type`,
   `enum`). Stable addresses: `GET /v1/orders/{id}` (OpenAPI operation), `OrderService.GetOrder` (RPC),
   `order.v1.Order.status` (message field), `Query.user` / `User.email` (GraphQL). An operation or
   message links to its fields; `$ref`/type references become edges. No new node kind; two new call-type labels
   (`implements_endpoint`, `consumes_endpoint`, beside the existing `http_endpoint`) are the only
   edge-schema addition —
   every graph tool (`orient`, `analyze_impact`, `find_path`, `search_code`) sees them.
2. **Implements edges.** A server route handler that the HTTP route parser already extracts is linked
   to the OpenAPI operation with the same method and normalized path template (`implements_endpoint`
   label). A gRPC service implementation is linked to its RPC when the generated-server base class or
   registration call names it. Matching is literal: method + path template, or fully qualified RPC
   name. Nothing is matched by similarity.
3. **Consumes edges.** A client call site that the HTTP projection already extracts (method + literal
   path) is linked to the matching operation node by a `consumes_endpoint` label, even when no handler
   for it is in the repo — so a vendored spec for an external API (a payment provider, an internal
   platform service) still shows who calls each of its operations. A call through a generated client
   is linked when the generated module is a known generated file whose source is the spec
   (`add-generated-file-guard`) and the called method's name is the spec's `operationId`.
4. **Literal-payload check.** When a client call site's request body is an object literal (or
   `JSON.stringify` of one) and it is linked to an operation, a required request property missing from
   the literal is `contract-payload-missing-required` (registered, advisory). A non-literal body is a
   disclosed boundary — never "conforms". This is the provable part of "do my payloads match the
   schema"; mapping arbitrary DTO types to schemas stays out (below).
5. **Two-way parity, in the same tool.** With no base ref, `certify_service_contract` returns the
   contract surface plus parity:
   - `declared-unimplemented` — a schema operation with no indexed handler;
   - `implemented-undeclared` — an indexed handler on a path a discovered spec covers but does not
     declare. **Covered**, segment by segment after the spec's `servers` base path: the handler's
     parent path (all segments but the last) equals a declared operation's path or that operation's
     parent path. So with `/v1/orders/{id}` declared, `/v1/orders/export` and
     `/v1/orders/{id}/refund` are covered, while `/v1/ordersX` and `/internal/health` are not. A repo
     with no spec never gets this finding.
6. **Breaking-change verdicts** with a base ref: a closed rule table per changed element —
   `breaking` (removed operation/field/enum value, added required field/param, narrowed type, changed
   protobuf field number or type), `dangerous` (deprecation, added enum value in a response),
   `non-breaking` (additive optional). A change the table cannot prove compatible is
   `potentially-breaking`, never silently safe.
7. **Consumer join.** Each `breaking`/`dangerous` element names its in-index consumers: client call
   sites from the HTTP projection (federated repos included by stable id) and imports of declared
   generated-client modules, each with file:line and reaching tests. External consumers are a
   disclosed known-unknowable boundary.
8. **Surfacing in the always-on briefings.** `orient` on a handler includes its contract node
   (operation address, file:line of the spec, and the request constraints the schema states —
   required params and properties, `type`, `enum`, `format`, length and range bounds).
   Contract nodes are served symbols, so the session ledger (`add-session-structural-ledger`) hashes
   them and names a background edit to the spec the agent read. `blast_radius` on a diff that touches
   a schema file or an implementing handler lists the affected contract elements. Both are additive
   fields, budgeted like the rest of the briefing.
9. **Phasing:** OpenAPI 3.0/3.1 and Swagger 2.0 first (plain YAML/JSON parse, no new grammar), then
   protobuf v3, then GraphQL SDL. Each phase ships alone.

## Honesty contract

An unparseable or partially parsed schema yields `not-assessed` for its elements with the failure
disclosed, never "no changes" or "no parity gaps". Dialect features outside the table (OpenAPI
`callbacks`/`webhooks`, proto custom options, GraphQL directives) are listed per file as unassessed
element classes. A handler whose path is built dynamically is a disclosed boundary, not an
`implemented-undeclared` finding.

## Not built

Registry or network fetches (schemas come from the working tree and from `--base` via git only);
runtime traffic or schema introspection; contract tests or mock servers (Pact/Specmatic run the
service, we do not); GraphQL federation composition; code generation; matching application DTO
types to schema fields across languages (it is name-based and cannot be proven — deferred); no LLM.

## Impact

- Files: schema readers → normalized element model, projection onto graph nodes, implements-edge
  matcher over the existing route parser, rule table + differ, parity pass, consumer join, handler +
  CLI, `orient`/`blast_radius` additive fields, language-support capability `contractSchemas`.
- Specs: `analyzer` — 3 ADDED; `mcp-handlers` — 3 ADDED.
- Tool surface: +1 tool (`certify_service_contract`, `full` preset, family `change`); siblings
  `certify_public_surface` (code-export shape) and `change_impact_certificate` (paths into surfaces).
- Findings registered in `FINDING_CODE_REGISTRY`, advisory by default: `contract-breaking`,
  `contract-declared-unimplemented`, `contract-implemented-undeclared`,
  `contract-payload-missing-required`.
- `verify_claim` kinds over these edges (`endpoint-implemented`, `endpoint-consumed`) are specified in
  `add-graph-claim-kinds`.
- Risk: path-template normalization mismatch drops an implements edge (mitigated: unmatched handlers
  and operations are both listed, and parity is only claimed over matched prefixes).
