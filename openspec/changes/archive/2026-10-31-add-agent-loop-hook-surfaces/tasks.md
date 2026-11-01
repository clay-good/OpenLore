# Tasks — add-agent-loop-hook-surfaces

## Implementation
- [x] `openlore hook <moment>` CLI (`before-edit`, `after-tools`, `before-stop`): read the harness
      payload from stdin, print one budgeted receipt as `additionalContext`, exit 0
      (`src/cli/commands/hook.ts`)
- [x] `before-edit`: the target is generated, vendored, or a lockfile (no file written)
- [x] `after-tools`: record the agent's edit for the session ledger; new ledger facts; generated-file,
      phantom-reference, and check-weakening facts scoped to the edited file
- [x] `before-stop`: `verify_change` receipt; `stop_hook_active` respected
- [x] Claude Code adapter: `PreToolUse` and `PostToolUse` (edit matcher), `Stop`, each group marked
      `_openloreHook: <moment>`; repository scope only; existing `SessionStart`/`UserPromptSubmit`
      and the opt-in `check-edit` group unchanged
- [x] Silent-when-empty + delivered-fact dedupe keyed by payload `session_id`
- [x] Per-moment budgets with counted truncation; hard timeout; fail-open; stdout carries only the
      receipt
- [x] Opt-in blocking only through `enforcement.policy` blocking codes; block message lists findings
      and next actions
- [x] Config `hooks.<moment>` opt-out; `openlore status` shows wired moments
- [x] Docs: `install.md` table of moments

## Verification
- [x] Each moment: payload fixture in → expected receipt out; empty receipt → no output
      (`src/cli/commands/hook.test.ts`)
- [x] Same fact twice in a session → printed once
- [x] Timeout → no output, exit 0
- [x] `before-edit` on a generated file → fact printed; the file is unchanged by the hook
- [x] With no blocking policy, `Stop` never blocks; with a blocking finding, `Stop` blocks and names it
- [x] Install/uninstall round-trip leaves user hooks (and `check-edit`) untouched
- [x] Full suite green

## Spec
- [x] `cli` delta: ADD LoopMomentsReceiveBudgetedReceipts
- [x] `cli` delta: ADD LoopHooksAreAdvisoryUnlessPolicyBlocks
