# Conclusions drop the line numbers the substrate already stores

> Status: PROPOSED (2026-07-23, competitive substrate sweep). The published agent-localization
> evidence is unambiguous: agents find the right FILE 60–70% of the time but the right LINES
> only 14–19%, and relevant-evidence-per-token correlates r≈0.95 with repair success
> (SWE-Explore, https://arxiv.org/html/2606.07297v1; the file→function→line precision decay is
> replicated in Agentless, https://arxiv.org/html/2407.01489, and graph-guided localization
> adds 15–25 pts at function level, LocAgent, https://arxiv.org/pdf/2503.09089). Span-level
> localization is the measured bottleneck of the whole category — and OpenLore already computes
> and persists the span-level evidence, then drops it at the conclusion boundary. This change is
> conclusion SHAPING, not new analysis: no new pass, no new artifact, no new tool.

## The gap

The line-precise substrate exists and is persisted:

- Call-site line on every edge: `CallEdge.line` (`src/core/analyzer/call-graph-types.ts:150`,
  raw at `:47-55`); node spans `startLine`/`endLine` (`:81-83`).
- Def-use edges with per-variable `defLine`/`useLine` and an `exact | may` precision marker
  (`src/core/analyzer/cfg.ts:47-64`), persisted per function in the `cfg_overlay` table
  (`src/core/services/edge-store.ts:293-298`), 11 languages (`cfg.ts:481-493`), kept fresh
  incrementally by the watcher (`mcp-watcher.ts:635-638`).

And the conclusions drop it:

- `orient` functions carry no line at all (`OrientFunction`, `orient.ts:108-116`, mapping
  `:224-236`); `search_code` symbol hits carry no line (`semantic.ts:255-280` — only the
  literal-text fallback has one, `:163-169`); `analyze_impact`/`trace_execution_path` summarize
  nodes as `{name, file, className, depth}` (`graph.ts:307-310`) and path steps drop the
  call-site line the edge stores (`graph.ts:1294-1306`).
- `get_function_body` can only return the whole span (`analysis.ts:481-493`); for a 300-line
  function the agent pays 300 lines to look at 6. The def-use slice that would answer "which
  lines matter for this variable/callee" is reachable today only through the value-level opt-in
  of two tools (`graph.ts:601-639`, `:1209-1232`).

The result: an agent that used OpenLore to localize perfectly at function granularity still
re-enters the file-dump loop to find the lines — the exact token burn the substrate exists to
eliminate.

## What changes

1. **Existing conclusions surface the lines they already have** (a few bytes per entry, no new
   computation): `search_code` symbol hits and `orient` functions gain `startLine`;
   `analyze_impact` affected entries and `trace_execution_path` steps gain the call-site
   `line` from their edge. Payload-budget impact is negligible and stays under the existing
   tool-guard caps.
2. **`get_function_body` gains an optional `focus`** — a variable or callee name. With focus,
   the response is the SLICE: the def-use lines for that variable (or the call-site lines for
   that callee) plus minimal surrounding excerpt, each line tagged with its provenance
   (`exact | may`, from the CFG overlay's existing precision marker) — instead of the whole
   body. Without `focus`, behavior is byte-identical to today.
3. **Honest at every boundary.** A language outside the CFG overlay's 11 (`cfgSupportsLanguage`,
   `cfg.ts:504-506`) returns the whole span with an explicit `sliceUnavailable: <reason>` —
   never a silently un-sliced answer that looks complete; `may`-precision lines are never
   presented as exact; a stale index discloses line-freshness via the dual-baseline pattern
   `locate_symbol_span` already established (`symbol-span.ts:76-87`).

**Deliberately NOT borrowed** from the localization literature: no learned ranker, no LLM
re-ranking of spans, no speculative "relevant lines" heuristics. Every surfaced line is a
stored structural fact (a call site, a def, a use) with named provenance — the deterministic
subset of span localization, which is exactly the part the substrate can certify.

## Why this is in scope

This is the highest-evidence usefulness gap in the field, and OpenLore's cost to close it is
uniquely low because the facts are already persisted — the change converts existing evidence
into conclusion-grade answers, which is the substrate's entire doctrine. It also compounds the
token-efficiency story: signature-level briefings for breadth (already shipped), slice-level
answers for depth.

## Impact

- Files: `src/core/services/mcp-handlers/orient.ts:224-236`, `semantic.ts:255-280`,
  `graph.ts:307-310, 1294-1306` (surface stored lines); `analysis.ts:457-531`
  (`get_function_body` focus + slice via `getCfg` + `valueReachableLines`, both existing);
  Pi-extension parity check per the MCP↔Pi rule.
- Specs: `mcp-handlers` — 2 ADDED requirements (ConclusionsCarrySpanEvidence,
  SliceFocusDisclosesPrecisionAndScope).
- No new tool; no new artifact; small additive payload fields. Risk: low — the hazards are
  payload-budget creep (bounded: integers on existing entries) and precision over-claim
  (bounded: the `exact | may` marker is carried, never collapsed). Sibling to
  `refine-orient-context-budgeting` (breadth budgeting) — this owns depth precision; neither
  re-proposes the other.
