# Ledger: contract and resource hashes, and session counts

> Status: PROPOSED (2026-11-01). Split from `add-session-lease-tokens`, whose lease tokens and
> `lease-current` shipped.

## Why

The session ledger tracks code symbols. An agent that read `POST /v1/checkout` from `openapi.yaml`, or
an IaC resource, is not told when a teammate changes it; and `openlore status` has no per-session
counts of what kind of change the agent made.

## What changes

| Part | What it does |
|------|--------------|
| Canonical hashes | OpenAPI operations and IaC resources tracked like symbols, hashed as SHA-256 over their parsed, sorted fields: a reformat is not a change, a changed field is |
| Session counts | `status --json`: body-only, signature-changed (disjoint), exports, contract elements, IaC resources — counts only |

## Impact

- Specs: `mcp-handlers` — 2 ADDED.
