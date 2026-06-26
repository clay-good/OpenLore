## Commands

| Command | Description | API Key |
|---------|-------------|---------|
| `openlore init` | Initialize configuration | No |
| `openlore install` | One-command setup: wire agent surfaces (lean `navigation` MCP + hooks) and build the index | No |
| `openlore connect [agent]` | Wire a specific coding agent to the MCP server + hooks | No |
| `openlore analyze` | Run static analysis | No |
| `openlore embed --local` | Enable on-device semantic embeddings (no API key; downloads ~23 MB model) and rebuild the index | No |
| `openlore embed --off` | Revert to the first-class keyword (BM25) default and rebuild | No |
| `openlore orient` | Relevant functions, callers, specs, and insertion points for a task (the flagship) | No |
| `openlore orient --inject` | Emit a bounded, ignorable task-scoped orientation block for a pre-turn hook | No |
| `openlore generate` | Generate specs from analysis | Yes |
| `openlore generate --adr` | Also generate Architecture Decision Records | Yes |
| `openlore verify` | Verify spec accuracy | Yes |
| `openlore drift` | Detect spec drift (static) | No |
| `openlore drift --use-llm` | Detect spec drift (LLM-enhanced) | Yes |
| `openlore drift --suggest-tests` | After drift, list test files covering affected domains | No |
| `openlore audit` | Report spec coverage gaps: uncovered functions, hub gaps, stale domains | No |
| `openlore test` | Report spec test coverage (scan test files for `// openlore:` annotation tags) | No |
| `openlore test --min-coverage <n>` | Fail when effective spec coverage is below N% (CI gate) | No |
| `openlore digest` | Plain-English summary of all specs for human review | No |
| `openlore prove` | Measure OpenLore's token value on your repo (WITH vs WITHOUT agent pass) | Yes |
| `openlore prove --estimate` | Deterministic, graph-derived projection of the orientation tax — no agent, no key | No |
| `openlore prove --json\|--markdown\|--save` | CI-consumable scorecard / paste-ready block + badge / dated record under `.openlore/prove/` | Matches arm |
| `openlore decisions` | Manage architectural decisions: list, approve, reject, sync to specs and ADRs | No |
| `openlore decisions --gate` | Pre-commit gate check: exit non-zero if decisions await review (used by the hook) | No |
| `openlore setup --tools claude` | Install the decisions pre-commit hook (+ skills) that gates commits until decisions are reviewed | No |
| `openlore run` | Full pipeline: init, analyze, generate | Yes |
| `openlore view` | Launch interactive graph & spec viewer in the browser | No |
| `openlore setup` | Install workflow skills into the project (Vibe, Cline, GSD, BMAD, Pi) | No |
| `openlore federation add\|remove\|list` | Manage the multi-repo federation registry (index-of-indexes) | No |
| `openlore spec-store status` | Report the health of the spec-store binding (read-only, advisory) | No |
| `openlore working-set context` | Assemble the working-set briefing for an active change across its targets (read-only, advisory) | Targets indexed |
| `openlore impact-certificate` | Certify what the current diff opens into declared covering surfaces, before it lands (advisory; opt-in blocking) | Yes |
| `openlore enforce` | Unified finding-enforcement gate: resolve every governance finding through `enforcement.policy` and block only on a `blocking`-classed finding (advisory by default) | Decisions/specs present |
| `openlore plugin-manifest emit\|validate` | Inspect/validate the OpenSpec plugin manifest (distinct from the federation `manifest`) | No |
| `openlore mcp` | Start MCP server (stdio, for Cline / Claude Code) | No |
| `openlore serve` | Start a warm local HTTP daemon exposing tools (loopback, for Pi / editors) | No |
| `openlore doctor` | Check environment and configuration for common issues | No |
| `openlore refresh-stories` | Refresh story files with latest structural context after each commit | No |
| `openlore blast-radius` | Pre-flight structural blast-radius briefing for the current diff (advisory; `--install-hook` for a pre-commit hook) | No |
| `openlore coverage-gaps` | Ranked structural test-coverage gaps: important code with NO reaching test (the inverse of `select_tests`), no runtime. Scope to a diff (`--base`/`--symbols`) or region (`--file-pattern`). Read-only, never blocks | Yes |
| `openlore certify-public-surface` | Certify the public API surface (no `--base`) or the breaking-change verdict for the working-tree diff (`--base <ref>`): removed/renamed exports, incompatible signatures, each breaking change with its in-repo consumers. Read-only, deterministic, never blocks | Yes |
| `openlore style-fingerprint` | Descriptive per-language idiom profile (function form, binding, conditional, async, string, naming case) for the repo, a region (`--community <id>`), or a file (`--file <path>`); `--language` filters, `--json` for machine output. Evidence-floor + enforcement-aware nulls. Read-only, deterministic, never blocks | Yes |
| `openlore briefing-since` | Catch-up briefing of what changed since a base ref (`--base <ref>`), ranked by significance tier — surprising-change (a stable hub moved) > hub-change > chokepoint-change > ordinary-change — from existing labels (not a score); grouped by region, with tests-to-run and a no-silent-truncation receipt. Scope with `--file-pattern`, bound with `--max`, `--json` for machine output. Read-only, deterministic, never blocks | Yes |
| `openlore find-clones` | Existing clones of ONE query — a function `--symbol <name>` (or `name::path`) in the index, or raw `--snippet <code>` (even code not yet written) — ranked exact > structural > near. The edit-time "does this already exist? reuse it" companion to the whole-repo `get_duplicate_report`. `--min <ratio>` sets the near floor (default 0.7), `--max <n>` bounds the list, `--json` for machine output. Read-only, deterministic, never blocks | Yes |
| `openlore error-propagation` | The exceptions that escape a function (`--symbol <name>`, or `name::path`) to its callers vs. those caught within it — the error-handling analogue of `analyze_impact`, for TS/JS/Python. A sound lower bound: byte-precise catch containment, un-analyzable callees disclosed, `<dynamic>` re-raises kept, unsupported language explicit. `--max-depth <n>` bounds the callee traversal (default 10), `--json` for machine output. Read-only, deterministic, never blocks | Yes |
| `openlore review` | Deterministic structural PR review (structural delta + blast radius) as a Markdown/JSON briefing; pairs with the bundled GitHub Action | No |
| `openlore preflight` | CI staleness gate: fail when the analysis graph is stale relative to the working tree | No |
| `openlore export scip` | Export the analysis graph as an SCIP index for the Sourcegraph / Glean ecosystem | No |
| `openlore export bundle` | Export the persisted graph index as a single portable, integrity-stamped artifact a teammate or CI imports without re-analyzing (`--out <path>`). Deterministic, offline. See [Shareable bundle](shareable-bundle.md) | No |
| `openlore import <artifact>` | Import a portable graph artifact (validate-or-rebuild): materializes a verified index when the artifact's commit matches the working tree, else falls back to a local rebuild. Never serves a stale/schema-skewed/tampered artifact as current | No |
| `openlore telemetry` | Analyze EpistemicLease cognitive-load telemetry | No |
| `openlore panic-*` | Agent behavioral-governance ("panic") commands — `panic-check`/`panic-level`/`panic-validate`/`panic-hotspots`/`panic-calibrate`/`panic-replay`. Opt-in, off by default; install hooks via `openlore setup --hooks` | No |
| `openlore gryph-watch` | Background Gryph behavioral observer (opt-in; install via `openlore setup --hooks`) | No |

