# Tasks — add-agent-loop-hooks-subagents-codex-pi

- [x] `before-subagent` (PreToolUse on `Agent|Task`): queue the sub-agent's task, print nothing
- [x] `subagent-start` (SubagentStart): task-scoped `orient` for the sub-agent's own task + peers' footprints
- [x] Install/uninstall wires and removes both groups; `hooks.<moment>` opt-out
- [x] Tests: own-task briefing; parallel matching by type and order; peers listed; credentials not stored; other sessions and opt-out quiet
- [x] Spec: `cli` ADD SubagentsStartWithATaskScopedBriefing
- Moved to `add-agent-loop-hooks-codex-pi-and-pending-edits`: task-created moment, PostToolBatch, pending-text phantom references, Codex and Pi adapters
