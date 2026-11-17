# Fleet records on the board; plan against the board

> Status: SHIPPED (2026-11-01). Split from `add-peer-notices-served-set-and-fleet-records`, which
> shipped peer notices for served functions.

## Why

Fleet verification records stay in each worktree's `.openlore/coordination/`, so a verdict one
worktree proved is not visible to its siblings. `plan_parallel_work` also plans only the task list
it is given, not the agents already on the board.

## What changes

| Part | What it does |
|------|--------------|
| Fleet records | move to the board directory in the git common directory (one-time read of the old path) |
| `plan_parallel_work` | an option to add the live board entries to the planned tasks |

## Not built

Message transport, locks, a network service, any LLM.

## Impact

- Specs: `mcp-handlers` — 1 ADDED.
