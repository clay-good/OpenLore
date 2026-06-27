# Zero-interaction onboarding and a passive update notifier

> Status: IMPLEMENTED (2026-06-26, on PR #216). Makes the install → first-run → stay-current path
> automatic and best-practice: a lightweight CI-guarded postinstall hint, a non-blocking background
> cold-start index build when the MCP server is wired without a prior `openlore install`, a fully
> non-interactive `connect --yes`, a passive cached "update available" notifier, and an `openlore
> update` command that detects npm/Homebrew/npx. Deterministic, no LLM, no new runtime dependency
> (Node `fetch` + `node:fs`). Grounded in the north star (`overview/spec.md`, decision `c6d1ad07`).

## The gap

OpenLore's onboarding was *good but opt-in*: `openlore install` already auto-detects the agent, wires
everything idempotently, and builds the index with no prompts and no API key — but only if the user
knows to run it. Three gaps remained on the path to a flawless happy path:

1. **Nothing guided a fresh install.** `npm install` ran no setup (correct — a heavy postinstall that
   rewrites a repo or builds an index on every CI/Docker/global install is an anti-pattern), but it
   also printed nothing, so a new user had no nudge toward the one command to run.
2. **The MCP server did not self-heal a cold start.** If an agent wired the server without ever
   running `openlore install` (or ran it with `--no-analyze`), the first session had no index and
   every tool returned "run analyze first" until a manual build.
3. **No update story at all.** No version check, no notifier, no update command. A globally-installed
   or Homebrew binary went stale silently.

There was also one residual interactive prompt: `openlore connect` with no agent in a TTY shows a
multi-select picker, with no flag to skip it.

## What changes

All best-practice, all opt-out-able, none touching the user's repo on `npm install`:

1. **Lightweight postinstall hint** (`scripts/postinstall.mjs`). Prints one friendly next-step
   (`cd your-project && openlore install`). Fast and side-effect-free — no analyze, no config writes.
   Silent in CI, when not a TTY, when opted out (`OPENLORE_SKIP_POSTINSTALL`), and when openlore is a
   transitive dependency or being developed in-tree. Always exits 0 — it can never fail an install.

2. **Cold-start self-bootstrap** (`cold-start-bootstrap.ts`, wired into `openlore mcp`). When the
   server starts watching a directory with no analysis, it builds the index **once, in the
   background** (non-blocking — a synchronous full analyze would hang the agent's turn). Fail-soft and
   guarded once-per-directory; opt out with `OPENLORE_NO_AUTO_ANALYZE=1`.

3. **Non-interactive `connect --yes`**. Skips the picker and wires every detected agent, exactly like
   bare `openlore install`.

4. **Passive update notifier** (`update-notifier.ts`). A cached (~daily), non-blocking, fail-silent
   check against the npm registry that prints "Update available: X → Y / Run: openlore update" to
   stderr. Reads the cache synchronously and prints instantly; a stale cache refreshes in the
   background and is never awaited, so no command ever waits on the network. Suppressed in CI, in
   non-TTY contexts (keeps agent/MCP/hook output clean), and via `OPENLORE_NO_UPDATE_NOTIFIER` /
   `NO_UPDATE_NOTIFIER`. Wired into the CLI `preAction` only for human-facing commands (install,
   connect, update, doctor, prove, analyze, init) — never the hot paths an agent drives.

5. **`openlore update` command**. Detects how openlore was installed (Homebrew / global npm / npx)
   from the running module path and runs the correct upgrade, or with `--check` / `--dry-run` reports
   without changing anything. For npx it explains that `npx --yes openlore` already floats to latest.

## Why this is in scope

Onboarding and currency are the substrate's front door; a coding agent only benefits from OpenLore if
it is installed and current with no friction. Everything here is deterministic and local (the only
network call is a fail-soft npm dist-tag lookup), adds no runtime dependency, and follows npm/gh/brew
conventions. Active self-update was deliberately rejected (permission pitfalls on global/brew installs;
behavior changing mid-session) in favor of the passive notifier + explicit command.

## Impact

- New: `scripts/postinstall.mjs`, `src/core/services/update-notifier.ts`,
  `src/core/services/cold-start-bootstrap.ts`, `src/cli/commands/update.ts` (+ tests).
- Changed: `package.json` (postinstall script + file include), `src/cli/index.ts` (register `update`,
  wire notifier), `src/cli/commands/connect.ts` (`--yes`), `src/cli/commands/mcp.ts` (cold-start hook),
  `README.md`.
- Specs: `cli` — 3 ADDED requirements.
- Risk: low. The notifier and bootstrap never block and are fail-soft; the postinstall always exits 0;
  every new behavior is opt-out-able.
