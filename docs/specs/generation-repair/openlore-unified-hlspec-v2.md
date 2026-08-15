# OpenLore — Unified Generation & Repair, High-Level Spec (Working Draft v4)

Status: architecture agreed — moving to stage 1-4 implementation/audit next
Supersedes: [openlore-generation-repair-hlspec.md](openlore-generation-repair-hlspec.md) (v1) and the standalone-generation
assumption in [openlore-capability-audit.md](openlore-capability-audit.md)'s closing note
Scope: a single architecture for producing and correcting OpenSpec specs from a
codebase, and the boundary with OpenSpec

## 1. Why this revises v1

v1 kept generation on its own standalone six-stage LLM pipeline and only moved
repair to an agent-hosted, tool-composition model. The capability audit found
that several of those six stages (`entities`, `services`, `api`, `architecture`)
already lean on deterministic, MCP-exposed inventories (`get_schema_inventory`,
`get_route_inventory`, `get_middleware_inventory`, `get_external_packages`,
`get_architecture_overview`) as *hints* inside their own LLM prompts — the
pipeline itself treats deterministic detection as more trustworthy than what it
re-derives per file chunk. That, plus per-chunk extraction losing cross-file
context, is a plausible source of current generation quality issues.

Given that, generation and repair converge on the same underlying layer:
OpenLore supplies deterministic evidence, the host agent (any MCP-capable agent,
including Claude Code and Pi) reasons
over it and writes the spec text. This draft treats that as the target
architecture for **both** capabilities. See §8 for the sequencing this implies.

## 2. Goals

- One shared deterministic evidence layer (no LLM inside OpenLore for either
  path), covering:
  - structural inventories (routes, schema, middleware, env vars, packages,
    architecture clusters);
  - code graph (call graph, subgraph, minimal per-function context);
  - spec state (existing spec text, requirement→function mapping, drift,
    coverage gaps).
- OpenLore reports observations about that evidence; it does not itself decide
  what those observations mean for the spec (see §5).
- One consumer, not two independent ones, per spec file: a single Repair
  operation that can both add missing sections and correct existing ones, so
  Generate and Repair never touch the same spec file separately in the same
  pass.
- Preserve the standalone CLI path for legacy pipelines/use cases (per earlier
  decision), but built on the *same* evidence layer rather than a parallel
  extraction pipeline — the standalone path keeps its own LLM call, it does not
  keep its own separate analysis logic.

## 3. Non-goals

- OpenLore does not decide what the user wants to build, does not manage
  propose → apply workflows. That stays OpenSpec's job.
- OpenLore does not infer business intent from static structure. Detecting
  that a function isn't covered by any spec is a structural observation;
  deciding that this means a specific business requirement is missing (and
  what that requirement is) is semantic inference, and that stays out of
  OpenLore (see §5).
- Repair does not invent intended future behavior — it only reconciles specs
  with what the code currently is.
- This draft does not commit to rewriting the six-stage pipeline in full at
  once — see §8 for the sequencing.

## 4. Architecture

```
                    ┌───────────────────────────────────┐
                    │         Evidence layer               │
                    │      (OpenLore, deterministic)        │
                    │                                       │
                    │  inventories: routes, schema,          │
                    │  middleware, env vars, packages,       │
                    │  architecture clusters                 │
                    │                                       │
                    │  graph: call graph, subgraph,          │
                    │  minimal per-function context          │
                    │                                       │
                    │  spec state: get_spec, get_mapping,    │
                    │  check_spec_drift, audit_spec_coverage,│
                    │  structural_diff, search_specs         │
                    └───────────────────┬───────────────────┘
                                        │
              deterministic OBSERVATIONS, not semantic classifications
                (see §5 — same primitives, task-specific composition,
                 see §6)
                                        │
                 ┌───────────────────────┴───────────────────────┐
                 │                                                 │
          Generate consumer                                Repair consumer
   (target scope: no spec exists                  (target scope: spec exists,
      for it yet)                                  coverage/content doesn't
                                                     fully match the code)
                 │                                                 │
                 ▼                                                 ▼
         Host agent drafts                               Host agent interprets
         new spec section                                observations, decides
                                                           reconciliation, adds
                                                           missing sections AND
                                                           corrects stale ones,
                                                           within one pass over
                                                           the same spec file
                 │                                                 │
                 └───────────────────┬───────────────────────────┘
                                        ▼
                              writes/patches OpenSpec files

Standalone facade (legacy CLI): same evidence layer underneath, but the LLM
call (drafting/correcting) is made by OpenLore's own configured provider
instead of a host agent. ACP is not part of this diagram — a host agent is a
host agent consuming OpenLore's MCP capabilities like any other, not a
provider OpenLore calls into.
```

