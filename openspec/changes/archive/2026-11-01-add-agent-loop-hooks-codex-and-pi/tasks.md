# Tasks — add-agent-loop-hooks-codex-and-pi

- [x] Codex adapter: `PreToolUse` and `PostToolUse` (`apply_patch`, `Bash`), `Stop`, `SessionStart` (`compact`) in `.codex/hooks.json`
- [x] `openlore hook`: `apply_patch` payloads name the patched files; `--harness codex` prints `{}` from a silent Stop
- [x] Tests: install/uninstall round-trip keeps user hooks; malformed event left alone; patch parsing; generated-file fact on a Codex patch
- [x] Spec: `cli` ADD CodexReceivesLoopReceipts
- Moved to `add-agent-loop-hooks-pi-and-task-created`: Pi extension, task-created moment, PostToolBatch, Codex sub-agent start
