# Contributing to openlore

Thank you for your interest in contributing. This document covers how to set up your development environment, run tests, and submit changes.

## Development Setup

**Requirements:** Node.js ≥ 22.5.0, npm ≥ 9

```bash
git clone https://github.com/clay-good/openlore
cd openlore
npm install
```

> **Windows (PowerShell):** if `npm install` fails with _"running scripts is disabled on this system"_, run this once to allow npm scripts for your user account:
> ```powershell
> Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned
> ```

Build TypeScript (outputs to `dist/`):

```bash
npm run build
```

Run the CLI directly during development (no build step needed):

```bash
npm run dev -- init
npm run dev -- analyze
npm run dev -- generate
```

To use the `openlore` command directly (instead of `npm run dev --`), link the package globally after building:

```bash
npm link
```

After that, `openlore init`, `openlore analyze`, etc. all work. Re-run `npm run build` before using the linked binary when you change source files.

## Agent Context Setup (one-time, after cloning)

This repo **dogfoods OpenLore's own tools**, so your coding agent can be oriented from the first task. The tracked `CLAUDE.md` / `AGENTS.md` reference two things a fresh clone doesn't have yet — both regenerated locally, never committed:

1. **`.openlore/analysis/CODEBASE.md`** (git-ignored) — the architecture digest `CLAUDE.md` loads at session start.
2. **The OpenLore MCP server** — `CLAUDE.md` instructs your agent to call tools like `orient`, `search_code`, and `record_decision`. These live in a `.mcp.json` that is **intentionally git-ignored** (it's regenerated per machine; it merges with, never overwrites, the tracked `CLAUDE.md`).

One command wires both, with no API key:

```bash
npm run build
npm install -g . && openlore install --preset full   # or, without a global link:
node dist/cli/index.js install --preset full
```

`--preset full` is recommended for contributors because the **decisions-gate workflow** below needs `record_decision`, `search_specs`, and `check_spec_drift`, which the lean default preset omits. This also builds the index (generating `CODEBASE.md`). See [Agent Setup](README.md#agent-setup) in the README for what these files contain and why they matter.

## Running Tests

```bash
# Run all tests once
npm run test:run

# Run in watch mode during development
npm test

# Run with coverage report
npm run test:coverage

# Run a specific test file
npm run test:run -- src/cli/commands/analyze.test.ts
```

Tests use [Vitest](https://vitest.dev/). The test suite runs entirely in-process with mocked filesystem/process calls — no real API calls or disk writes.

## Integration & E2E Tests

The e2e suite (`src/core/analyzer/e2e.integration.test.ts`) runs the full `analyze` pipeline against the real openlore codebase and verifies that semantic queries return the correct source files. It is the primary non-regression guard for the analyzer.

**Prerequisites:**

```bash
openlore embed --local        # switch to the on-device embedder and build the semantic index (no Docker, no API key)
```

**Run:**

```bash
npm run test:e2e
```

Tests auto-skip when the embedding server or index is missing, so they never break a cold CI environment. They do not replace `npm run test:run` — run both.

**When to run before committing:**

| Change area | Required |
|---|---|
| `src/core/analyzer/**` | yes |
| `src/core/generator/stages/**` | yes |
| `src/core/services/mcp-handlers/**` | yes |
| Everything else | recommended |

## Type Checking

```bash
npm run typecheck
```

This must pass with zero errors before any PR is merged. The project uses strict TypeScript.

## Linting

```bash
npm run lint
```

Uses ESLint with typescript-eslint. Fix lint errors before submitting.

## Project Structure

```
src/
├── api/              Programmatic API (no process.exit, no console.log)
├── cli/
│   ├── commands/     One file per CLI command + matching .test.ts
│   └── index.ts      CLI entry point
├── core/
│   ├── analyzer/     Static analysis (file walker, dependency graph, etc.)
│   ├── drift/        Drift detection and spec mapping
│   ├── generator/    Spec generation pipeline and OpenSpec writer
│   └── services/     Shared services (LLM, config, MCP handlers)
├── types/            Shared TypeScript interfaces
├── utils/            Utilities (logger, errors, shutdown, etc.)
└── constants.ts      All magic numbers and path strings
```

### Key conventions

- **Constants:** All magic numbers and path strings belong in `src/constants.ts`. Never hardcode `.openlore`, `openspec`, subdirectory names, or numeric thresholds inline.
- **API vs CLI:** The `src/api/` layer must never call `process.exit()` or write to stdout/stderr directly — it only throws errors. The `src/cli/` layer handles all user-facing output.
- **File existence:** Use the async `fileExists()` from `src/utils/command-helpers.ts` instead of `fs.existsSync()` in async contexts.
- **Error classes:** Use the `errors.*` factory functions in `src/utils/errors.ts` for typed, user-facing errors.

## Writing Tests

Every CLI command file (`src/cli/commands/foo.ts`) should have a matching `foo.test.ts`. Follow the patterns in existing test files:

1. Mock `../../utils/logger.js` to suppress output
2. Mock heavy dependencies (`repository-mapper`, `dependency-graph`, etc.)
3. Test command configuration (options, defaults, descriptions)
4. Test validation paths (invalid inputs should set `process.exitCode = 1`)
5. Test the happy path using mocked services

For each `beforeEach`, reset `process.exitCode = undefined` and call `vi.clearAllMocks()`.

## Submitting Changes

1. Fork the repository and create a branch: `git checkout -b my-feature`
2. Make your changes — keep PRs focused on a single concern
3. Ensure `npm run typecheck`, `npm run lint`, and `npm run test:run` all pass
4. If touching `src/core/analyzer/`, `src/core/generator/stages/`, or `src/core/services/mcp-handlers/`: run `npm run test:e2e` (requires a semantic index — `openlore embed --local`)
5. Open a pull request with a clear description of the change and why

## The commit gate (decisions)

This repo ships a **decisions pre-commit gate** (installed by `openlore install`). When you `git commit` after changing source, it can block the commit and print JSON containing `"gated": true` — this is expected, not a crash. It means OpenLore detected an architectural decision that should be recorded before the change lands.

What to do when a commit is blocked:

- Read the `reason` field. Common ones: `verified` (decisions are waiting for you to approve), `approved_not_synced` (run `openlore decisions --sync`), `no_decisions_recorded` (source changed but nothing was recorded — run `openlore decisions --consolidate --gate` to check for undocumented decisions).
- To record a decision proactively (and keep commits instant), call `record_decision` **before** writing the code — see the checklist in [`CLAUDE.md`](CLAUDE.md).
- Escape hatch: `git commit --no-verify` skips the gate for a commit that genuinely introduces no architectural decision.

The gate adds no LLM latency on the happy path; it only triggers extraction when source changed without a recorded decision.

## Reporting Bugs

Open an issue at https://github.com/clay-good/openlore/issues with:
- The command you ran
- The error message or unexpected output
- Your OS, Node.js version (`node --version`), and openlore version (`openlore --version`)
- Output of `openlore doctor` if relevant
