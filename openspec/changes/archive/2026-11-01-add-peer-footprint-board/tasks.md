# Tasks — add-peer-footprint-board

- [x] Board store at `<git-common-dir>/openlore/board/` (atomic write, fail-open read, 64-entry and 256 KB bounds); entry shape with write/read symbols, hashes, creations, worktree, branch, title, timestamps
- [x] `declare_footprint` MCP tool + `openlore footprint declare|release|list`; resolution through `change-footprint.ts`; hazards vs live peers in the same response
- [x] Wiring: conclusion, family `coordinate`, `coordination` preset, Pi exclusion with reason, lease weight, live-data driver (list), payload and token budgets re-baselined, docs rows, CLI/MCP parity, read-only audit (board reads never write; pruning only from the writing tool)
- [x] `map_in_flight_conflicts` reads live entries as agent tasks; `fleet_status` lists them
- [x] `duplicate-intent` hazard + registered finding (advisory)
- [x] Lease end: release, branch merged/deleted, worktree removed, 30-minute expiry; `movedSinceDeclared`
- [x] Title redaction + instruction-shaped withholding; `local-unreviewed` provenance on peer fields
- [x] Tests: sibling worktrees see each other, separate clone does not; duplicate-intent; every end reason; fresh branch not "merged"; moved symbols; title screening; board tasks
- [x] Moved to `add-peer-change-notices`: peer read-after-write notices, fleet record move, planning against the board
