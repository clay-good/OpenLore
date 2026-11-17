# Service contract certification (OpenAPI phase)

> Status: SHIPPED (2026-11-01). Research: `FIELD-RESEARCH-2026-07.md`,
> `CONTRACT-GRAPH-AND-AGENT-LOOP-2026-10.md`. Prior art: oasdiff's classified change rules and the
> spec-to-implementation question of Specmatic/Pact; no tool's rule set or runtime is used.
> Graph projection, briefings, payload checks, protobuf, and GraphQL moved to
> `add-contract-graph-projection`.

## Why

Services bind through API schemas. OpenLore did not read any. A removed operation or a field made
required shipped with no signal, and nothing told an agent that a spec declares a route no handler
serves, or that a handler serves a route the spec omits. The cross-service HTTP projection already
knows who calls which route; schema-diff tools know what broke. Nothing joined the two.

## What changes

New tool `certify_service_contract` (`full` preset, family `change`) and CLI
`openlore certify-service-contract [--base <ref>]`:

| Mode | Returns |
|------|---------|
| No base ref | Operations each OpenAPI 3.x / Swagger 2.0 document declares; two-way parity with the indexed route handlers |
| `--base <ref>` | One closed-table verdict per changed element vs the merge-base, breaking and dangerous ones joined to in-repo client call sites; `suggestedBump` |

| Class | Rules |
|-------|-------|
| `breaking` | removed operation; added required param or request property; param, body, or property made required; changed param or property type; response property removed or made optional |
| `dangerous` | deprecated operation; widened response property type (new enum value, `null`) |
| `non-breaking` | added operation, optional param or property, response property; removed param; widened request property type |
| `potentially-breaking` | any other schema difference (constraints, nested schemas, `oneOf`/`anyOf`, external `$ref`, status codes), found by hashing what the rules do not compare |

Findings, advisory by default: `contract-breaking`, `contract-declared-unimplemented`,
`contract-implemented-undeclared`.

## Honesty contract

A specification that cannot be parsed is `notAssessed`, never "no changes". External `$ref`,
`callbacks`, and `webhooks` are listed as outside the model. Parity is not claimed when no route
inventory or no server route exists. Dynamic-path routes and callers in other repositories are
disclosed boundaries.

## Not built

Network fetches, runtime traffic, contract tests, code generation, any LLM. See
`add-contract-graph-projection` for the rest of the original scope.
