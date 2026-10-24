# Index computational notebooks: cells become nodes, hidden state becomes a disclosed hazard

> Status: PROPOSED (2026-07-27, substrate-whitespace sweep). `.ipynb` is invisible to OpenLore
> today — not unsupported, *absent*. Prior art: HeaderGen, which shows notebook call-graph
> analysis is tractable at 95% precision/recall with flow-sensitivity over an existing Python
> analyzer (https://arxiv.org/abs/2301.04419); FlowBook on execution-order reproducibility
> (https://arxiv.org/pdf/2605.01560).

## The gap

`EXTENSION_TO_LANGUAGE` (`src/core/analyzer/language-detection.ts:30`) has no `.ipynb` entry, and
nothing in `src/` mentions notebooks. On a data/ML repository whose primary logic lives in
notebooks, every OpenLore conclusion is silently computed over the fraction of the repo that
happens to be `.py` modules: `orient` returns nothing for a concept defined in a notebook,
`report_coverage_gaps` cannot see the untested notebook function, and `find_dead_code` will call a
module function dead when its only caller is a notebook cell. The `get_language_support` matrix
(`src/core/analyzer/language-support.ts:41`) cannot express this either — a language with no
record reads as "not detected", not "present but unindexed".

Notebooks also carry a structural hazard no source file has: **the order cells ran is not the
order they are written**. A notebook whose `execution_count` sequence disagrees with its cell
order produced its outputs from state a fresh top-to-bottom run would not reproduce. That fact is
recorded in the file, deterministically checkable, and nobody joins it to a call graph.

## What changes

1. **`.ipynb` becomes an indexed source form** (a projection, in the `iac/` precedent's shape —
   `src/core/analyzer/iac/index.ts:32` — not a new grammar): the notebook JSON is read, code cells
   are extracted with their source offsets, and the concatenated cell source is handed to the
   **existing** Python extractors. Functions and classes defined in cells become ordinary graph
   nodes; a call from a cell to an imported module function becomes an ordinary edge, so notebook
   → module reachability works everywhere reachability already works. Every node carries its
   `cell` index and in-cell line, so spans stay line-precise against the `.ipynb` file, not
   against a synthetic concatenation.
2. **Cell-level dependency edges**: a cell that reads a name another cell defines gets a
   `notebook-cell::` edge, computed from the def-use facts the overlay already produces
   (`cfg.ts:52`). This is what makes "if I change cell 3, which later cells break" a lookup.
3. **Execution-order disclosure**: when the recorded `execution_count` order disagrees with cell
   order, or a cell reads a name defined only in a *later* cell, the notebook is reported
   `out-of-order` / `forward-dependent` — a disclosed structural fact with the cell numbers, never
   a quality score and never a fix.
4. **`notebookProjection` joins `CAPABILITIES`** (`language-support.ts:41`) so a quiet notebook
   result is interpretable as "unsupported kernel" rather than "nothing found".

Honest boundaries, disclosed rather than guessed: non-Python kernels are projected as
**membership only** (cells listed, no call graph); IPython magics (`%`, `!`) and `get_ipython()`
calls are recorded as unresolvable boundary sites, never silently dropped; a notebook with no
`execution_count` metadata reports "order unknowable", not "in order".

Deliberately NOT borrowed from the prior art: HeaderGen's ML-taxonomy header *generation*
(OpenLore does not author content), notebook execution or output inspection of any kind, and
FlowBook's runtime reproducibility enforcement — the recorded metadata is read, the notebook is
never run.

## Why this is in scope

The north star (decision `c6d1ad07`) is deterministic structural context for coding agents. On a
notebook-first repository OpenLore currently gives an agent a confidently-shaped answer computed
over a minority of the code — the exact dishonest-silence failure the honesty contract exists to
prevent, at whole-file-class scale. Everything needed (Python extractors, def-use overlay,
projection wiring, capability registry) already ships.

## Impact

- New: `src/core/analyzer/notebook/` (JSON reader, cell offset mapping, cell-edge synthesis);
  `.ipynb` added to `EXTENSION_TO_LANGUAGE`; `notebookProjection` added to `CAPABILITIES` +
  `CAPABILITY_DESCRIPTIONS`; the file walker's corpus gate widened (bounded — a notebook is
  subject to the same per-file parse budget as any source file).
- No new MCP tool, no tool-count change. Existing tools gain notebook symbols for free.
- Specs: `analyzer` — 1 ADDED (NotebooksAreIndexedWithDisclosedExecutionOrder).
- Risk: notebooks are large, output-heavy JSON (mitigated: outputs are never read into the
  corpus — only `cell_type == "code"` source; the per-file parse budget applies unchanged);
  concatenation could mis-attribute spans (mitigated: offsets are mapped back per cell, and the
  span mapping is the first thing tested).
