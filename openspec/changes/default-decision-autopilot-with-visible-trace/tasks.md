# Tasks

## 1. Mode and record path

- [ ] 1.1 Resolve the default mode from how the repository was set up (auto-init vs explicit gate). Verify with tests for absent, true, false and gated.
- [ ] 1.2 Under autopilot, `decisions record` writes `auto-approved` plus a ledger entry (actor `agent`) and starts a background sync. Verify with no API key and no git hook.
- [ ] 1.3 Keep a decision that fails a deterministic check as `draft`, with the reason. Never re-accept a human rejection.

## 2. Trace

- [ ] 2.1 Add a governance block to `openlore status` (text and `--json`).
- [ ] 2.2 Show the unreviewed count in the Claude Code status line and Pi footer.
- [ ] 2.3 Add a one-line "auto-accepted since last session" to the session primer.
- [ ] 2.4 Tell agents to record decisions with `openlore decisions record` in the managed guidance block.

## 3. Verification

- [ ] 3.1 Dogfood on an auto-initialized clone: record a decision, see it in `status`, the status line, `decisions log` and the spec, then reject it with `decisions review`.
- [ ] 3.2 Run `npm run test:unit`, lint and typecheck.
