# Tasks — add-agent-loop-hooks-codex-pi-and-pending-edits

- [ ] `task-created` moment: wired only when a coordination finding code is blocking
- [ ] `after-tools` on `PostToolBatch` for harnesses without a shell matcher
- [ ] `before-edit`: phantom references on the pending text (in-memory check; no file written)
- [ ] Codex adapter: `PreToolUse`, `PostToolUse`, `SessionStart` (incl. compact), `SubagentStart`
- [ ] Pi extension: `tool_call`, `tool_result`, `session_before_compact`, `before_agent_start`
- [ ] Tests: payload fixture in → receipt out; invented import before the write; install round-trip for Codex and Pi
- [ ] Spec: `cli` ADD RemainingLoopMomentsReceiveReceipts
