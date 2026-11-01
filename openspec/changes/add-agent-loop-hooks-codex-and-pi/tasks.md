# Tasks — add-agent-loop-hooks-codex-and-pi

- [ ] Codex adapter: `PreToolUse`, `PostToolUse`, `SessionStart` (incl. compact), `SubagentStart`
- [ ] Pi extension: `tool_call`, `tool_result`, `session_before_compact`, `before_agent_start`
- [ ] `task-created` moment: wired only when a coordination finding code is blocking
- [ ] `after-tools` on `PostToolBatch` for harnesses without a shell matcher
- [ ] Tests: payload fixture in → receipt out per harness; install round-trip for Codex and Pi
- [ ] Spec: `cli` ADD CodexAndPiReceiveLoopReceipts
