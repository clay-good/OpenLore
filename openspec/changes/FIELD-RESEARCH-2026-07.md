# Change set: field research sweep 2026-07-27 — the substrate the 2026 agent ecosystem is asking for

This directory gained 10 change proposals on 2026-07-27, produced by a three-track web research
sweep (agent memory & context engineering; code-intelligence capabilities; spec-driven
development, governance, and multi-agent trust) diffed against the full open backlog — all 94
open proposals were digested first, so every item here is net-new whitespace. Per project
policy, no competing agent product is named in any proposal; open formats, standards, and
academic sources are cited directly.

## What the research established

- **Positioning confirmed, twice.** The canonical vendor guidance on context engineering now
  prescribes exactly what OpenLore ships: just-in-time retrieval via lightweight identifiers
  over preloading, and the smallest high-signal token set
  (https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents; distractor
  evidence: https://www.trychroma.com/research/context-rot). And across the surveyed memory
  systems, every commercial write path is LLM-dependent — structurally-anchored,
  deterministically-invalidated memory has no commercial analogue. The differentiation claims
  hold against the 2026 landscape.
- **The field's succession trend replaces compaction with goal-scoped artifacts** (context
  collapse under iterative rewriting: https://arxiv.org/abs/2510.04618). OpenLore can compute
  the succession artifact no one else can — deterministic, replayable, receipt-backed.
- **Provenance is the new governance axis.** A vendor-neutral line-attribution record format
  now exists (https://agent-trace.dev/) with multi-harness adoption; attestation practice
  (in-toto envelopes) and platform transports (SARIF) are the settled sockets. Nobody joins
  line provenance to a call graph — that join is OpenLore-shaped whitespace.
- **Value-flow is the open capability gap.** The main OSS structural-rule engine paywalled
  cross-function taint; the code-property-graph literature shows the layer is computable from
  facts OpenLore already extracts (CFG + def-use + call graph).

## The ten proposals

| # | Change | Track | One line |
|---|--------|-------|----------|
| 1 | `add-line-provenance-evidence` | governance | Ingest open line-attribution records, project onto symbols: "this hub is agent-authored, unreviewed" as a disclosed evidence dimension |
| 2 | `add-attested-governance-artifacts` | governance | Emitted certificates become signed in-toto-style statements; decision history becomes hash-chained tamper-evident |
| 3 | `add-data-flow-conclusions` | capability | `trace_data_flow`: interprocedural value flow from existing def-use + call graph, sound-lower-bound honesty, hash-memoized summaries |
| 4 | `add-service-contract-certification` | capability | OpenAPI/proto/GraphQL breaking-change rule table, joined to the consumers the shipped cross-service topology already knows |
| 5 | `add-log-anchor-conclusions` | capability | Static log-template index; a pasted production line resolves to its emitting call site + paths + tests (no runtime integration) |
| 6 | `add-effect-purity-inference` | capability | Closed-vocabulary effect facts, compositional over resolved edges; verifiable `effect-free` claims; unverified `#__PURE__` flagged |
| 7 | `add-session-handoff-briefing` | memory/context | `get_handoff_briefing`: the in-flight state as one deterministic, replayable succession receipt with re-fetch identifiers |
| 8 | `add-scenario-checkability-binding` | SDD | Scenario shape lint (checkable THEN) + scenario→reaching-test binding in `audit_spec_coverage` |
| 9 | `add-change-evidence-audit` | self-governance | `openlore change-status`: STATUS.md's manual marker/sync evidence pass, computed with receipts; lifecycle stays delegated |
| 10 | `add-sarif-finding-emission` | governance | `--sarif` on enforce/review: the finding registry serialized to the platform's code-scanning rails; transport, never policy |

## How they compose

1+2+10 form the trust arc (who wrote it → what was certified → where platforms consume it);
3+6 share the summary-composition architecture (hash-keyed per-function facts, closed
transitively) and 3 is the machinery that later closes `analyze_env_impact`'s disclosed
config-object boundary; 4 rides the shipped cross-service HTTP topology; 5 is the
`analyze_env_impact` shape applied to the logging surface; 7 composes only shipped lookups;
8 consumes whatever anchor fidelity `ground-generated-specs-in-the-graph` delivers
(makes-better, not blocks); 9 automates the ritual `STATUS.md` already specifies.

## Considered and deliberately not proposed

- **Task-seeded personalized PageRank for orient** — PPR ranking is already shipped;
  `refine-orient-context-budgeting` owns the remaining shaping work.
- **Graph-adjacent memory recall (1-hop neighbor memories)** — too near the open
  `add-memory-trigger-predicates` (`withinHops` predicates); not re-proposed.
- **Merkle-tree staleness roots** — the read-path staleness lanes (`disclose-stale-serving-on-
  cold-reads`, self-healing, hash-keyed analyze) own this ground; a Merkle layer is an
  optimization of theirs, not a new capability.
- **OpenTelemetry ingest as an observed-evidence tier** — runtime observability is a settled
  won't-do (`defer-gryph-runtime-observability`); not reopened.
- **Mutation-strength verdicts on reaching tests** — would be OpenLore's first run-the-tests
  capability; a doctrine boundary (static-only) that deserves its own explicit decision before
  any proposal, not a side door.
- **Footprint-compiled sandbox/permission profiles** — promising (a declared write-set is a
  filesystem allowlist), but it emits host-specific security config; deferred until the
  `plan_parallel_work` adoption evidence justifies owning that surface.
- **MCP RC re-baselining** — the 2026-07-28 RC deprecates the elicitation shape and changes
  the Tasks lifecycle that `adopt-mcp-protocol-conformance` / `adopt-mcp-tasks-and-cache-hints`
  were drafted against; both proposals already gate/watch the RC, so the note is recorded here
  rather than re-proposed: re-baseline both before building.
- **AGENTS.md as an injection target, byte-stable response prefixes, distractor collapse** —
  owned by `adopt-agent-context-interop`, `adopt-mcp-tasks-and-cache-hints`' cache-hint lane,
  and `refine-search-serving-quality` respectively.
- **Federated memory write etiquette (bank policies, provenance-required writes)** — belongs
  to the deferred federation fleet-memory group (group 4); recorded as design input for when
  that group reopens.

Baseline: main @ cca1894, 94 pre-existing open changes in this directory. Method and detailed
findings: three research agents (memory/context, code intelligence, governance/SDD), two
backlog-digest agents over all 94 open proposals; sources cited inline in each proposal.
