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
- One build per repository at a time, across processes: the existing full-analysis ownership lock
  plus an attempt stamp. A finished attempt is not repeated for 2 minutes, so a build that cannot
  succeed is not restarted on every prompt.
- **Reversal:** `OneShotOrientCarriesTheSameStalenessDisclosure` said the hook path SHALL "never
  spawn analysis". It now may spawn one detached build. It still never blocks.

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `cli`: one-shot orient self-bootstraps; the "never spawn analysis from the hook" clause is relaxed
  to "never block on analysis".

## Impact

- `src/core/services/one-shot-index-build.ts` (new) — the detached build, its guards, and the
  supervisor process
- `src/cli/commands/orient.ts` — starts the build; not-ready, primer, and `--inject` text
- No index or artifact format change
