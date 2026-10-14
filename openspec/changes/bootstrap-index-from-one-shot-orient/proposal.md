# Proposal

## Why

`openlore orient` often answers "No analysis found. Run `openlore analyze` first." The MCP server
already builds a missing index by itself (`ColdStartSelfBootstrap`), but the one-shot CLI path does
not. That path is the one install wires as agent hooks, and it is the first thing that runs in a new
git worktree, where `.openlore/analysis` does not exist yet. The agent gets no context and a manual
chore, and the next prompt gets the same answer.

## What Changes

- One-shot `orient` (`--task`, `--inject`, and the no-task primer) starts one detached background
  build when the index is absent or stale, then returns immediately. It never waits for the build.
- The not-ready answer says a build is running and to retry, not "run `openlore analyze`".
- The build uses the existing consent rules (`AutoInitIsConsentGuarded`): git work trees only,
  `autoInit: false` and `OPENLORE_NO_AUTO_ANALYZE` respected, no git hook installed.
- A repo-level lock makes the build at-most-once across processes, so many hook calls start one
  build, not many.
- **Reversal:** `OneShotOrientCarriesTheSameStalenessDisclosure` said the hook path SHALL "never
  spawn analysis". It now may spawn one detached build. It still never blocks.

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `cli`: one-shot orient self-bootstraps; the "never spawn analysis from the hook" clause is relaxed
  to "never block on analysis".

## Impact

- `src/cli/commands/orient.ts` — trigger the build on the not-ready and stale paths; primer text
- `src/core/services/cold-start-bootstrap.ts` — a detached, cross-process-locked build entry point
- `src/core/services/mcp-handlers/orient.ts` — not-ready message when a build is in flight
- No index or artifact format change