### Global Options

```bash
--api-base <url>       # Custom LLM API base URL (proxy / self-hosted)
--insecure             # Disable SSL certificate verification
--config <path>        # Config file path (default: .openlore/config.json)
-q, --quiet            # Errors only
-v, --verbose          # Debug output
--no-color             # Plain text output (enables timestamps)
```

Generate-specific options:
```bash
--model <name>         # Override LLM model (e.g. gpt-4o-mini, llama3.2)
```

### Orient Options

```bash
openlore orient [options]

  --task <task>          # Natural-language task (e.g. "add rate limiting")
  --directory <path>     # Project directory to orient in (default: cwd)
  --limit <n>            # Number of relevant functions to return (default: 5)
  --token-budget <n>     # Cap relevantFunctions to ~this many tokens
  --lean                 # Return only the navigation core (drop heavier sections)
  --json                 # Emit the full result as JSON instead of the human view
  --metrics              # Report wall time + output size to stderr (opt-in)
  --inject               # Emit a bounded, ignorable task-scoped orientation block
                         #   for a pre-turn agent hook; reads the task from --task
                         #   or stdin. Fail-open: any failure degrades to a single
                         #   pointer line at exit 0 (see docs/install.md).
```

With no `--task`, `orient` prints a session-start primer. Requires `openlore analyze`
to have run at least once.

### Install Options

```bash
openlore install [options]   # detect agents, wire surfaces, build the index

  --agent <name>         # Limit to one surface: claude-code, cursor, cline,
                         #   continue, agents-md
  --preset <name>        # MCP tool preset to wire: navigation (lean default),
                         #   minimal, memory, verify, federation, coordination, or full
  --all-tools            # Wire the full 71-tool surface (alias of --preset full)
  --dry-run              # Print planned changes without writing any files
  --force                # Overwrite OpenLore-managed blocks even if hand-edited
  --uninstall            # Remove OpenLore-managed blocks and entries
  --no-analyze           # Configure surfaces only; skip init + analyze
```

### Connect Options

```bash
openlore connect [agent] [options]   # wire ONE agent (no index build by default)
openlore connect remove [agent]      # disconnect that agent

  <agent>                # Positional: claude-code | cursor | cline | continue |
                         #   agents-md (omit for an interactive picker)
  --preset <name>        # MCP tool preset to wire (same names as install)
  --all-tools            # Wire the full 71-tool surface (alias of --preset full)
  --dry-run              # Print planned changes without writing any files
  --force                # Overwrite OpenLore-managed blocks even if hand-edited
  --no-analyze           # Configure surfaces only; do not build the index
```

`connect` takes the agent as a positional argument (`openlore connect cursor`), not
`--agent`, and disconnects via the `remove` subcommand rather than `--uninstall`.

A bare `openlore install` wires the lean `navigation` surface (10 tools) and, for
Claude Code, both a `SessionStart` primer hook and a `UserPromptSubmit` task-scoped
injection hook. Restore the prior all-tools default with `--preset full`.

