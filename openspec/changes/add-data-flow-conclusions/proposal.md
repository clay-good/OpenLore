# Data-flow conclusions: does this value reach that sink — a third overlay, honestly bounded

> Status: PROPOSED (2026-07-27, field research sweep — `FIELD-RESEARCH-2026-07.md`). Add
> interprocedural value-flow as a conclusion: `trace_data_flow({source, sink})` answers "can a
> value from A reach B?" with a statement-level path receipt or an honestly-bounded negative.
> Prior art: the code-property-graph literature (AST + CFG + data-dependence as composable
> layers) establishes this is computable from parse-tree-derived facts alone; the field's main
> open structural-rule engine moved cross-function taint behind a commercial tier in 2025,
> leaving honest local-first interprocedural flow as open whitespace.

## The gap

- OpenLore answers control-flow questions (`trace_execution_path`, `analyze_impact`,
  `analyze_error_propagation`) but not **value-flow** questions: "does request input reach this
  SQL string?", "does this config value flow into that outbound call?", "is this return value
  ever derived from that parameter?" Agents answer these today with grep plus guesswork — the
  exact failure mode the conclusion doctrine exists to prevent.
- The substrate already computes two of the three layers: the call graph (interprocedural
  edges, resolution-confidence-labeled) and the CFG overlay with def-use chains
  (intra-procedural, line-precise, TS/JS/Python plus other CFG languages). The missing piece is
  the **composition**: binding call-site arguments to callee parameters and callee returns to
  call-site results, then chaining def-use across those bindings. No new grammar, no new parse
  pass.
- `analyze_env_impact`'s spec discloses config-object key flows (`config.x.y`) as an
  out-of-scope boundary; published configuration-dependency research shows value-flow is exactly
  the machinery that closes such boundaries later. This proposal builds the machinery; closing
  that boundary is a named follow-up, not part of this change.

## What changes

- **One new conclusion tool, `trace_data_flow`** (`full` preset, family `navigate`; CLI
  `openlore data-flow --source <symbol[:param]> --sink <symbol[:param]>`). Source and sink name
  an indexed symbol, optionally narrowed to a parameter or return. The verdict is one of:
  - `flow-found` — with the concrete path: an ordered list of hops, each a def-use step
    (file:line) or a call binding (call site → parameter / return → result), so the receipt is
    replayable by reading the cited lines;
  - `no-flow-within-analyzed-scope` — with the boundaries that bound the claim enumerated:
    unresolved/external callees on the frontier, dynamic-dispatch sites, unsupported-language
    regions, and the depth cap if hit. The response never says "safe" and states the sound
    direction verbatim: a found flow is proven; an absent flow is bounded by the disclosed
    frontier.
- **Propagation rules are deliberately minimal and closed:** direct assignment/def-use chains,
  call-argument → parameter, return → call-result, member/index writes treated as flows into
  the container (over-approximate, disclosed as `container-level`). No alias analysis — two
  names for one object are disclosed as a boundary class, never silently assumed either way.
- **Compositional and O(diff).** Per-function flow summaries (param → return / param → callee-
  argument / param → container-write) are computed per function and memoized by the same
  content-hash key as Pass-1 facts, so watcher-time refresh touches only changed functions.
- **Scope:** TS/JS/Python first (the def-use overlay's strongest languages); any other language
  in the query's reachable region returns/discloses `unsupported`, never an empty "no flow".
- **Deliberately NOT borrowed / NOT built:** security rule packs, sanitizer taxonomies, and
  vulnerability verdicts (this tool reports *flow evidence*, not "vulnerable" — a SAST verdict
  needs semantics OpenLore does not claim); alias/points-to analysis; string solving; whole-
  program fixpoint solving (bounded traversal with a disclosed cap, like every sibling
  conclusion); any LLM anywhere.

## Why this is in scope

Value-flow is the third layer of the structural substrate the first two layers were built for,
computed from facts already extracted, under the same sound-lower-bound honesty contract as
`analyze_error_propagation` (which this tool mirrors in shape: escapes ↔ flows, boundaries ↔
boundaries). It converts the single most common security/correctness question agents ask into a
receipt-backed conclusion, deterministically and locally.

## Impact

- Files: a flow-summary extractor beside the CFG overlay (per-function, hash-memoized), an
  interprocedural composer (bounded BFS over resolved edges), the `trace_data_flow` handler +
  CLI command, tool-contract classification (`conclusion`, family `navigate`), presets/docs.
- Specs: `analyzer` — 1 ADDED requirement; `mcp-handlers` — 1 ADDED requirement.
- Tool surface: +1 tool in `full` preset only (tools/list budget respected; not in substrate/
  navigation presets); adjacent-tool cross-references: names `trace_execution_path` (control
  flow) and `analyze_error_propagation` (exception flow) as siblings per NoRedundantConclusions.
- Risk: over-approximation noise from container-level flows (mitigated: hop kind labeled
  `container-level` so a reader can discount it); depth-cap truncation misread as absence
  (mitigated: cap disclosure is mandatory in the negative verdict); summary staleness
  (mitigated: content-hash keying shared with Pass-1 memoization).
