# Ledger session counts: how the session's symbols changed

> Status: SHIPPED (2026-11-01). Split from `add-ledger-contract-hashes-and-counts`; contract and IaC
> resource hashes (and their counts) moved to `add-ledger-contract-hashes`.

## Why

`openlore status` had served/edited totals but no counts of what kind of change the session made.

## What changes

`status --json` `session.changeKinds`: `bodyOnly`, `signatureChanged`, `unclassified` (disjoint) and
`exportsChanged`, comparing each changed symbol's first observed version with its latest. The
signature is the parser's declaration line, hashed; exports come from the public-surface reader.
Counts only: no percentage, score, or threshold.

## Impact

- Specs: `mcp-handlers` — 1 ADDED.
