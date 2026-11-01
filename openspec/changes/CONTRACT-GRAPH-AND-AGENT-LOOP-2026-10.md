# Contract graph and agent-loop research — 2026-10-31

Inputs: a design note proposing a "contract and schema graph" plus inner-loop and outer-loop tools,
checked against the shipped product and the open backlog; a web sweep of 2025–2026 agent failure
research, harness hook surfaces, MCP 2026-07-28, competitors, and parallel-agent coordination. Every
URL below resolved on 2026-10-31.

**Bottom line:** most of the note is already built or proposed. What is missing falls into three
groups:

1. Make API schemas part of the graph.
2. Catch the diff shapes agents get wrong (weakened checks, invented references, edits to generated
   files).
3. Push all of it into the agent loop through the hooks that exist now, including between parallel
   agents.

## What we fold in

| Item | Where | New or existing |
|---|---|---|
| OpenAPI two-way parity, breaking verdicts, consumer join | [add-service-contract-certification](archive/2026-11-01-add-service-contract-certification/) | shipped (OpenAPI phase) |
| Contract elements as graph nodes, handler ↔ operation edges, briefings, payload check, protobuf, GraphQL | [add-contract-graph-projection](add-contract-graph-projection/) | split from the above |
| Grade a proposed patch in memory before it is written | [add-verification-feedback-loop](add-verification-feedback-loop/) | existing, addendum |
| `verify_change` as the one landing place for all diff findings, plus new architecture violations and secrets on added lines | [add-verification-feedback-loop](add-verification-feedback-loop/) | existing, addendum |
| Name the symbol that changed under the agent; detect modify/revert edit loops; name edits made after the last test run | [add-session-structural-ledger](archive/2026-10-31-add-session-structural-ledger/) (shipped; test runs, contract hashes, lease tokens in [add-session-ledger-runs-contracts-tokens](add-session-ledger-runs-contracts-tokens/)) | shipped |
| IaC sites that set each env var | [add-iac-code-binding](archive/2026-11-01-add-iac-code-binding/) | shipped (env half) |
| IaC resource → the code it runs | [add-iac-deploy-binding](add-iac-deploy-binding/) | split from the above |
| Tests deleted, skipped, or emptied; expected values changed; suppressions; swallowed errors; relaxed CI | [add-check-weakening-findings](archive/2026-10-31-add-check-weakening-findings/) | shipped (#634) |
| Imports, exports, and packages that do not exist or are not declared | [add-phantom-reference-findings](archive/2026-10-31-add-phantom-reference-findings/) | shipped (#632) |
| Generated or vendored file edited by hand; name its source and regenerate command | [add-generated-file-guard](archive/2026-10-31-add-generated-file-guard/) | shipped (#629) |
| Push receipts after edits, after compaction, before stop, at sub-agent start, at task creation | [add-agent-loop-hook-surfaces](archive/2026-10-31-add-agent-loop-hook-surfaces/) (Claude Code; the rest in [add-agent-loop-hooks-subagents-codex-pi](add-agent-loop-hooks-subagents-codex-pi/)) | shipped |
| Shared footprint board across worktrees; duplicate intent | [add-peer-footprint-board](archive/2026-11-01-add-peer-footprint-board/) | shipped |
| Peer read-after-write notices; fleet records on the board | [add-peer-change-notices](add-peer-change-notices/) | split from the above |
| Compaction pushes the handoff briefing | [add-session-handoff-briefing](archive/2026-11-01-add-session-handoff-briefing/) | shipped |
| Real call-site examples; profile line in `orient` | [add-call-site-usage-profile](add-call-site-usage-profile/) | existing, addendum, promoted |
| Workspace manifests as package nodes, no export step | [add-build-graph-ingest](add-build-graph-ingest/) | existing, addendum |
| MCP 2026-07-28 is published: correct cache-hint scope, deterministic `tools/list`, `subscriptions/listen` | [adopt-mcp-tasks-and-cache-hints](adopt-mcp-tasks-and-cache-hints/) | existing, addendum |
| Fleet verification records shared across worktrees | [add-fleet-coordination-arc](add-fleet-coordination-arc/) | existing, addendum |
| `verify_claim` kinds: endpoint implemented / consumed, decision governed, lease current | [add-graph-claim-kinds](archive/2026-11-01-add-graph-claim-kinds/) | shipped (lease-current moved) |
| The session's closing receipt (start → end delta, parity, decisions, counts) | [add-change-provenance-certificate](add-change-provenance-certificate/) | existing, addendum |

## What we do not build, and why

| Idea | Reason |
|---|---|
| `check_drift_budget` with "% cumulative blast radius" thresholds | An arbitrary weighted score (excluded by the north star). The counts already exist in `blast_radius`, and the ledger gives the loop facts. |
| A separate `attest_session_delta` tool | It is `certify_provenance` over the session's range; the addendum folds in what the note listed. |
| A separate `verify_hypothesis` tool | It is `verify_claim`; the note's questions became claim kinds. |
| A new `simulate_impact` tool | Same conclusion as `verify_change`, so it became a `patch` input. |
| Reading `terraform.tfstate` | It holds live state and secrets, and it is not static. |
| A separate vector entry layer | Already the design: BM25 by default, optional embeddings, both handing off to graph tools. |
| Matching DTO types to schema fields across languages (`serializes_to`), "field mapped consistently" claims, model-field renames reaching schema fields | Name-based only, so it cannot be proven. The provable part — literal request payloads missing required fields — is in. |
| Percentages, budgets, `budget_exceeded` | Arbitrary thresholds. OpenLore reports raw session counts; the orchestrator sets limits. |
| `STALE_LEASE` alerts that tell the agent what to do | Imperatives in tool output (decision 8e95746d). The note names what changed, as a fact. |
| Downstream database tables in `orient` | Needs `add-datastore-access-graph`, which stays deferred. |
| License, i18n, generic config validation | Mature tools exist, and none is an agent-failure lever. |
| Registry lookups for package existence | Needs the network. The manifest and lockfile check gives most of the value locally. |
| Agent-to-agent messaging, spawning, task boards, write locks | Transports and orchestrators own these (A2A 1.0, agent-team mailboxes, Claude Squad, Vibe Kanban, Conductor). |
| Issue trackers, OS sandboxing, auto-fix, LLM in hooks | Standing non-goals. |

## The original note, section by section

| Section | Outcome |
|---|---|
| 1 Principles (schema as typed nodes, literal resolution, unified leases, empower not restrict) | Kept as the design rules of every change below |
| 2 API & RPC sources, node kinds, addresses | Contract graph: OpenAPI 3.x, Swagger 2.0, protobuf, GraphQL; closed kind list; stable addresses |
| 2 IaC sources | Already projected (12 ecosystems); OpenTofu `.tofu` added; `.tfstate` skipped |
| 2 Architectural specs (ADRs, constraints) | Already built (decisions, `check_architecture`); surfaced in `verify_change` and the certificate |
| 3 Parsing, flattening | Contract readers flatten nested messages to addressable fields |
| 3 `implements_endpoint`, `consumes_endpoint` | Contract graph |
| 3 `serializes_to` / `deserializes_from` | Skipped (not provable); literal-payload check instead |
| 3 `deploys_symbol` / `provisions_for` | IaC-code binding (embedded IaC `references` already shipped) |
| 4 `orient` multi-boundary view | Contract node + request constraints; env vars + IaC sites + deploy resources; tables deferred |
| 4 `blast_radius` across boundaries | Contract elements touched; IaC sites setting a renamed env key |
| 4 `verify_claim`, `check_parity` | Claim kinds; parity inside `certify_service_contract` (no separate tool) |
| 4 Contract leases | Ledger: canonical hashes for contract and IaC nodes |
| 5 Phase 4 vector entry layer | Already the design |
| 6 Non-goals | Unchanged and enforced |
| 7.1 `simulate_impact` | `verify_change` `patch`: broken callers, contract drift, decisions, new cycles |
| 7.2 Lease token, staleness nudge | `leaseToken` + `lease-current`; neutral note naming the change |
| 7.3 `verify_hypothesis` | Claim kinds with receipt paths |
| 8.1 Session ledger, churn split, contract mutations | Raw session counts; no budget or percentage |
| 8.2 Oscillation, cycle trace | Ledger edit-oscillation signal with its hash cycle |
| 8.3 `attest_session_delta` | `certify_provenance` addendum |
| 9 Endpoints | Folded into existing tools above; no new endpoint |

## Key evidence

- **Agents weaken checks:** ImpossibleBench https://arxiv.org/abs/2510.20270, EvilGenie
  https://arxiv.org/abs/2511.21654, Anthropic reward-hacking generalization https://arxiv.org/abs/2511.18397.
- **Agents invent packages and APIs:** https://arxiv.org/abs/2406.10279 (5.2%–21.7% of suggested
  packages do not exist), https://arxiv.org/abs/2509.22202, https://arxiv.org/abs/2604.07755.
- **Long contexts degrade:** https://research.trychroma.com/context-rot; SWE-Bench Pro
  https://arxiv.org/abs/2509.16941.
- **Parallel agents fail together:** CooperBench https://arxiv.org/abs/2601.13295 (two agents about
  50% below one); MAST https://arxiv.org/abs/2503.13657; structural merge conflicts in agent PRs
  https://arxiv.org/abs/2607.04697.
- **Claude Code agent teams leave file ownership to the prompt:**
  https://code.claude.com/docs/en/agent-teams.
- **Hook events:** Claude Code https://code.claude.com/docs/en/hooks (`PostToolBatch`, `Stop`, and
  `SubagentStart` inject context; `PreCompact` cannot, so the post-compaction point is `SessionStart`
  with `compact`); Codex https://learn.chatgpt.com/docs/hooks; Pi https://pi.dev/docs/latest/extensions.
- **MCP 2026-07-28:** https://modelcontextprotocol.io/specification/2026-07-28/changelog.

## Parallel agents: the lane

OpenLore computes coordination **facts**: who will write which symbols, who read a symbol a peer just
changed, which tasks collide, and which verdicts are still valid. It publishes them on a local board
in the git common directory, shared by all worktrees of one clone. The harness delivers them through
its hooks. OpenLore carries no free-text messages, assigns no work, and holds no locks. This is the
part transports cannot do, because only the graph knows who needs to hear a fact.

## Order

The ROADMAP's Phase 1b sequences these changes. Diff findings land in `verify_change` first, because
every hook delivers through it; the hooks come next; the board follows, because it uses the ledger
and the hooks. The claim kinds close the phase because two of them need the contract graph and the
ledger, but `decision-governed` has no dependency and can ship at any time.
