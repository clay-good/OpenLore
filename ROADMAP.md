# OpenLore roadmap

> Governing decision: [ADR-0035](openspec/decisions/) — focus on the verification/governance moat and
> cross-harness interop. This file sequences the open [`openspec/changes/`](openspec/changes) backlog
> against that decision. It is a priority view, not a spec: normative behavior still lives in
> `openspec/specs/`, and each change below folds its delta into those specs only when it ships and is
> archived.

## The thesis in one breath

Claude Code and Codex still ship **no persistent codebase index** — they grep or clone-per-task — so a
deterministic, local-first structural substrate (call graph, blast radius, spec drift, no-LLM memory
with provenance) fills a real gap for them. But the *retrieval* half of that is commoditizing (Serena,
CodeGraph, managed context engines) and the IDEs are absorbing memory outright (Cursor's always-on
index, Antigravity's native Knowledge Items). So we stop competing on retrieval breadth and double down
on the two things that are hard to replicate and that the harness vendors are least likely to build:

1. **The verification/governance moat** — deterministic, no-LLM blast radius, spec drift, public-surface
   contracts, claim verification, and provenance-tracked memory on one graph. This is what makes an
   agent *trustworthy*, not just *informed*.
2. **Interop** — AGENTS.md / SKILL.md / SCIP / LSP / MCP, so OpenLore augments *whatever* agent the
   user runs (Claude Code, Codex, Antigravity) instead of being one more tool to choose between.

"Best tool for agents" means best *underneath* the agent.

## BUILD NOW — the moat + interop

| Change | Face | Why it's first |
|--------|------|----------------|
| [`adopt-agent-context-interop`](openspec/changes/adopt-agent-context-interop) | interop | Make AGENTS.md / SKILL.md first-class and **slim the auto-injected digest** — our own cited benchmark shows always-injected context cuts task success ~3% and raises cost >20%. Highest leverage: rides every harness, and it's also a correctness fix. |
| [`add-callgraph-soundness-calibration`](openspec/changes/add-callgraph-soundness-calibration) | moat | Measure the soundness/honesty claims instead of asserting them. The credibility of "deterministic and sound" *is* the product. |
| [`add-dependency-impact-analysis`](openspec/changes/add-dependency-impact-analysis) | value | Consumer-side blast radius for a dependency bump — extends `blast_radius`, constant real demand (every dependabot PR). |
| [`add-vuln-reachability-triage`](openspec/changes/add-vuln-reachability-triage) | value | "Is the vulnerable function actually reachable from my code?" High-stakes, differentiated, reachability-gated. |
| [`add-scip-index-interchange`](openspec/changes/add-scip-index-interchange) | interop + moat | Ingest a compiler-verified SCIP index (export already ships); upgrades `name_only` call sites to compiler-grade provenance. |
| [`add-lsp-evidence-tier`](openspec/changes/add-lsp-evidence-tier) | moat | Compiler-grade receipts that escalate/discharge `certify_public_surface` and strengthen `verify_claim`. Evidence only, no navigation surface. |
| [`add-structural-search-tool`](openspec/changes/add-structural-search-tool) | value | Deterministic AST pattern search (`await` in a loop, empty `catch`) — structure, not text. Fills a gap grep and semantic search can't. |
| [`add-store-origin-provenance`](openspec/changes/add-store-origin-provenance) | moat (memory) | Immutable write-time origin on every memory/decision; the deterministic defense against memory poisoning (OWASP ASI06). Protects the memory substrate's trust. |

## BUILD NEXT — strong, right after the above

| Change | Why |
|--------|-----|
| [`add-merge-semantic-certificate`](openspec/changes/add-merge-semantic-certificate) | The fleet-era landing gap: two branches merge cleanly yet disagree structurally. The breaking-change classifier it needs already shipped. |
| [`add-behavior-neutral-change-verdict`](openspec/changes/add-behavior-neutral-change-verdict) | Prove the no-op half of a diff is a no-op; subtract it from blast radius / briefing / churn for precision. |
| [`add-team-memory-promotion`](openspec/changes/add-team-memory-promotion) | Git-native, PR-reviewed shared memory — uses the approval gate you already have, zero new infra. |
| [`add-coverage-map-test-selection`](openspec/changes/add-coverage-map-test-selection) | Opt-in precision layer over `select_tests` (a shipped strength) using real coverage. |
| [`add-service-contract-certification`](openspec/changes/add-service-contract-certification) | Extend the public-surface contract to service schemas and the consumers a break strands. |
| [`adopt-mcp-tasks-and-cache-hints`](openspec/changes/adopt-mcp-tasks-and-cache-hints) | Ride the MCP protocol: cache hints carry the lease, tasks carry long builds. Gated on the MCP RC stabilizing. |
| [`add-incremental-early-cutoff`](openspec/changes/add-incremental-early-cutoff) | Unchanged extracted facts stop the invalidation cascade — scale, pairs with the monorepo theme. |

## DEFER — plausible, not now

Kept as open proposals; revisit when a real user need or a BUILD item pulls one in. Order within this
tier is not yet decided.

`add-data-flow-conclusions` · `add-datastore-access-graph` · `add-ffi-boundary-edges` ·
`add-effect-purity-inference` · `add-resource-lifecycle-conclusions` · `add-shared-state-hazard-conclusions` ·
`add-flag-impact-analysis` · `add-log-anchor-conclusions` · `add-call-site-usage-profile` ·
`add-doc-claim-certification` · `add-migration-impact-certificate` · `add-knowledge-map-and-coupling-upgrades` ·
`add-refactoring-aware-churn` · `add-symbol-provenance-conclusions` · `add-ownership-tagged-conclusions` ·
`add-codeowners-ownership-evidence` · `add-invalidation-receipts` · `add-assumption-anchored-resolutions` ·
`add-attested-governance-artifacts` · `add-build-graph-ingest` · `add-test-evidence-claims` ·
`add-session-handoff-briefing` · `adopt-spec-link-status-vocabulary`

Most of these are the `*-conclusions` / `*-certificate` / `*-graph` breadth cluster. Each is a *new*
tool on a surface we already had to shrink to a lean default ([ADR-0023](openspec/decisions/)); the bar
to promote one to BUILD is a concrete user need, not completeness.

`honour-npmrc-in-update-check` is effectively **built** — only a manual private-registry check for the
author remains; it stays open as a reminder, not a backlog item.

## WON'T DO — archived 2026-10-24

Moved to [`openspec/changes/archive/2026-10-24-*`](openspec/changes/archive) with full text preserved
(archive, not delete — the *reason we declined* is memory worth keeping). See the batch note:
[`2026-10-24-WONT-DO-roadmap-focus.md`](openspec/changes/archive/2026-10-24-WONT-DO-roadmap-focus.md).

- **The 22 Kotlin changes** (`add-kotlin-*`, `fix-kotlin-*`, `harden-kotlin-grammar-currency`,
  `widen-kotlin-control-flow-overlay`). Full first-class support for one more language is breadth, not
  moat; the existing multi-language ladder already fails soft for Kotlin. These were already marked NOT
  DOING in `STATUS.md`; this makes it official.
- **`add-notebook-cell-graph`** — Jupyter notebooks are a narrow audience for a coding-agent substrate.
- **`add-line-provenance-evidence`** — human-vs-agent line attribution is speculative and privacy-adjacent.
- **`add-render-guard-index`** — narrow (UI render guards); re-propose properly if a real need appears.

## How we execute

Work the BUILD list top-down, one change at a time. Each change ships behind its tests, then
`openspec archive <name>` folds its delta into `openspec/specs/`. Promote from DEFER only on evidence.
Re-run this triage whenever a sweep adds proposals — the tiers are a living view, not a contract.
