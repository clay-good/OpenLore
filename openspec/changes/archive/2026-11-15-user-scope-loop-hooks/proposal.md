# Wire the agent-loop hooks from a user-scope install

## Why

The briefing audit (2026-11-15) found that the edit-time and stop-time hooks — the layer with real
evidence for agents (unresolved imports, generated files, tests to rerun, what a change breaks) —
reach only repositories where `openlore install` ran at repo scope. A user-scope install, and every
git worktree (its `.claude/settings.json` is usually untracked), gets the prompt hook alone. The
Claude Code plugin already wires all hooks user-wide; npm users did not get the same.

## What Changes

- `openlore install --scope user` also wires the agent-loop moments.
- Each loop command starts with `[ -d "${CLAUDE_PROJECT_DIR:-.}/.openlore" ] || exit 0;`, so outside a
  project with `.openlore/` it exits before Node starts.
- Every user-scope command carries `--scope user`: `openlore hook` and `openlore orient` then do
  nothing when the repository's own `.claude/settings.json` or `settings.local.json` wires the same
  step with a repo-scope command, so a repository wired at both scopes gets each receipt once. This
  also stops the double prompt briefing a user-scope plus repo-scope install gave before.
- `openlore doctor` counts a user-scope command beside a repo-scope one for the same step as one
  step, not a duplicate.
- Unchanged: repo-scope installs, the plugin, `hooks.<moment>: false`, uninstall. Nothing changes
  for a user until they run `openlore install --scope user` again.
