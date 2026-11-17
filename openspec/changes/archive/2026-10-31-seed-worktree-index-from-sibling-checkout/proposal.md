# Proposal

## Why

Agents increasingly work in git worktrees (Claude Code `--worktree`, sub-agent isolation, parallel
tasks). `.openlore/` is gitignored, so a new worktree has no index. Today the first call starts a
background build and returns only `notReady` ("re-run once it completes"). On roughlogic.com that is
about 23 s; on a large repository it is minutes. In that window the agent greps. The main checkout
next door already holds a current index of nearly the same code.

## What Changes

- When a directory inside a git work tree has no index, OpenLore looks for a sibling checkout of the
  same repository (same `git rev-parse --git-common-dir`) with a published, healthy index. It looks
  at the main worktree first, then other linked worktrees.
- If one exists, OpenLore copies its analysis artifacts into this worktree. It uses a copy-on-write
  clone where the file system supports one. It serves at once and starts a background rebuild.
  - The rebuild reuses the copied per-file fact memo, so only files that differ are re-extracted.
- The answer is honest while seeded. The per-file content hashes (PR #630) mark exactly the files
  that differ from the seed as behind the working tree, and the repair marker names the reason
  `seeded`.
- The copy is validated before use: the generation manifest verifies and the edge store attests
  `healthy`. Only the known artifact names are copied, with no symlinks followed and no runtime
  state (locks, markers). Any failure falls back to today's cold build.
- This is host-neutral (Claude Code, Codex, Cursor, Pi). It does not depend on `.worktreeinclude`.

## Capabilities

### Modified Capabilities

- `cli`: adds `NewWorktreeIsSeededFromASiblingCheckout` and `SeedingCopiesOnlyVerifiedArtifacts`, beside `AutoInitIsConsentGuarded`.

## Impact

- Code: `src/core/services/one-shot-index-build.ts`, `cold-start-bootstrap.ts` (seed before
  build), a small `seedFromSiblingCheckout` helper beside `analysis-generation.ts`.
- Disk: one index copy per worktree. That is the same as a cold build's output, written sooner.
- No new MCP tool, no new config key. `autoInit: false` still disables it.

## Prior art

Cursor's indexing reuses an existing index of a similar copy as the starting point for a new one,
and filters results to files the new copy can prove it holds
([Cursor, "Secure codebase indexing"](https://cursor.com/blog/secure-codebase-indexing)).
