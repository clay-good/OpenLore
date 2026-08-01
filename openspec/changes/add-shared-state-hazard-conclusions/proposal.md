# Add shared-state hazard conclusions: who mutates module state, and where an await splits it

> Status: PROPOSED (2026-07-27, substrate-whitespace sweep). Prior art for the analysis family:
> the race-detector survey's lockset/static lane (https://arxiv.org/pdf/2312.14479); the
> code-property-graph tradition of computing concurrency facts from CFG + call graph. OpenLore's
> version is deliberately the *census*, not the prover.

## The gap

An agent editing a function in a concurrent codebase is asked to reason about state it cannot see.
OpenLore can answer "who calls this" and "what exceptions escape" (`analyze_error_propagation`),
but not "what mutable state does this function share with the rest of the process, and who else
writes it". The facts needed are already extracted and stored — the CFG/def-use overlay
(`src/core/analyzer/cfg.ts:52`, persisted per `cfg-overlay-storage.test.ts`), module-level
declarations from the same walk, and the resolved call graph — but nothing joins them. So the
agent either reads every file that imports the module, or guesses.

The second half of the gap is specific to the async languages OpenLore serves best: **an `await`
inside a read-modify-write splits it into two steps another task can interleave between.** That is
a purely structural fact (an await point strictly between a def and its dependent use of shared
state), decidable from the overlay, and invisible today.

## What changes

**`analyze_shared_state`** (`--preset full`; CLI `openlore shared-state [--symbol <name>]
[--file-pattern <substr>]`) returns two conclusions:

1. **A shared-state census.** For each module-level mutable binding (a `let`/`var` or mutated
   `const` object in TS/JS, a module global assigned outside a function in Python, a package-level
   `var` in Go), the functions that **write** it and the functions that **read** it, each
   line-precise, plus the upstream callers that reach a writer and the reaching tests. Scoped to
   one symbol or region, or the whole repo.
2. **Interleaving hazards.** A `read → await → write` on the same shared binding within one
   function is reported as `interleaved-update` with all three lines. This is reported as a
   *structural shape*, with the exact evidence — never as a proven bug and never with a severity
   ranking of the developer's design.

Honesty, stated in the result and non-negotiable:

- **Sound-direction only.** The census reports the writes it can see. A write through an alias, a
  reflective/dynamic property assignment, an unresolved intra-object receiver, or a call into an
  unanalyzable callee is disclosed in `boundaries` — the writer set is a **lower bound**, and the
  absence of a writer is never rendered as "this state is safe" or "not shared".
- **Explicitly NOT a race detector.** No lockset inference, no alias analysis, no happens-before,
  no deadlock or lock-order claim, no runtime instrumentation. A conclusion the analysis cannot
  ground is not emitted at all.
- **Language scope is declared**: TypeScript/JavaScript, Python, Go — the languages with both a
  CFG overlay and type inference today. Any other language returns an explicit `unsupported`
  result, never an empty hazard set.

## Why this is in scope

Same doctrine, same substrate, same shape as `analyze_error_propagation`: a question about
non-local consequences of a local edit, answered from stored facts by deterministic traversal, as
a conclusion rather than a graph to walk. It is the one class of "what else touches this" an
edge-based call graph structurally cannot answer, because the coupling runs through data, not
calls. Adjacent siblings it must cross-reference, not merge with (per `NoRedundantConclusions`):
`analyze_error_propagation` (exceptional control flow), and — if it ships — `add-effect-purity-
inference`'s effect classes, which say *whether* a function mutates global state, while this says
*which binding, where, and who else*.

## Impact

- Touches: a new handler reading the persisted CFG/def-use overlay and the graph; module-level
  binding extraction added to the existing walk (no new parse pass); no artifact schema change
  beyond the module-binding table.
- Tool surface: +1 tool in `--preset full` only; family `navigate`; `conclusion` class registered.
- Specs: `mcp-handlers` — 1 ADDED (SharedStateConclusionsAreASoundLowerBoundNotARaceVerdict).
- Risk: over-reporting on benign module state such as caches and memo tables (mitigated: the
  output is a census with evidence, not a finding — nothing is emitted into the governance finding
  registry and nothing is gateable by this change); cost on large repos (mitigated: computed live
  from the cached overlay, scoped by symbol or file pattern, with the same truncation-receipt
  discipline as the other bounded conclusions).
