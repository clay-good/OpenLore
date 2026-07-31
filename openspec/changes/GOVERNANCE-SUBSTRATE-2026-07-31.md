# Governance-substrate study — 2026-07-31

A study of a mature deterministic requirements-as-code engine: a Rust CLI and MCP server that keeps
engineering decisions as typed Markdown in a repository, validates that corpus, and serves it
read-only to agents with no embeddings, no model call, and no hosted index. Its stated guarantee is
the same one OpenLore makes — *the same repository state produces the same answer* — arrived at from
the opposite direction: it started from the knowledge corpus and grew toward code; OpenLore started
from the code graph and grew toward governance.

That mirror-image lineage is what makes it useful. Where it is ahead, it is ahead on the governance
face, and its lead is almost entirely in **checking the knowledge corpus with the same rigor the
code graph gets**. Seven changes came out of the study. None of them adds a dependency, a model
call, or a new store; all seven are joins between machinery OpenLore already ships.

## The seven

| Change | The pattern | Domains |
|---|---|---|
| `add-knowledge-corpus-integrity` | The governance corpus is a typed graph with declared edge semantics — validate it like one | `openspec` |
| `add-corpus-change-intent-review` | Review changes to the *specs* between two refs; catch the requirement that got quietly weakened | `drift`, `cli` |
| `add-decision-bound-code-constraints` | The machine-checkable rule lives in the decision that motivated it, inherits its lifecycle, and publishes its coverage as an honest ledger | `architecture`, `mcp-handlers` |
| `add-retrieval-match-evidence` | Explain the hit and explain the miss — receipts for the one tool that has none | `mcp-handlers` |
| `certify-derived-artifact-equivalence` | Every acceleration must be provably answer-identical, and the performance envelope must be published | `analyzer`, `architecture` |
| `bound-standing-context-cost` | Measure the token tax the surface charges before it answers anything; treat the CLI as an equal, zero-cost face | `mcp-quality` |
| `bound-served-content-trust` | Read-only protects the store, not the agent — name the trust boundary, state provenance, never rewrite | `mcp-security`, `architecture` |

## The four ideas underneath them

**1. The knowledge corpus deserves the rigor the code graph gets.** OpenLore verifies call edges
exhaustively and cross-artifact edges not at all — spec-cites-decision, decision-supersedes-decision,
change-delta-targets-domain all dangle silently today. The memory face already computes the
stale-decision verdict the spec face lacks; that asymmetry is the whole finding, and it is why the
2026-07-27 corpus repair was a manual pass rather than a caught regression.
(`add-knowledge-corpus-integrity`, `add-corpus-change-intent-review`)

**2. A rule severed from its reason cannot retire.** Enforcement rules living in a config file have
no rationale to cite and no lifecycle to inherit — reverse the decision and the rule keeps blocking.
Binding the rule to the decision gives violations a receipt and gives supersession teeth. The
paired move is an *eligibility ledger*: adoption, coverage, unclassified count, and rule count as
four separate numbers, never one, because a single percentage can be improved by lying in either
direction. (`add-decision-bound-code-constraints`)

**3. Honesty has to reach retrieval too.** OpenLore's honesty discipline covers every conclusion
except the one an agent calls first. A hit that states its score but not what matched, and an empty
result with no way to ask why, are the highest-frequency instances of the exact silent-degradation
shape the repo has spent months closing everywhere else. Both answers are already computed and
discarded. (`add-retrieval-match-evidence`)

**4. Speed claims and cost claims need the same proof discipline as correctness claims.** Five
acceleration paths now sit between repository bytes and an answer, each defended by its own ad-hoc
test; the repo's own memory records two equivalence traps inside a single one of them. The
corresponding gap on the input side is the standing token cost of the tool surface — asserted as a
target, never measured, while the byte ceiling that does exist has been raised three times. Both
are the same failure: an unfalsifiable claim in a product whose entire warrant is falsifiability.
(`certify-derived-artifact-equivalence`, `bound-standing-context-cost`)

## What was deliberately not borrowed

- **A second artifact taxonomy.** The studied engine infers five artifact types from heading shape.
  OpenLore delegates the change lifecycle to the `openspec` CLI and its format; adding a parallel
  typed-artifact registry would fork the corpus for no gain.
- **SARIF emission.** Already owned by the existing `add-sarif-finding-emission` proposal — noted as
  confirmed by external precedent, not re-proposed.
- **A warnings-first severity ratchet.** Already owned by `add-enforcement-baseline-ratchet`; the
  corpus-integrity change names it as its intended adoption ramp rather than duplicating it.
- **An org-wide shared serving endpoint.** OpenLore's federation work already covers the multi-repo
  case; a hosted co-mounted endpoint is a deployment topology, not a substrate capability.
- **A carrier-format export profile.** Interchange is already covered by the bundle artifact and the
  SCIP interchange proposal.
- **Telemetry read-back.** OpenLore's telemetry-honesty work already scopes this, and the studied
  engine's version depends on a consent record OpenLore has deliberately kept minimal.
- **A trustworthiness score on served content.** Explicitly rejected in
  `bound-served-content-trust`: a lexical score dressed as a verdict is wrong in both directions and
  gets consumed as authority anyway.

## Status

All seven are PROPOSED and pass `openspec validate --strict`. None has code on `main`.
