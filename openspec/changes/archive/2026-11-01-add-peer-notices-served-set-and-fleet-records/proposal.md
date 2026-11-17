# Peer notices for the served set; fleet records on the board

> Status: SHIPPED (2026-11-01), served-set notices only; fleet records and the planning option
> moved to `add-board-fleet-records-and-planning`. Split from `add-peer-change-notices`, which shipped notices for
> the declared read-set.

## Why

An agent often reads code it never declared: what `orient` or `recall` served it. A peer's change to
that code is the same read-after-write risk. Fleet verification records also stay per worktree, so a
verdict one worktree proved is not visible to its siblings.

## What changes

| Part | What it does |
|------|--------------|
| Served-set notices | the after-tools peer notice also covers symbols the session was served (lease tokens, `add-session-lease-tokens`), with the time served |
| Fleet records | fleet verification records move from per-worktree `.openlore/coordination/` to the board directory (one-time read of the old path) |
| `plan_parallel_work` | an option to plan against the live board entries |

## Not built

Message transport, locks, a network service, any LLM.

## Impact

- Specs: `mcp-handlers` — 1 ADDED.
