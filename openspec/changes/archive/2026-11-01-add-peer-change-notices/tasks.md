# Tasks — add-peer-change-notices

- [x] Peer edits computed from the board and the peer's worktree (replaces a ledger publish step): `src/core/services/peer-notices.ts`
- [x] After-tools hook: a peer edit to my declared read-set → one neutral line, once per session; unrelated → nothing
- [x] Tests: peer edit in my read-set is named; unrelated edit quiet; older peer base quiet; no board quiet
- [x] Spec: `mcp-handlers` ADD PeersAreToldWhenASymbolTheyReadChanges (declared read-set)
- Moved to `add-peer-notices-served-set-and-fleet-records`: served-set notices, fleet records on the board, `plan_parallel_work` board option
