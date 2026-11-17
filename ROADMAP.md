# OpenLore roadmap

> Governing decision: [ADR-0036](openspec/decisions/adr-0036-deliver-deterministic-evidence-to-the-agent-at-hoo.md)
> (supersedes ADR-0035). Normative behavior lives in `openspec/specs/`. Each item below is an open
> change in `openspec/changes/` until it ships and is archived.

## Direction

- **Evidence at four moments.** Through hooks, the agent gets deterministic evidence when a prompt
  is submitted, before an edit, after an edit, and before stop. Each finding carries proof (file,
  line, edge, or receipt) and leads to one action: fix it, decide and record why, or raise it to a
  human in the agent's own final message or PR body. It stays quiet unless something is new and real.
- **Simple, local, always on.** No new MCP tools, integrations, services, or network calls. No LLM
  in the hot path. No separate UI. Findings are advisory; enforcement stays off by default.
- **Silent in the background.** OpenLore speaks to the agent only with evidence it can act on. It
  speaks to the user only when work runs that the user would otherwise wonder about, such as an
  index build: then the status line shows progress. Otherwise it says nothing.
- **A utility for agents, not a spec generator.** The plugin carries deterministic evidence tools
  only, used on demand like a shell tool. Spec generation stays in the npm CLI and MCP presets.
- **Any spec workflow.** OpenSpec is the first-class format, but no feature may require OpenSpec or
  its CLI. A repo with no spec framework still gets full value from code, tests, and decisions.
- **Every current user keeps working.** No tool renames, no aliases. The npm CLI, the MCP server and
  the Pi extension stay supported; tools hidden from the plugin's default set stay available there.
- **Proof from daily use**, not benchmark tracks. Target: `claude plugin install`, no config.

## Build next

**Core accuracy first (owner, 2026-11-15):** fix what makes the evidence agents receive wrong or
noisy, one PR each, before more P1 work. Next: [`spec-framework-neutrality`](openspec/changes/spec-framework-neutrality)
group 5 (the remaining `openspec/` sites honor `openspecPath`), then the P0 row below.

Shipped since 3.6.0 for the same reason:

