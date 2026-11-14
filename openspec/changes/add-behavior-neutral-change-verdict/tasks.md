# Tasks

## 1. Count

- [ ] 1.1 In `computeSymbolChangedSet` (`src/core/services/symbol-changed-set.ts`), mark a symbol
      `provenNeutral` when its span text differs between the base and the working tree and its
      normalized hash is equal. Test: `src/core/services/symbol-changed-set.test.ts`. Done when a
      re-indented function is counted, an untouched function is not, and a function with one
      changed operator is `changed`.
- [ ] 1.2 Add `provenNeutral: { symbols, files, sample }` to `ChangeGranularityReceipt` in
      `granularityReceipt` (same file), with `sample` bounded by `GRANULARITY_FALLBACK_SAMPLE`.
      Test: `src/core/services/symbol-changed-set.test.ts`. Done when a file kept whole adds
      nothing to the count and the output is identical across two runs.
- [ ] 1.3 Add fixtures to `src/core/services/symbol-changed-set.test.ts`: a string-literal edit, a
      Python block moved out of an `if`, and a file with a parse error. Done when none is counted
      as neutral.

## 2. Surfaces

- [ ] 2.1 State the count in a mixed diff in `src/core/services/mcp-handlers/blast-radius.ts`
      (next to `granularityCaveat`). Test:
      `src/core/services/mcp-handlers/blast-radius.test.ts`. Done when a 30-symbol reformat with
      one real edit reports the neutral count and seeds only the real edit.
- [ ] 2.2 Add one `info` item to the receipt in
      `src/core/services/mcp-handlers/verify-change.ts`, with whole-diff wording when nothing is
      seeded. Test: `src/core/services/mcp-handlers/verify-change.test.ts`. Done when the item is
      absent at count zero and present once otherwise.
- [ ] 2.3 Confirm `beforeStop` in `src/cli/commands/hook.ts` shows the item once per session
      through the existing dedupe key. Test: `src/cli/commands/hook.test.ts`. Done when a second
      stop with the same counts prints nothing new.
- [ ] 2.4 Classify `provenNeutral` in
      `src/core/services/mcp-handlers/confidence-boundary.ts` as a non-disclosure field (it is not
      a completeness signal). Test:
      `src/core/services/mcp-handlers/completeness-invariant.test.ts`. Done when the sweep passes
      and `confidenceBoundary.complete` is unchanged by the new field.

## 3. Docs and checks

- [ ] 3.1 Update `docs/structural-diff.md` and `docs/mcp-tools.md`: the field, the wording, and
      the limits (comments and whitespace only). Done when both name `provenNeutral`.
- [ ] 3.2 Run `npx vitest run src/pi/extension.test.ts` (MCP↔Pi parity guard; `blast_radius` and
      `verify_change` gain a field) and `openspec validate add-behavior-neutral-change-verdict`.
      Done when both pass.
