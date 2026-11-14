# Design

## Layout

```
.claude-plugin/marketplace.json      self-hosted marketplace, source "./plugin"
plugin/
  .claude-plugin/plugin.json         name, version (= the pinned openlore), icon.png
  .mcp.json                          node ${CLAUDE_PLUGIN_ROOT}/runtime/openlore.mjs mcp --preset substrate
  hooks/hooks.json                   exec-form node hooks through the same launcher
  runtime/openlore.mjs               the launcher (Node built-ins only)
  runtime/package.json, lockfile     the pin; NOT at the plugin root, so Claude Code installs nothing
  skills/openlore-orient/SKILL.md
  README.md, LICENSE
```

## The launcher

| Situation | Hook | MCP server |
|-----------|------|------------|
| Not started by Claude Code (`CLAUDE_PLUGIN_DATA` unset) | exit 0, silent | exit 0 |
| `openlore install` hooks found in user or project settings | exit 0, silent | runs |
| Runtime ready | runs the CLI in-process | runs the CLI in-process |
| Node older than 22.22 | one line, exit 0 | one line, exit 0 |
| Not installed | starts one detached install; one line; exit 0 | starts it and waits (up to 10 min) |
| Install failed in the last 10 min | one line naming the error and log | exits 1 |

- Install: copy the pin files to `runtime/<version>.tmp-<pid>`, run `npm install --omit=optional
  --ignore-scripts --no-save --legacy-peer-deps` plus openlore's optional packages except
  embeddings and viewer, at the lockfile's versions, plus this machine's LanceDB binding. Then write
  `.ready` and rename the folder into place. Remove older versions.
- A lock folder keeps installs to one at a time; it goes stale after 15 min.
- npm runs as `node <npm-cli.js>` beside the running node binary, so no shell is needed on Windows.
- Only `orient` hooks print the one-line notes: their plain output reaches the agent.

## Why not the alternatives

- **Claude Code's own install:** cannot leave out optional packages; fails on Windows.
- **Change the npm package's optional packages:** npm CLI users would lose embeddings, the viewer,
  or the native grammars. Current users must keep working.
- **Commit a bundled runtime:** over the directory's size and file-count limits.

## Release flow

After `vX.Y.Z` is on npm, run `node scripts/sync-plugin-version.mjs` and merge
`chore(plugin): pin openlore X.Y.Z`. The lockfile records the published tarball, so it cannot be
part of the release commit. `plugin-manifest.test.ts` checks that pin, manifest version, and
lockfile agree.
