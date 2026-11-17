# Tasks — add notebook cell graph

## Implementation
- [ ] `src/core/analyzer/notebook/`: parse `.ipynb` JSON, take `cell_type == "code"` source only
      (outputs never read), retain per-cell byte/line offsets
- [ ] Feed concatenated cell source to the existing Python extractors; map every resulting span
      back to `{ cell, lineInCell, lineInFile }`
- [ ] Synthesize `notebook-cell::` edges from cross-cell def-use (reuse the overlay's facts, no
      second analysis)
- [ ] Record `out-of-order` (execution_count disagrees with cell order), `forward-dependent`
      (a cell reads a name defined only later), and `order-unknowable` (no execution metadata)
- [ ] Record magics / `get_ipython()` / shell-escape sites as disclosed boundary sites
- [ ] Non-Python kernels: membership-only projection (cells listed, no call graph, disclosed)
- [ ] Register `.ipynb` in `EXTENSION_TO_LANGUAGE`; add `notebookProjection` to `CAPABILITIES`
      and `CAPABILITY_DESCRIPTIONS`, derived from the live projector (no hand-written claim)
- [ ] Widen the file-walker corpus gate; per-file parse budget applies unchanged

## Verification
- [ ] Span fidelity: a function defined in cell 4 reports the line it occupies in the `.ipynb`
      file, and its `cell` index — verified against a fixture with cells of differing lengths
- [ ] Reachability: a module function whose only caller is a notebook cell is NOT reported dead
- [ ] Cell edges: editing cell 3 lists the dependent later cells; independent cells are absent
- [ ] Out-of-order: a fixture with shuffled `execution_count` reports `out-of-order` with cell
      numbers; a clean notebook does not
- [ ] Forward dependency is reported even when execution order is clean
- [ ] Magics fixture: the magic line is a disclosed boundary, not a dropped line
- [ ] Non-Python kernel fixture: membership-only, `notebookProjection` supported, `callGraph` not
- [ ] Outputs (including a multi-MB embedded image) never enter the corpus or the search index
- [ ] `get_language_support` reports the notebook capability from the registry, not a literal

## Spec
- [ ] `analyzer` delta: ADD NotebooksAreIndexedWithDisclosedExecutionOrder
