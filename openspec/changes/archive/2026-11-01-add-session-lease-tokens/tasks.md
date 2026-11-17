# Tasks — add-session-lease-tokens

- [x] Token store `.openlore/session-ledger/tokens/` (gitignored with the ledger, 12-hour lifetime, at most 500 kept)
- [x] `leaseToken` on `orient` and `recall`, attached in the shared dispatcher (MCP and CLI)
- [x] `verify_claim` kind `lease-current`; schemas, Pi, docs
- [x] Tests: confirmed → refuted naming the changed symbol; unserved symbol edit keeps it current; file-level and removed entries; reformat not a change; unknown/malformed/expired; nothing served → no token
- [x] Moved to `add-ledger-contract-hashes-and-counts`: canonical contract/IaC hashes, session counts
