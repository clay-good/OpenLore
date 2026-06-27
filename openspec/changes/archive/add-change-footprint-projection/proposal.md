# Change footprint projection: a deterministic per-task write/read/affected region and a pairwise hazard classifier

> Status: SHIPPED (2026-06-24) on branch `feat/change-footprint-projection`. Part of the
> `PARALLEL-WORK-COORDINATION.md` set (proposal 1, the foundation). Generalizes `blast_radius` from
> "one symbol" to "a declared task," splits the result into write / read / affected regions, and adds
> a pure pairwise hazard classifier (WAW / shared-append / RAW / WAR / soft-coupling). No new MCP tool,
> no graph-schema change, no LLM, no runtime.
>
> Implementation: `src/core/services/mcp-handlers/change-footprint.ts` (+ co-located
> `change-footprint.test.ts`, 31 cases — 24 spec-scenario tests plus 7 adversarial regression tests
> covering WAW-over-RAW precedence, the `extraSeedIds` semantic-search seam, partial seed resolution,
> the distance/depth overrides, and combined file+symbol seeds). The decision is captured in the `## Decision` section below
> and recorded through the commit-time decisions gate (the `record_decision` MCP tool is not in this
> session's lean tool surface). Dogfood verification: `DOGFOOD-change-footprint-projection.md`.

## Why

OpenLore can already compute the transitive reach of a *single symbol* (`blast_radius`,
`analyze_impact`) and what *historically co-changes* with a file (`get_change_coupling`). What it
cannot yet express is the unit the rest of this set needs: the **footprint of a proposed task** — the
region of the codebase a unit of work is expected to mutate, the region it depends on, and the region
it would impact. Without a first-class footprint there is nothing to intersect, so there is no way to
ask "can these two tasks run at once?"

This proposal is the borrow-analysis core of the set. It defines, deterministically and with no new
tool surface:

1. a **footprint** for a task descriptor, in three parts (write / read / affected), and
2. a pure **hazard classifier** that, given two footprints, returns the data-hazard between them
   (WAW / RAW / WAR / disjoint) plus any soft co-change coupling.

Everything downstream — the planner (proposal 2), escape detection (proposal 3), the cross-actor map
(proposal 4) — is a consumer of these two functions. Building them once, in the analyzer, keeps the
conflict semantics in a single deterministic place and keeps the tool count at zero for this proposal.

## What changes

1. **A task descriptor (input contract, no persistence).** A task is described by the *caller* (an
   agent or a human), never invented by OpenLore: `{ id, seedSymbols?, seedFiles?, intent?,
   writeMode? }`. At least one seed (symbol or file) is required; `intent` is optional free text used
   only to widen seeds via the existing semantic search when seeds are sparse, never to guess edits.
   `writeMode: 'append' | 'modify'` (default `modify`) is an optional, caller-declared annotation that
   a seed is a pure *addition* to a registration site (a new switch case, a new array/registry entry)
   rather than a change to existing code; it is what lets the classifier avoid the false-conflict
   collapse the validation exercise exposed (see the `shared-append` hazard below). The descriptor is
   an input to a pure function; nothing about it is stored across calls.

2. **The footprint, in three regions** — each computed by reusing existing reachability, not new
   graph machinery:
   - **write-set** — the symbols the task is expected to *modify*. Seeded by `seedSymbols`/`seedFiles`
     and conservatively expanded to the enclosing symbol/type/file of each seed. This is a *declared*
     region (the borrow declaration), not a prediction of every edit; the honesty contract is that
     OpenLore reports the declared write-set, lightly normalized, and nothing more.
   - **read-set** — the transitive *callees / dependencies* of the write-set (forward reachability):
     what the task's code reads to function. Bounded by the existing call-distance scoping **and** with
     *ambient symbols* excluded — symbols whose fan-in exceeds a configurable percentile (`logger`,
     `validateDirectory`, the call-graph primitives) are the dependency-graph equivalent of IR
     stop-words: everyone reads them, so they carry no ordering signal and would otherwise bloat every
     read-set toward the whole graph. The validation exercise showed this bound and exclusion are
     load-bearing, not cosmetic.
   - **affected-set** — the transitive *callers* of the write-set (backward reachability = today's
     `blast_radius`): who is impacted if the write-set changes. This is retained as **informational
     human-facing output only**; it is *not* an input to hazard classification (the classifier uses
     write/read sets exclusively), so computing it never widens the conflict graph.
   - **coupling-neighbors** — files that co-change with the write-set above the existing
     `COUPLING_MIN_SUPPORT` / `COUPLING_MIN_CONFIDENCE` thresholds, carried as a *soft* annotation
     (advisory), kept separate from the static regions so consumers can weight it differently.

3. **The pairwise hazard classifier (pure function).** Given two footprints A and B, return the
   strongest hazard between them:
   - **WAW** if `write(A) ∩ write(B) ≠ ∅` and at least one side touches the shared symbol in `modify`
     mode — both genuinely change a shared symbol → mutual-exclusion class.
   - **shared-append** if `write(A) ∩ write(B) ≠ ∅` but **both** sides touch every shared symbol in
     `append` mode — concurrent additions to a registration site (dispatcher, registry array, preset
     list) that merge trivially → low-risk advisory, *not* mutual exclusion. This is the refinement the
     validation exercise forced: without it, every new-tool task collides on `dispatchTool` /
     `TOOL_DEFINITIONS` and the whole swarm serializes.
   - **RAW** if `write(A) ∩ read(B) ≠ ∅` (or symmetrically `write(B) ∩ read(A)`), after ambient
     symbols are excluded — one task writes a non-ambient symbol the other reads → an *ordering*
     relation (the reader runs after the writer or re-orients), not exclusion. The direction is
     recorded.
   - **WAR / disjoint-region-same-file** if regions overlap only in read sets, or touch the same file
     in disjoint symbols → low-risk, surfaced but not serializing.
   - **soft-coupling** if the write-sets share no static relation but the files co-change above
     threshold → advisory warning only.
   - **none** otherwise. The result includes the witnessing symbol(s) so a consumer can explain the
     verdict.

4. **Determinism & honesty.** A footprint and a hazard verdict are deterministic functions of the
   graph state, the coupling store, and the descriptor; byte-identical across re-evaluations of a
   fixed state. A descriptor whose seeds resolve to nothing (unknown symbol, untracked file) yields an
   **empty footprint with an explicit "unresolved seed" note**, never a fabricated region. The
   write-set is always reported as *declared/advisory*, carrying the known-unknowable disclosure that
   an agent may edit outside it (this is what proposal 3 later checks).

## Decision

**Footprint = three reachability regions over the existing call graph + a soft co-change annotation;
hazards = set intersection classified by the RAW/WAR/WAW data-hazard taxonomy, extended with a
caller-declared `shared-append` class and ambient-symbol exclusion.** We deliberately do not
introduce a new edge kind, a new persisted structure, or any predictive model. The write-set is
*declared by the caller and normalized*, not inferred, because inferring "what an agent will edit"
is exactly the kind of guess the north star forbids; the read/affected regions are deterministic
reachability we already compute. The `shared-append` downgrade and the ambient-symbol exclusion are
both forced by the validation exercise (run against this repo's real `dispatchTool` / `TOOL_DEFINITIONS`
hot-spots and its hub fan-in): without them the classifier is technically correct but useless, because
it serializes every task that registers a tool. `shared-append` stays *caller-declared* (`writeMode`),
never inferred, so the honesty contract holds. The classifier is a pure function so every downstream
consumer shares one conflict definition.

## Scope contract — do not break these things

This change must NOT:
- Add an MCP tool, a new node/edge kind, or a persisted store. Footprints and hazards are computed
  on demand from existing primitives and returned to in-process callers (the proposal-2 tool).
- Infer the write-set beyond declared seeds + conservative enclosing-scope normalization. No
  "predict the edits" heuristic.
- Fabricate a region for an unresolved seed. Unresolved → empty footprint + explicit note.
- Let the read/affected regions fan out unbounded. Reuse the existing call-distance scoping.
- Treat soft co-change coupling as a hard hazard. It is advisory and kept separate from the static
  hazard classes.
- Persist or remember any descriptor across calls. The function is pure.

## Out of scope (deferred)

A learned write-set predictor; weighting hazards by symbol importance/PageRank (the planner may layer
ordering on top later); cross-language footprint differences beyond what call-distance scoping already
handles; and exposing footprints as their own MCP tool (the planner in proposal 2 is the agent-facing
surface — a bare footprint is a primitive, not a conclusion).

## Implementation status

Tracked in `tasks.md`. Verified by unit tests over a fixture graph: a write-set seeded by a symbol
expands to its enclosing scope; the affected-set equals `blast_radius` of the write-set; the read-set
is the forward call closure within the distance bound; two tasks sharing a written symbol classify
WAW; a task that writes a symbol another reads classifies RAW with the correct direction; same-file
disjoint symbols classify WAR/low-risk; co-changing-but-statically-unrelated files classify
soft-coupling; an unresolved seed yields an empty footprint with a note; and re-evaluation is
byte-identical.
