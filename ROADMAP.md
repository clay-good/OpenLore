# OpenLore roadmap

> Governing decision: [ADR-0038](openspec/decisions/adr-0038-make-openlore-as-trusted-as-grep-push-exact-eviden.md)
> (supersedes ADR-0036). Normative behavior lives in `openspec/specs/`. Each item below is an open
> change in `openspec/changes/` until it ships and is archived.

## Direction

**Goal: agents trust OpenLore the way they trust grep, and understand the codebase constantly as
they work.**

- **Exact or silent.** Every fact OpenLore pushes is exact, or says "not assessed" and why. A fact
  kind found wrong is fixed or removed before a new kind ships.
- **Pushed while the agent works.** Evidence arrives at five moments: a prompt is submitted, the
  first touch of a file, before an edit, after an edit, and before stop. Standing instructions stay
  a few lines. Nothing is said unless it is new and real.
- **Code and contracts first.** The call graph, tests, exports, routes, schemas, and config that
  code depends on. Written intent (specs, ADRs) is used when the repository has it; none is required.
- **The agent settles governance.** Each finding carries proof and one action: fix it, or record a
  decision with the proof. New findings are handed back to the agent once at stop. The agent raises
  to a human only when the evidence warrants it: a breaking change to a contract used outside the
  repository, overriding an accepted decision, an added secret, or a finding it cannot settle.
- **Simple and local.** No new MCP tools, integrations, services, or network calls. No LLM in the
  hot path. No renames or aliases. npm CLI, MCP server, Pi, and the Claude Code plugin stay supported.
- **Proof from daily use.** `openlore status` shows which pushed lines the agent acts on. A kind
  it never uses is cut.

Shipped work is in `CHANGELOG.md` and `openspec/changes/archive/`.

## Fix first (trust bar, ADR-0038 item 1)

