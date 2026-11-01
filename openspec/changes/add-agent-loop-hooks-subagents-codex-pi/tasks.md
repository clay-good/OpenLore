# Tasks — add-agent-loop-hooks-subagents-codex-pi

## Implementation
- [ ] `subagent-start` moment: task-scoped `orient` for the sub-agent's prompt (+ peers' footprints
      once the peer board ships)
- [ ] `task-created` moment: wired only when a coordination finding code is blocking
- [ ] `after-tools` on `PostToolBatch` (every tool): record test runs for the session ledger
- [ ] `before-edit`: phantom references on the pending text (in-memory check; no file written)
- [ ] Codex adapter: `PreToolUse`, `PostToolUse`, `SessionStart` (incl. compact), `SubagentStart`
- [ ] Pi extension: `tool_call`, `tool_result`, `session_before_compact` (the handoff briefing),
      `before_agent_start`

## Verification
- [ ] Each moment: payload fixture in → expected receipt out; empty receipt → no output
- [ ] `before-edit` with an invented import in the tool input → fact printed; file unchanged
- [ ] Install/uninstall round-trip for Codex and Pi leaves user hooks untouched
- [ ] Full suite green

## Spec
- [ ] `cli` delta: ADD RemainingLoopMomentsReceiveReceipts
