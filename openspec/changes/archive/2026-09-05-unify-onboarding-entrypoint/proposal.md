# One entrypoint: install once, auto-init on every repo you touch

> Status: PROPOSED (2026-07-18). `add-zero-interaction-onboarding` (PR #216) and
> `refine-happy-path-and-defaults` (PR #218) made the *per-repo* path one command
> (`openlore install`: detect agents → wire MCP + hooks + CLAUDE.md + permission → build the
> no-API-key BM25 index) and gave the MCP server a background cold-start bootstrap. What is
> still missing is the *per-user* story: today every repo requires that one manual command,
> and the governance wiring lives behind a second, separate command. This change makes
> "install OpenLore once, and every repo you work on sets itself up in the background" true
> with **zero extra flags**: bare `openlore install` wires the user scope by default, and the
> consent guardrails — not command-line ceremony — do the safety work. The complete user
> experience is `npm i -g openlore && openlore install`, once, ever.

## The gap

- **The entrypoint is per-repo, not per-user.** `openlore install` wires the *current* repo
  (`runInstall`, `src/cli/install/index.ts:149-267`). The cold-start bootstrap
  (`src/core/services/cold-start-bootstrap.ts:63-92`) can self-build an index on first tool
  call — but only fires if the MCP server is already wired for that repo. A user with ten
  repos runs `openlore install` ten times. Claude Code (and Cursor) support user-scope MCP
  registration and user-level hooks; no adapter uses them.
- **`npm install -g openlore` does nothing but print.** `scripts/postinstall.mjs` is
  deliberately side-effect-free (correct for npm lifecycle discipline) — but nothing follows
  it up, so the global install is inert until the user re-reads the hint.
- **Governance is a second entrypoint.** The decisions pre-commit gate + Claude skills are
  wired only by `openlore setup --tools claude` (`installPreCommitHook`,
  `src/cli/commands/decisions.ts:202-256`; `src/cli/commands/setup.ts`), never by `install`.
  A user who runs the advertised one command gets the navigation face but no decision trail.
- **Auto-init has no consent story.** The existing bootstrap fires on any directory-bearing
  tool call with only `OPENLORE_NO_AUTO_ANALYZE` as an opt-out — acceptable when the user
  wired that repo explicitly, not acceptable once wiring is global (it would silently index
  any directory an agent touches, including non-repos and sensitive checkouts).

## What changes

1. **Bare `openlore install` wires the user scope by default — no flags.** For each adapter
   that supports a user scope (claude-code first: user-level MCP registration + user-level
   SessionStart/UserPromptSubmit hooks + user CLAUDE.md block), register the same managed,
   marker-identified entries `install` writes per-repo today. From then on, ANY repo the
   agent opens reaches the MCP server, and the existing cold-start bootstrap auto-builds its
   index in the background. When run inside a repo, `install` additionally wires and indexes
   that repo immediately (today's behavior), so the first repo is warm rather than lazy.
   Adapters without a user scope fall back to per-repo wiring with an honest note (a
   warning, not a failure). `--repo-only` is the escape hatch for users who do NOT want
   user-scope wiring; repo-scope managed entries win where both exist.
2. **Auto-init guardrails** (apply to every background bootstrap, global or per-repo):
   - **Git-repo only.** Never auto-init a directory that is not a git work tree.
   - **First-touch disclosure.** The first bootstrap in a repo emits a one-line notice in the
     tool response's freshness note (what was built, where it lives, how to opt out) — never
     silent, never blocking.
   - **Per-repo opt-out.** `.openlore/config.json` `autoInit: false` (and the existing
     `OPENLORE_NO_AUTO_ANALYZE` env) suppress auto-init for that repo permanently.
   - **Size ceiling.** Above a file-count ceiling (reuse the watcher's large-tree ceiling
     pattern, `src/core/services/mcp-watcher.ts`), auto-init builds the signatures/BM25 lane
     only and discloses the degradation, instead of pinning a laptop on a monorepo.
3. **`install` absorbs governance wiring.** Once `add-decision-autopilot` lands,
   `openlore install` wires the decisions pre-commit hook *in autopilot (non-blocking,
   trail-only) mode* by default — one entrypoint yields navigation and a decision trail. Blocking human-review
   mode stays an explicit opt-in (doctrine: advisory by default, blocking opt-in).
   `openlore setup` remains for skills/panic extras; its gate-wiring becomes a thin alias.
4. **Postinstall stays side-effect-free.** The hint it prints stays exactly
   `openlore install` — one command, once, and never again for any repo — and the update
   notifier's cached check is reused unchanged.

## Impact

- Specs touched: `cli` (new requirement + `ZeroInteractionOnboarding` modified), `config`
  (`autoInit` key).
- Likely code: `src/cli/install/index.ts`, `src/cli/install/adapters/claude-code.ts` (+ a
  `supportsGlobal` adapter capability), `src/core/services/cold-start-bootstrap.ts`,
  `scripts/postinstall.mjs`, `src/cli/commands/setup.ts`.
- Depends on: `add-decision-autopilot` (for step 3 only; steps 1-2-4 stand alone).
- Cross-references (do not duplicate): `fix-update-install-detection` (global vs local
  install detection), `fix-windows-invocation-surface` (spawn/`npx` hygiene in generated
  configs), `adopt-agent-context-interop` (AGENTS.md as a context target).

## Non-goals

- No auto-run from npm postinstall (lifecycle discipline stands).
- No indexing of non-git directories, ever.
- No removal of per-repo wiring: `--repo-only` and `connect` remain for users who want
  explicit scope control; no change to the default tool preset (ADR-0023 benchmark process
  governs that).
