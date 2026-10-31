# Agent-loop hook surfaces: push the right receipt at each point in the loop

> Status: PROPOSED (2026-10-31, `CONTRACT-GRAPH-AND-AGENT-LOOP-2026-10.md`). Wire OpenLore's
> deterministic receipts into the harness events that exist in 2026, so the agent gets them without
> having to think of calling a tool. No new MCP tool.

## The gap

`openlore install` wires two context points for Claude Code (`SessionStart` → whole-repo primer,
`UserPromptSubmit` → task-scoped `orient --inject`) and one for Codex (`UserPromptSubmit`). The opt-in
panic `PreToolUse` gate is separate (`openlore setup --hooks`). Everything else OpenLore computes is pull-only: an agent benefits
only if it calls `verify_change`, `recall`, or `blast_radius` at the right moment. Research is
consistent that agents do not reliably self-check, and that the most useful feedback is the one that
arrives at the moment the agent can still act on it.

The harnesses now expose those moments (verified 2026-10-31):

| Moment | Claude Code | Codex | Pi |
|---|---|---|---|
| before an edit | `PreToolUse` on edit/write tools (injects) | `PreToolUse` (injects) | `tool_call` |
| after a batch of tool calls | `PostToolBatch` (injects context) | `PostToolUse` (injects) | `tool_result` |
| after compaction | `SessionStart` matcher `compact` (injects; `PreCompact` cannot inject) | `SessionStart` | `session_before_compact` / `context` |
| before stopping | `Stop` (injects or blocks), `TaskCompleted` (blocks) | `Stop` (block only) | `agent_end` |
| sub-agent / teammate start | `SubagentStart` (injects) | `SubagentStart` (injects) | `before_agent_start` |
| a team task is created | `TaskCreated` (blocks) | — | — |

Sources: https://code.claude.com/docs/en/hooks, https://learn.chatgpt.com/docs/hooks,
https://pi.dev/docs/latest/extensions.

## What changes

`openlore install` wires, per harness and only where the event can inject context, one OpenLore CLI
command per moment. Each command prints one budgeted receipt and exits 0. The one block-only moment
(team task created) is wired only when a team has made a coordination finding blocking.

| Moment | Receipt (all deterministic, all already specified elsewhere) |
|---|---|
| before an edit | the pending edit is turned into a patch (from the tool input) and graded in memory by `verify_change`, limited to the fast families: phantom references and generated-file edits — the agent sees "`formatDate` is not exported by `packages/utils`" before the write |
| after tools | the session ledger's new facts (background change to a served symbol, a peer's change, edit oscillation, test runs seen — `add-session-structural-ledger`); for the files just edited: check weakening and the rest of `verify_change`, scoped to those files |
| after compaction | the handoff briefing (`add-session-handoff-briefing`): in-flight symbols, decisions and memories in scope, open findings, tests still to run |
| before stopping | the definition-of-done receipt: `verify_change` over the session's diff, plus "symbols changed after the last test run, and the tests that reach them" (ledger) |
| sub-agent start | a task-scoped `orient` for the sub-agent's prompt, plus peers' live footprints (`add-peer-footprint-board`) |
| team task created | only when `enforcement.policy` makes `parallel-work-conflict` or `duplicate-intent` blocking: the hazards between the new task and live peer footprints, as a block with the hazards listed (the event cannot inject context, so there is no advisory form) |

Rules for every hook:

- **Silent when there is nothing new.** A receipt with no new item prints nothing. A fact already
  delivered in this harness session is not repeated. Hooks are separate processes, so delivered facts
  are recorded keyed by the payload's `session_id` (no `session_id` → no dedupe, disclosed in
  `status`).
- **Budgeted.** A per-moment token cap; truncation counted, highest severity kept (the `orient`
  budgeting discipline).
- **Advisory and fail-open.** Exit 0 by default. A timeout or error always prints nothing, exits 0,
  and is logged — with or without a blocking policy. Blocking (`Stop`, `TaskCompleted`, `TaskCreated`) is available only when a team names
  finding codes as blocking in `enforcement.policy` — the same opt-in `openlore enforce` uses — and
  then the block message lists the findings and their next actions.
- **Neutral wording.** The hook adds no imperative of its own (decision 8e95746d). A receipt's
  `nextAction` fields are carried as labeled data (`next action: …`), the same field a pull call
  returns; `verify_change` next actions are worded as the check or file concerned, not as orders.
- **Per-moment opt-out** in `.openlore/config.json` (`hooks.<moment>: false`), shown by
  `openlore status`.
- **Command hooks, not `mcp_tool` hooks.** One CLI per moment works across all three harnesses and at
  launch (Claude Code skips `mcp_tool` hooks at launch-time `SessionStart`).

## Not built

OS-level interception, command jails, or rewriting tool inputs; any LLM call in a hook (no
prompt-type hooks); auto-running tests; Cursor and Gemini CLI wiring (their hooks are IDE-only or
changing — revisit when stable).

## Impact

- Files: install adapters (Claude Code, Codex, Pi), one CLI entry per moment (`openlore hook
  <moment>` reading the harness payload from stdin), patch construction from edit-tool inputs,
  delivered-fact dedupe keyed by the harness `session_id`, config keys, `status` output, docs
  (`agent-setup.md`).
- Specs: `cli` — 2 ADDED.
- Depends on (each moment ships when its receipt ships): `add-session-structural-ledger`,
  `add-session-handoff-briefing`, `add-verification-feedback-loop`, `add-phantom-reference-findings`,
  `add-generated-file-guard`, `add-check-weakening-findings`, `add-peer-footprint-board`.
- Risk: noise (mitigated: silent-when-empty, dedupe, budgets, per-moment opt-out); latency on every
  edit batch (mitigated: scoped to the edited files, hash-keyed parse memo, hard timeout, fail-open).
