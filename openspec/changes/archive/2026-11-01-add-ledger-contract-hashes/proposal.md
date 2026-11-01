# Ledger: contract and resource hashes

> Status: PROPOSED (2026-11-01). Split from `add-ledger-contract-hashes-and-counts`, whose session
> counts for code symbols shipped in `add-ledger-session-counts`.

## Why

The session ledger tracks code symbols. An agent that read `POST /v1/checkout` from `openapi.yaml`, or
an IaC resource, is not told when a teammate changes it, and the session counts have no contract or
resource entries.

## What changes

| Part | What it does |
|------|--------------|
| Canonical hashes | OpenAPI operations and IaC resources tracked like symbols, hashed as SHA-256 over their parsed, sorted fields: a reformat is not a change, a changed field is |
| Counts | `changeKinds` gains `contractElementsChanged` and `iacResourcesChanged` |

## Impact

- Specs: `mcp-handlers` — 1 ADDED.
