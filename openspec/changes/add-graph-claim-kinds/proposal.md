# Graph claim kinds: let agents test contract, governance, and lease hypotheses with `verify_claim`

> Status: PROPOSED (2026-10-31, `CONTRACT-GRAPH-AND-AGENT-LOOP-2026-10.md`). Four new kinds for the
> existing `verify_claim` tool. No new tool.

## The gap

The design note asked for a `verify_hypothesis` tool that takes a structural question and returns a
verdict with the path that proves it. `verify_claim` already is that tool: it returns
`confirmed | refuted | unverifiable` with a receipt and, for reach claims, the path
(`claim-verification.ts`). Its kinds are `calls`, `reaches`, `impacts`, `dead`, `safe-to-change`, and
`decision-current`. None of them answers the questions the new changes make answerable:

- "Is `POST /v1/checkout` implemented here?" / "Does anything call `/v1/webhooks/stripe`?"
- "Does removing `DeprecatedHandler` touch a recorded decision?" (`safe-to-change` looks at callers,
  not decisions)
- "Is what I (or my parent agent) read still current?"

## What changes

| Kind | Subject | Confirmed when | Refuted when | Unverifiable when |
|---|---|---|---|---|
| `endpoint-implemented` | operation address (`POST /v1/checkout`, `OrderService.GetOrder`) | an `implements_endpoint` edge exists; receipt names the handler | the spec declares it and no handler is bound | the spec file is not assessed, or the address is not in any spec |
| `endpoint-consumed` | operation address | a `consumes_endpoint` or `http_endpoint` edge reaches it in the index (federated repos included); receipt lists the call sites | no indexed consumer — stated as "no consumer in the indexed repositories"; external callers are a named boundary | the spec is not assessed |
| `decision-governed` | symbol | an authoritative decision or memory is anchored to it; receipt lists ids and freshness | none is anchored | the symbol is not in the index |
| `lease-current` | a `leaseToken` | every (address, hash) in the token still matches | any entry changed; receipt lists them | the token is unknown or expired |

Each verdict carries the existing receipt shape, so the "proof path" the note asked for is the
receipt's edge chain.

## Honesty

`endpoint-consumed` never claims "nobody calls this": refuted is scoped to the indexed repositories and
says so. `decision-governed` uses the recall freshness rules — an orphaned memory is listed as
orphaned, not as governing.

## Not built

A free-form hypothesis language; an "is field X mapped consistently across model and message" kind
(that needs DTO↔schema matching, which cannot be proven by name); new verdict values.

## Impact

- Files: four evaluators in `claim-verification.ts`, kind enum and docs.
- Depends on: `add-service-contract-certification` (endpoint kinds), `add-session-structural-ledger`
  (`lease-current`). `decision-governed` has no dependency and can ship first.
- Specs: `mcp-handlers` — 1 ADDED.
- Tool surface: none added; `verify_claim` is already in the default `substrate` preset.
