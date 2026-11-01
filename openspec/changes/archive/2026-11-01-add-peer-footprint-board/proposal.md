# Peer footprint board: who is about to touch what, across the worktrees of one clone

> Status: SHIPPED (2026-11-01, `CONTRACT-GRAPH-AND-AGENT-LOOP-2026-10.md`). Peer change notices,
> the fleet store move, and planning against the board moved to `add-peer-change-notices`.

## Why

Parallel agents in worktrees fail together: overwrites, duplicated work started at claim time,
merge conflicts that are structural. Transports (A2A, team mailboxes) carry messages but have no
code graph. OpenLore's coordination tools computed hazards only for a caller-supplied snapshot and
forgot it; sibling worktrees never saw each other.

## What changes

| Part | What it does |
|------|--------------|
| Board | one JSON entry per live agent in `<git-common-dir>/openlore/board/`, shared by every worktree of the clone; atomic writes, fail-open reads, at most 64 entries |
| `declare_footprint` (coordination preset) + `openlore footprint declare\|release\|list` | publish write-set/read-set (resolved by the `plan_parallel_work` footprint machinery, each symbol hashed); hazards vs every live peer in the same response |
| `duplicate-intent` | two write-sets that create the same symbol name or file (registered finding, advisory) |
| Lease end | release, merged branch, deleted branch, removed worktree, or 30 minutes without a refresh (the panic-state session expiry); `movedSinceDeclared` for declared symbols whose text changed |
| Readers | `map_in_flight_conflicts` adds live entries as agent tasks; `fleet_status` lists them |

Titles are redacted and withheld when instruction-shaped; every peer field is screened and served as
`local-unreviewed`. Advisory: nothing is locked.

## Not built

Message transport, locks, spawning or assigning work, a network service, boards across clones, any LLM.