### MCP Server Options

```bash
openlore mcp [options]             # start the stdio MCP server

  --preset <name>        # Expose a named preset (default: lean navigation, 10 tools)
  --minimal              # Expose only the core 6 governance tools
  --all-tools            # Expose the full surface — all 71 tools (alias --preset full)
  --watch-auto           # Auto-detect + incrementally re-index the project dir
  --no-watch-auto        # Disable auto-watch (use for one-shot tool calls)
  --daemon               # Delegate tool calls to a shared `openlore serve` daemon
```

When the lean default is active, the server advertises the opt-in presets once via
the MCP `initialize` `instructions` channel (no extra tool schemas).

### Drift Options

```bash
openlore drift [options]
  --base <ref>           # Git ref to compare against (default: auto-detect)
  --files <paths>        # Specific files to check (comma-separated)
  --domains <list>       # Only check specific domains
  --use-llm              # LLM semantic analysis
  --json                 # JSON output
  --fail-on <severity>   # Exit non-zero threshold: error, warning, info
  --max-files <n>        # Max changed files to analyze (default: 100)
  --verbose              # Show detailed issue information
  --suggest-tests        # List test files covering drifted domains
  --install-hook         # Install pre-commit hook
  --uninstall-hook       # Remove pre-commit hook
```

### Generate Options

```bash
openlore generate [options]
  --model <name>         # LLM model to use
  --dry-run              # Preview without writing
  --domains <list>       # Only generate specific domains
  --merge                # Merge with existing specs
  --no-overwrite         # Skip existing files
  --adr                  # Also generate ADRs
  --adr-only             # Generate only ADRs
  --force                # Re-run all LLM stages, clear generation cache, remove stale domains
  --analysis <path>      # Path to existing analysis directory
  --output-dir <path>    # Override openspec output location
  -y, --yes              # Skip confirmation prompts
```

### Run Options

```bash
openlore run [options]
  --force                # Reinitialize even if config exists
  --reanalyze            # Force fresh analysis even if recent exists
  --model <name>         # LLM model to use for generation
  --dry-run              # Show what would be done without making changes
  -y, --yes              # Skip all confirmation prompts
  --max-files <n>        # Maximum files to analyze (default: 500)
  --adr                  # Also generate Architecture Decision Records
```

### Analyze Options

```bash
openlore analyze [options]
  --output <path>        # Output directory (default: .openlore/analysis/)
  --max-files <n>        # Max files (default: 500)
  --include <glob>       # Additional include patterns
  --exclude <glob>       # Additional exclude patterns
  --force                # Force re-analysis (bypass 1-hour cache)
  --ai-configs           # Generate AI tool config files (CLAUDE.md, .cursorrules, .clinerules/openlore.md,
                         #   .github/copilot-instructions.md, .windsurf/rules.md, .vibe/skills/openlore.md)
                         #   Safe to re-run — skips files that already exist, marks pre-existing ones.
  --no-embed             # Force a keyword-only (BM25) index (keyword is the first-class default;
                         #   semantic is built only when a provider is configured — see "openlore embed")
  --reindex-specs        # Re-index OpenSpec specs into the vector index without re-running full analysis
                         #   (uses the configured embedding provider — local or remote — else keyword)
```

`analyze` also carries anchored memory across refactors: if a symbol with anchored memories/decisions was
renamed or moved since the last analysis, its anchors are re-pointed to the new symbol (deterministically,
no LLM) and the run logs `Memory continuity: carried N symbol(s) across rename/move`. See
[docs/mcp-tools.md](mcp-tools.md) ("Memory survives refactors").

### Embed Options

```bash
openlore embed [options]
  --local                # Enable the on-device, no-API-key local embedder and rebuild the index.
                         #   Lazily downloads + caches a small pinned model (~23 MB) under ~/.openlore/models.
                         #   An explicit local provider wins over any EMBED_* env.
  --off                  # Revert to the keyword (BM25) default and rebuild
  --model <id>           # Override the local embedding model (advanced; default is a pinned small model)
```

