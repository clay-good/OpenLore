# Graph claim kinds: contract and governance hypotheses through `verify_claim`

> Status: SHIPPED (2026-11-01, `CONTRACT-GRAPH-AND-AGENT-LOOP-2026-10.md`). No new tool.
> `lease-current` moved to `add-session-ledger-runs-contracts-tokens`, which builds lease tokens.

## Why

`verify_claim` answers structural and decision-authority questions with a verdict and a receipt. It
could not answer "is `POST /v1/checkout` implemented here?", "does anything call it?", or "does a
recorded decision govern `DeprecatedHandler`?".

## What changes

| Kind | Subject | Confirmed | Refuted | Unverifiable |
|---|---|---|---|---|
| `endpoint-implemented` | `METHOD /path` | an indexed route handler serves it; receipt names the handler | declared, no handler; receipt names the spec file and line | not in any readable spec; no route inventory; no server route indexed |
| `endpoint-consumed` | `METHOD /path` | a client call site in this repository calls it; receipt lists them | none in this repository — stated as scoped, other callers named as not visible | not in any readable spec |
| `decision-governed` | a symbol | an authoritative decision or memory is anchored to it; receipt lists ids and freshness | none; draft, superseded, or orphaned records listed as not governing | the symbol is unknown or ambiguous; a store cannot be read |

Matching for the endpoint kinds is the literal rule of `certify_service_contract` (method and path
template, base path and parameter names optional). The base and parameter forms of an address match.

## Not built

A free-form hypothesis language; DTO↔schema mapping claims; federated consumers (a named boundary);
new verdict values.
