# Unify navigation and governance as two faces of one structural substrate

> Status: PROPOSED (2026-06-26). Spec-only change. Establishes that OpenLore's navigation tools and
> its governance/memory tools are not two products but two faces of a single deterministic substrate —
> one graph, one anchored-fact store, one freshness lease — and turns that model into three enforceable
> requirements: a capability-family taxonomy over the full tool surface, a no-redundant-conclusions
> discipline, and a both-faces default surface gated on the existing benchmark guardrail. No new tool,
> no new dependency, no LLM. Grounded in the north star (`overview/spec.md`, decision `c6d1ad07`):
> deterministic, locally-computed structural context, conclusion over graph.

## The gap

OpenLore's tool surface has grown to ~71 tools across two visibly different jobs:

- **Navigation** — "what is the structure?" `orient`, `find_path`, `analyze_impact`, `get_subgraph`,
  `select_tests`, `find_dead_code`, `get_map`, … Read the graph, return a conclusion.
- **Governance** — "did this change respect the structure, and what is known about it?" `remember` /
  `recall`, `record_decision`, `verify_claim`, `blast_radius`, `change_impact_certificate`,
  `certify_public_surface`, the enforcement policy and the commit gate.

Because these arrived as separate change proposals over many months, they *read* like two products
bolted together — and the lean default (`navigation` preset, 10 tools) effectively ships only the
first one out of the box. An agent that installs OpenLore the documented way gets a traversal tool and
has to opt in, by name, to discover that the same substrate also remembers decisions, verifies its own
claims, and certifies a diff. The breadth also makes the *full* surface hard to navigate: 71 flat,
individually-named tools, several of which answer adjacent questions, degrade an agent's selection
accuracy (the `mcp-quality` "Full surface does not dilute discovery" scenario already names this risk
but does not yet enforce a fix).

The instinct to split them behind presets (ADR-0022) was right for *token economy* but it has hardened
into a *conceptual* split: two surfaces, two mental models, an out-of-box experience that under-sells
half of what the substrate already computes. We want one product that does both — not by merging
distinct tools, but by making the shared spine explicit and presenting the surface as one coherent
whole.

## The unified model

Navigation and governance are not two systems. They are the **read face** and the **write/check face**
of one substrate with a shared spine:

1. **One graph.** The call graph + IaC projection + cross-service HTTP edges + type hierarchy, all
   extracted deterministically by tree-sitter. Every navigation conclusion and every governance gate is
   computed from this one graph.
2. **One anchored-fact store.** Memories (`remember`) and architectural decisions (`record_decision`)
   are the same kind of thing: a durable fact anchored to a symbol or file. Both self-invalidate when
   their anchor changes; both are carried across a rename by symbol-identity continuity.
3. **One freshness lease.** The epistemic lease (`epistemic-lease.ts`) is the shared decay mechanism
   that ages out a stale memory, refutes a superseded decision citation, and decays a change-impact
   certificate by the *same* rule, anchored to the *same* touched symbols.

On that spine, governance is just navigation's structural facts turned into anchored memory and gates:

| Governance tool | …is navigation of the same graph, expressed as a check |
|---|---|
| `recall` | "navigate to the durable facts anchored at the code I'm touching" |
| `verify_claim` | "navigate the graph to settle an assertion before it reaches a human" |
| `blast_radius` / `change_impact_certificate` | "navigate the callers/paths a diff opens" |
| `certify_public_surface` | "navigate the exported surface and diff its shape" |
| the commit gate | "navigate decisions anchored to the staged symbols; block if unrecorded" |

This is the unlock: once the spine is named, the product is obviously **one thing**, and the right
design questions become tractable — what is the taxonomy, what is genuinely redundant, what should the
default surface be.

## What changes (spec only)

Three enforceable requirements, plus one model statement.

### 1. Name the substrate (architecture spec, ADDED)

A new `architecture` requirement, **UnifiedStructuralSubstrate**, states the one-graph / one-fact-store
/ one-lease model and the read-face/write-face framing as a design invariant. New capabilities must
attach to the shared spine (read the one graph, anchor to the one fact store, decay via the one lease)
rather than introduce a parallel store or a parallel staleness rule. This is the durable statement that
OpenLore is one product.

