# Proposal

## Why

Autopilot governance exists: `auto-approved` status, an append-only ledger, and `decisions log` /
`decisions review` (PR #223). But it runs only at the pre-commit gate, which only an explicit
`openlore install` writes. Every repository reached by user-scope auto-init has no gate, no
`governance` block and no LLM key, so:

- A decision an agent records (`openlore decisions record`, any preset) stays `draft` forever.
  Consolidation and verification call an LLM and run only at the gate.
- Nothing is accepted, synced or shown. `openlore status` has no governance section.

The user's goal is "auto-accept, but let me see what was accepted."

## What Changes

- **Default autopilot.** An absent `governance.autopilot` means *on* for a repository OpenLore
  auto-initialized, and stays *blocking* for one where a human installed a blocking gate (today's
  rule, unchanged). `governance.autopilot: false` opts out.
- **Accept on record, no gate needed.** Under autopilot, a decision recorded with a title and
  rationale moves straight to `auto-approved`, with actor `agent`, a timestamp and HEAD. It is
  written to the ledger and synced to specs in the background. The agent that recorded it is the
  LLM in the loop, so nothing in the background needs a key. Deterministic checks only: anchored
  files exist, and a `--supersedes` target is live.
- **The trace is visible without asking:**
  - `openlore status` gains a governance block (mode; auto-accepted count, unreviewed count, last
    three ledger entries).
  - The Claude Code status line and Pi footer show the unreviewed count.
  - The session primer names new auto-accepts since the last session, in one line.
- **Review stays one command:** `openlore decisions review` (promote or reject). A rejection retires
  the spec text and is never re-accepted (existing rule).
- **Agent guidance** in the managed CLAUDE.md/AGENTS.md block tells agents to record significant
  design choices with `openlore decisions record`.

## Capabilities

### Modified Capabilities

- `cli`: adds `AutopilotIsTheDefaultForAutoInitializedRepositories`, `AWorktreeFollowsTheMainCheckoutsGovernance`,
  `RecordedDecisionsAreAcceptedWithoutAGate`, `GovernanceTraceIsVisibleWithoutAsking`.

## Impact

- Code: `src/cli/commands/decisions.ts` (record path), `src/core/decisions/ledger.ts` (actor
  `agent`), `src/cli/commands/status.ts`, the status line and Pi footer renderers, the
  managed guidance block.
- No git hook is written by auto-init (`AutoInitIsConsentGuarded` unchanged). No new MCP tool.
- Relation: `add-agent-loop-hook-surfaces` and `add-session-handoff-briefing` push receipts into the
  agent loop; this change is about decisions and the human-facing trail, and does not depend on them.
