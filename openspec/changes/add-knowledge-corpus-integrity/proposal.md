# Knowledge-corpus integrity: the governance corpus is a typed graph, and nothing checks it

> Status: PROPOSED (2026-07-31, external-pattern study). OpenLore verifies the *code* graph
> exhaustively and the *knowledge* graph not at all. Specs cite decision ids, changes cite spec
> domains, decisions supersede decisions, memories anchor to symbols and cite decisions — every one
> of those is a typed edge with a declared range, direction, and liveness rule, and every one can
> dangle silently today. This change makes the governance corpus checkable by the same standard the
> call graph already meets: declared edges, resolved targets, registered findings, advisory by
> default. Prior art: deterministic requirements-corpus engines that validate the knowledge graph
> as a first-class artifact rather than trusting authorship.

## The gap

OpenLore's governance face stores a graph and validates almost none of it.

- **Decision references in specs are unchecked.** `src/core/decisions/syncer.ts` writes
  `> Decision recorded: <8-char id>` lines into `openspec/specs/<domain>/spec.md`. Nothing
  afterwards verifies that the id still resolves to a decision, that the decision is still
  authoritative, or that two requirements do not claim the same one. `verify_claim`'s
  `decision-current` kind can answer this — **for one id, when an agent thinks to ask**. There is
  no corpus-wide sweep, so a superseded decision keeps governing a live requirement until a human
  happens to cite it.
