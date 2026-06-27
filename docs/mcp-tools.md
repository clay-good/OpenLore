## MCP Server

`openlore mcp` starts openlore as a [Model Context Protocol](https://modelcontextprotocol.io/) server over stdio, exposing static analysis as tools that any MCP-compatible AI agent (Cline, Roo Code, Kilocode, Claude Code, Cursor...) can call directly -- no API key required.

### Setup

**Claude Code** -- add a `.mcp.json` at your project root:

```json
{
  "mcpServers": {
    "openlore": {
      "command": "openlore",
      "args": ["mcp"]
    }
  }
}
```

or for local development:

```json
{
  "mcpServers": {
    "openlore": {
      "command": "node",
      "args": ["/absolute/path/to/openlore/dist/cli/index.js", "mcp"]
    }
  }
}
```

**Cline / Roo Code / Kilocode** -- add the same block under `mcpServers` in the MCP settings JSON of your editor.

### Recommended lean surface (cost, Spec 25 P1 · Spec 28)

MCP clients send every tool's JSON Schema on every request, so tools the agent never calls are pure per-request overhead. The full surface is **71 tools / ~78 KB / ~20k tokens** of `tools/list`. The Spec 14 benchmark showed this prefix is what made openlore *lose* on small repos — and that a lean, navigation-focused surface flips it to a win (see the [Value Scorecard](../README.md#value-scorecard--does-it-pay-for-itself)).

**Since `default-to-lean-tool-surface`, the lean surface is the default**, not an extra step: `openlore install` (and a bare `openlore mcp`) wires the **`navigation`** preset — 10 tools, the benchmark winner — so the byte win is the out-of-box experience. The full surface is one explicit opt-in away (`--preset full` / `--all-tools`), and every governance/memory/verify/federation/coordination capability stays reachable via its named preset. When the lean default is active, the server advertises this once via its `instructions` channel (no extra tool schemas) so an agent never concludes a capability is absent. To restore the prior all-tools default: `openlore install --preset full`.

**Spec 28 measured how far the *server* can shrink that prefix, honestly:** MCP has no server-driven lazy-schema mechanism (`tools/list` always returns full schemas), and the lossless server-side byte-lever is only ~2% — the payload is dominated by irreducible per-tool schema structure plus the selection text an agent needs to pick a tool. So the real lever is the *client* (deferred schemas, below) and *tool count* (`--preset`), not byte-shaving. The surface has been trimmed losslessly anyway (shared param descriptions, no boilerplate) and is now **bounded by a regression guard** so it can't silently bloat. Two ways to get the lean surface, in order of preference:

1. **Deferred schemas (best — keeps every tool available).** If your client supports it (Claude Code: `alwaysLoad: false`), advertise tool *names* cheaply and load a tool's schema only when it's used. See the [two-server setup](agent-setup.md) — you keep all 71 tools without paying their schema cost up front.
2. **`--preset navigation` (server-side, navigation-only — now the default).** This is what a bare `openlore mcp` / `openlore install` already wires: a graph-traversal surface of 10 tools (orient, search_code, get_subgraph, trace_execution_path, analyze_impact, suggest_insertion_points, get_function_skeleton, get_landmarks, get_map, find_path). It is exactly the configuration the benchmark measured (−7%→−21% cost, −26% round-trips on deep traces). Note it omits the governance tools (`record_decision`, `check_architecture`, inventories), so if you use the decision gate or architecture checks during a session, prefer option 1 (deferred schemas) or wire a governance-bearing preset (`--minimal`, or the full surface with `--preset full`).

The tool list and schemas are emitted in a fixed, deterministic order with no per-request variation, so the provider KV-cache holds the surface and its cost drops sharply after the first call (guarded by a regression test).

### Watch mode (keep search_code and orient fresh)

By default the MCP server reads `llm-context.json` from the last `analyze` run. With `--watch-auto`, it also watches source files for changes and incrementally re-indexes signatures *and call-graph edges* so `search_code`, `orient`, and graph queries reflect your latest edits without waiting for the next commit.

Add `--watch-auto` to your MCP config args:

```json
{
  "mcpServers": {
    "openlore": {
      "command": "openlore",
      "args": ["mcp", "--watch-auto"]
    }
  }
}
```

The watcher is **on by default** — it starts automatically on the first tool call
(no hardcoded path needed) and keeps the analysis fresh as you edit. To disable it,
start the server with `openlore mcp --no-watch-auto`.

Freshness is **O(change), not O(repo)** (Spec 13.1): per-file save events are coalesced
into a single batched flush, the patched signatures are handed directly to the MCP read
cache (so the next tool call is a cache hit, not a cold re-parse of `llm-context.json`),
and the vector index is updated with row-level ops rather than a full-table rewrite.
A bulk event (branch switch / rebase / formatter) collapses to a single refresh. On large
repos (> 5000 source files) live embedding auto-degrades to signatures-only (logged once);
embeddings then refresh at commit. Set `OPENLORE_WATCH_DEBUG=1` for per-file stderr detail
(default is one summary line per batch).

The call graph **is** kept incrementally fresh: each save re-resolves the changed file's
reverse-dependency closure — its direct callers plus any prior non-callers whose
previously-unresolved calls a newly-added symbol should now bind — so the affected region
matches what `analyze --force` would produce. A bounded per-save work budget
(`INCREMENTAL_CLOSURE_BUDGET`, default 40 files) keeps a hub edit light; when a change's
closure exceeds it, the un-recomputed files are marked **explicitly stale** in the graph
metadata (freshness verdicts over their symbols report non-authoritative, never silently
wrong) and self-heal as later edits touch them. A full `openlore analyze --force` (e.g. the
[post-commit hook](#cicd-integration)) recomputes everything and clears the stale region.

| Option | Default | Description |
|---|---|---|
| `--watch-auto` | **on** | Auto-detect project root from first tool call |
| `--no-watch-auto` | — | Disable the auto-watcher (one-shot tool calls) |
| `--watch <dir>` | — | Watch a fixed directory (alternative to `--watch-auto`) |
| `--watch-debounce <ms>` | 400 | Idle delay before a coalesced flush after a change |
| `--watch-no-embed` | off | Signatures-only: skip live re-embedding (refresh at commit) |

### Cline / Roo Code / Kilocode

For editors with MCP support, after adding the `mcpServers` block to your settings, download the slash command workflows:

```bash
mkdir -p .clinerules/workflows
curl -sL https://raw.githubusercontent.com/clay-good/openlore/main/examples/cline-workflows/openlore-analyze-codebase.md -o .clinerules/workflows/openlore-analyze-codebase.md
curl -sL https://raw.githubusercontent.com/clay-good/openlore/main/examples/cline-workflows/openlore-check-spec-drift.md -o .clinerules/workflows/openlore-check-spec-drift.md
curl -sL https://raw.githubusercontent.com/clay-good/openlore/main/examples/cline-workflows/openlore-plan-refactor.md -o .clinerules/workflows/openlore-plan-refactor.md
curl -sL https://raw.githubusercontent.com/clay-good/openlore/main/examples/cline-workflows/openlore-execute-refactor.md -o .clinerules/workflows/openlore-execute-refactor.md
curl -sL https://raw.githubusercontent.com/clay-good/openlore/main/examples/cline-workflows/openlore-implement-feature.md -o .clinerules/workflows/openlore-implement-feature.md
curl -sL https://raw.githubusercontent.com/clay-good/openlore/main/examples/cline-workflows/openlore-refactor-codebase.md -o .clinerules/workflows/openlore-refactor-codebase.md
```

Available commands:

| Command | What it does |
|---------|-------------|
| `/openlore-analyze-codebase` | Runs `analyze_codebase`, summarises the results (project type, file count, top 3 refactor issues, detected domains), shows the call graph highlights, and suggests next steps. |
| `/openlore-check-spec-drift` | Runs `check_spec_drift`, presents issues by severity (gap / stale / uncovered / orphaned-spec), shows per-kind remediation commands, and optionally drills into affected file signatures. |
| `/openlore-plan-refactor` | Runs static analysis, picks the highest-priority target with coverage gate, assesses impact and call graph, then writes a detailed plan to `.openlore/refactor-plan.md`. No code changes. |
| `/openlore-execute-refactor` | Reads `.openlore/refactor-plan.md`, establishes a green baseline, and applies each planned change one at a time -- with diff verification and test run after every step. Optional final step covers dead-code detection and naming alignment (requires `openlore generate`). |
| `/openlore-implement-feature` | Plans and implements a new feature with full architectural context: architecture overview, OpenSpec requirements, insertion points, implementation, and drift check. |
| `/openlore-refactor-codebase` | Convenience redirect that runs `/openlore-plan-refactor` followed by `/openlore-execute-refactor`. |

All six commands ask which directory to use, call the MCP tools directly, and guide you through the results without leaving the editor. They work in any editor that supports the `.clinerules/workflows/` convention.

### Claude Skills

For Claude Code, copy the skill files to `.claude/skills/` in your project:

```bash
mkdir -p .claude/skills
curl -sL https://raw.githubusercontent.com/clay-good/openlore/main/skills/claude-openlore.md -o .claude/skills/claude-openlore.md
curl -sL https://raw.githubusercontent.com/clay-good/openlore/main/skills/openspec-skill.md -o .claude/skills/openspec-skill.md
```

**OpenLore Skill** (`claude-openlore.md`) — Code archaeology skill that guides Claude through:
- Project type detection and domain identification
- Entity extraction, service analysis, API extraction
- Architecture synthesis and OpenSpec spec generation

**OpenSpec Skill** (`openspec-skill.md`) — Skill for working with OpenSpec specifications:
- Semantic spec search with `search_specs`
- List domains with `list_spec_domains`
- Navigate requirements and scenarios

### Tools

Most tools run on **pure static analysis** — no LLM quota consumed. Exceptions: `record_decision` consolidation (LLM optional, falls back to diff extraction) and `sync_decisions` (writes to files).

**Run analysis**

| Tool | Description | Requires prior analysis |
|------|-------------|:---:|
| `analyze_codebase` | Run full static analysis: repo structure, dependency graph, call graph (hub functions, entry points, layer violations), and top refactoring priorities. Results cached for 1 hour (`force: true` to bypass). | No |
| `get_call_graph` | Hub functions (high fan-in), entry points (no internal callers), and architectural layer violations. Supports TypeScript, JavaScript, Python, Go, Rust, Ruby, Java, C++, Swift. | Yes |
| `get_signatures` | Compact function/class signatures per file. Filter by path substring with `filePattern`. Useful for understanding a module's public API without reading full source. | Yes |
| `get_duplicate_report` | Detect duplicate code: Type 1 (exact clones), Type 2 (structural -- renamed variables), Type 3 (near-clones with Jaccard similarity >= 0.7). Groups sorted by impact. | Yes |
| `find_clones` | Find existing clones of ONE query -- a `symbol` (a function in the index) or a `snippet` (raw code, even before you write it) -- ranked exact > structural > near. The edit-time "does this already exist? reuse it" question, scoped, where `get_duplicate_report` is the whole-repo audit. Reuses the same detector; one-vs-all so it finds near-clones even where the whole-repo O(n²) pass is skipped. Opt-in (`--preset full`). | Yes |
| `analyze_error_propagation` | The error-handling analogue of `analyze_impact`: given a `symbol` (TS/JS/Python), the exception types that can **escape** it to its callers (each with origin, direct-vs-propagated, and call path) and the ones thrown in its reachable subtree but **caught within** it (`handledInternally`, so callers are shielded). A **sound lower bound** -- an un-analyzable callee is disclosed in `boundaries`, never assumed exception-free; an intra-object `this.`/`super.`/`self.`/`cls.` call the call graph could not resolve is disclosed too (the one call shape that gets neither a resolved nor an `external::` edge); a re-raise of unknowable static type is `<dynamic>`, never dropped; Python typed `except` is matched by exact name only (disclosed). Computed live from the cached graph + a source re-read (no new artifact). A symbol in any other language returns an explicit `unsupported` result. Opt-in (`--preset full`). CLI: `openlore error-propagation`. | Yes |

**Explore & Navigate**

| Tool | Description | Requires prior analysis |
|------|-------------|:---:|
| `orient` | **Single entry point for any new task.** Given a natural-language task description, returns in one call: relevant functions, source files, spec domains, call neighbourhoods, insertion-point candidates, matching spec sections, and `suggestedTools` — a ranked list of next tools to call derived from task context (hub presence, spec domains, keywords). Start here. | Yes (+ embedding) |
| `search_code` | Natural-language semantic search over indexed functions. Returns the closest matches by meaning with similarity score, call-graph neighbourhood enrichment, and spec-linked peer functions. Falls back to BM25 keyword search when no embedding server is configured. | Yes (+ embedding) |
| `suggest_insertion_points` | Semantic search over the vector index to find the best existing functions to extend or hook into when implementing a new feature. Returns ranked candidates with role and strategy. Falls back to BM25 keyword search when no embedding server is configured. | Yes (+ embedding) |
| `get_subgraph` | Depth-limited subgraph centred on a function. Direction: `downstream` (what it calls), `upstream` (who calls it), or `both`. Output as JSON or Mermaid diagram. | Yes |
| `trace_execution_path` | Find all call-graph paths between two functions (DFS, configurable depth/max-paths). Use this when debugging: "how does request X reach function Y?" Returns shortest path, all paths sorted by hops, and a step-by-step chain per path. | Yes |
| `get_function_body` | Return the exact source code of a named function in a file. | No |
| `get_function_skeleton` | Noise-stripped view of a source file: logs, inline comments, and non-JSDoc block comments removed. Signatures, control flow, return/throw, and call expressions preserved. Returns reduction %. | No |
| `get_file_dependencies` | Return the file-level import dependencies for a given source file (imports, imported-by, or both). | Yes |
| `get_architecture_overview` | High-level cluster map: roles (entry layer, orchestrator, core utilities, API layer, internal), inter-cluster dependencies, global entry points, and critical hubs. No LLM required. | Yes |
| `get_minimal_context` | The minimum context to safely modify a function: its signature + body, direct callers and callees (signatures only), and which test files cover it. Cheaper than reading whole files. | Yes |
| `get_cluster` | All functions in the same community as a given function — label-propagation clusters of tightly-coupled code computed at analyze time. | Yes |
| `search_unified` | Search code functions AND spec requirements in one call, cross-boosting results — "where is X implemented and what does the spec say about it?" | Yes |

**Stack inventory**

| Tool | Description | Requires prior analysis |
|------|-------------|:---:|
| `get_route_inventory` | All detected HTTP routes with method, path, handler, and framework. Supports Express, NestJS, Next.js, FastAPI, Flask, and more. | Yes |
| `get_schema_inventory` | ORM schema tables with field names and types. Supports Prisma, TypeORM, Drizzle, and SQLAlchemy. | Yes |
| `get_ui_components` | Detected UI components with framework, props, and source file. Supports React, Vue, Svelte, and Angular. | Yes |
| `get_env_vars` | Env vars referenced in source code with `required` (no fallback) and `hasDefault` flags. Supports JS/TS, Python, Go, and Ruby. | Yes |
| `get_middleware_inventory` | Detected middleware with type (auth/cors/rate-limit/validation/logging/error-handler) and framework. | Yes |
| `get_external_packages` | All direct external dependencies from package manifests (npm `package.json`, pypi `pyproject.toml`/`requirements.txt`, cargo `Cargo.toml`, go `go.mod`) — each with name, version, and ecosystem. | Yes |

**Code quality**

| Tool | Description | Requires prior analysis |
|------|-------------|:---:|
| `get_refactor_report` | Prioritized list of functions with structural issues: unreachable code, hub overload (high fan-in), god functions (high fan-out), SRP violations, cyclic dependencies. | Yes |
| `get_critical_hubs` | Highest-impact hub functions ranked by criticality. Each hub gets a stability score (0-100) and a recommended approach: extract, split, facade, or delegate. | Yes |
| `get_god_functions` | Detect god functions (high fan-out, likely orchestrators) in the project or in a specific file, and return their call-graph neighborhood. Use this to identify which functions need to be refactored and understand what logical blocks to extract. | Yes |
| `analyze_impact` | Deep impact analysis for a specific function: fan-in/fan-out, upstream call chain, downstream critical path, risk score (0-100), blast radius, and recommended strategy. | Yes |
| `blast_radius` | Pre-flight structural blast-radius briefing for the current staged/working diff (advisory). Pure orchestration of existing analyses — no LLM: affected callers/layers and hubs (`analyze_impact`), tests to run (`select_tests`), and the anchored memories/decisions the diff will drift/orphan plus specs it will make stale (`check_spec_drift`). One conclusion-shaped briefing, never a graph. CLI: `openlore blast-radius` (+ `--install-hook` for an advisory pre-commit hook). | Yes |
| `get_low_risk_refactor_candidates` | Safest functions to refactor first: low fan-in, low fan-out, not a hub, no cyclic involvement. Best starting point for incremental, low-risk sessions. | Yes |
| `get_leaf_functions` | Functions that make no internal calls (leaves of the call graph). Zero downstream blast radius. Sorted by fan-in by default -- most-called leaves have the best unit-test ROI. | Yes |
| `structural_diff` | A graph diff (complement to `git diff`) between two states (working tree vs a ref, or two refs): what changed structurally and whose callers are now stale. | Yes |
| `detect_changes` | Detect recently changed functions (git diff vs a base ref) and rank them by blast radius (fan-in + transitive reach). | Yes |
| `get_change_coupling` | Co-change coupling mined from git history (not the call graph): what changes together with a file, and the most volatile code. | Yes |
| `get_health_map` | One-call structural health dashboard: hubs, god functions, layer violations, and volatile files, ranked by severity. A good starting point on an unfamiliar repo. Surfaces an `indexIntegrity` block when the on-disk index did not reconcile against its build-time attestation (`degraded` / `mismatched`), so the health signals are not presented as complete over a broken index. | Yes |
| `get_surprising_connections` | Unexpected structural coupling — cross-community edges, peripheral-to-hub calls, cross-test-boundary dependencies. Spot accidental coupling before a refactor. | Yes |
| `report_coverage_gaps` | Important code with **no reaching test**, ranked by hub/chokepoint significance — the structural inverse of `select_tests` over the whole graph, no runtime/coverage tool. SOUND DIRECTION ONLY: reports "no reaching test", never claims a symbol is "tested" (reachable-from-a-test ≠ behavior-verified). A gap with no caller at all is labeled also-dead (distinct from `find_dead_code`); an untested entry point is reported as untested-not-dead. Scope to a diff (`changedSymbols`/`diffRef`) or region (`filePattern`). Distinct from `get_test_coverage` (spec-tag based). Full surface only (opt-in `--preset full`); not in the lean default. CLI: `openlore coverage-gaps`. | Yes |
| `certify_public_surface` | With **no base ref**, returns the package's **public surface** (exported symbols + signatures); with a base ref, a deterministic **breaking-change verdict** for the working-tree diff — each changed export classified `breaking` / `non-breaking` / `potentially-breaking` (removed/renamed export, added required param, narrowed param/return type, reduced visibility), each breaking one paired with the **in-repo consumers it breaks**, plus an overall summary. **Conservative by construction**: a change it cannot *prove* compatible is `potentially-breaking`, never silently safe (no type checker, no build). A renamed export is reported as a rename (via symbol-identity continuity), not remove+add; external/unindexed consumers are disclosed as a known-unknowable boundary. Signature classification: TypeScript/JavaScript/Python (others fail-soft, surface membership only). Distinct from `change_impact_certificate` (paths *into* a surface) — this certifies the exported contract's *shape*. Full surface only (opt-in `--preset full`); not in the lean default. CLI: `openlore certify-public-surface`. | Yes |
| `get_style_fingerprint` | A **descriptive, deterministic idiom profile** measured during the AST walk (no second parse, no LLM): per language, the dominant choice for a fixed counter set — function form (arrow vs. declaration vs. method), binding (`const` vs. `let`), conditional (ternary vs. `if`), async (`await` vs. `.then`), string (template vs. concatenation), function-naming case — as `{ dominant, ratio, samples }`. Repository profile by default; `communityId` for a region, `filePath` for one file. **Honest by construction**: a counter below a fixed **evidence floor**, or one the language/formatter **enforces** (e.g. Go's visibility-by-case → `functionNaming` reports an `enforced` null), withholds its ratio rather than reporting a misleading or tautological value. **Descriptive, not prescriptive** — it measures what the code *is*, emits no lint judgment, and blends nothing into a composite style score. Languages: TypeScript / JavaScript / Python / Go (others fail-soft, no counters). `orient` also carries a compact `regionStyle` summary for the area in scope. Full surface only (opt-in `--preset full`); not in the lean default. CLI: `openlore style-fingerprint`. | Yes |
| `briefing_since` | A **catch-up briefing**: given a base ref, the changed production symbols **since** it, ranked into a fixed tier order — `surprising-change` (a high-fan-in **hub** whose file **rarely changed before**) > `hub-change` (a broad high-fan-in/high-fan-out hub) > `chokepoint-change` (a high-fan-in funnel) > `ordinary-change`. Unlike `blast_radius` / `change_impact_certificate` (which brief *your own* pending diff), this briefs everything that moved since the ref — the reviewer / returning-engineer / onboarding lens. Tiers come **entirely from existing classifiers** (`landmark-signals` hub/orchestrator/chokepoint + the `volatilityLevel` churn classifier) plus raw evidence (fan-in, fan-out, prior churn) — **no weighted score, no new tuning constant**. **Honest by construction**: changed symbols are **file-granular** (disclosed); the `surprising-change` label is **withheld** when history is too shallow (`< 2` non-bulk commits) to say "rarely changed before"; a bounded briefing carries a **truncation receipt** (omitted count + lowest tier) and **never drops a higher tier for a lower one**; a **silent base-ref fallback is disclosed** (an unresolvable `baseRef` reports `baseRefFallback` instead of silently briefing against `main`); and the file-path-exact churn join (git does not follow renames) is caveated when it could over-flag a just-renamed file as surprising; and the scope is **hand-authored source code** — IaC resources and generated/vendored files are excluded (their change-impact has its own lens), the same candidate set `report_coverage_gaps` ranks. Grouped by region, with the tests to run for the whole change set (via `select_tests`). The cursor is the **base ref**, never wall-clock time. Full surface only (opt-in `--preset full`); not in the lean default. CLI: `openlore briefing-since`. | Yes |

**Specs**

| Tool | Description | Requires prior analysis |
|------|-------------|:---:|
| `get_spec` | Read the full content of an OpenSpec domain spec by domain name. | Yes (generate) |
| `get_mapping` | Requirement->function mapping produced by `openlore generate`. Shows which functions implement which spec requirements, confidence level, and orphan functions with no spec coverage. | Yes (generate) |
| `check_spec_drift` | Detect code changes not reflected in OpenSpec specs. Compares git-changed files against spec coverage maps. Issues: gap / stale / uncovered / orphaned-spec / adr-gap. | Yes (generate) |
| `search_specs` | Semantic search over OpenSpec specifications to find requirements, design notes, and architecture decisions by meaning. Also searches ADR files (`openspec/decisions/adr-*.md`) indexed under domain `decisions`. Returns linked source files for graph highlighting. Use this when asked "which spec covers X?" or "where should we implement Z?" or "what decisions were made about Y?". Requires a spec index built with `openlore analyze` or `--reindex-specs`. | Yes (generate) |
| `list_spec_domains` | List all OpenSpec domains available in this project. Use this to discover what domains exist before doing a targeted `search_specs` call. | Yes (generate) |
| `audit_spec_coverage` | Parity audit: uncovered functions (in call graph, no spec), hub gaps (high fan-in + no spec), orphan requirements (spec with no implementation found), and stale domains (source changed after spec). Run before starting a feature to understand coverage health. No LLM required. | Yes (analyze) |
| `generate_tests` | Generate spec-driven test files from OpenSpec scenarios — vitest, playwright (JS/TS), pytest (Python), gtest/catch2 (C++), junit (Java/Kotlin), gotest (Go). | Yes (generate) |
| `get_test_coverage` | Which OpenSpec scenarios have test coverage — scans test files for `// openlore:` / `# openlore:` tags (added automatically by `generate_tests`). | Yes (generate) |
| `get_language_support` | The deterministic per-language **capability matrix** (`signatures`, `callGraph`, `imports`, `cfgOverlay`, `typeInference`, `styleFingerprint`, `iacProjection`, `crossServiceHttp`, `errorPropagation`) for the repo's detected languages — or, with a `language` name, that one language (a pure registry lookup; an unknown language returns an honest all-unsupported record). Tells you whether a quiet structural result means "nothing found" or "this language is only partly supported". Fail-soft: an unsupported capability yields nothing, never a guess. Full surface only (opt-in `--preset full`); not in the lean default. | Repo mode: yes; named mode: no |

**Decisions**

| Tool | Description | Requires prior analysis |
|------|-------------|:---:|
| `record_decision` | Record an architectural decision before writing code. Triggers background consolidation immediately — by commit time, decisions are already verified and the gate adds no LLM latency. | No |
| `list_decisions` | List decisions in the store, optionally filtered by status (`draft`, `consolidated`, `verified`, `approved`, `synced`, `phantom`). | No |
| `approve_decision` | Approve one or more decisions by ID, marking them ready to sync into specs and ADRs. | No |
| `reject_decision` | Reject a decision by ID with a reason. Rejected decisions are excluded from sync. | No |
| `sync_decisions` | Write approved decisions into OpenSpec spec.md files (as requirements) and create ADR files in `openspec/decisions/`. Append-only — never rewrites existing content. After sync, inactive decisions (synced/rejected/phantom) are purged from the store — their content lives in ADRs and git. Pass `dryRun: true` to preview. | No |

**Memory (opt-in, `--preset memory`)**

Durable, code-anchored notes that self-invalidate when the code they describe moves. Registered only under `openlore mcp --preset memory`.

| Tool | Description | Requires prior analysis |
|------|-------------|:---:|
| `remember` | Persist a durable, code-anchored memory (invariant / gotcha / rationale). Anchor it to a symbol and/or file so it self-invalidates when that code changes. Re-recording the same content+anchor updates in place; `supersedes` retires a prior memory. | Yes |
| `recall` | Recall code-anchored memories (notes + decisions) for a task with a freshness verdict — fresh, drifted (verify), or orphaned (never served as authoritative). Optional `asOf`/`changedSince` for history and a `type` filter. | Yes |

**Memory survives refactors (symbol identity continuity).** A pure rename or a file move changes a symbol's identity and would otherwise orphan every memory and decision anchored to it. At each `openlore analyze`, OpenLore detects the rename/move between the prior and new graph and **carries the anchors forward** to the new symbol, recording `carriedAcross: { from, reason, basis, atCommit }` provenance that `recall` surfaces on the anchor — so the note recalls as `fresh`/`drifted (carried)` instead of `orphaned`. The match is deterministic and conservative: `exact-body` (byte-identical span — a move) or `exact-signature` (body identical *modulo the symbol's own name* — a rename, verified by name substitution against the recorded baseline hash), admitted only on a strict one-to-one match where the name-independent body is unique among new symbols. A deleted symbol is never re-anchored onto an unrelated newcomer that merely shares a parameter shape; an ambiguous move stays `orphaned` and discloses `possiblyMovedTo: [...]` candidates rather than guessing. No new tool, no LLM; the carry runs as part of `analyze`.

**Claim verification (opt-in, `--preset verify`)**

| Tool | Description | Requires prior analysis |
|------|-------------|:---:|
| `verify_claim` | Verify a claim **before** asserting it to a human: a deterministic verdict (`confirmed` / `refuted` / `unverifiable`) plus a citation receipt. Structural kinds (`calls`, `reaches`, `dead`, `impacts`, `safe-to-change`) check the call graph ("X is dead", "Y calls Z", "this is safe to change"). The `decision-current` kind checks whether a recorded decision is still authoritative before you cite it — `subject` is an 8-char decision id, and the verdict is `refuted` (naming the live superseder to cite instead) if that decision was superseded or rejected. An `unverifiable` verdict means hedge or read the source. Registered only under `openlore mcp --preset verify`. | Yes (structural kinds) |

**Federation (multi-repo, opt-in)**

Registered only under `openlore mcp --preset federation`. Federation is an index-of-indexes: each repo keeps its own `.openlore` index, referenced by a project-local registry (`openlore federation add`). No merged graph is built.

| Tool | Description | Requires prior analysis |
|------|-------------|:---:|
| `federation_status` | Report the federation registry and each registered repo's live index state (`indexed` / `stale` / `unindexed` / `missing`), with registered-vs-live fingerprints. Read-only. | No |
| `spec_store_status` | Report the health of a spec-store binding (`.openlore/config.json` `specStore`): per-target resolution + live index state, reference presence, and store-path presence. Declared target/reference **names** resolve against the federation registry. Read-only; never throws, never blocks. | No |
| `working_set_context` | Assemble the working-set structural briefing for an active change in a spec-store binding: `orient`, generalized from one repo to the change's targets. Reads the change's proposal under the bound store, orients each resolved+indexed target on that intent, and returns ONE deterministic, token-budgeted, per-target-attributed briefing (symbol, callers, spec domains, insertion points) plus fresh in-scope anchored intent (orphaned withheld, drifted flagged). Read-only; never throws, never blocks. | Targets indexed |
| `change_impact_certificate` | Certify what the current diff touches before it lands: ONE conclusion-shaped certificate combining blast radius, the paths the change NEWLY OPENS into each declared covering surface (reachable after but not before — computed differentially over the call graph, no LLM), the specs it drifts, and the tests to run. Anchored to the touched symbols via the freshness lease, so it decays. Advisory; opt-in blocking only on a configured surface severity. CLI: `openlore impact-certificate` (+ `--install-hook`). | Yes |
| `map_in_flight_conflicts` | Cross-actor interference map — also in the `coordination` preset (full description [below](#parallel-work-coordination-opt-in---preset-coordination)). In the **federation** preset, passing `federation: true` matches in-flight changes (branches/PRs/agent tasks) **across repository boundaries** by content-addressed stable id, so a branch in repo A conflicts with a PR in repo B when they touch the same federated symbol. Read-only, stateless, advisory. | Yes |

When a registry exists, `analyze_impact`, `find_dead_code`, `select_tests`, and `find_path` accept opt-in `federation` (boolean) and `federationRepos` (name list) params: cross-repo consumers, live-via-federation exports, cross-repo test selection, and cross-repo producer/bridge location respectively. Each response names `reposConsulted` / `reposSkipped` — unindexed/stale repos are reported, never guessed.

A **spec-store binding** declares the code repositories an external spec repository targets/references; `spec_store_status` reports its health as a conclusion-shaped report whose `findings[]` carry stable codes (the `--json` agent contract):

| Code | Severity | Meaning |
|------|:---:|---------|
| `no-binding` | info | no `specStore` block configured (single-repo behavior unchanged) |
| `binding-invalid` | error | malformed block: empty name/path, self-referential store path, a duplicate name, or a name in both `targets` and `references` |
| `registry-unreadable` | error | `.openlore/federation.json` is present but corrupt/unparseable |
| `store-path-missing` | error | the store's declared `path` does not exist on disk |
| `target-unresolved` | error | a declared target name is not registered in the federation registry |
| `target-missing` | error | a resolved target's registered path no longer exists |
| `index-missing` | warn | a resolved target has no built `.openlore` index |
| `index-stale` | warn | a resolved target's index is stale vs its working tree |
| `reference-missing` | warn | a declared reference is unresolved or its path is gone |

The report is `sound` when it carries no error-severity finding. Every finding includes a pasteable `remediation`. Exposed only under `openlore mcp --preset federation`.

`working_set_context` builds on the binding: given `--change <id>`, it reads that change's proposal under the bound store, extracts a concise intent, and runs task-scoped `orient` against each resolved+indexed target. The merged briefing is ranked by structural relevance and bounded by a token budget (`tokenBudget`, default 8000); when truncated it carries an `omissionNote`. Every item is attributed to its target repository (`target`, `name`, `callers`, `specDomains`, `expand`). Fresh in-scope decisions appear under each target's `anchoredIntent` with `verdict: "current"`; drifted anchors appear as `verdict: "drifted"`; orphaned anchors are withheld entirely (orient never serves them as authoritative). Its `findings[]` carry stable codes (`no-binding`, `binding-unsound`, `change-unspecified`, `change-not-found`, `no-briefable-targets`, `target-not-briefable`, `orient-unavailable`); `ready` is true when the binding is sound and at least one target was briefed. Read-only, never blocks. Also exposed only under `openlore mcp --preset federation`.

`change_impact_certificate` is the third tool of the spec-store arc. Where `blast_radius` answers "what does this diff touch?", the certificate answers the more dangerous question "what can this diff now *reach* that it could not before?" — the cross-boundary case file-ownership misses. You declare **covering surfaces** (semantic/governance boundaries, not directory globs) under `impactCertificate.surfaces`; for the current diff, OpenLore computes reachability to each surface in the pre-change and post-change call graph and reports the paths that exist only after — the paths the change *opened*, with the shortest opening path named. This is differential and needs no full rebuild: a new call edge can only come from a changed file, so only the changed files are re-parsed (base-ref vs working tree), and the canonical adjacency is adjusted both ways (`post = canonical + added − removed`, `pre = canonical − added + removed`). The certificate also folds in blast radius, drifted specs, and tests-to-run (reused from `blast_radius`), and is anchored to the touched symbols via the freshness lease so it decays — when an anchored symbol later moves, `spec_store_status` re-fires it as a `certificate-stale` finding. Advisory by default; a repository MAY opt into blocking specific surface severities (e.g. `impactCertificate.block: ["critical"]`), exactly as `blast_radius` made blocking opt-in. That per-surface `block` is now thin sugar over the **unified `enforcement.policy`** (`{ "surface-critical": "blocking" }`), governed by the `openlore enforce` gate — one declarative source of truth across all governance findings, with a direct policy entry winning over inherited legacy sugar. See [configuration.md](configuration.md#enforcement-policy) and [cli-reference.md](cli-reference.md#enforcement-gate). CLI: `openlore impact-certificate [--base <ref>] [--change <id>] [--json] [--hook] [--save]`. Exposed only under `openlore mcp --preset federation`.

**Parallel-work coordination (opt-in, `--preset coordination`)**

Registered only under `openlore mcp --preset coordination`.

| Tool | Description | Requires prior analysis |
|------|-------------|:---:|
| `plan_parallel_work` | Before fanning N tasks out across agents/worktrees, decide which are safe to run concurrently. Given a caller-supplied task list (each with seed symbols/files and an optional `writeMode`), returns the computed plan: a hazard-typed conflict graph (WAW / shared-append / RAW / WAR / soft-coupling) with witnessing symbols, a wave schedule (wave 1 = dispatch now; later waves name the predecessors they wait on), and a critical path (the minimum sequential rounds even with unlimited agents). Stateless and advisory — re-invoke with the remaining tasks to re-plan; there is no lease, no task assignment, no memory between calls. | Yes |
| `map_in_flight_conflicts` | The *team* version of `plan_parallel_work`. Instead of a caller-supplied task list it harvests every change already in flight — local branches, open PRs (via `gh`), and any supplied agent task descriptors — and runs the same hazard classifier across all of them. Each footprint is derived from the change's ACTUAL diff, so it works without any `writeMode` declaration. Returns per conflict: the two actors, hazard class, shared symbols, and a suggested landing order. A change whose diff can't be fetched or whose symbols don't resolve is labeled "not assessed", never "no conflict". Read-only, stateless (no watcher/poll/store), advisory; also in the `federation` preset, where it matches across repo boundaries by stable id. | Yes |

`plan_parallel_work` is the agent-facing surface of the parallel-work-coordination set: it composes a deterministic per-task **footprint** (write-set / read-set / affected-set, with ambient high-fan-in symbols excluded) and a **pairwise hazard classifier** into the schedule. The conflict model is a borrow checker lifted from variables to repository regions — two tasks may not hold overlapping *mutable* borrows of the same region concurrently (WAW → different waves), a read-after-write is an ordering edge (RAW → later wave), and concurrent *appends* to a shared registration site (a dispatcher case, a tool-registry array) are low-risk (shared-append → same wave, advisory). Declare registration-site touches `writeMode: "append"` so they are not falsely serialized — otherwise the conservative `modify` default will (correctly, but unhelpfully) split them across waves. OpenLore schedules; it never invents or decomposes the task list, never holds a lock, and never dispatches — the harness owns state and dispatch. WAW conflicts surface as the `parallel-work-conflict` governance finding (and unorderable RAW cycles as `parallel-work-cycle`), emitted in the unified `GovernanceFinding` shape so the **caller that invoked `plan_parallel_work`** can classify them with `resolveEnforcementClass(code, policy)` and choose to block in its own orchestration/CI. Note: the bundled `openlore enforce` commit gate is diff-based and does **not** run the planner, so it never blocks on these codes — they are policy-governable by the caller, not by the bundled gate. The supporting-evidence lists (`conflicts`, `advisories`, `findings`, and the per-task footprint regions) are capped with authoritative uncapped counts and a `truncationNote` for a very large plan, so the response stays well within the MCP byte budget; the schedule (waves + critical path) is always complete. Every plan carries the standing disclosure that footprints are predicted and integration tests remain the ground truth.

`map_in_flight_conflicts` generalizes that conflict graph from "N tasks I am about to dispatch" to "every change in flight right now." A team's costliest collision is not "two of my agents collided," it is "my agent spent an hour rewriting `resolveCallSite`, and so did a teammate's open PR, and we find out at merge." Worktrees and branch isolation cannot prevent that — they cause it, then surface it late. This tool surfaces it early, structurally: it enumerates local branches (diffed against the base), open PRs (changed files via `gh`), and any supplied agent task descriptors as actor-attributed nodes `{ actor, ref, repo }`, derives each footprint from its **actual diff** rather than declared seeds, and runs the same pairwise hazard classifier across all of them. Because the write-set is observed, the per-symbol `writeMode` is read straight off the hunks — a symbol touched only by pure-insertion hunks is an `append`, one touched by any deletion/modification is a `modify` — so two PRs that each append a disjoint entry to the same dispatcher (or to the same module-scope registry array/object literal, which carries no function node — those module-scope appends fall back to a file-scope member) resolve to `shared-append` (merges trivially), not a false WAW, with no `writeMode` declaration needed. The base snapshot is parsed under each file's **base path**, so a symbol in a renamed-and-edited file keeps its base identity and still conflicts with an in-place edit of the same function (a rename does not hide a real merge conflict). Honesty is structural: a PR whose diff cannot be fetched, a federated target whose index is stale, a change whose symbols do not resolve, or a changed file whose base content could not be read (its symbols are omitted, disclosed in a caveat) is handled without ever producing a false "no conflict." (One deliberate limit: a module-scope *modify* of a non-function declaration is not assessed at symbol granularity — at file granularity it would over-couple disjoint top-level edits into a spurious WAW, and the tool prefers a rare missed module-scope-modify over a noisy false "must serialize.") It is read-only and stateless — no watcher, no polling, no persisted conflict store, no new graph schema; re-invoke to refresh. With `federation: true` it extends across repository boundaries, matching changes by content-addressed **stable id** (qualified name + parameter shape — the same identity model federation uses, with no file path or body) so a branch in repo A conflicts with a PR in repo B when they touch the same federated symbol, and degrading cleanly to single-repo when no federation is configured. Cross-repo matches carry a caveat that two genuinely different symbols sharing a name and arity across repos could collide, so confirm a cross-repo witness names the same logical symbol before acting (file paths are namespaced per repo, so a coincidental shared relative path never raises a false same-file overlap). WAW pairs surface as the `cross-actor-conflict` governance finding, so a CI check can `resolveEnforcementClass(code, policy)` and warn when a new PR's footprint collides with an open one. Advisory by default; the standing disclosure holds — structural overlap predicts conflict probability, not certainty, and merge/integration remains the ground truth.

**Story Management**

| Tool | Description | Requires prior analysis |
|------|-------------|:---:|
| `generate_change_proposal` | Generate a structured change proposal for a feature: affected functions, risk score, insertion points, spec impact, and a ready-to-use story file. Use during sprint planning or before implementing a non-trivial change. | Yes |
| `annotate_story` | Annotate an existing story file with structural context: risk score, affected functions, recommended insertion point, and spec domain links. Prepares a story for the dev agent so it can skip the orientation step. | Yes |

### Parameters

**`orient`**
```
directory    string   Absolute path to the project directory
task         string   Natural-language description of the task, e.g. "add rate limiting to the API"
limit        number   Max relevant functions to return (default: 5, max: 20)
tokenBudget  number   Optional: cap relevantFunctions to ~this many tokens (Spec 25 P4) —
                      highest-scored kept, exact duplicates collapsed; each carries an `expand` handle
lean         boolean  Optional: return only the navigation core (relevantFunctions + callPaths +
                      specDomains + suggestedTools), dropping enrichment (Spec 27). See below.
```

Response includes `suggestedTools: string[]` — a ranked list of openlore tool names relevant to the task, derived from hub presence, spec domains, and task keywords. No extra I/O. Use this on clients without Tool Search (Cline, Cursor, OpenCode) to know which tools to call next without enumerating all 69.

**Lean mode (Spec 27).** `lean: true` (CLI: `orient --lean`) returns only the navigation core for shallow "who calls X / where is Y" lookups — ~40% smaller than the rich default on this repo. Everything dropped (insertion points, provenance, change-coupling, inline specs, matching specs, decisions, architecture violations) is one `expand` handle or one dedicated tool call away, so it trims bytes per turn without forcing a follow-up round-trip. Lean is also **compute-lean** (Spec 27 P5): it skips the work behind those blocks — the extra spec-embedding search, manifest/spec-file reads, the decision-store load, and the git-derived joins — so the shallow path is faster, not only smaller. The rich default is unchanged; omit `lean` when you need specs, decisions, or insertion points.

**`working_set_context`**
```
directory    string   Absolute path to the home project directory (holds the specStore binding)
change       string   The change id to brief; its proposal.md lives under the bound store at
                      <store>/openspec/changes/<change>/. Confined to the store (traversal is rejected).
tokenBudget  number   Optional: cap the merged briefing to ~this many tokens (default: 8000)
```

Response (`WorkingSetContextReport`) — the stable JSON shape an orchestrator can rely on:
```
bound        boolean   whether a specStore binding is configured
store        { name, path }                       present when bound
change       { id, intent, declaredScope? }        intent = the ≤1000-char task oriented on; declaredScope = the change's spec-delta domains
targets      [ { target, briefed, reason?, insertionPoints[], specDomains[],
                 anchoredIntent[ { id, title, status, verdict: "current"|"drifted" } ] } ]
items        [ { target, name, filePath, score, expand, signature?, callers[], specDomains[] } ]   merged, ranked, budgeted
omissionNote string    present only when the budget dropped items
findings     [ { code, severity, subject, message, remediation } ]   stable codes (see below)
ready        boolean   true when the binding is sound AND ≥1 target was briefed
summary      string    conclusion-shaped headline
```
Finding codes: `no-binding`, `binding-unsound`, `change-unspecified`, `change-not-found`, `no-briefable-targets`, `target-not-briefable`, `orient-unavailable`. Read-only; always succeeds (every problem is a finding), never blocks.

**`change_impact_certificate`**
```
directory  string    Absolute path to the project directory (must have a built index)
baseRef    string    Optional: git ref to diff the working tree against (default: HEAD)
change     string    Optional: change id recorded on the certificate (default: "working-tree")
persist    boolean   Optional: write the certificate under .openlore/impact-certificates/ so the
                     spec-store health check can re-fire it when its lease decays
```

Response (`ImpactCertificate`) — the stable JSON shape an orchestrator can rely on:
```
change                 string   the change id (or "working-tree")
baseRef, resolvedBaseRef  string   requested vs the ref git actually diffed against
changed                { files, symbols }
surfaces               [ { name, severity, resolvedSymbols, unresolvedMembers[] } ]
newlyOpenedPaths       [ { surface, surfaceSeverity, openingEdge: { from, to }, path[], reaches } ]
impact / tests / specs    reused verbatim from blast_radius (or { unavailable })
lease                  { anchors[] }   the touched-symbol anchors that drive decay
findings               [ { code, severity, subject, message, remediation, surfaceSeverity? } ]
highestSurfaceSeverity "info" | "warn" | "critical" | "none"   the block signal
posture                "advisory"
caveats                string[]
headline               string   conclusion-shaped one-liner
```
Finding codes: `surface-newly-reached`, `surface-critical`, `surface-unresolved-member`, `surface-empty`, `spec-drift`, `unresolved-added-call`, `no-surfaces-declared` (and `certificate-stale`, emitted by `spec_store_status` when a persisted certificate's anchored symbols have moved). Declare covering surfaces under `impactCertificate.surfaces` in `.openlore/config.json` (a surface is a set of `{ symbol }` / `{ file }` members with an optional `severity`); opt into blocking with `impactCertificate.block: ["critical"]` — now thin sugar over the unified [`enforcement.policy`](configuration.md#enforcement-policy), governed by `openlore enforce`. (Note: the certificate's own finding codes above are what `--json` emits; the enforcement gate governs the per-severity codes `surface-info` / `surface-warn` / `surface-critical`, so a `enforcement.policy` entry should name `surface-critical`, not `surface-newly-reached`.) Newly-opened-path detection is differential and bounded — only the changed files are re-parsed; renamed files read their base-ref content, untracked files are folded in, and an ambiguous added callee is reported (`unresolved-added-call`), never guessed. Read-only; always succeeds (every problem is a finding/caveat), advisory — never blocks. Exposed only under `openlore mcp --preset federation`.

**`analyze_codebase`**
```
directory  string   Absolute path to the project directory
force      boolean  Force re-analysis even if cache is fresh (default: false)
```

**`get_refactor_report`**, **`get_call_graph`**
```
directory  string   Absolute path to the project directory
```

**`get_signatures`**
```
directory    string   Absolute path to the project directory
filePattern  string   Optional path substring filter (e.g. "services", ".py")
```

**`get_subgraph`**
```
directory     string   Absolute path to the project directory
functionName  string   Function name to centre on (case-insensitive partial match)
direction     string   "downstream" | "upstream" | "both"  (default: "downstream")
maxDepth      number   BFS traversal depth limit  (default: 3)
format        string   "json" | "mermaid"  (default: "json")
```

*Note: If no exact name match is found, `get_subgraph` falls back to semantic search (when a vector index is available) to find the most similar function.*

**`get_mapping`**
```
directory    string    Absolute path to the project directory
domain       string    Optional domain filter (e.g. "auth", "crawler")
orphansOnly  boolean   Return only orphan functions (default: false)
```

**`get_duplicate_report`**
```
directory  string   Absolute path to the project directory
```

**`check_spec_drift`**
```
directory  string    Absolute path to the project directory
base       string    Git ref to compare against (default: auto-detect main/master)
files      string[]  Specific files to check (default: all changed files)
domains    string[]  Only check these spec domains (default: all)
failOn     string    Minimum severity to report: "error" | "warning" | "info" (default: "warning")
maxFiles   number    Max changed files to analyze (default: 100)
```

**`list_spec_domains`**
```
directory  string   Absolute path to the project directory
```

**`analyze_impact`**
```
directory  string   Absolute path to the project directory
symbol     string   Function or method name (exact or partial match)
depth      number   Traversal depth for upstream/downstream chains (default: 2)
```

*Note: If no exact name match is found, `analyze_impact` falls back to semantic search (when a vector index is available) to find the most similar function.*

**`get_low_risk_refactor_candidates`**
```
directory    string   Absolute path to the project directory
limit        number   Max candidates to return (default: 5)
filePattern  string   Optional path substring filter (e.g. "services", ".py")
```

**`get_leaf_functions`**
```
directory    string   Absolute path to the project directory
limit        number   Max results to return (default: 20)
filePattern  string   Optional path substring filter
sortBy       string   "fanIn" (default) | "name" | "file"
```

**`get_critical_hubs`**
```
directory  string   Absolute path to the project directory
limit      number   Max hubs to return (default: 10)
minFanIn   number   Minimum fan-in threshold to be considered a hub (default: 3)
```

**`get_architecture_overview`**
```
directory  string   Absolute path to the project directory
```

**`get_function_skeleton`**
```
directory  string   Absolute path to the project directory
filePath   string   Path to the file, relative to the project directory
```

**`get_function_body`**
```
directory     string   Absolute path to the project directory
filePath      string   Path to the file, relative to the project directory
functionName  string   Name of the function to extract
```

**`get_file_dependencies`**
```
directory  string   Absolute path to the project directory
filePath   string   Path to the file, relative to the project directory
direction  string   "imports" | "importedBy" | "both"  (default: "both")
```

**`trace_execution_path`**
```
directory       string   Absolute path to the project directory
entryFunction   string   Name of the starting function (case-insensitive partial match)
targetFunction  string   Name of the target function (case-insensitive partial match)
maxDepth        number   Maximum path length in hops (default: 6)
maxPaths        number   Maximum number of paths to return (default: 10, max: 50)
```

**`get_spec`**
```
directory  string   Absolute path to the project directory
domain     string   Domain name (e.g. "auth", "user", "api")
```

**`get_god_functions`**
```
directory        string   Absolute path to the project directory
filePath         string   Optional: restrict search to this file (relative path)
fanOutThreshold  number   Minimum fan-out to be considered a god function (default: 8)
```

**`suggest_insertion_points`**
```
directory    string   Absolute path to the project directory
description  string   Natural-language description of the feature to implement
limit        number   Max candidates to return (default: 5)
language     string   Filter by language: "TypeScript" | "Python" | "Go" | ...
```

**`search_code`**
```
directory  string   Absolute path to the project directory
query      string   Natural-language query, e.g. "authenticate user with JWT"
limit      number   Max results (default: 10)
language   string   Filter by language: "TypeScript" | "Python" | "Go" | ...
minFanIn   number   Only return functions with at least this many callers
```

**`search_specs`**
```
directory  string   Absolute path to the project directory
query      string   Natural language query, e.g. "email validation workflow"
limit      number   Maximum number of results to return (default: 10)
domain     string   Filter by domain name (e.g. "auth", "analyzer")
section    string   Filter by section type: "requirements" | "purpose" | "design" | "architecture" | "entities"
```

**`generate_change_proposal`**
```
directory     string   Absolute path to the project directory
description   string   Natural-language description of the change (story, intent, or spec delta)
slug          string   URL-safe identifier for the proposal (e.g. "add-payment-retry")
storyContent  string   Optional full story markdown to embed in the proposal
```

**`annotate_story`**
```
directory      string   Absolute path to the project directory
storyFilePath  string   Path to the story file (relative to project root or absolute)
description    string   Natural-language summary of the story for structural analysis
```

**`record_decision`**
```
directory             string    Absolute path to the project directory
title                 string    Short decision title (e.g. "Use Redis for session cache")
rationale             string    Why this approach was chosen
consequences          string    Trade-offs and impacts of this decision
affectedFiles         string[]  Source files involved (relative paths)
proposedRequirement   string    Optional: "The system SHALL …" requirement to add to specs
supersedes            string    Optional: ID of a prior decision this replaces
```

**`list_decisions`**
```
directory  string   Absolute path to the project directory
status     string   Optional filter: draft | consolidated | verified | approved | synced | phantom
```

**`approve_decision`**
```
directory  string    Absolute path to the project directory
ids        string[]  Decision IDs to approve
```

**`reject_decision`**
```
directory  string   Absolute path to the project directory
id         string   Decision ID to reject
reason     string   Reason for rejection
```

**`sync_decisions`**
```
directory  string    Absolute path to the project directory
dryRun     boolean   Preview changes without writing files (default: false)
```

### Typical workflow

**Scenario A -- Initial exploration**
```
1. analyze_codebase({ directory })                    # repo structure + call graph + top issues
2. get_call_graph({ directory })                      # hub functions + layer violations
3. get_duplicate_report({ directory })                # clone groups to consolidate
4. get_refactor_report({ directory })                 # prioritized refactoring candidates
```

**Scenario B -- Targeted refactoring**
```
1. analyze_impact({ directory, symbol: "myFunction" })       # risk score + blast radius + strategy
2. get_subgraph({ directory, functionName: "myFunction",     # Mermaid call neighbourhood
                  direction: "both", format: "mermaid" })
3. get_low_risk_refactor_candidates({ directory,             # safe entry points to extract first
                                      filePattern: "myFile" })
4. get_leaf_functions({ directory, filePattern: "myFile" })  # zero-risk extraction targets
```

**Scenario C -- Spec maintenance**
```
1. check_spec_drift({ directory })                    # code changes not reflected in specs
2. get_mapping({ directory, orphansOnly: true })      # functions with no spec coverage
```

**Scenario D -- Starting a new task (fastest orientation)**
```
1. orient({ directory, task: "add rate limiting to the API" })
   # Returns in one call:
   #   - relevant functions (keyword/BM25 by default, or hybrid semantic when enabled)
   #   - source files and spec domains that cover them
   #   - call-graph neighbourhood for each top function
   #   - best insertion-point candidates
   #   - spec-linked peer functions (cross-graph traversal)
   #   - matching spec sections AND matching ADRs (domain "decisions")
   #   - active decisions touching the task's domains (pendingDecisions)
   #   - approved decisions always surfaced — must sync before committing
   #   - suggestedTools: ranked list of next tools to call based on task context
   #     (hub presence, spec domains, task keywords) — portable discovery for
   #     clients without Tool Search (Cline, Cursor, OpenCode)
2. get_spec({ directory, domain: "..." })             # read full spec before writing code
3. check_spec_drift({ directory })                    # verify after implementation
```

**Scenario E -- Coverage audit before implementing**
```
1. audit_spec_coverage({ directory })
   # Before writing code: surfaces stale domains, uncovered hub functions,
   # orphan requirements. 0 LLM calls, ~200ms.
2. If staleDomains includes your target: openlore generate --domains $DOMAIN
3. If hubGaps includes a function you'll touch: flag it in your risk check
```

**Scenario F -- Decisions workflow**
```
1. record_decision({ directory, title, rationale, consequences, affectedFiles })
   # Call this before writing code — captures the design choice
2. [implement the feature / refactor]
3. git commit  # decisions hook consolidates drafts, cross-checks against diff,
               # blocks commit if unreviewed decisions remain
   # If blocked, check "reason":
   #   "verified"              → present decisions to user, approve/reject, then sync
   #   "approved_not_synced"   → run sync_decisions, then retry commit
   #   "drafts_pending_consolidation" → run openlore decisions --consolidate --gate
   #   "no_decisions_recorded" → run openlore decisions --consolidate --gate
4. list_decisions({ directory, status: "verified" })
   # Review the consolidated + verified decisions
5. approve_decision({ directory, ids: ["<id>"] })
6. sync_decisions({ directory, dryRun: true })   # preview
7. sync_decisions({ directory })                  # write to specs and ADRs
```

---


## Semantic Search & GraphRAG

`openlore analyze` builds a vector index over all functions in the call graph, enabling natural-language search via the `search_code`, `orient`, and `suggest_insertion_points` MCP tools, and the search bar in the viewer.

### GraphRAG retrieval expansion

Semantic search is only the starting point. openlore combines three retrieval layers into every search result — this is what makes it genuinely useful for AI agents navigating unfamiliar codebases:

1. **Semantic seed** — keyword (BM25) search by default, or dense+BM25 hybrid ranking when embeddings are enabled, finds the top-N functions closest in meaning to the query.
2. **Call-graph expansion** — BFS up to depth 2 follows callee edges from every seed function, pulling in the files those functions depend on. During `generate`, this ensures the LLM sees the full call neighbourhood, not just the most obvious files.
3. **Spec-linked peer functions** — each seed function's spec domain is looked up in the requirement→function mapping. Functions from the same spec domain that live in *different files* are surfaced as `specLinkedFunctions`. This crosses the call-graph boundary: implementations that share a spec requirement but are not directly connected by calls are retrieved automatically.

The result: a single `orient` or `search_code` call returns not just "functions that mention this concept" but the interconnected cluster of code and specs that collectively implement it. Agents spend less time chasing cross-file references manually and more time making changes with confidence.

### Embedding configuration

Keyword (BM25) search is the first-class default and needs no configuration. To enable semantic ranking you have two options:

**Local, zero-config (recommended):**
```bash
openlore embed --local      # on-device, no API key; revert with: openlore embed --off
```

**Remote OpenAI-compatible endpoint** — via environment variables or `.openlore/config.json`:
```bash
EMBED_BASE_URL=https://api.openai.com/v1
EMBED_MODEL=text-embedding-3-small
EMBED_API_KEY=sk-...         # optional for local servers
openlore analyze             # embedding is automatic when configured
```

```json
{
  "embedding": {
    "provider": "remote",
    "baseUrl": "http://localhost:11434/v1",
    "model": "nomic-embed-text",
    "batchSize": 64
  }
}
```

- `provider`: `"local"` (on-device) or `"remote"` (default when `baseUrl`/`model` are set)
- `batchSize`: Number of texts to embed per API call (default: 64)

See [docs/semantic-search.md](semantic-search.md#retrieval-modes) for the full retrieval-mode reference. The index is stored in `.openlore/analysis/vector-index/` and is automatically used by the viewer's search bar and the `search_code` / `suggest_insertion_points` MCP tools.

