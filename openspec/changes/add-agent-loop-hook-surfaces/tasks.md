# Tasks — add-agent-loop-hook-surfaces

## Implementation
- [ ] `openlore hook <moment>` CLI (`before-edit`, `after-tools`, `after-compact`, `before-stop`,
      `subagent-start`, `task-created`): read the harness payload from stdin, print one budgeted
      receipt, exit 0
- [ ] `before-edit`: build a unified patch from edit/write tool input; grade with `verify_change`
      `patch` limited to phantom-reference and generated-file families; hard latency cap
- [ ] Claude Code adapter: `PreToolUse` (edit/write matcher), `PostToolBatch`, `SessionStart` matcher
      `compact`, `Stop`, `SubagentStart`; `TaskCreated` only when a coordination code is blocking;
      existing `SessionStart`/`UserPromptSubmit` unchanged
- [ ] Codex adapter: `PreToolUse`, `PostToolUse`, `SessionStart`, `SubagentStart` (no `Stop` by
      default: it cannot inject)
- [ ] Pi extension: matching events
- [ ] Silent-when-empty + delivered-fact dedupe keyed by payload `session_id`
- [ ] Per-moment token caps with counted truncation; hard timeout; fail-open
- [ ] Opt-in blocking only through `enforcement.policy` blocking codes; block message lists findings
      and next actions
- [ ] Config `hooks.<moment>` opt-out; `openlore status` shows wired moments
- [ ] Docs: `agent-setup.md` table of moments per harness

## Verification
- [ ] Each moment: payload fixture in → expected receipt out; empty receipt → no output
- [ ] Same fact twice in a session → printed once
- [ ] Timeout → no output, exit 0, also with a blocking policy set
- [ ] `before-edit` with an invented import in the tool input → fact printed before the write; the
      file is unchanged by the hook
- [ ] With no blocking policy, `Stop` never blocks; with `test-disabled` set to block, `Stop` blocks
      and names the finding
- [ ] Install/uninstall round-trip leaves user hooks untouched (existing managed-paths guard)
- [ ] Full suite green

## Spec
- [ ] `cli` delta: ADD LoopMomentsReceiveBudgetedReceipts
- [ ] `cli` delta: ADD LoopHooksAreAdvisoryUnlessPolicyBlocks