### 2. Capability-family taxonomy (mcp-quality spec, ADDED)

Every tool declares one of a small, fixed set of **capability families** — `navigate`, `change`,
`remember`, `verify`, `coordinate`, `federate` — and the full surface is presented **grouped by
family**, not as a flat list. The agent then chooses among ~6 families and a handful of tools per
family, never among 71 undifferentiated names. The family set is closed and source-declared (a new
tool joins an existing family or the change must justify a new one), mirroring how
`tool-contract.ts` already forces every tool to declare `conclusion` vs `explicit-topology`. This
turns "71 tools" into "6 families" for discovery without removing a single capability.

### 3. No redundant conclusions (mcp-quality spec, ADDED)

Two tools in the same family that could be read as answering the same question SHALL each declare its
**distinct question** in one sentence and cross-reference its near-siblings, OR be consolidated. The
requirement deliberately does **not** force-merge tools with distinct conclusions (see below) — it
mandates that adjacency is either *disambiguated in the tool's own description* or *eliminated*. The
`tool-contract` test is the natural home for the check.

### 4. A both-faces default, gated on evidence (mcp-quality spec, MODIFIED)

Define a recommended **`substrate` default surface** that spans both faces: the `navigation` core plus
the three highest-value governance *reads* — `recall`, `verify_claim`, `blast_radius` — so an
out-of-box agent gets the whole substrate's value, not just traversal. Per ADR-0022's evidence-backed-
default rule, the *active* out-of-box default flips from `navigation` to `substrate` only when the
agent benchmark shows the wider default does not regress selection accuracy or token economy; until
then `substrate` ships as a named preset and `navigation` remains the measured default. This keeps the
"lean default stays ~constant as the registry grows" guarantee while resolving the two-products-out-of-
box symptom honestly, on evidence, not by fiat.

## What we are NOT merging, and why

An honest audit of the suspected overlaps found that most are **distinct conclusions wearing adjacent
names**, not redundancy. Forcing them into one tool would destroy a real, separately-useful answer.
We keep them and disambiguate (requirement 3) rather than delete:

| Adjacent tools | Why they stay separate |
|---|---|
| `blast_radius` · `structural_diff` · `change_impact_certificate` · `change_footprint` | Different questions: advisory briefing vs. delta+stale-callers vs. paths newly opened into a sensitive surface vs. write/read region for parallel planning. Same graph, four conclusions. |
| `plan_parallel_work` · `map_in_flight_conflicts` | Same hazard classifier, different input source: caller-supplied proposed tasks vs. harvested in-flight branches/PRs. The input boundary is the distinction. |
| `find_clones` · `get_duplicate_report` | One-vs-all query (pre-write, `O(n)`) vs. whole-repo audit (`O(n²)`, skipped on large repos). Different shape, same detector. |
| `report_coverage_gaps` · `select_tests` | Exact inverses (untested code vs. reaching tests). Both directions are load-bearing. |

The finding itself matters: the surface's problem was never mostly redundancy — it was the **absence
of a taxonomy** that made distinct tools look interchangeable. That is what requirements 2 and 3 fix,
at near-zero cost and with no capability loss.

## Why this is in scope

This change adds **no tool, no dependency, no LLM, no new persisted artifact**. It is purely a
structural/spec statement that makes the existing surface coherent and the out-of-box experience whole.
It strengthens the north star (`c6d1ad07`) rather than extending it: the substrate stays deterministic
and local; we are only naming what it already is and presenting it as one product.

## Impact

- Specs: `architecture` (1 ADDED requirement), `mcp-quality` (2 ADDED, 1 MODIFIED requirement).
- Code (a *later*, separate change — not this proposal): a source-declared `family` field per tool, a
  `substrate` preset entry, grouped-by-family rendering in the tool list, and `tool-contract` checks
  for family membership + distinct-question disambiguation. Flipping the active default is gated on a
  benchmark run.
- Risk: low. No behavior changes here. The eventual default flip is evidence-gated and reversible.