- **The memory face has the check the spec face lacks.** `stale-decision-reference.ts` already
  computes exactly this verdict for memories (`staleDecisionRef`, shipped PR #163/#192 lineage).
  The spec corpus — the *more* authoritative surface — gets none of it. That asymmetry is the
  whole finding.
- **Supersession chains are unvalidated as a graph.** `supersedes` is a directional, acyclic edge
  by construction. `src/core/decisions/store.ts` accepts a `supersedes` id without checking that it
  resolves, that it is not self-referential, or that A→B→A has not formed. A cycle makes "which
  decision is current?" unanswerable, and `verify_claim decision-current` would then be answering
  from a broken store.
- **Change→spec deltas can name domains that do not exist.** `openspec/changes/*/specs/<domain>/`
  is a reference to a spec domain; a typo produces a silently orphaned delta that archives into
  nothing. `openspec-compat.ts` validates markdown *shape*, not cross-artifact *resolution*.
- **Memory anchors that lose their target already have a verdict; spec anchors do not.** Symbol
  identity continuity carries memories across renames and orphans them honestly when it cannot.
  A spec requirement that names a file or symbol has no equivalent — it just goes quietly wrong.
- **Duplicate identity is undetected.** Two decisions consolidating to the same 8-char id, or two
  requirements with the same name in one domain, make every reference to that name ambiguous. The
  archive repair pass of 2026-07-27 found this class by hand (`STATUS.md`: "synced-decision dedup
  is by requirement NAME"); nothing catches it mechanically.

The corpus-wide consequence: OpenLore's honesty contract holds *within* a tool and breaks *between*
artifacts. An agent asked "what governs this?" gets an answer assembled from edges nobody checked.

## What changes

**One deterministic corpus-integrity pass over the artifacts OpenLore already writes**, emitting
registered `GovernanceFinding`s. No new store, no new authoring format, no LLM.

1. **A declared edge registry** — `CORPUS_EDGE_REGISTRY`, in the `FINDING_CODE_REGISTRY` style
   (`enforcement-policy.ts`) and living beside it. Each edge kind declares its **source artifact
   type**, its **target range**, whether it is **directional**, whether it may **cycle**, and
   whether a **live source may point at a retired target**:

   | Edge | Source → range | Directional | May cycle | Live→retired |
   |---|---|---|---|---|
   | `spec-cites-decision` | requirement → decision | yes | n/a | no |
   | `decision-supersedes` | decision → decision | yes | **no** | yes (that is its job) |
   | `change-delta-targets-domain` | change delta → spec domain | yes | n/a | n/a |
   | `memory-cites-decision` | memory → decision | yes | n/a | no (already checked; folded in) |
   | `memory-anchors-symbol` | memory → symbol/file | yes | n/a | n/a (already checked; folded in) |
   | `spec-anchors-symbol` | requirement → symbol/file | yes | n/a | n/a |

   The registry is the single source of truth: adding an artifact type or edge without registering
   it fails a closure guard test, the same discipline `tool-contract.test.ts` applies to capability
   families.

2. **Findings, each with a stable registered code** — `corpus-reference-unresolved`,
   `corpus-reference-ambiguous`, `corpus-self-reference`, `corpus-duplicate-identifier`,
   `corpus-edge-unsupported` (an edge kind the source type does not declare),
   `corpus-target-type-mismatch`, `corpus-target-retired` (a live requirement citing a superseded
   or rejected decision), `corpus-supersession-cycle`, `corpus-anchor-target-missing`. Every
   finding names the source artifact path, the edge kind, the reference as written, and the reason.
   Default classes follow the existing doctrine: resolution and graph-shape breakages default
   **blocking**, liveness and anchor findings default **advisory** — and every default is
   overridable through the operator's existing `enforcement.policy`.

3. **Mentioned-but-unlinked, as an advisory only.** A proposal or spec body that names a decision
   id or a requirement name in prose without a declared edge emits
   `corpus-reference-undeclared` — naming the source, the matched target, the token that matched,
   and the edge that would capture it. Matching is restricted to exact ids and exact requirement
   names (never titles, never fuzzy), excludes fenced code blocks and the reference lines
   themselves, and emits at most one finding per (source, target) pair. **OpenLore never writes the
   edge.** A suggestion the tool applies itself is an assertion the human never made.

4. **Two surfaces, one engine.** `openlore doctor` gains a corpus section (it is already the
   diagnostic command, `src/cli/commands/doctor.ts`), and `openlore enforce`
   (`src/cli/commands/enforce.ts`) governs the findings through the policy it already reads. **No
   new MCP tool** — the finding stream is the product, per the minimize-tool-surface rule.

## Why this is in scope

`architecture`'s `UnifiedStructuralSubstrate` says both faces share one graph and one freshness
lease. The navigation face's graph is checked at every level; the governance face's graph is
checked nowhere. This change closes that asymmetry using only machinery that exists: the finding
registry, the enforcement policy, the decision store, and the memory face's own stale-reference
verdict — generalized from one artifact type to all of them.

It is also the precondition for the honesty of two shipped claims. `verify_claim decision-current`
is only as sound as the supersession chain it reads; `recall`'s `unreconciled` signal is only
meaningful if identity is unique. Both currently assume corpus integrity that nothing establishes.

## Impact

- **Files:** new `src/core/decisions/corpus-integrity.ts` (registry + resolver + findings), new
  codes registered in `enforcement-policy.ts`, a corpus section in `src/cli/commands/doctor.ts`,
  a finding source wired into `src/cli/commands/enforce.ts`, a registry-closure guard test.
  Folds `stale-decision-reference.ts`'s existing verdict in as one registered edge rather than
  reimplementing it.
- **Specs:** `openspec` — 2 ADDED requirements (corpus edge registry + integrity findings, and
  the undeclared-reference advisory).
- **Tool surface:** unchanged. No tool added; `mcp-presets.test.ts` ceilings untouched.
- **Risk:** low-medium. The blocking-by-default classes could fail an existing repo's gate on day
  one — which is why every default is policy-overridable and the sibling
  `add-enforcement-baseline-ratchet` (`frozen` class, blocks only NEW findings) is the intended
  adoption path. This change adds the findings; that change owns the ratchet.
- **Sibling boundaries:** `add-corpus-change-intent-review` reviews *changes* to the corpus between
  two refs; this change checks the corpus *as it stands*. `check_spec_drift` compares spec to
  **code**; this compares corpus to **corpus**. `add-scenario-checkability-binding` owns whether a
  scenario is checkable; this owns whether a reference resolves.
