# Tasks — fix-inject-relevance-gate-keyword-mode

## Implementation

- [x] Add the exact-identifier-mention predicate to `passesRelevanceGate`
      (`orient-inject-render.ts:139-154`): tokenize the prompt with the existing
      identifier-aware tokenizer, pass when a matched function's exact name (or its full
      identifier token) appears — binary, mode-independent
- [x] Add the keyword-mode rank-evidence branch (top match's identifier tokens ∩ prompt
      identifier tokens ≠ ∅); document why raw-BM25-vs-constant stays forbidden
- [x] Debug observability: `OPENLORE_INJECT_DEBUG=1` (or `--inject-debug`) reports verdict +
      failing criteria to stderr in `runInject`; stdout untouched
- [x] Pi parity: confirm the Pi extension's injection path consumes the updated shared render
      module; note in the PR if parity is intentionally skipped
- [x] Tests: small-repo keyword fixture — exact mention → block; no-mention weak match →
      pointer; hybrid-mode behavior unchanged; stderr debug shape

## Verification

- [x] Re-run the sandbox repro: `{"prompt":"fix the bug where chargeCard rejects zero
      amounts"}` through `orient --inject` on a fresh 5-function install emits the full block