## 5. Generate / Repair boundary

Top-level boundary, unchanged in shape:

- **Generate** → no specification exists yet for the target scope.
- **Repair** → a specification exists for the target scope, but its coverage
  or content does not fully correspond to the current code.

Within Repair, the four states from earlier drafts (`consistent` / `stale` /
`missing` / `orphaned`) are **reconciliation outcomes that the host agent
determines**, not classifications OpenLore itself performs. OpenLore cannot
establish that a requirement is missing — it can only establish that a
function isn't covered by any requirement. Inferring the business requirement
that ought to exist (e.g. "the missing requirement is *refund a payment*",
from an uncovered `refund()` function) is semantic inference, and that is
exactly where the host LLM reasons.

### 5.1 Deterministic observations (OpenLore)

What the evidence layer can establish, and which tools establish it:

| Observation | Source |
|---|---|
| `covered` | `get_mapping` — requirement has a mapped function |
| `uncovered_function` | `audit_spec_coverage` — function in call graph, no spec |
| `stale_mapping` | `check_spec_drift` — spec-mapped file changed, spec didn't |
| `orphan_requirement` | `audit_spec_coverage` — spec requirement, no implementation found |
| `structural_change` | `structural_diff` — precise signature/call/edge delta for a changed function |

These are facts about code-vs-spec correspondence, not decisions about what
the spec should say.

### 5.2 Reconciliation (host agent)

The MCP-compatible host agent maps observations to a reconciliation action:

- `covered`, no `stale_mapping`/`structural_change` → **consistent**, leave
  unchanged.
- `stale_mapping` / `structural_change` on an existing requirement →
  **stale**, update using the structural evidence.
- `uncovered_function` → **determine whether a requirement is missing**, and
  if justified, add one. This is the one step that requires judgment, not
  just observation.
- `orphan_requirement` → **orphaned**, flag (not auto-deleted).

Example this handles directly:

```
Code:            Spec:                    Observation:            Reconciliation:
  create-payment    create-payment          covered                 consistent
  cancel-payment    cancel-payment          stale_mapping           stale, update
  refund()          (nothing)               uncovered_function      Host agent judges: is a
                                                                     requirement missing
                                                                     here? if so, add it
```

A single Repair pass produces all of this together for a spec file — Generate
and Repair never operate independently on the same file once a spec exists
for the domain.

### 5.3 Division of responsibility

```
OpenLore:    deterministic observations + evidence
Host agent:  semantic interpretation + reconciliation decision
OpenSpec:    specification format + evolution/change workflow
```

## 6. Same evidence layer, task-specific composition

