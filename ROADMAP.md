# OpenLore roadmap

> Governing decision: [ADR-0035](openspec/decisions/) — focus on the verification/governance moat and
> cross-harness interop. This file sequences the open [`openspec/changes/`](openspec/changes) backlog
> against that decision. It is a priority view, not a spec: normative behavior still lives in
> `openspec/specs/`, and each change folds its delta into those specs only when it ships and is
> archived.

## The thesis in one breath

Claude Code and Codex still ship **no persistent codebase index** — they grep or clone-per-task — so a
deterministic, local-first structural substrate fills a real gap for them. The *retrieval* half of
that is commoditizing and the IDEs are absorbing memory, so we don't compete on retrieval breadth. We
deepen the two things that are hard to replicate and that harness vendors are least likely to build:

1. **The verification/governance moat** — deterministic, no-LLM blast radius, spec drift, public-surface
   contracts, claim verification, provenance-tracked memory on one graph. What makes an agent
   *trustworthy*, not just *informed*. The 2026 bottleneck is verification, not generation: agents
   can't self-correct without external feedback, and "an agent can only achieve what it receives
   feedback on."
2. **Interop** — AGENTS.md / SKILL.md / SCIP / LSP / MCP, so OpenLore augments *whatever* agent the
   user runs instead of being one more tool to choose. "Best tool for agents" means best *underneath*
   the agent.

## Execution order

Work the phases in order. Within a phase, each change ships as its own reviewed PR and folds its delta
into `openspec/specs/` on archive. Nothing here is code yet — these are the specs and the path.

| Phase | What | Why this order |
|-------|------|----------------|
| **0 — Harden first** | Make the moat's claims measured, not asserted | The whole pitch is "deterministic and sound"; prove it before building more on top |
| **1 — New direction (3 features)** | Verification feedback loop, change-provenance certificate, fleet coordination arc | The net-new capabilities that extend the moat into the industry's open problems |
| **1b — Into the agent loop** | Diff findings agents most need, pushed through harness hooks; contract graph; parallel-agent facts | Turns pull-only receipts into feedback at the moment the agent can act |
| **2 — Remaining moat + interop** | The rest of the BUILD/interop set | Still high-value; sequenced after the new direction lands |
| **3 — Defer** | Breadth proposals | Promote only on a concrete user need |

## Phase 0 — Harden first

The moat's credibility is the product. Harden the claims before extending them.

| Work | What | Status |
|------|------|--------|
| [`add-callgraph-soundness-calibration`](openspec/changes/add-callgraph-soundness-calibration) | Measure the soundness/precision numbers instead of asserting them | open proposal |
| Freshness-lease correctness under drift | Guarantee a receipt is never served stale-as-fresh when the base moves (the same discipline the fleet arc depends on) | hardening theme — scope a proposal when picked up |
| Known-limitations residue | Package-aware monorepo scale and keyword recall for abbreviated identifiers — where big real repos quietly underperform | hardening theme |

## Phase 1 — New direction (the three features)

Each is net-new, but built almost entirely by composing shipped deterministic conclusions — no new
analysis engine, no LLM.

| Feature | What it does | Builds on |
|---------|--------------|-----------|
| [`add-verification-feedback-loop`](openspec/changes/add-verification-feedback-loop) | `verify_change`: one ordered, actionable receipt from the existing checks (blast radius, tests to run, spec drift, surface breaks) — external feedback at the moment the agent can act on it | composes shipped `blast_radius` / `select_tests` / `check_spec_drift` / `certify_public_surface` / `structural_diff` |
| [`add-change-provenance-certificate`](openspec/changes/add-change-provenance-certificate) | `certify_provenance`: a reproducible, content-addressed record of *what a change does*, shaped to attach to SLSA/in-toto identity attestation — the semantic half of provenance nobody provides | composes shipped `change_impact_certificate` etc.; supersedes the deferred attested-governance proposal |
| [`add-merge-semantic-certificate`](openspec/changes/add-merge-semantic-certificate) | `certify_merge`: "git merges cleanly, the combination is broken" — the landing verdict the fleet arc records | the public-surface breaking-change classifier (shipped); **dependency of the fleet arc** |
| [`add-fleet-coordination-arc`](openspec/changes/add-fleet-coordination-arc) | Drift-aware shared verification memory + `fleet_status`: completes dispatch → in-flight → landing so parallel agents don't re-verify what's still valid and never trust a verdict the base invalidated | shipped `plan_parallel_work` / `map_in_flight_conflicts` + anchored memory + freshness lease + `certify_merge` |

## Phase 1b — Into the agent loop (added 2026-10-31)

Research and triage: [`CONTRACT-GRAPH-AND-AGENT-LOOP-2026-10.md`](openspec/changes/CONTRACT-GRAPH-AND-AGENT-LOOP-2026-10.md).
Phase 1 builds the receipts; Phase 1b catches the diff shapes agents most often get wrong and
pushes every receipt to the agent at the moment it can act, including between parallel agents.
Work in this order:

| # | Change | What it does for the agent |
|---|--------|----------------------------|
| 1 | [`add-generated-file-guard`](openspec/changes/archive/2026-10-31-add-generated-file-guard) — **shipped** (#629, [docs](docs/generated-files.md)) | "This file is generated from `order.proto`; regenerate with …" |
| 2 | [`add-phantom-reference-findings`](openspec/changes/archive/2026-10-31-add-phantom-reference-findings) — **shipped** (#632, [docs](docs/phantom-references.md)) | Invented imports, exports, and packages caught, before the write through `verify_change`'s `patch` input |
| 3 | [`add-check-weakening-findings`](openspec/changes/archive/2026-10-31-add-check-weakening-findings) — **shipped** ([docs](docs/check-weakening.md)) | Skipped/deleted tests, removed assertions, suppressions, relaxed CI — joined to the code they guarded |
| 4 | [`add-session-structural-ledger`](openspec/changes/add-session-structural-ledger) | Names the symbol that changed under the agent; sees modify/revert loops; edits after the last test run |
| 5 | [`add-agent-loop-hook-surfaces`](openspec/changes/add-agent-loop-hook-surfaces) | Receipts pushed after edits, after compaction, before stop, at sub-agent start, at task creation |
| 6 | [`add-session-handoff-briefing`](openspec/changes/add-session-handoff-briefing) | Compaction no longer loses the in-flight change (promoted from Defer) |
| 7 | [`add-service-contract-certification`](openspec/changes/add-service-contract-certification) | API schemas as graph nodes: handler ↔ operation, parity, breaking verdicts, consumers (promoted from Phase 2) |
| 8 | [`add-iac-code-binding`](openspec/changes/add-iac-code-binding) | Which code a resource runs; which manifests still set a renamed env var |
| 9 | [`add-peer-footprint-board`](openspec/changes/add-peer-footprint-board) | Parallel agents see each other's footprints and are told when a peer changes what they read |
| 10 | [`add-graph-claim-kinds`](openspec/changes/add-graph-claim-kinds) | `verify_claim` answers "is this endpoint implemented / called?", "does a decision govern this?", "is what I read still current?" (`decision-governed` can ship first) |

Items 1–3 add findings, not tools, and land in `verify_change` (its 2026-10-31 addenda also add the
speculative `patch` input, diff-scoped architecture violations, and `secret-added`). The phase adds
three tools, none in the default surface: `get_handoff_briefing` and `certify_service_contract`
(`full` preset) and `declare_footprint` (`coordination` preset). The lane for parallel
agents: OpenLore computes and publishes coordination facts; harness transports deliver them; no
messaging, dispatch, or locks.

## Phase 2 — Remaining moat + interop

Kept as open proposals; sequence after Phase 1.

**Interop:** [`adopt-agent-context-interop`](openspec/changes/adopt-agent-context-interop) (AGENTS.md/SKILL.md + slim injected digest) ·
[`add-scip-index-interchange`](openspec/changes/add-scip-index-interchange) ·
[`add-lsp-evidence-tier`](openspec/changes/add-lsp-evidence-tier) ·
[`adopt-mcp-tasks-and-cache-hints`](openspec/changes/adopt-mcp-tasks-and-cache-hints) ·
[`add-structural-search-tool`](openspec/changes/add-structural-search-tool)

**Moat / value:** [`add-dependency-impact-analysis`](openspec/changes/add-dependency-impact-analysis) ·
[`add-vuln-reachability-triage`](openspec/changes/add-vuln-reachability-triage) ·
[`add-store-origin-provenance`](openspec/changes/add-store-origin-provenance) ·
[`add-behavior-neutral-change-verdict`](openspec/changes/add-behavior-neutral-change-verdict) ·
[`add-team-memory-promotion`](openspec/changes/add-team-memory-promotion) ·
[`add-coverage-map-test-selection`](openspec/changes/add-coverage-map-test-selection) ·
[`add-incremental-early-cutoff`](openspec/changes/add-incremental-early-cutoff) ·
[`add-call-site-usage-profile`](openspec/changes/add-call-site-usage-profile) (promoted from Defer) ·
[`add-build-graph-ingest`](openspec/changes/add-build-graph-ingest) (promoted from Defer: zero-config workspace tier)

## Phase 3 — Defer

Plausible, not now — mostly the `*-conclusions` / `*-certificate` / `*-graph` breadth cluster. Each is
a new tool on a surface already shrunk to a lean default ([ADR-0023](openspec/decisions/)); the bar to
promote one is a concrete user need, not completeness.

`add-data-flow-conclusions` · `add-datastore-access-graph` · `add-ffi-boundary-edges` ·
`add-effect-purity-inference` · `add-resource-lifecycle-conclusions` · `add-shared-state-hazard-conclusions` ·
`add-flag-impact-analysis` · `add-log-anchor-conclusions` ·
`add-doc-claim-certification` · `add-migration-impact-certificate` · `add-knowledge-map-and-coupling-upgrades` ·
`add-refactoring-aware-churn` · `add-symbol-provenance-conclusions` · `add-ownership-tagged-conclusions` ·
`add-codeowners-ownership-evidence` · `add-invalidation-receipts` · `add-assumption-anchored-resolutions` ·
`add-test-evidence-claims` ·
`adopt-spec-link-status-vocabulary`

`honour-npmrc-in-update-check` is effectively **built** — only a manual private-registry check remains.

## Won't do — archived 2026-10-24

Moved to [`openspec/changes/archive/2026-10-24-*`](openspec/changes/archive) with full text preserved
(archive, not delete). Batch note: [`2026-10-24-WONT-DO-roadmap-focus.md`](openspec/changes/archive/2026-10-24-WONT-DO-roadmap-focus.md).

- **The 22 Kotlin changes** — full first-class support for one more language is breadth, not moat; the
  multi-language ladder already fails soft for Kotlin. Already NOT DOING in `STATUS.md`.
- **`add-notebook-cell-graph`**, **`add-line-provenance-evidence`**, **`add-render-guard-index`** — narrow / speculative.
- **`add-attested-governance-artifacts`** — **superseded** by `add-change-provenance-certificate`, which carries the interop target and the recompute-to-verify guarantee it lacked.

## How we execute

Phases in order; within a phase, one change per PR, each shipping behind its tests and then
`openspec archive <name>` to fold its delta into `openspec/specs/`. Promote from Defer only on
evidence. Re-run this triage whenever a sweep adds proposals — the tiers are a living view, not a
contract.
