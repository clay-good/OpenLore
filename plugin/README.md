# OpenLore for Claude Code

OpenLore gives Claude deterministic, local facts about your codebase: the call graph, the tests that
reach a function, the specs and decisions that govern it, and what an edit is likely to break. It
delivers them through hooks at the moments the agent can act, and through an MCP server for when the
agent wants to ask. There is no LLM in this path, and your code never leaves your machine.

## Install

```bash
claude plugin marketplace add clay-good/OpenLore
claude plugin install openlore@openlore
```

No config is needed. Requires Node.js 22.22 or later on your `PATH`.

**First use.** The plugin ships a small launcher, not the runtime. On the first hook it installs the
pinned `openlore` npm package once, in the background: about 15 s on macOS or Linux, about two
minutes on Windows, longer on a slow link. The first prompt says so; briefings start when it finishes. Then the first
prompt in each repository starts a background index build (seconds for a small repo, minutes for a
monorepo).

**Updates.** To get each release without asking, turn on auto-update for this marketplace: run
`/plugin`, open **Marketplaces**, select `openlore`, and choose **Enable auto-update**. Claude Code
does not auto-update third-party marketplaces unless you do this. A new version installs its new
runtime on first use and removes the old one.

**Build progress.** A plugin cannot set your status line, so build progress is not shown by
default. To see it (`OpenLore: indexing 45% (1,310/2,900 files)`), install the `openlore` CLI and
set `"statusLine": { "type": "command", "command": "openlore statusline" }` in
`~/.claude/settings.json`. The agent is never told about a build.

## What the agent gets

| Moment | Hook | What the agent sees |
|--------|------|---------------------|
| Session start | `SessionStart` | A short primer for the repository. After a compaction, a handoff briefing. |
| Prompt submitted | `UserPromptSubmit` | The functions, callers, specs, and insertion points relevant to the prompt. |
| After an edit or a shell command | `PostToolUse`, `PostToolUseFailure` | Findings about the edit, and a record of test runs. |
| Before stop | `Stop` | One receipt: what the session changed, which tests reach it, and what drifted. |

The MCP server (`openlore`) exposes 15 read-only tools, such as `orient`, `search_code`,
`blast_radius`, `recall`, and `verify_claim`.

Every hook fails open: if OpenLore cannot answer, the agent continues without it.

## What it runs, writes, and sends

**Runs:** `node` with `runtime/openlore.mjs` from this plugin for each hook and for the MCP server.
On first use of a version it runs `npm install` once, in a detached process. A first run or a stale
index in a repository starts one detached `node` process that rebuilds the index and then exits.

**Fetches:** on first use of each plugin version, `npm install` downloads the pinned `openlore`
package and its dependencies from the npm registry (your npm configuration applies). Nothing else.

**Writes:**

- In Claude Code's data folder for this plugin (`${CLAUDE_PLUGIN_DATA}`, removed on uninstall):
  `runtime/<version>/` (the npm packages, about 820 MB) and `install.log`.
- In each repository you use it in:
  - `.openlore/`: the index, analysis files, session records, and `config.json`;
  - `.gitignore`: one `.openlore/` line, added when it is missing;
  - `openspec/specs/`: an empty folder, created on first run. Git does not track empty folders.

**Sends:** nothing. No telemetry, and no code or index data leaves your machine.

- The npm update notifier does not run: it only prints in an interactive terminal.
- Semantic embeddings are off, and the plugin does not install their packages.
- Spec generation, chat, and the graph viewer call an LLM provider. They are separate `openlore`
  CLI commands that you start yourself; this plugin never starts them.

## Use with the `openlore` CLI

If you ran `openlore install`, its hooks stay in your Claude settings. The plugin sees them and keeps
its own hooks silent, so nothing runs twice. The CLI's MCP entry and the plugin's server both start;
run `openlore uninstall` to keep only the plugin. The CLI stays useful for the status line, git
hooks, and the `openlore` commands.

## Links

- Source and full docs: <https://github.com/clay-good/openlore>
- Security policy: <https://github.com/clay-good/openlore/blob/main/SECURITY.md>
- License: MIT