The primitives are shared (§4's list); the composition pulled from them is
not required to be identical between Generate and Repair. Generate composes
forward from code:

```
code → structural evidence → graph/context → draft
```

Repair composes from both code and existing spec state:

```
code + existing spec + mapping + drift/diff → observations → reconciliation
```

Both draw from the same deterministic tools — neither needs a primitive the
other doesn't already have access to — but "one identical bundle for both
consumers" is not a requirement. Each composes the subset and shape of
evidence its task actually needs.

## 7. Implementation approach: compose existing primitives first

No new MCP primitive at this stage — `detect_drift()`, `repair_context()`, or
any other composite repair tool are explicitly not being added yet. The
existing surface already covers everything §5.1 needs: `orient`, `get_spec`,
`get_mapping`, `search_specs`, `check_spec_drift`, `audit_spec_coverage`,
`structural_diff`, `get_subgraph`.

The next implementation step is to test whether an MCP-compatible host can compose these
into the repair workflow directly:

```
orient(scope)
    ↓
audit_spec_coverage()
    ↓
get_spec(domain)
get_mapping(domain)
check_spec_drift(domain)
    ↓
structural_diff(...)
get_subgraph(...)
    ↓
Host agent determines reconciliation (§5.2)
    ↓
edit OpenSpec file
```

If this works, it stays this way. A new composite MCP primitive is only
justified once a concrete information or performance gap is identified that
composing the existing tools cannot solve — not for convenience or to shorten
the tool-call sequence.

### 7.1 Verified caveat: `get_mapping` / `audit_spec_coverage` provenance

The composed-primitives workflow above is not fully self-sufficient from
current code + current specs + static graph alone. Verified in the
implementation:

- `get_mapping` reads `mapping.json`, an artifact whose `requirement` field
  (`RequirementMapping.requirement`) is populated from
  `pipeline.services[].operations[].name` — i.e. from a prior `openlore
  generate` LLM run (`MappingGenerator.generate(pipeline, depGraph)`). It is
  not reconstructible from code/specs/graph alone.
- `audit_spec_coverage` reads the same `mapping.json` and now exposes
  `mappingCoverage` as `available`, `missing`, `invalid`, or `stale`, with a
  stable reason code and regeneration guidance. When unavailable, it withholds
  mapping-derived uncovered/hub/orphan conclusions. Only `staleDomains` remains
  independently available because it comes from `SpecSnapshotGenerator`
  comparing spec vs. source mtimes.
- `check_spec_drift` is independent — `buildSpecMap()` parses the
  `"> Source files: ..."` header directly out of each `spec.md`. Its only
  dependency is that convention being present in the spec text itself, not a
  runtime coupling to the old pipeline.

**Practical implication**: the Repair workflow's `uncovered_function` and
`orphan_requirement` observations require a valid `mapping.json` to exist and
be current — a real precondition, not an emergent property of code + specs.
`stale_mapping` and `structural_change` do not have this dependency.

**Implemented choice**: the dependency is explicit. Coverage fails closed and
reports unavailable evidence; OpenLore does not heuristically rebuild
requirement-to-function correspondence from spec prose.

## 8. Sequencing (decided)

Stages 1-4 predate the graph/structural-intelligence layer OpenLore has now —
they were never reworked to lean on it as heavily as they could. Fixing them
is decoupled from the generate/repair unification question and from the ACP
question: it benefits the standalone facade directly, with the currently
configured provider, independent of any decision about hosting the drafting
step in a particular host agent.

Order of work:

1. Rework stages 1-4 around per-domain deterministic aggregation, following
   stage5's already-correct shape (per-stage audit in
   [openlore-capability-audit.md](openlore-capability-audit.md) §E: stage5 and stage6 are single full-context
   calls over an aggregated deterministic bundle; stages 1-4 are per-file
   loops that only partially trust the same deterministic data). Concretely:
   - Group by `repoStructure.domains` rather than by individual schema/
     service/api file.
   - Treat deterministic inventory data (schema fields/types from
     `get_schema_inventory`, method/path from `get_route_inventory`,
     signatures) as fixed input, not a "hint" the LLM re-derives — the LLM's
     job becomes purpose/relationships/descriptions only.
   - Replace per-file `seenNames`/`seenPaths` dedup with reconciliation at the
     aggregated-bundle level.
2. Stabilize that evidence representation in the standalone pipeline. Ships
   in the **standalone facade**, with the existing configured LLM provider —
   no dependency on a particular host agent or on MCP.
3. Reuse that evidence representation for the agent-hosted path (§4/§6) —
   same primitives, composed per §6 for Generate vs. Repair.
4. Test agent-hosted generation/repair (§7's composed-primitives workflow)
   against the improved standalone pipeline's output.
5. Only then decide whether individual LLM stages (1, 3, 4 — the per-file
   extraction loops) are still necessary as separate stages, or collapse into
   the evidence-layer composition directly.

This is preferable to mixing pipeline-quality work with the hosting-
architecture question. In this model, ACP is no longer a fundamental
architectural concern: an MCP-compatible client is simply the host agent consuming
OpenLore's MCP capabilities.

## 9. Open questions

- Standalone facade parity: once the evidence layer is unified, should the
  standalone LLM provider call use the exact same prompt/evidence shape as the
  agent-hosted path, or a different one? This is a design choice to make as
  part of step 2 in §8, not something to leave open indefinitely.
- What happens to `MappingGenerator`, `ADRGenerator`, `RagManifestGenerator`
  (currently downstream of the six-stage pipeline) if generation moves to the
  evidence-layer model? Not addressed in this draft — needs its own pass once
  the stages 1-4 rework in §8 lands.
