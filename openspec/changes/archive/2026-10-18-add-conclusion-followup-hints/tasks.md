# Tasks — add-conclusion-followup-hints

## Implementation
- [x] `followup-hints.ts`: closed `FOLLOWUP_HINT_RULES` (search_code hub top hit → analyze_impact;
      find_dead_code `byConfidence.low` → verify_claim; blast_radius `specs.willGoStale` →
      check_spec_drift); receipts `{ tool, trigger: { field, value }, message }`; at most 2
- [x] Attached once at dispatch (`dispatchTool`, after the conclusion-shape check); never on an
      error or non-object payload

## Verification (`followup-hints.test.ts`)
- [x] Each rule fires on its field with the field's value, and not otherwise
- [x] Table-closure guard: every rule names registered tools
- [x] No tool description changed, so schema budgets are unchanged

## Spec
- [x] `mcp-quality` delta: ADD DataDependentFollowupHints
