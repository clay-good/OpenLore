# Proposal

## Why

User-scope wiring (PR #455) is what makes "install once, every repository just works" true. A user
who installed before it shipped still has only repo-level wiring, and nothing tells them. On the
author's own machine:

- No user-scope OpenLore entry exists.
- roughlogic.com has June-era repo wiring (`npx --yes openlore mcp`, a `SessionStart` hook only).
  Its `.mcp.json` and `.claude/settings.json` are untracked, so none of its three agent worktrees
  had OpenLore at all. An August worktree session got "OpenLore is installed but no analysis was
  found" and continued without it.

`openlore doctor` checks only that a user-scope launcher still exists, not that user scope is
wired. `openlore update` upgrades the package but never the wiring.

## What Changes

- `openlore doctor` adds a **User-scope wiring** check. It warns when a repository carries
  OpenLore-managed repo wiring but the user scope has none, or when the user-scope entry is an older
  shape. The remedy is the existing `openlore install` user-scope write, offered by `doctor --fix`.
- `openlore update`, after a successful upgrade on an interactive terminal, offers the same rewire
  once (`--yes` accepts it). It never writes `~` silently.
- `openlore status` shows the wiring scope in one line: `user + repo`, `repo only`, or `none`.
- OpenLore never writes user-level configuration from a hook, the MCP server, or auto-init. That
  consent rule from `AutoInitIsConsentGuarded` is unchanged.

## Capabilities

### Modified Capabilities

- `cli`: adds `RepoOnlyWiringIsOfferedTheUserScope` and `OnlyAHumanRunCommandWritesUserConfiguration`.

## Impact

- Code: `src/cli/commands/doctor.ts` (one check plus a remediation), `src/cli/commands/update.ts`
  (the post-upgrade offer), `src/core/services/status-report.ts` (one field). It reuses the install
  writer and `withGuardedConfigWrite`.
- No new command, no new config key.
