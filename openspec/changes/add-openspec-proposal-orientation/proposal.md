# Orient OpenSpec proposals from conversation intent and repository structure

## Why

An OpenSpec `propose` workflow can start after a long discussion in which the actual request is
implicit in earlier turns. The latest prompt may be only “propose it,” and may follow an `explore`
that discussed options without settling on any action. Treating that last prompt as a complete
request can produce a proposal that invents intent, turns an unaccepted suggestion into a decision,
or misses the repository architecture that should shape the change.

OpenLore already provides structural orientation and has agent-specific integration points. It can
prepare the proposal workflow with both a careful summary of the conversation and relevant
repository evidence, before OpenSpec writes change artifacts.

## What Changes

- When an OpenSpec `propose` workflow is invoked, OpenLore instructs the agent to derive a concise
  change brief from the conversation: the user's requested outcome, explicitly accepted decisions,
  constraints, and unresolved questions.
- The agent distinguishes a concrete request from exploration. Questions, options, and assistant
  suggestions do not become user requirements unless the user accepted them. If no actionable
  request can be recovered, the agent asks one focused clarification and does not create proposal
  files yet.
- For a clear request, the agent calls OpenLore `orient()` with the brief before authoring the
  proposal. The resulting structural evidence informs the proposal and its spec delta; it does not
  decide product questions or replace user intent.
- **Claude Code:** extend OpenLore's existing managed `UserPromptSubmit` hook and
  `openlore orient --inject` path so a `propose` invocation receives the conversation-brief
  instruction and task-scoped structural orientation.
- **Pi:** default to on-demand context instead of reinjecting the repository-wide architecture
  digest and spec-domain index on every turn. Keep a concise proposal instruction for recognized
  `propose` invocations and use `openlore_orient` with the conversation brief for task-specific
  evidence. Preserve the current full digest injection as an opt-in through
  `.openlore/config.json` (`pi.contextMode: "full"`).
- **Codex:** add an OpenLore-managed prompt-submission hook adapter and register the OpenLore MCP
  server so the agent can call `openlore_orient`; installation and trust follow Codex's own rules.
- OpenSpec core and its command implementation remain unchanged.

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `openspec`: prepare proposal workflows from explicit conversation intent and OpenLore structural
  orientation, while stopping for clarification when no concrete request is present.
- `cli`: make Pi's standing repository context on-demand by default, while retaining full digest
  injection as an opt-in.

## Impact

- **Claude Code:** extend the existing `UserPromptSubmit` / `openlore orient --inject` integration
  with proposal-specific intent synthesis and orientation.
- **Pi:** make `before_agent_start` omit the repeated architecture digest and spec-domain index by
  default, retain them under an explicit full-context setting, and inject only the concise
  proposal-preparation instruction for recognized proposal invocations. The OpenLore tool surface
  itself is unchanged by this change.
- **Codex:** add a supported hook and MCP-server adapter to OpenLore's installer/detection surfaces;
  users must trust or approve the configured hook as Codex requires.
- `openspec` spec delta defines when to orient, when to ask for clarification, and how to preserve
  unresolved decisions.
- No OpenSpec upstream change, no autonomous choice among alternatives, and no proposal files
  written when the conversation contains only exploration.
- If the repository has no usable OpenLore analysis index, the workflow remains available and
  proceeds without structural evidence, explicitly disclosing that orientation was unavailable.
