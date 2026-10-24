# Won't-do batch — 2026-10-24 (roadmap focus)

The 25 changes archived as `2026-10-24-*` on this date were **not built and will not be built** — they
are archived as settled won't-dos, not as shipped work. Their full proposals are preserved here so the
reasoning we declined on stays readable (and so they are not silently re-proposed).

Governing decision: **ADR-0035 — Focus OpenLore on the verification/governance moat and cross-harness
interop** (`openspec/decisions/`). Priority context: [`ROADMAP.md`](../../../ROADMAP.md) at the repo root.

## What was archived and why

- **The 22 Kotlin changes** — `add-kotlin-callable-node-shapes`, `add-kotlin-declared-type-receivers`,
  `add-kotlin-dynamic-boundary`, `add-kotlin-entry-point-roots`, `add-kotlin-env-var-reads`,
  `add-kotlin-error-propagation`, `add-kotlin-http-topology`, `add-kotlin-java-interop-resolution`,
  `add-kotlin-multiplatform-source-sets`, `add-kotlin-project-identity`, `add-kotlin-public-surface`,
  `add-kotlin-reference-corpus-conformance`, `add-kotlin-schema-inventory`, `add-kotlin-style-fingerprint`,
  `add-kotlin-test-detection-and-generation`, `add-kotlin-ui-and-middleware-inventories`,
  `fix-kotlin-auxiliary-surface-parity`, `fix-kotlin-package-binding-soundness`,
  `fix-kotlin-signature-and-kdoc-fidelity`, `fix-kotlin-type-hierarchy-fidelity`,
  `harden-kotlin-grammar-currency`, `widen-kotlin-control-flow-overlay`.
  Full first-class support for one more language is breadth, not moat. The multi-language ladder already
  fails soft for Kotlin, which is enough. These were already flagged NOT DOING in `STATUS.md`; this
  makes it official.
- **`add-notebook-cell-graph`** — Jupyter notebooks are a narrow audience for a coding-agent substrate.
- **`add-line-provenance-evidence`** — human-vs-agent line attribution is speculative and privacy-adjacent.
- **`add-render-guard-index`** — narrow (UI render guards).

## If one of these becomes worth doing

Re-propose it fresh with `openspec` (a new `openspec/changes/<name>/`), citing the current need. The
archived copy here is the prior art and the record of why it was declined the first time.
