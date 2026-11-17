# Peer change notices: tell an agent when a peer changes what it read

> Status: SHIPPED (2026-11-01), declared read-set only; the rest moved to
> `add-peer-notices-served-set-and-fleet-records`. Split from `add-peer-footprint-board`, whose board,
> `declare_footprint`, and coordination-tool reads shipped.

## Why

The board says who is about to write what. It does not yet say, mid-task, "the peer in `../feat-b`
just changed `parseConfig`, which you read at 14:02" — the read-after-write case that the graph
alone can route to the one agent that needs it.

## What changes

| Part | What it does |
|------|--------------|
| Ledger publish | each session's ledger (`add-session-structural-ledger`) publishes the content hashes of symbols it edits to its board entry |
| After-tools notice | the after-tools hook names a peer edit that hits this session's declared read-set or served set, with the peer's worktree and when it was read; unrelated edits are quiet |
| Fleet records | fleet verification records move from per-worktree `.openlore/coordination/` to the board directory (one-time read of the old path), so a verdict one worktree proved is visible to its siblings |
| `plan_parallel_work` | an option to plan against the live board entries |

## Not built

Message transport, locks, a network service, any LLM.

## Impact

- Specs: `mcp-handlers` — 1 ADDED.
