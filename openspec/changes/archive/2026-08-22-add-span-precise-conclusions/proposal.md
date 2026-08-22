# Conclusions drop the line numbers the substrate already stores

> Status: BUILT (2026-08-22). The published agent-localization
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

- Optional call-site line on stored call edges: `CallEdge.line`
  (`src/core/analyzer/call-graph-types.ts`); node spans carry optional
  `startLine`/`endLine`. Missing line evidence stays missing rather than being reconstructed.
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

1. **Existing conclusions surface only stored line facts.** `search_code` symbol hits and
   `orient` functions gain `startLine`, joined by the canonical symbol id rather than by a
   possibly-colliding name. `analyze_impact` affected entries selected by a canonical global
   response cap gain a `callSites` collection for every qualifying shortest-frontier edge that
   places the symbol at its reported depth, with a top-level receipt disclosing omitted entries.
   `trace_execution_path` non-terminal steps gain `callsNext` for every stored parallel edge to
   the next symbol. Collections are deterministically ordered, deduplicated, bounded by the
   dedicated line-receipt cap, and carry an explicit receipt with the returned count, an exact
   total when complete or bounded `totalAtLeast` when truncated, and the truncation verdict.
   This keeps receipt computation memory-bounded. An absent stored line remains absent.
2. **`get_function_body` gains optional focused reads with an explicit kind.** Legacy calls omit
   both fields and remain byte-for-byte unchanged. A focused call supplies `focus` plus
   `focusKind: variable | callee`, so a spelling that is both a local and a callee is never
   resolved by an undocumented preference. A successful focused response omits `body`:
   - `variable` returns the persisted **direct, same-spelling** definition/use evidence from the
     function's CFG overlay. Each line carries the overlay's stored `dataFlowPrecision`
     (`exact | may`) and its definition/use roles. The response discloses that the overlay stores
     display spellings, not scope-qualified variable identities.
   - `callee` returns stored call-site lines whose raw `calleeName` matches the focus. Each line
     carries the edge's stored `callConfidence`; it does not receive a fabricated data-flow
     precision label. Parallel call sites are preserved.
   Both kinds return the source text for each evidence line, ordered and bounded under the same
   explicit receipt discipline as the other line collections.
3. **Honest at every boundary.** A variable focus in a language outside CFG-overlay support, or
   on a supported function with no usable overlay, returns the legacy whole body plus a
   machine-readable `sliceUnavailable` reason. An unknown focus returns a typed not-found with
   bounded candidates. An ambiguous symbol, stale index, mixed/incoherent analysis generation,
   or stored line outside the selected symbol span fails closed with a machine-readable refusal
   and no focused body. Freshness uses the established content-hash-first, artifact-mtime-fallback
   dual baseline from `locate_symbol_span`. `may` is never collapsed to `exact`, and call-edge
   confidence is never relabeled as data-flow precision.

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

- Files: `src/core/services/mcp-handlers/orient.ts`, `semantic.ts`, and `graph.ts` (shape stored
  line receipts); `analysis.ts` (focused `get_function_body` reads from one cached generation);
  `cfg.ts` (one pure direct-evidence shaper over persisted `DefUseEdge`s); MCP and Pi schemas;
  docs and parity/budget guards.
- Specs: `mcp-handlers` — 2 ADDED requirements (ConclusionsCarrySpanEvidence,
  SliceFocusDisclosesPrecisionAndScope).
- No new tool; no new artifact; additive fields on existing conclusions and an opt-in focused
  mode on an existing tool. Risk is concentrated in payload growth, stale line coordinates,
  parallel-edge collapse, and precision over-claim. Deterministic caps + truncation receipts,
  dual-baseline freshness, all-parallel-edge collections, and separate `dataFlowPrecision` /
  `callConfidence` fields bound those risks. Sibling to
  `refine-orient-context-budgeting` (breadth budgeting) — this owns depth precision; neither
  re-proposes the other.
