# Ship OpenLore as a Claude Code plugin

## Why

Claude Code users install OpenLore with `npm install -g openlore && openlore install`. That works,
but it writes hooks and MCP entries into their settings, and updates need a manual npm step. A
Claude Code plugin installs in one command, updates through Claude Code, and can be listed in
Anthropic's plugin directory, where it auto-updates by default. The plugin is one more install path.
npm, the Pi extension, and the MCP registry listings stay as they are.

## What changes

- A `plugin/` folder and a self-hosted `.claude-plugin/marketplace.json` in this repository.
- The plugin ships a launcher, not a runtime. On first use the launcher installs the pinned `openlore`
  package once into `${CLAUDE_PLUGIN_DATA}`, without the packages the plugin never uses.
- Default hooks at four moments (session start, prompt, after edit, before stop) and the MCP server on
  the default `substrate` preset. Hooks never wait for the install and never fail the agent's turn.
- When `openlore install` hooks exist, the plugin's hooks stay silent, so nothing runs twice.
- CI validates the plugin and runs a real `claude plugin install` on Linux, Windows, and macOS.
- After each npm release, a script pins the plugin to that version.

## What does not change

- The npm package contents, the CLI, the MCP tool set, and the Pi extension.
- No new MCP tool, no telemetry, no LLM in any hook.

## Spike results (2026-11-14, Claude Code 2.1.322)

| Fact | Consequence |
|------|-------------|
| Claude Code npm-installs a plugin's `package.json` into the plugin folder, with optional packages, `--ignore-scripts`, and a 60 s limit | For `openlore` that is 1.6 GB; 62.9 s on Windows, so the install was killed and the plugin had no runtime |
| A trimmed lockfile is rejected by `npm ci` and undone by `npm install`; `.npmrc` is not read | The plugin cannot shape Claude Code's install, so it ships no `package.json` |
| The call graph needs the native tree-sitter grammars (prebuilt, no compile needed) | They stay in the runtime; only embeddings and viewer packages are left out (822 MB) |
| LanceDB holds the keyword index | Required: without it `orient` reports no search index |
| Third-party marketplaces do not auto-update by default | The README explains how to turn it on |
| The root `.gitignore` ignored `plugin/.mcp.json` | Fixed with an exception and a test that no plugin file is ignored |
