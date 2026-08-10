# OpenLore Spec 01 — `openlore install` Auto-Configure Command

> **Status (verified 2026-06-09): IMPLEMENTED.** `openlore install` / `openlore setup` ship
> (`src/cli/install/`, `src/cli/commands/setup.ts`, registered in `src/cli/index.ts`); see
> [docs/install.md](../install.md). The `TODO(spec-01-followup)` markers in the body are deferred
> enhancements, not pending work.

> A Claude Code prompt. Paste this into a fresh Claude Code session opened at the OpenLore repo root. Treat this file as the **complete spec**: nothing else needs to be loaded.

---

## Context for you (the agent)

OpenLore (https://npmjs.com/package/openlore) is a TypeScript/Node CLI + MCP server that gives AI coding agents a persistent, deterministic, graph-native understanding of a codebase. Its current top-level scope:

1. **Static analysis** — call graph, McCabe complexity, label-propagation clusters, `CODEBASE.md` digest. No API key.
2. **Spec layer** — LLM-generated OpenSpec-compatible living specs, ADRs, drift detection.
3. **Agent runtime** — 45 MCP tools, with `orient()` as the canonical entry point. No API key.

The CLI lives in `src/cli/`. The package is published as `openlore` on npm. Bin entry: `dist/cli/index.js`.

**The current friction point this PR solves.** Agents only call `orient()` if they have been *told* to via `AGENTS.md` or `CLAUDE.md` instructions written by the user. Most users do not write those instructions. The result is that OpenLore's deterministic graph exists but the agent never consults it. We need a one-command install that wires OpenLore into the popular agent surfaces so the agent calls `orient()` *automatically*.

## Scope contract — do not break these things

This PR must NOT:

- Change the public MCP tool signatures, the `orient()` contract, or the graph schema.
- Add new runtime dependencies beyond what is strictly required to write small config files. No new framework, no daemon, no telemetry, no network calls.
- Modify the analysis or spec-generation pipelines.
- Touch the OpenSpec integration, the viewer, or the drift detector.
- Add a paid tier, a hosted service, or anything that phones home.

This PR must:

- Stay MIT-licensed and zero-config-by-default.
- Be additive only: nothing existing changes behavior unless the user runs `openlore install`.
- Pass `npm run lint`, `npm run typecheck`, `npm run test:run`, and `npm run build` clean.

## The deliverable

Add a new CLI subcommand: `openlore install`.

```
openlore install [--agent <name>] [--dry-run] [--force]
```

Behavior:

- With no `--agent`, auto-detect which of the supported surfaces are present in the cwd (or up to 3 parent dirs) by checking for marker files. Install hooks/config for every detected surface and print a summary.
- With `--agent <name>`, install only for that surface.
- With `--dry-run`, print the files that *would* be written and their diffs, write nothing.
- With `--force`, overwrite existing OpenLore-managed blocks even if modified. Without `--force`, refuse to overwrite if the OpenLore block has been hand-edited (detected via a comment fingerprint).

### Supported agent surfaces (in this PR)

1. **`claude-code`** — Claude Code (Anthropic's CLI).
   - Marker: `.claude/` directory exists *or* `CLAUDE.md` exists at repo root.
   - Action: Append (or update) an OpenLore-managed block to `CLAUDE.md` instructing the agent to call `openlore mcp` orient on session start and after any cross-module edit. Add a `SessionStart` hook to `.claude/settings.json` (create if absent) that runs `openlore orient --json` and prints the result. The hook command must be exactly `npx --yes openlore orient --json` so it works without a global install.

2. **`cursor`** — Cursor IDE.
   - Marker: `.cursor/` directory or `.cursorrules` file.
   - Action: Append (or update) an OpenLore-managed block to `.cursorrules` and write a `.cursor/rules/openlore.mdc` file describing the `orient()` workflow.

3. **`cline`** — Cline (formerly Claude Dev) VS Code extension.
   - Marker: `.clinerules` file or `.vscode/settings.json` containing `cline.*` keys.
   - Action: Append OpenLore block to `.clinerules`.

4. **`continue`** — Continue.dev.
   - Marker: `.continue/` directory or `~/.continue/config.json` referencing this repo.
   - Action: Add an OpenLore "slash command" entry to `.continue/config.json` named `/orient` that runs `npx --yes openlore orient --json`.

5. **`agents-md`** — generic fallback that always applies.
   - Action: Append (or update) an OpenLore-managed block to `AGENTS.md` (create if absent) at repo root. This is the canonical convention OpenAI Codex / others read.

### The OpenLore-managed block format

Every file we touch gets a block delimited by:

```
<!-- BEGIN OPENLORE (managed — edits inside this block will be overwritten) -->
... content ...
<!-- END OPENLORE -->
```

For JSON files, use a top-level `_openlore` key whose value object includes a `managed: true` flag and a `fingerprint` (sha256 of the canonical content we wrote). On re-run, refuse to overwrite if `fingerprint` does not match.

### The instruction text injected into markdown files

Write a single source-of-truth template in `src/cli/install/templates/agent-instructions.md` containing roughly:

```
This project uses OpenLore for persistent architectural memory.

ALWAYS call `orient()` (via the openlore MCP server, or `npx openlore orient --json`)
before reading source files when starting a new task. This returns the relevant
functions, callers, spec sections, and insertion points for the task at hand and
saves you 15,000–50,000 tokens of file-by-file rediscovery.

OpenLore prefixes tool responses with a brief, factual freshness note (the
Epistemic Lease) once your cached context has aged or the repo has moved since
your last `orient()`. It is informational — re-`orient()` if you are relying on
cached cross-module structure; otherwise carry on.

For the MCP setup, ensure `openlore mcp` is configured as an MCP server.
See https://github.com/clay-good/OpenLore for details.
```

Keep the template short, model-agnostic, and free of marketing language. The template is the same regardless of which surface receives it.

### MCP server registration

Where the surface supports MCP server registration via config (Claude Code, Cursor, Continue), `openlore install` must also register `openlore` as an MCP server, pointing at `npx --yes openlore mcp`. For Claude Code, this is `.claude/settings.json` under `mcpServers`. For Cursor, the equivalent path per current Cursor docs. For Continue, the equivalent. If you are unsure of a path, do NOT guess — gate it behind a `// TODO(openlore-spec-01): verify path` comment and log a warning during install rather than silently writing the wrong file.

### Uninstall

Also add `openlore install --uninstall` which removes any OpenLore-managed blocks and entries it can identify by fingerprint. Files that contain only an OpenLore block (and were thus created by us) get deleted; files that had pre-existing content keep that content. Idempotent.

## Files you will create or modify (approximate)

```
src/cli/install/
  index.ts                   # main entry, dispatch on --agent
  detect.ts                  # surface detection
  adapters/
    claude-code.ts
    cursor.ts
    cline.ts
    continue.ts
    agents-md.ts
  templates/
    agent-instructions.md
    cursor-openlore.mdc
  block.ts                   # block-write / fingerprint utilities
  json-managed.ts            # safe merge into JSON config files
src/cli/index.ts             # register subcommand
docs/install.md              # one-page user docs
test/cli/install/*.test.ts   # see acceptance below
```

## Acceptance criteria

A reviewer must be able to verify all of these without reading your PR description:

1. `openlore install --dry-run` in a clean repo prints the planned diffs and writes nothing.
2. `openlore install --agent claude-code` in a repo containing `CLAUDE.md` adds exactly one OpenLore-managed block, with the canonical comment delimiters, and creates `.claude/settings.json` with the `SessionStart` hook and `mcpServers` entry.
3. Running `openlore install` a second time is a no-op (fingerprint matches; nothing written; exit 0).
4. Hand-editing inside an OpenLore block, then re-running `openlore install`, prints a warning and refuses to overwrite (exit non-zero unless `--force`).
5. `openlore install --uninstall` removes the agent wiring created in the previous step and names the retained `.openlore/` data directory plus its removal command. Files that pre-existed and only had OpenLore blocks added to them are restored to their pre-install state byte-for-byte. (Test this with a git-clean fixture.)
6. All unit tests added in `test/cli/install/` pass. Test fixtures live under `test/cli/install/fixtures/` as small example trees.
7. `npm run lint`, `npm run typecheck`, `npm run test:run`, `npm run build` all pass.
8. No new runtime dependencies added (devDependencies only, ideally none).

## Git workflow — read carefully

1. Create branch `openlore-spec-01-install-command` off `main` (or whatever the default branch is — check with `git symbolic-ref refs/remotes/origin/HEAD`). If the branch already exists from a prior attempt, check it out and continue on it; do **not** create a new branch with a numbered suffix.
2. Make the changes for this spec only. No drive-by refactors. No formatting sweeps outside files you are touching. If you find a real bug in unrelated code, leave a `// TODO(spec-01-followup):` comment and mention it in the PR description — do not fix it in this PR.
3. Commit in logical chunks with messages like `spec-01: add install command skeleton`, `spec-01: claude-code adapter`, etc.
4. **Open exactly one PR** for this work, titled: `spec-01: openlore install — auto-configure agent surfaces`. The PR body must summarize the deliverable and link this spec file by path.
5. **All subsequent commits for this spec push to the same PR.** Never open a second PR for spec-01 work. If you need to redo something, push more commits to the existing branch. Use `gh pr view` to confirm the PR exists before pushing follow-up commits.
6. If the PR is approved/merged and you discover a follow-up, that follow-up is its own *new* spec file — not a commit on this PR.
7. Do not run `git push --force` to the shared branch unless you must rewrite history for a legitimate reason; if you do, narrate why in the PR.
8. Run the full local verification (`lint`, `typecheck`, `test:run`, `build`) before every push.

## When you are done

Reply with: (a) the PR URL, (b) a one-paragraph summary of what shipped, (c) any `TODO(spec-01-followup)` you left, (d) a list of files changed. Nothing else. Do not start the next spec.