The seven issues listed here before (#805-#811) are closed. These were found in older code while
`adopt-agent-context-interop` was reviewed; each is a small bug PR. Ordered by harm to an agent that
trusts the answer.

| Where | Harm | Fix |
|-------|------|-----|
| Prompt briefing `names()` (`orient-inject-render.ts`) | Shows 3 callers of a function with 5, with no "+2 more", and unqualified names | Say how many were left out; qualify class methods |
| Handoff briefing (`handoff.ts`) | Says "the index is behind the working tree" right after a fresh analyze, whenever any part is not assessed | Print the staleness line only when the index is stale; name the parts not assessed |
| Silence contract (`orient-inject.ts`) | A backticked name that does not resolve because the index is behind looks like "no such code" | Say the index is behind when an anchor does not resolve and the index is stale |
| `CODEBASE.md` workflow section and `orient` "Next steps" | Name tools the wired preset does not expose | Filter by the wired preset, as the prompt briefing does (since `trim-standing-agent-instructions`, `CODEBASE.md` is read on demand, not loaded every turn) |
| Prompt briefing `keepExactAnchors` | Drops the spec domain that an exact `Implementation` anchor links | Keep linked spec domains for the resolved symbol |
| `sanitizeForTerminal` (`misc.ts`) | Unicode tag characters and other invisible format characters survive every served frame | Strip them; the slim digest already refuses them |
| `openlore doctor` / `status --json` | Doctor warns about an LLM key on every fresh repository; `status --json` says no hook moment is wired while doctor counts 9 | Treat the optional LLM as optional; report wiring the same way in both |

## Next release (in this order)

| # | Change | What it does for the agent | Needs |
|---|--------|----------------------------|-------|
| 1 | `adopt-agent-context-interop` (shipped; [archived](openspec/changes/archive/2026-11-27-adopt-agent-context-interop)) | A 9-line digest once per session, and five short plugin skills | — |
| 2 | `trim-standing-agent-instructions` (shipped; [archived](openspec/changes/archive/2026-11-27-trim-standing-agent-instructions)) | Standing instructions are a few lines; tool descriptions are 800 characters or fewer; the full-digest `@`-import goes | — |
| 3 | [`add-incremental-early-cutoff`](openspec/changes/add-incremental-early-cutoff) | A comment or format edit no longer marks answers stale, so "stale" can be trusted | — |
| 4 | [`add-pushed-evidence-yield`](openspec/changes/add-pushed-evidence-yield) | We see which pushed lines the agent uses, so dead weight is cut | — |
| 5 | [`add-first-touch-file-briefing`](openspec/changes/add-first-touch-file-briefing) | The first read of a file shows its callers elsewhere, its decisions, its contracts, and its tests | 4 to measure it |
| 6 | [`add-session-catch-up-briefing`](openspec/changes/add-session-catch-up-briefing) | A new session starts with what changed since the last one, only when it matters | 1 (shipped) |
| 7 | [`add-verification-feedback-loop`](openspec/changes/add-verification-feedback-loop) group 4 and fold-ins | New breaks are handed back to the agent at stop, once, with proof; breaking exports, contract breaks, and still-set env keys join the receipt | — |
| 8 | [`add-log-anchor-conclusions`](openspec/changes/add-log-anchor-conclusions) | A failed command's error points at the line that emitted it | — |
| 9 | [`ship-claude-code-plugin`](openspec/changes/ship-claude-code-plugin) (finish) | One install, no setup: a week of daily use on three OS, the `doctor` double-wiring check, the directory submission | — |

## After that

| Change | What it does for the agent |
|--------|----------------------------|
| [`add-verification-feedback-loop`](openspec/changes/add-verification-feedback-loop) new findings and `patch` input | New architecture violations, added secrets, and new import cycles; grading an edit before it is written |
| [`curate-product-surface`](openspec/changes/curate-product-surface) | No stale skill is offered to the agent; fewer docs and a short README for people |
| [`spec-framework-neutrality`](openspec/changes/spec-framework-neutrality) groups 6-11 | Written intent from ADR folders first, then Spec Kit, BMAD, plain requirements, and tests |

## Later

| Change | What it does for the agent |
|--------|----------------------------|
| [`add-ffi-boundary-edges`](openspec/changes/add-ffi-boundary-edges) | A function called from another language is no longer reported dead or safe to change |
| [`add-call-site-usage-profile`](openspec/changes/add-call-site-usage-profile) | It copies the call shape the repository already uses, and sees which callers a signature change breaks |
| [`add-datastore-access-graph`](openspec/changes/add-datastore-access-graph) | Before it drops or narrows a column, it sees the code and tests that still use it |
| [`add-behavior-neutral-change-verdict`](openspec/changes/add-behavior-neutral-change-verdict) | It can say which changed symbols changed only in comments and layout, with proof |
| [`add-codeowners-ownership-evidence`](openspec/changes/add-codeowners-ownership-evidence) | When it must raise to a human, it names the right one |

Ideas without a folder, each carried by a shipped surface:

- **`intent-check-at-stop`**: before stop, check the change against the requirements, asserting
  tests, and decisions it touches. Carried by `verify_change` and test evidence (#799).
- **`proven-fact-memory`**: keep a durable fact because a session proved it (a failing test and the
  change that fixed it, a recorded decision, a reverted change), and retire it when later sessions
  do not use it. Builds on `remember`/`recall` and the session ledger.

## Not doing

Cut work is deleted, not archived: in OpenSpec, archived means shipped. Restore a change with
`git show <restore SHA>:openspec/changes/<name>/proposal.md`; restore a cut task from the same
path's `tasks.md`.

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
| `add-effect-purity-inference` | A new analysis engine (effects, shared state across `await`); too large and too imprecise to meet the trust bar (ADR-0038) | `e6d63d915` |
| `add-resource-lifecycle-conclusions` | Path-sensitive bug finding that linters already cover; hard to make exact | `e6d63d915` |
| `add-assumption-anchored-resolutions` | Mixes agent-written assumptions into deterministic answers, which weakens the trust bar | `e6d63d915` |
| `add-refactoring-aware-churn` | Agents already have `git log --follow`; small gain for the cost | `e6d63d915` |
| `add-doc-claim-certification` | Narrow (README lines); not code or contract context | `e6d63d915` |
| `add-invalidation-receipts` | Memory is an opt-in preset; a stale verdict already says not to trust the memory | `e6d63d915` |
| `adopt-spec-link-status-vocabulary` | Refines spec vocabulary, not code or contract context; `verify_change` test evidence (#799) covers the agent case | `e6d63d915` |
| `add-openspec-proposal-orientation` | Prompt-phrase heuristics for plan writing; not deterministic code context | `e6d63d915` |
| `add-iac-deploy-binding-commands` | Narrow; the shipped deploy binding (#645) covers the common case | `e6d63d915` |
| `add-agent-loop-hooks-task-created` | Waits on a harness event that is not documented; restore when it exists | `e6d63d915` |
| `adopt-mcp-tasks-and-cache-hints` | Waits on an MCP protocol revision; restore when it is final | `e6d63d915` |
| `add-agentic-configuration-assistant` tasks: 7.10 notification precision on a quiet-control corpus; 8.1 every acceptance fixture on all OS | The assistant shipped (#720) and is archived; these are measurement tasks with no agent-facing change | `e6d63d915` |

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

| Question | Decision | Where |
|---|---|---|
| Direction (2026-11-27) | Trusted like grep: exact or silent, pushed while the agent works, the agent settles governance, a human only when warranted | ADR-0038 |
| A fifth moment (2026-11-27) | The first touch of a file is a moment (`after-read`) | ADR-0038; `add-first-touch-file-briefing` |
| Plugin tool set | `verify_change` stays out of `substrate`; `plugin` is `substrate`'s evidence tools plus `verify_change`, with no spec-generation tool | ADR-0039 (supersedes ADR-0037) |
| Spec frameworks | Detect OpenSpec, Spec Kit and BMAD; require none | `spec-framework-neutrality` |
| No specs found | Spec numbers are `null` with reason `no-spec-source` and a `no spec source found` note, never 0 | `spec-framework-neutrality` design 3 |
| Index-building message | Progress in the status line and `openlore status`; nothing in the agent's context | `hook-reliability` (shipped) |
| Spec skills in the plugin | No; the plugin ships evidence skills only | `curate-product-surface` |

- `honour-npmrc-in-update-check` is archived as shipped. One task is manual: check the update
  notifier against a private registry (Nexus) on a machine set up for one.
- ADR-0038 and ADR-0039 were written by hand from decisions 35c3f807 and f7faf32c (approved in this
  checkout's local store, not synced). A `decisions --sync` here would also write a duplicate of
  ADR-0035 (decision 225084d7 was never marked synced in this store) and would add ADR-0039 to the
  analyzer and drift specs. Check with `--dry-run` before syncing.
