# Tasks — fix-inject-relevance-gate-keyword-mode

## Implementation

- [ ] Add the exact-identifier-mention predicate to `passesRelevanceGate`
      (`orient-inject-render.ts:139-154`): tokenize the prompt with the existing
      identifier-aware tokenizer, pass when a matched function's exact name (or its full
      identifier token) appears — binary, mode-independent
- [ ] Add the keyword-mode rank-evidence branch (top match's identifier tokens ∩ prompt
      identifier tokens ≠ ∅); document why raw-BM25-vs-constant stays forbidden
- [ ] Debug observability: `OPENLORE_INJECT_DEBUG=1` (or `--inject-debug`) reports verdict +
      failing criteria to stderr in `runInject`; stdout untouched
- [ ] Pi parity: confirm the Pi extension's injection path consumes the updated shared render
      module; note in the PR if parity is intentionally skipped
- [ ] Tests: small-repo keyword fixture — exact mention → block; no-mention weak match →
      pointer; hybrid-mode behavior unchanged; stderr debug shape

## Verification

- [ ] Re-run the sandbox repro: `{"prompt":"fix the bug where chargeCard rejects zero
      amounts"}` through `orient --inject` on a fresh 5-function install emits the full block
