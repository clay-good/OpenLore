# Change set: substrate-whitespace sweep 2026-07-27 — five net-new proposals

This directory gained 5 change proposals on 2026-07-27, from a third research sweep run the same
day as — and deduplicated against — both `FIELD-RESEARCH-2026-07.md` and
`ECOSYSTEM-RESEARCH-2026-07-27.md`, plus the full 114-item open backlog per `STATUS.md`.

Because the two earlier sweeps had already worked the memory, governance, coordination, and
code-intelligence tracks hard, this one deliberately went where neither looked: **source forms
OpenLore does not index, and coupling that does not run through call edges.** Every `file:line`
cited in a proposal was verified against this checkout before it was written.

## What this sweep established

- **`.ipynb` is absent, not unsupported.** No occurrence of `ipynb`/`notebook` anywhere in `src/`,
  and no entry in `EXTENSION_TO_LANGUAGE` (`language-detection.ts:30`). On a data/ML repository,
  every conclusion is computed over the minority of the repo that happens to be `.py` — a
  dishonest silence at whole-file-class scale. The field shows the analysis is tractable:
  HeaderGen reports 95%+ call-graph precision/recall on notebooks by extending an existing Python
  analyzer (https://arxiv.org/abs/2301.04419).
- **The data layer is a catalog with no consumers.** `schema-extractor.ts` parses ORM *model
  definitions* for five ORMs (`schema-extractor.ts:4`, `:27`); nothing records which code reads or
  writes a table. That is both the missing fourth member of the shipped
  inventory→sites→radius→tests family (env, logs, errors, **data**) and the dependency the open
  `add-migration-impact-certificate` names when it joins a verdict to "surviving readers".
  Static query analysis is the settled approach in the data ecosystem (dbt's static analysis
  phase, sqlglot-backed column lineage, SQLMesh).
- **Two questions live in the overlay and have no tool.** The CFG/def-use overlay is extracted,
  persisted, and read by exactly one conclusion (`analyze_error_propagation`). Two more are
  decidable from the same facts with no new grammar: *what shared state does this function write,
  and does an await split an update* (the static, census-shaped lane of the race-detection
  literature — https://arxiv.org/pdf/2312.14479), and *which path leaves the handle open* — the
  consequence question error propagation stops one step short of.
- **The honesty contract has a blind spot: OpenLore's own prose.** `src/doc-claim-sync.test.ts`
  guards four documented claims with hand-written assertions because those claims rotted. The
  substrate holds the ground truth for hundreds more (symbol table, file tree, command registry,
  tool definitions) and has never read its own docs.

## The five proposals

| # | Change | Track | One line |
|---|--------|-------|----------|
| 1 | `add-notebook-cell-graph` | corpus | `.ipynb` indexed via the existing Python extractors; cell-level dependency edges; out-of-order execution disclosed from recorded metadata, never run |
| 2 | `add-datastore-access-graph` | capability | `analyze_datastore_impact`: line-precise read/write/DDL sites per table, blast radius, reaching tests, confidence-tiered with unresolvable queries disclosed |
| 3 | `add-shared-state-hazard-conclusions` | capability | `analyze_shared_state`: module-state reader/writer census + await-split updates as evidence — a lower bound, explicitly not a race detector |
| 4 | `add-doc-claim-certification` | verify | `certify_doc_claims`: a closed syntactic claim vocabulary resolved against the substrate; ambiguous ⇒ `uncheckable`, never `refuted` |
| 5 | `add-resource-lifecycle-conclusions` | capability | `analyze_resource_lifecycle`: proven leak paths only, joined to the escaping exception type; never a "released" claim |

## How they compose

1 widens the corpus every other conclusion reads (notebook symbols become ordinary nodes, so 2–5
apply to notebooks for free). 2 supplies the readers `add-migration-impact-certificate` needs and
extends the shipped inventory→radius family to the data layer. 3 and 5 are the second and third
consumers of the CFG/def-use overlay, each cross-referencing `analyze_error_propagation` as a
sibling rather than merging with it (`NoRedundantConclusions`): errors say what escapes, 5 says
what was held when it did, 3 says what data the escape leaves inconsistent. 4 turns the honesty
contract on the project's own documentation and makes the other four's docs self-checking.

## Considered and deliberately not proposed

- **Context-recall/precision self-evaluation** (ContextBench-style gold-context recall and
  precision over agent trajectories, https://arxiv.org/abs/2602.05892 — its headline finding, that
  agents retrieve far more context than they use, is a direct argument for a precision metric).
  This belongs *inside* the open `add-benchmark-harness-protocol` as a metric lane, not as a
  competing proposal; recorded here as design input for it, and for
  `refine-orient-context-budgeting` which owns the payload-shaping side.
- **Agent-surface inventory / configuration-drift governance** (which MCP servers, hooks, and
  skills a repo wires, and what changed). Real and topical in 2026, but it is host-specific
  security configuration — the same boundary that got sandbox/permission-profile projection
  rejected in the field-research sweep. The `AGENTS.md`/skills half is already owned by
  `adopt-agent-context-interop`.
- **Column-level lineage through SQL expressions** (join trees, CTE projection chains). Requires a
  SQL dialect engine; no grammar is in `package.json` and adding one for this is disproportionate.
  Proposal 2 declares it out of scope in the payload rather than approximating it.
- **Notebook reproducibility enforcement** (FlowBook-style, https://arxiv.org/pdf/2605.01560) —
  would mean executing notebooks. Proposal 1 reads the recorded metadata and stops there; running
  code is outside the static-only doctrine, the same boundary the mutation-testing question is
  parked behind.
- **Lock-order / deadlock and lockset inference.** The sound version needs alias analysis OpenLore
  does not have; proposal 3 explicitly refuses these verdicts rather than shipping a plausible
  one.
- **Docstring/JSDoc signature drift.** Linter territory with a different anchor (the doc block next
  to the code); proposal 4 covers prose claims about the system instead, and says so.
- **User-authored resource pairing rules / architecture rule authoring.** Both are the
  generalization step; the closed vocabularies ship first, exactly as
  `widen-architecture-rule-vocabulary` reasons about its own scope.

Baseline: main @ cca1894; 114 open changes per `STATUS.md` plus the 20 proposals from the two
earlier same-day sweeps. Method: five web-research tracks (data/SQL lineage, notebook static
analysis, concurrency static analysis, documentation-drift verification, retrieval evaluation),
each finding diffed against the backlog and grounded in the code before anything was written.
