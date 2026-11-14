# OpenLore for Claude Code

OpenLore gives Claude deterministic, local facts about your codebase: the call graph, the tests that
reach a function, the specs and decisions that govern it, and what an edit is likely to break. It
delivers them through hooks at the moments the agent can act, and through an MCP server for when the
agent wants to ask. There is no LLM in this path and nothing leaves your machine.

## Install

```bash
claude plugin marketplace add clay-good/OpenLore
claude plugin install openlore@openlore
```

No config is needed. To get each release without asking, turn on auto-update for this marketplace:
run `/plugin`, open **Marketplaces**, select `openlore`, and choose **Enable auto-update**. Claude
Code does not auto-update third-party marketplaces unless you do this. The first prompt in a repository starts a background index build (seconds for a
small repo, a few minutes for a large monorepo). Until it finishes, the hooks say so and stay out of
the way.

Requires Node.js 22.22 or later on your `PATH`.

## What the agent gets

| Moment | Hook | What the agent sees |
|--------|------|---------------------|
| Session start | `SessionStart` | A short primer for the repository. After a compaction, a handoff briefing. |
| Prompt submitted | `UserPromptSubmit` | The functions, callers, specs, and insertion points relevant to the prompt. |
| Before an edit | `PreToolUse` (edit tools) | A warning when the file is generated from another source. |
| After an edit or a shell command | `PostToolUse`, `PostToolUseFailure` | Findings about the edit, and a record of test runs. |
| Before stop | `Stop` | One receipt: what the session changed, which tests reach it, and what drifted. |

The MCP server (`openlore`) exposes 15 read-only tools, such as `orient`, `search_code`,
`blast_radius`, `recall`, and `verify_claim`.

Every hook fails open: if OpenLore cannot answer, the agent continues without it.

## What it runs, writes, and sends

**Runs:** `node` with the `openlore` npm package that this plugin installs into its own folder. The
hooks and the MCP server run on your machine. A first run or a stale index starts one detached
`node` process that rebuilds the index and then exits.

**Writes, in each repository you use it in:**

- `.openlore/`: the index, analysis files, session records, and `config.json`.
- `.gitignore`: one `.openlore/` line, added when it is missing.
- `openspec/specs/`: an empty folder, created on first run. Git does not track empty folders.

It writes nothing outside the repository, apart from the plugin's own folder.

**Sends and fetches:** nothing, in this plugin's default setup.

- No telemetry.
- The npm update check is off inside hooks and MCP, because it runs only in an interactive terminal.
- Semantic embeddings (a model download from Hugging Face) are off by default. They turn on only if
  you set them in `.openlore/config.json`.
- Spec generation, chat, and the graph viewer call an LLM provider. They are separate `openlore`
  CLI commands that you start yourself; this plugin never starts them.

Claude Code installs the plugin's npm dependencies from the npm registry when you install or update it.

## Use with the `openlore` CLI

If you already ran `openlore install` in a repository, its hooks and MCP entry are still in your
Claude settings, and both sets run. Run `openlore uninstall` in that repository to keep only the
plugin. The CLI stays useful for the status line, git hooks, and the `openlore` commands.

## Links

- Source and full docs: <https://github.com/clay-good/openlore>
- Security policy: <https://github.com/clay-good/openlore/blob/main/SECURITY.md>
- License: MIT