Keyword (BM25) search is the first-class default and needs no setup. `openlore embed --local` is the one-command semantic upgrade; for a remote OpenAI-compatible endpoint instead, set `EMBED_BASE_URL`/`EMBED_MODEL` (or an `embedding` block in `.openlore/config.json`) and run `openlore analyze`. See [docs/semantic-search.md](semantic-search.md#retrieval-modes).

### Prove Options

```bash
openlore prove [options]
  --directory <path>     # Repo to measure (default: current directory)
  --runs <n>             # Runs per arm per task (default: 2; non-numeric is rejected)
  --model <name>         # Agent model (default: sonnet)
  --max-budget-usd <n>   # Per-agent-call USD ceiling (default: 0.5; non-numeric is rejected)
  --estimate             # Deterministic, no-agent, no-API projection of the orientation tax
  --dry-run              # Synthetic numbers (no agent, no API key)
  --json                 # Stable schemaVersion:1 scorecard on stdout (mutually exclusive with --markdown)
  --markdown             # Paste-ready scorecard block + shields.io badge (mutually exclusive with --json)
  --save                 # Persist a dated, non-clobbering scorecard under .openlore/prove/
```

The measured arm needs `claude` + an API key; `--estimate` and `--dry-run` need neither. A measured
run whose agent calls all fail **exits non-zero** rather than emitting a verdict over no data. The
`--json` shape is documented in [AGENT-BENCHMARKS.md](AGENT-BENCHMARKS.md#json-output-schema-for-ci).

### Setup Options

```bash
openlore setup [options]
  --tools <list>   Comma-separated tools to install: vibe, cline, claude, opencode, gsd, bmad, omoa (default: interactive prompt)
  --force          Overwrite existing files (use after upgrading openlore)
  --dir <path>     Project root directory (default: current directory)
```

Installs workflow skills from the openlore package into the project. Skills are static assets — identical across projects — so this command only needs to be run once at project onboarding and again after upgrading openlore.

Files installed:

| Tool | Destination | Content |
|------|-------------|---------|
| `vibe` | `.vibe/skills/openlore-{name}/SKILL.md` | 8 skills |
| `cline` | `.clinerules/workflows/openlore-{name}.md` | 7 workflows |
| `claude` | `.claude/skills/openlore-{name}/SKILL.md` + decisions pre-commit hook | 8 skills + commit gate |
| `opencode` | `.opencode/skills/openlore-{name}/SKILL.md` + `.opencode/plugins/agent-guard.ts` | 8 skills + guard plugin |
| `gsd` | `.claude/commands/gsd/openlore-{name}.md` | 2 commands |
| `bmad` | `_bmad/openlore/{agents,tasks}/` | 2 agents, 4 tasks |
| `omoa` | `.opencode/plugins/` + `.opencode/prompts/` | 4 SDD plugins + Sisyphus prompt (oh-my-openagent) |

The `omoa` option is **auto-detected and pre-checked** in the interactive prompt when oh-my-openagent is found in the project or user config.

Never overwrites existing files. Combine with `analyze --ai-configs` for a complete agent setup:

```bash
openlore analyze --ai-configs   # project-specific context files
openlore setup                   # workflow skills
```

### Decisions Options

```bash
openlore decisions [options]
  --list                 # List decisions, optionally filtered by --status
  --status <status>      # Filter by status: draft, consolidated, verified, approved, synced, phantom
                         # Note: synced/rejected/phantom are purged from store after --sync
  --approve <id>         # Approve a decision by ID (blocked if already synced)
  --reject <id>          # Reject a decision by ID
  --reason <text>        # Rejection reason (used with --reject)
  --sync                 # Write approved decisions into specs and ADRs, then purge inactive entries
  --dry-run              # Preview sync without writing files
  --gate                 # Run commit gate check (reads pending.json, no LLM — used by pre-commit hook)
                         # Gate reason codes: verified | approved_not_synced |
                         #   drafts_pending_consolidation | no_decisions_recorded
  --consolidate          # Manually trigger LLM consolidation + diff verification of drafts
  --json                 # Machine-readable output
  --uninstall-hook       # Remove decisions pre-commit hook (install via: openlore setup --tools claude)
```

### Verify Options

```bash
openlore verify [options]
  --samples <n>          # Files to verify (default: 5)
  --threshold <0-1>      # Minimum score to pass (default: 0.7)
  --files <paths>        # Specific files to verify
  --domains <list>       # Only verify specific domains
  --verbose              # Show detailed prediction vs actual comparison
  --json                 # JSON output
```

### Doctor

`openlore doctor` runs a self-diagnostic and surfaces actionable fixes when something is misconfigured or missing:

```bash
openlore doctor          # Run all checks
openlore doctor --json   # JSON output for scripting
```

Checks performed:

| Check | What it looks for |
|-------|------------------|
| Node.js version | ≥ 22.5 required (`node:sqlite`) |
| Git repository | `.git` directory and `git` binary on PATH |
| openlore config | `.openlore/config.json` exists and is parseable |
| Analysis artifacts | `repo-structure.json` freshness (warns if >24h old) |
| OpenSpec directory | `openspec/specs/` exists |
| LLM provider | API key or `claude` CLI detected |
| Disk space | Warns < 500 MB, fails < 200 MB |

Run `openlore doctor` whenever setup instructions aren't working — it tells you exactly what to fix and how.

### PR review (`openlore review`)

`openlore review` composes the structural delta (`structural_diff`) and the blast radius
(`computeBlastRadius` — hubs, layers, tests to run, and the spec/memory/decision drift the change
introduces) for a `base..head` range into **one deterministic, conclusion-shaped briefing** — no LLM,
no new MCP tool. It is the same distinctive structural output OpenLore already produces, rendered for a
human reviewer and bundled as a GitHub Action that posts it as one sticky PR comment.

```bash
openlore review                                  # markdown briefing for the current diff (auto-detected base)
openlore review --base main --head HEAD          # explicit range
openlore review --format json                    # machine-readable briefing on stdout
openlore review --out review.md                  # write the markdown to a file (used by the Action)
openlore review --hook                           # honor blastRadius.block and fail on a configured pattern
```

| Option | Description |
|--------|-------------|
| `--base <ref>` | Base ref to compare against (default: auto-detected — requested → `main` → `master` → `HEAD~1`) |
| `--head <ref>` | Head ref (default: working tree). Blast radius is computed against the working tree; in CI the runner checks out the head SHA so they align (a caveat is printed when an explicit `--head` could differ) |
| `--format <fmt>` | `markdown` (default, for PR comments) or `json` (programmatic consumers); unknown value exits 2 |
| `--out <path>` | Write the briefing to a file instead of stdout |
| `--hook` | Opt-in gating: exit non-zero when a configured `.openlore/config.json` `blastRadius.block` pattern fires. Advisory (exit 0) otherwise |

Advisory by default — it informs, it never fails the check. Degrades honestly: with no analysis index
it shows the structural delta and says "run `openlore analyze`"; a non-git directory or unreachable
base is disclosed rather than emitted as a misleading empty briefing. The structural delta works
without an index (it builds the old/new graphs from just the changed files).

**GitHub Action.** The repo ships `.github/actions/openlore-review` (composite action: checkout →
`openlore analyze` → `openlore review` → one sticky comment matched by a hidden `<!-- openlore-review -->`
marker, created once and updated in place — duplicate-proof via paginated comment lookup) and a
copy-paste workflow (`.github/workflows/openlore-review.yml.example`). Adoption is one file; it needs a
full-history checkout (`fetch-depth: 0`) and `pull-requests: write` permission. The Action runs
`npx openlore@<version>`, so it activates once a **published** `openlore` ships `review` (until then it
no-ops gracefully — no comment, the check stays green). Advisory by default; gate mode fails the job
**only** when the briefing was produced and a configured `blastRadius.block` pattern fired (a missing
`openlore`/`review` or an unreachable range never produces a false-positive red check). A comment-post
failure never fails the check either: on a **fork PR** GitHub gives `pull_request` a read-only token, so
the comment can't be posted for external contributors — the Action warns and leaves the briefing in the
job log (use `pull_request_target`, with its security trade-offs, if you need the comment on fork PRs).
The briefing is always clamped to GitHub's 65,536-char comment limit.

### Federation (multi-repo)

Federation is an **index-of-indexes**: each repo keeps its own independently-built `.openlore` index, and a project-local registry (`.openlore/federation.json`) references them. Adding or removing a repo edits only the registry plus that repo's own build — never a global rebuild. No merged cross-repo graph is ever materialized; federated queries load only the per-repo indexes they need, on demand.

```bash
openlore federation add <path> [--name <name>]   # Register a repo (default name: its basename)
openlore federation remove <nameOrPath>          # alias: rm
openlore federation list                          # alias: ls — shows each repo's index state
```

Index state per repo: `✓ indexed`, `⚠ stale` (re-run `openlore analyze` there), `∅ unindexed`, or `✗ missing path`. Once a repo is registered, the four cross-repo conclusion tools — `analyze_impact`, `find_dead_code`, `select_tests`, `find_path` — accept an opt-in `federation` (or `federationRepos`) flag and report which repos were consulted vs skipped. The registry-status tool `federation_status` is exposed only under `openlore mcp --preset federation`. See [docs/federation.md](federation.md).

#### Spec-store binding

A **spec-store binding** points OpenLore at an external spec repository (one that holds specs/changes) and declares the code repositories its plans `targets` and `references`. The declared names resolve against the federation registry above. Configure it in `.openlore/config.json` (see [Configuration](configuration.md#spec-store-binding)), then check its health:

```bash
openlore spec-store status            # human-readable: per-target resolution + index state, references, store path
openlore spec-store status --json     # stable finding codes for an orchestrator (see docs/mcp-tools.md)
```

Read-only and advisory — it reports binding health and always exits 0; it never blocks. Findings carry stable codes (`target-unresolved`, `index-stale`, `reference-missing`, `registry-unreadable`, …) each with a pasteable remediation. The matching MCP tool `spec_store_status` is exposed under `openlore mcp --preset federation`.

#### Working-set context

Once a binding is sound, assemble the structural briefing an active change actually needs — `orient`, generalized from one repo to the change's targets:

```bash
openlore working-set context --change <id>                  # human-readable: per-target items, callers, anchored intent
openlore working-set context --change <id> --json           # documented JSON for an orchestrator to splice into its agent brief
openlore working-set context --change <id> --token-budget 4000   # cap the merged briefing
```

It reads the change's proposal under the bound store, orients each resolved+indexed target on that intent, and returns one budgeted, per-target-attributed briefing plus fresh in-scope anchored intent (orphaned withheld, drifted flagged). Read-only and advisory — always exits 0, never blocks. Findings carry stable codes (`change-not-found`, `target-not-briefable`, `no-briefable-targets`, …). The matching MCP tool `working_set_context` is exposed under `openlore mcp --preset federation`.

#### Change impact certificate

Certify what the current diff touches — and, crucially, what it *newly reaches* — before it lands. You declare **covering surfaces** (semantic/governance boundaries) under `impactCertificate.surfaces` in `.openlore/config.json`; the certificate reports the paths the change opens into each surface (reachable after the diff but not before), plus blast radius, drifted specs, and tests to run:

```bash
openlore impact-certificate                       # human-readable certificate for the working tree vs HEAD
openlore impact-certificate --base main --json    # documented JSON (stable surface + path codes) for an orchestrator
openlore impact-certificate --change <id> --save  # record the change id + persist for later decay re-checks
openlore impact-certificate --install-hook        # install the ADVISORY pre-commit hook (never blocks by default)
openlore impact-certificate --uninstall-hook      # remove the pre-commit hook block (coexists with other openlore hooks)
```

Advisory by default — it emits the certificate and exits 0; an infrastructure failure (no index, not a repo) never blocks. A repository MAY opt into blocking specific surface severities with `impactCertificate.block: ["critical"]`, in which case the `--hook` exits non-zero only when the diff opens a new path into a surface of that severity. Newly-opened-path detection is differential and deterministic (no LLM): only the changed files are re-parsed, renamed files read their base-ref content, untracked files are folded in, and an ambiguous added callee is reported, never guessed. The certificate decays via the freshness lease — when an anchored symbol later moves, `openlore spec-store status` re-fires it as a `certificate-stale` finding. The matching MCP tool `change_impact_certificate` is exposed under `openlore mcp --preset federation`.

#### Test-coverage gaps

Report important code with **no reaching test**, ranked by hub/chokepoint significance — the structural inverse of `select_tests` over the whole graph, with no test run, no coverage tool, and no runtime. It is gaps-only and honest: it reports "no reaching test" and never claims a symbol is "tested":

```bash
openlore coverage-gaps                              # whole repo, ranked (default 100, capped 500)
openlore coverage-gaps --max 50                     # cap the list
openlore coverage-gaps --file-pattern src/core/auth # region scope
openlore coverage-gaps --base main                  # diff scope: gaps among symbols changed vs main
openlore coverage-gaps --symbols parseConfig,login  # diff scope: only these changed symbols
openlore coverage-gaps --json                       # machine-readable (stable shape) for CI / an orchestrator
```

A gap with no caller at all is labeled *also-dead* (distinct from `find_dead_code`); an untested entry point is *untested-not-dead*. A scope that resolves to nothing returns an explicit `note` ("nothing matched", not a reassuring "0 gaps"), and the counts (`analyzedSymbols` / `reachableFromTest`) range over the in-scope set. Read-only and advisory — it is a report and never blocks. The matching MCP tool `report_coverage_gaps` is exposed under `openlore mcp --preset full`. See [coverage-gaps.md](coverage-gaps.md).

#### Find clones of a symbol or snippet

Answer the edit-time question "does a near-duplicate of **this** already exist that I should reuse?" — scoped to one query, where `get_duplicate_report` is the whole-repo audit. Reuses the same detector (exact / structural / near), one-vs-all so it finds near-clones even on repos large enough that the whole-repo near pass is skipped:

```bash
openlore find-clones --symbol getPyParser                 # clones of an indexed function
openlore find-clones --symbol 'getPyParser::src/core/analyzer/call-graph.ts'  # disambiguate by path
openlore find-clones --snippet "$(cat candidate.ts)"      # clones of code you're about to write
openlore find-clones --symbol handleFoo --min 0.6 --max 5 # lower the near floor, cap the list
openlore find-clones --symbol handleFoo --json            # machine-readable (stable shape)
```

Honest by construction: an unknown symbol is an explicit not-found (with candidates), never an empty "unique"; an ambiguous bare name lists `name::path` candidates; a query below the evidence floor reports "too small to compare", not "no clones"; the query never matches itself. The matching MCP tool `find_clones` is exposed under `openlore mcp --preset full`.

#### Error propagation

Answer "what exceptions can blow out of this function — and is any already handled?" (and the inverse: "I changed this to throw; who's exposed, and where is it caught?"). The error-handling analogue of `analyze_impact`: given a function `--symbol`, the exception types that propagate OUT to its callers vs. those caught within it. TypeScript / JavaScript / Python:

```bash
openlore error-propagation --symbol handleRequest                 # exceptions that escape this function
openlore error-propagation --symbol 'handleRequest::src/api/handler.ts'  # disambiguate by path
openlore error-propagation --symbol parseConfig --max-depth 5     # bound the callee traversal (default 10)
openlore error-propagation --symbol parseConfig --json            # machine-readable (stable shape)
```

`escapes` lists each escaping type with its origin function/file/line, whether it is a direct throw or propagated from a callee, and the call path; `handledInternally` lists exceptions thrown in the reachable subtree but caught within the function (callers shielded). Honest by construction — a **sound lower bound**: containment is byte-precise (a throw in a catch body or after a one-line nested try is never mis-attributed as handled), an inner typed `except` never shadows an outer catch-all, an un-analyzable callee (external / bodyless / unsupported-language / over-bound) is disclosed in `boundaries` and never assumed exception-free, an intra-object `this.`/`super.`/`self.`/`cls.` call site the call graph could not resolve to an indexed method is disclosed too (`unresolvedSelfCalls` — the one call shape that gets neither a resolved nor an `external::` edge, so a clean escape set does not silently clear it), a re-raise of unknowable static type is surfaced as `<dynamic>`, and a symbol in any other language returns an explicit `unsupported` result rather than an empty escape set. Computed live from the cached call graph plus a re-read of the source it spans — no new persisted artifact. The matching MCP tool `analyze_error_propagation` is exposed under `openlore mcp --preset full`.

#### Public API surface contract

Certify whether the working-tree diff breaks the package's exported contract. With **no `--base`** it prints the public surface (exported symbols + signatures); with `--base <ref>` it prints a deterministic breaking-change verdict — each changed export classified `breaking` / `non-breaking` / `potentially-breaking`, and each breaking one paired with the in-repo consumers it breaks:

```bash
openlore certify-public-surface                     # print the public surface (exported symbols + signatures)
openlore certify-public-surface --base main         # breaking-change verdict for the working tree vs main
openlore certify-public-surface --max 50            # cap the surface listing in surface mode (default 200, cap 500)
openlore certify-public-surface --base HEAD --json  # machine-readable verdict (stable shape) for CI / an orchestrator
```

The closed classification rules: a **removed** or **renamed** export, an **added required parameter**, a parameter made **required**, or a **narrowed** parameter/return type is `breaking`; an added **trailing optional** parameter, a **new export**, or a **widened** return type is `non-breaking`; anything that cannot be *proven* compatible from the available signatures (untyped/dynamically-typed, or an incomparable type change) is `potentially-breaking` — **never silently safe**, since there is no type checker and no build in the loop. A renamed export is reported as a rename (via symbol-identity continuity), not a remove+add. A symbol still defined but no longer exported is reported as `visibility-reduced` (public → private); a re-export (`export { X } from …`) follows its definition — it is tracked at the definition site, not separately at the barrel, so a barrel'd symbol is never double-counted. External/unindexed consumers are disclosed as a known-unknowable boundary, not implied absent. Signature classification covers TypeScript/JavaScript/Python; other languages fail-soft to surface membership only (a removed/added export is still reported, without a signature classification). Test files are excluded from the surface. Read-only and advisory — it is a report and never blocks. The matching MCP tool `certify_public_surface` is exposed under `openlore mcp --preset full`.

#### Change significance briefing

```bash
openlore briefing-since                              # what changed since the auto base (main → master → HEAD~1)
openlore briefing-since --base HEAD~20               # brief everything that changed in the last 20 commits
openlore briefing-since --file-pattern src/core/auth # region scope
openlore briefing-since --max 25                     # bound the briefing (default 50, capped 200)
openlore briefing-since --base main --json           # machine-readable (stable shape) for CI / an orchestrator
```

`briefing-since` answers the reviewer / catch-up / onboarding question the other change tools don't — not "what does *my* pending diff do?" but **"a lot changed since I last looked; which of it structurally matters?"** Each changed production symbol is labeled with exactly one **tier**, ordered highest-first: `surprising-change` (a high-fan-in **hub** whose file **rarely changed before** — a normally-stable, widely-depended-on symbol that suddenly moved) > `hub-change` (a broad high-fan-in/high-fan-out hub) > `chokepoint-change` (a high-fan-in funnel) > `ordinary-change`. The tiers come **entirely from existing classifiers** (`landmark-signals` hub/orchestrator/chokepoint + the `volatilityLevel` churn classifier) plus raw evidence (fan-in, fan-out, prior churn) — there is **no weighted significance score and no new tuning constant**; the caller makes the final judgment from the evidence. **Honest by construction**: changed symbols are at **file granularity** (every function in a changed file is briefed, disclosed in a caveat); the `surprising-change` label is **withheld** when git history is too shallow (`< 2` non-bulk commits) to say "rarely changed before"; a bounded briefing always carries a **truncation receipt** (omitted count + per-tier breakdown + lowest tier reached) and **never drops a higher tier for a lower one**; a **silent base-ref fallback is disclosed** — a `--base` that git cannot resolve (a typo) is reported (`baseRefFallback`) and you are told which base was actually used, rather than briefing against `main` unannounced; because per-file churn is matched by exact path (git history does not follow renames), a just-renamed file that reads as low-churn carries a caveat so its `surprising-change` label isn't trusted blindly; and the scope is **hand-authored source code** — infrastructure (IaC) resources and generated/vendored files are excluded (the same candidate set `coverage-gaps` ranks), so the briefing stays about the code whose call-graph significance the tiers actually measure. The cursor is the **base ref**, never wall-clock time. It also includes the tests to run for the whole change set (via `select_tests`), grouped by region/community. Deterministic and offline. The matching MCP tool `briefing_since` is exposed under `openlore mcp --preset full`.

#### Enforcement gate

`openlore enforce` is the **unified** finding-enforcement gate. It collects governance findings from every in-scope source, resolves each finding's enforcement class through the single declared [`enforcement.policy`](configuration.md#enforcement-policy) (with the legacy `blastRadius.block` / `impactCertificate.block` sugar lowered onto it), and — in `--hook` mode — fails the commit only when at least one finding resolves to `blocking`:

```bash
openlore enforce                 # human-readable gate report for the working tree (advisory)
openlore enforce --json          # documented JSON: gated, blocking[], advisory[], off[], unknownPolicyCodes[], caveats[]
openlore enforce --hook          # hook mode: stderr + exit 1 only on a blocking-classed finding
openlore enforce --install-hook  # install the unified pre-commit hook (coexists with the decisions gate)
openlore enforce --uninstall-hook
```

Sources: the **stale-decision-reference** check always runs (a cheap walk of the decision graph + anchored references — it flags a live, authoritative artifact that still cites a superseded decision); the **blast-radius** orphan patterns and **impact-certificate** surfaces are collected only when the repository has configured them (those analyses are diff-heavy). Every source is advisory-safe — a throw degrades to a caveat and never blocks. Advisory by default: a repository that declares no `enforcement.policy` never blocks, and an `off`-classed finding is still listed (silenced, not invisible). Deterministic, no LLM. This gate is the recommended single posture; the per-surface `blast-radius --hook` / `impact-certificate --hook` remain for repositories that prefer one source per hook.

---

## OpenSpec plugin manifest

`openlore plugin-manifest` inspects and validates the OpenSpec **plugin** manifest
OpenLore publishes — the `"openspec"` key in its `package.json` — so the OpenSpec
marketplace can discover, surface, gate, and invoke OpenLore as a subprocess
without importing its code. It is **distinct** from `openlore manifest` (the
federation `.well-known/openlore.json`); the names never collide.

```bash
openlore plugin-manifest emit            # human-readable summary
openlore plugin-manifest emit --json     # the manifest as JSON, stdout only
openlore plugin-manifest validate        # schema + semantic check of OpenLore's own manifest
openlore plugin-manifest validate <dir>  # validate another package's manifest
```

`validate` exits `0` when the manifest is valid, `1` on a schema/semantic failure
(missing required field, no `bin`/`binArgs`, non-token `namespace`, a traversing
skill `dir`/`source`), and `2` when no manifest is found. The manifest declares the
namespace (`lore`), the executable (`bin: openlore`), `openspecCompat` (kept
coherent with the `@fission-ai/openspec` peer-dep range), the help-only surfaced
commands, the contributed skill, and `ownsConfigKeys: ["openlore"]`. See
[OPENSPEC-INTEGRATION.md](OPENSPEC-INTEGRATION.md) for the full marketplace contract.

> **Node-version guard.** OpenLore requires Node ≥22.5. The CLI checks this before
> any command runs; under an older Node it prints one stderr line naming the
> required and actual versions and exits with the stable code **78** — never a
> stack trace — so a host delegating to OpenLore (e.g. `openspec lore generate` on
> Node 20) surfaces a clean, legible failure.

---

## Serve (warm daemon)

`openlore serve` runs a long-lived loopback HTTP daemon that keeps openlore's
caches warm across calls and, with `--watch` (default), keeps the analysis
continuously fresh — signatures/vector live, plus a debounced full call-graph
re-analyze after each edit burst. It exposes the same tools as the MCP server
over plain HTTP so non-MCP clients (e.g. the [Pi](https://pi.dev) extension in
`examples/pi/`) can hit them with `fetch` — no JSON-RPC, no subprocess-per-call.

```bash
openlore serve                          # navigation preset, ephemeral port, watch on
openlore serve --preset all --port 7077 # all 71 tools on a fixed port
openlore serve --no-watch               # transport only, no freshness lane
openlore serve --stop                   # stop the daemon serving this directory
```

| Option | Description |
|--------|-------------|
| `-d, --directory <path>` | Project root to serve; discovery file written here (default: cwd) |
| `-p, --port <number>` | Port to bind (default: ephemeral free port) |
| `--host <host>` | Host to bind (default: `127.0.0.1`) |
| `--preset <name>` | Advisory surface reported by `/health`: `minimal`, `navigation` (default), or `all`/`full` (the full surface — `full` matches the `openlore mcp` selector name). The daemon dispatches any known tool regardless; clients curate their own surface |
| `--token <token>` | Require this token as the `x-openlore-token` header (default: `$OPENLORE_SERVE_TOKEN`) |
| `--no-watch` | Disable the freshness watcher + re-analyze lane |
| `--stop` | Stop a running daemon for `--directory` and exit |

Endpoints (loopback only): `GET /health`, `POST /tool/:name` with body
`{ "directory": "...", "args": { ... } }`. Discovery: the daemon writes
`.openlore/serve.json` `{ port, pid, host, token? }` (removed on clean shutdown).

```bash
PORT=$(jq .port .openlore/serve.json)
curl 127.0.0.1:$PORT/health
curl -XPOST 127.0.0.1:$PORT/tool/orient -d '{"args":{"task":"add rate limiting"}}'
```

### Pi integration

`openlore setup --tools pi` installs the Pi extension to `.pi/extensions/openlore.ts`
(add `--global` for `~/.pi/agent/extensions/`). It auto-starts and talks to the
serve daemon, injecting structural context and exposing the navigation tools.
See `examples/pi/README.md`.

---

## Developer Scripts

| Script | Description |
|--------|-------------|
| `npm run bench` | EdgeStore micro-benchmark (node lookup, BFS, orient path) — requires `openlore analyze` |
| `npm run bench:mcp` | MCP handler benchmark — measures cold vs warm path for `readCachedContext`, `handleOrient`, `handleSearchCode`. Requires `openlore analyze`. Pass a project dir: `npm run bench:mcp -- /path/to/project` |