- **Prompt briefing:** names only code the prompt names exactly (#758; replay with
  `npm run bench:briefing`); "no index" is said only when there is none (#760).
- **Call graph:** TypeScript grammar gaps no longer leave parse errors (#759); JavaScript is labeled
  JavaScript (#764); Java and C# field calls use the field's declared type (#765).
- **Freshness and scope:** the watcher honors `.openlore-ignore` and `excludePatterns` (#766); the
  hooks, status line and Pi find the project by one rule (#768).
- **Served text:** OpenAPI enum changes read as values (#767); every MCP tool input has a
  description (#769); spec text is labeled reviewed only when it is, and spec paths follow
  `openspecPath` (#771, #773).
- **Install and CI:** a user-scope install wires the edit-time hooks (#762); CI runs every
  integration test that can check something there (#770).
- **Test selection, measured:** `npm run bench:select-tests` replays recent commits and checks
  whether `select_tests` names the tests each one had to touch (#780, tiers #785). Over 20 commits,
  recall went from 84% to 98%: dynamic imports, source guards named by path, a function added to a
  file, imported classes and object literals, and renamed imports (#776, #781–#783). The 22
  high-confidence files find 79% of them; medium and above finds 94% in 64 files (#786), and
  `blast_radius` lists every file to run (#775). A rule for tests that run the CLI as a process was
  measured and dropped: it added files and found nothing new.
- **Dogfooding `blast_radius`:** an empty ADR `**Domains**:` line no longer names `## Context`
  (#787); domain-level ADR matches are one line, not one per ADR (#788); the diff itself is not
  reported as index staleness (#789).
- **Hook findings and health:** a swallowed error moved across files counts as moved, and its
  fallback is named (#777); a failed hook run records why (#778).

## P0: 3.6.0 follow-ups (small fixes, any time)

| Fix | Where | Source |
|-----|-------|--------|
| 15 tool descriptions exceed 800 characters (token cost, not accuracy) | `analyze_error_propagation`, `find_clones`, `briefing_since`, … in `src/cli/commands/mcp.ts` | `mcp-quality` spec |

## P1: the agent-evidence direction (in this order)

| # | Change | Why it helps the agent | Needs |
|---|--------|------------------------|-------|
| 1 | [`ship-claude-code-plugin`](openspec/changes/ship-claude-code-plugin) ([PR #727](https://github.com/clay-good/OpenLore/pull/727), merged; dogfooding, the 3.7.0 pin, and the directory submission remain) | Hooks and tools arrive with one install and stay current | — |
| 2 | `hook-reliability` (shipped; [archived](openspec/changes/archive/2026-11-15-hook-reliability)) | Hooks never slow or break a session, each finding is said once, and index progress goes to the status line, not the agent | — |
| 3 | `reframe-governance-as-agent-evidence` (shipped; [archived](openspec/changes/archive/2026-11-15-reframe-governance-as-agent-evidence); task 2.1 not doing) | One small plugin set; governance arrives as quiet findings with proof and one action | — |
| 4 | [`spec-framework-neutrality`](openspec/changes/spec-framework-neutrality) (groups 1-4 merged: #751, #753, #754, #756, #772; group 5 in progress: #771, #773) | OpenSpec, Spec Kit and BMAD are detected; none is required; "no specs" is an honest state, never a zero | can start any time |
| 5 | [`curate-product-surface`](openspec/changes/curate-product-surface) | Fewer, current skills and docs, so nothing stale misleads the agent | 1, 3 |

## P2: next, after P1 ships

Five items get their own change folder only when P1 has shipped. Each names the existing change
that carries it today, or what it builds on.

| Item (no folder yet) | What it does for the agent | Carried by |
|------|----------------------------|------------|
| `stop-hook-speaks-to-agent` | The before-stop receipt reaches the agent, not only the user, and is silent when nothing is new | `add-verification-feedback-loop` |
| `intent-check-at-stop` | Before stop, the change is checked against the intent it touches: requirements, asserting tests, decisions | `add-test-evidence-claims`, `adopt-spec-link-status-vocabulary` |
| `test-failure-localization` | A failed test or command points at the line that emitted the error and the changed code that reaches it | `add-log-anchor-conclusions` |
| `first-session-experience` | The first prompt in a repo gets a short digest; a plan prompt is oriented. Build progress is `hook-reliability` group 9 | `adopt-agent-context-interop`, `add-openspec-proposal-orientation` |
| `proven-fact-memory` | Durable facts are kept because a session proved them (a failing test and the change that fixed it, a recorded decision, a reverted change), not only when an agent calls `remember`; each is kept or retired by whether later sessions use it. Today memory is code-anchored and goes stale on its own, but what is remembered depends on an opt-in tool | builds on `remember`/`recall` (memory triggers, claim verdicts, anchor verdicts) and the session ledger |

| Change | Why it helps the agent |
|--------|------------------------|
| [`add-verification-feedback-loop`](openspec/changes/add-verification-feedback-loop) | One receipt names every break the diff causes, with proof, while the agent can still fix it |
| [`add-test-evidence-claims`](openspec/changes/add-test-evidence-claims) | Before it says "this is tested," it knows if a test asserts on the symbol, only calls it, or only reaches it |
| [`adopt-spec-link-status-vocabulary`](openspec/changes/adopt-spec-link-status-vocabulary) | It sees when it touches code that a requirement covers but no test reaches, or that no requirement asks for |
| [`add-log-anchor-conclusions`](openspec/changes/add-log-anchor-conclusions) | It starts at the line that emitted an error instead of grepping fragments of a message |
| [`adopt-agent-context-interop`](openspec/changes/adopt-agent-context-interop) | A few lines of repository shape once per session and five short skills, not a long file every turn |
| [`add-openspec-proposal-orientation`](openspec/changes/add-openspec-proposal-orientation) | A plan, spec, or proposal starts from what the user asked and from the real code, in any spec workflow |
| [`add-incremental-early-cutoff`](openspec/changes/add-incremental-early-cutoff) | After an edit that changed no structure, answers stay fresh and it is not told to re-orient |
| [`add-behavior-neutral-change-verdict`](openspec/changes/add-behavior-neutral-change-verdict) | It can say "these symbols changed only in comments and layout" with proof, and check the rest |

## P3: later

| Change | Why it helps the agent |
|--------|------------------------|
| [`add-agent-loop-hooks-task-created`](openspec/changes/add-agent-loop-hooks-task-created) | A team task that will collide with a live peer is stopped before work starts (waits on harness facts) |
| [`add-assumption-anchored-resolutions`](openspec/changes/add-assumption-anchored-resolutions) | A known gap in the graph is answered once, with proof, instead of disclosed on every call |
| [`add-call-site-usage-profile`](openspec/changes/add-call-site-usage-profile) | It copies the call shape the repo already uses and sees which callers a signature change breaks |
| [`add-codeowners-ownership-evidence`](openspec/changes/add-codeowners-ownership-evidence) | It can name the right human in its final message or PR body |
| [`add-datastore-access-graph`](openspec/changes/add-datastore-access-graph) | Before it drops or narrows a column, it sees the functions and tests that still use it |
| [`add-doc-claim-certification`](openspec/changes/add-doc-claim-certification) | It fixes the README line it just broke, in the same change |
| [`add-effect-purity-inference`](openspec/changes/add-effect-purity-inference) | It stops guessing purity from names and sees when an edit splits a shared-state update across an `await` |
| [`add-ffi-boundary-edges`](openspec/changes/add-ffi-boundary-edges) | It stops calling a function dead or safe to change when another language calls it through a binding |
| [`add-iac-deploy-binding-commands`](openspec/changes/add-iac-deploy-binding-commands) | When it edits a script a container runs, it sees which image or pod runs it |
| [`add-invalidation-receipts`](openspec/changes/add-invalidation-receipts) | It reads the one commit that broke a remembered fact and decides to re-anchor or drop it |
| [`add-refactoring-aware-churn`](openspec/changes/add-refactoring-aware-churn) | It sees when a function appeared, what changed it last, and what changes with it, across renames |
| [`add-resource-lifecycle-conclusions`](openspec/changes/add-resource-lifecycle-conclusions) | It learns at once that its new early return skips a `close()`, with the line |
| [`adopt-mcp-tasks-and-cache-hints`](openspec/changes/adopt-mcp-tasks-and-cache-hints) | The client reads freshness as data, and a first index build shows progress and can be canceled (waits on the MCP revision) |

## Later (not now)

- Adapters for more harnesses (Codex, Cursor, Antigravity, others) beyond what ships today.
- Agent Plugins 1.0 packaging.

## Not doing

Cut work is deleted, not archived: in OpenSpec, archived means shipped. Restore a change with
`git show 0dd75dbef:openspec/changes/<name>/proposal.md`; restore a cut task from the same path's
`tasks.md`.

| Name | Reason | Restore SHA |
|------|--------|-------------|
| `add-build-graph-ingest` | New integration (Nx, Turborepo, Bazel exports); its zero-config manifest tier goes with it | `0dd75dbef` |
| `add-coverage-map-test-selection` | New integration (coverage artifacts); `select_tests` already works from the graph | `0dd75dbef` |
| `add-dependency-impact-analysis` | New tool; its convenience path fetches packages from a registry | `0dd75dbef` |
| `add-lsp-evidence-tier` | New integration (a language-server sidecar) | `0dd75dbef` |
| `add-scip-index-interchange` | New integration (a `--scip` mode on `openlore import`) | `0dd75dbef` |
| `add-store-origin-provenance` | Serves the commit gate and operator policy, not evidence about the change in hand | `0dd75dbef` |
| `add-team-memory-promotion` | A workflow for humans to manage, not evidence for the agent | `0dd75dbef` |
| `add-vuln-reachability-triage` | New tool that needs caller-supplied advisory data | `0dd75dbef` |
| `add-data-flow-conclusions` | New tool and a new analysis engine; too large for the value | `0dd75dbef` |
| `add-structural-search-tool` | New tool; agents already have grep and ast-grep | `0dd75dbef` |
| `add-flag-impact-analysis` | New tool for a narrow case | `0dd75dbef` |
| `add-knowledge-map-and-coupling-upgrades` | Mostly facts about people (bus factor); its coupling noise guards go with it | `0dd75dbef` |
| `add-ownership-tagged-conclusions` | Lease tokens (#644) already give exact staleness of what `orient` and `recall` served; the rest is plumbing | `0dd75dbef` |
| `add-migration-impact-certificate` | Merged into `add-datastore-access-graph`; its lock-hazard rule table is dropped | `0dd75dbef` |
| `add-shared-state-hazard-conclusions` | Merged into `add-effect-purity-inference`; Go support and the reader census are dropped | `0dd75dbef` |
| `add-symbol-provenance-conclusions` | Merged into `add-refactoring-aware-churn`; the separate tool is dropped | `0dd75dbef` |
| `add-callgraph-soundness-calibration` tasks: CI job; execution-witnessed recall harness, results doc, its checks | Benchmark track; proof comes from daily use | `0dd75dbef` |
| `add-change-provenance-certificate` tasks: CLI; public-surface field; addendum fold-ins; in-toto check against an external validator | New surface; the MCP tool stays as shipped | `0dd75dbef` |
| `add-merge-semantic-certificate` tasks: retained edges; diff-union build scoping; CLI | New surface or low value for the agent loop | `0dd75dbef` |
| `add-fleet-coordination-arc` tasks: `carried` state and invalidating commit; live arc execution; CLI; lease test for both | No tool records a verdict yet, so these add surface with no user | `0dd75dbef` |
| `add-verification-feedback-loop` tasks: `openlore verify-change` CLI; pre-commit gate; their tests | New surfaces; the MCP tool and the before-stop hook already deliver the receipt | `0dd75dbef` |
| `spec-framework-neutrality` task: Kiro adapter | The owner named OpenSpec, Spec Kit and BMAD; add Kiro when a user asks | `63001d670` |

## Research notes (removed)

Reports that sat in `openspec/changes/` but were not changes. Restore with
`git show 0dd75dbef:openspec/changes/<file>`.

| Files | Restore SHA |
|-------|-------------|
| `README.md`, `STATUS.md` (this file replaces them) | `0dd75dbef` |
| `DOGFOOD-call-resolution-recall.md`, `DOGFOOD-change-impact-certificate.md`, `DOGFOOD-v2.0.19.md`, `DOGFOOD-v2.1.1-tool-count-drift.md`, `DOGFOOD-widen-js.md` | `0dd75dbef` |
| `RELEASE-v2.1.0.md`, `RELEASE-v2.1.1.md`, `RELEASE-v2.1.2.md`, `RELEASE-v2.1.4.md`, `RELEASE-v2.1.5.md` | `0dd75dbef` |
| `E2E-AUDIT-2026-07.md`, `E2E-FIRSTRUN-2026-07-27.md`, `KNOWN-LIMITATIONS-2026-07.md`, `FEATURE-UPDATES.md`, `HARDEN-DISTRIBUTION-AND-SUBSTRATE.md` | `0dd75dbef` |
| `BACKGROUND-SUBSTRATE-2026-10.md`, `COMPETITIVE-SUBSTRATE-2026-07.md`, `CONTRACT-GRAPH-AND-AGENT-LOOP-2026-10.md`, `ECOSYSTEM-RESEARCH-2026-07-27.md`, `FIELD-RESEARCH-2026-07.md`, `GOVERNANCE-SUBSTRATE-2026-07-31.md`, `SUBSTRATE-WHITESPACE-2026-07-27.md`, `STRUCTURAL-CONTEXT-PATTERNS.md` | `0dd75dbef` |
| `KOTLIN-TOTAL-SUPPORT-2026-10.md`, `PARALLEL-WORK-COORDINATION.md`, `SPEC-STORE-INTEGRATION.md` | `0dd75dbef` |

## Notes for the owner

Decided 2026-11-14 (owner's answers to the open questions):

| Question | Decision | Where |
|---|---|---|
| Plugin tool set (ADR-0037) | `verify_change` stays out of `substrate` (its benchmark is not doing); the `plugin` set is a subset of `substrate` except `verify_change`, with no spec-generation tool | `reframe-governance-as-agent-evidence` design 1 |
| Spec frameworks | Detect OpenSpec, Spec Kit and BMAD; require none | `spec-framework-neutrality` |
| No specs found | Spec numbers are `null` with reason `no-spec-source` and a `no spec source found` note, never 0 | `spec-framework-neutrality` design 3 |
| Index-building message | Progress in the status line and `openlore status`; nothing in the agent's context; one start and one ready line only for users without OpenLore's status line | `hook-reliability` group 9 |
| Spec skills in the plugin | No; the plugin ships evidence skills only | `curate-product-surface` |


- `honour-npmrc-in-update-check` is archived as shipped. One task is manual: check the update
  notifier against a private registry (Nexus) on a machine set up for one.
