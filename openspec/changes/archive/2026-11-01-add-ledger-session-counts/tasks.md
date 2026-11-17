# Tasks — add-ledger-session-counts

- [x] Ledger hasher records a declaration-line hash and an export flag per symbol
- [x] First observed version kept apart (versions are trimmed); `changeKinds()` net of first and latest
- [x] Snapshot and `status --json` carry `changeKinds`; the persisted ledger round-trips it
- [x] Tests: 2 body-only + 1 signature + 2 exports; changed-and-back not counted; no threshold fields
- [x] Spec: `mcp-handlers` ADD SessionCountsAreExposedAsData
