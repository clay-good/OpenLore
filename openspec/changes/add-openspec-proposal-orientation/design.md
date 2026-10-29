# Design

## Context

The relevant input is not always the latest user message. A user may discuss a problem, explore
possible approaches, and later invoke `propose` with a short confirmation. A hook that only forwards
the current prompt to `orient` loses the agreed request; a hook that treats the entire discussion as
requirements risks promoting rejected or unchosen ideas.

OpenLore already has two useful integration patterns: Pi's `before_agent_start` event can add
context to an agent turn, and Claude Code's managed `UserPromptSubmit` hook invokes
`openlore orient --inject` for a submitted task. Codex exposes a prompt-submission hook, but OpenLore
does not currently register a Codex installer adapter. This change adds proposal-specific
preparation to Claude Code and Pi integrations and introduces the Codex adapter, including MCP
server registration so the agent can call `openlore_orient`; it does not change OpenSpec itself.

## Goals

- Ground OpenSpec proposals in both the user's intent across the conversation and repository
  structure.
- Detect the absence of an actionable request and defer proposal authoring until the user clarifies.
- Keep unresolved alternatives and constraints visible without inventing decisions.
- Support Claude Code, Pi, and Codex through OpenLore-owned integrations.
- Preserve a usable path when structural orientation cannot run.
- Reduce Pi's default standing context cost by removing the repeated repository-wide digest and
  spec-domain index while retaining an opt-in full-context mode.

## Non-Goals

- Changing OpenSpec commands, formats, or upstream behavior.
- Inferring user intent from repository structure or deciding between unresolved alternatives.
- Automatically creating a proposal after an exploratory conversation with no actionable request.
- Making `orient()` mandatory for every agent prompt; this behavior is scoped to proposal workflows.
- Redesigning Pi's registered tool schemas or the approximately 3,100-token lean tool-surface
  budget; this change removes the repeated architecture digest, not tool definitions.

## Decisions

### 1. The hook triggers preparation; the agent synthesizes intent

Client hooks should identify the OpenSpec `propose` invocation and inject a short instruction. The
agent, which already has the conversation context, writes a brief containing: requested outcome,
accepted decisions, constraints, and open questions. The hook must not attempt to parse or
reconstruct the full transcript itself.

The brief is actionable only when the conversation contains a concrete user request or an explicit
user acceptance of a proposed direction. Exploration, questions, and assistant-authored options do
not count as acceptance. If no actionable request is present, the agent asks for clarification and
does not create the change artifacts.

### 2. Orient against the brief before authoring

For an actionable brief, the agent calls `orient()` before writing the proposal, spec delta, design,
or tasks. The call is task-scoped to the brief; its bounded structural evidence informs scope,
affected domains, and implementation impact. It cannot settle an open product decision or override
an explicit user constraint.

### 3. Keep orientation failure non-blocking and visible

If no analysis index is available or orientation otherwise cannot provide evidence, the workflow
continues from the actionable brief. The proposal must disclose that structural orientation was
unavailable rather than implying repository-grounded analysis.

### 4. Integrate at the client boundary

Claude Code can use its managed `UserPromptSubmit` hook and existing `orient --inject` path, extended
to detect proposal workflow invocation and provide the proposal-specific instruction. Pi can use its
existing extension hook. Codex needs an OpenLore-managed prompt-submission hook and MCP-server
registration in its installer/detection support so the agent can run `openlore_orient`. Codex hook
trust and activation remain governed by Codex; OpenLore does not bypass that consent boundary. Other
existing client behavior remains unchanged.

### 5. Make Pi context on-demand by default

Pi currently appends the repository architecture digest (up to 8,000 characters) and the
spec-domain index to the system prompt on every turn. The default becomes `on-demand`: omit those
standing repository summaries and rely on the existing `openlore_orient` tool for task-specific
structural evidence. The `.openlore/config.json` setting `pi.contextMode: "full"` restores the
existing digest-plus-index injection. When a `propose` invocation is recognized, inject only the
short proposal-preparation instruction; the agent synthesizes intent from the conversation and
calls `openlore_orient` with that brief. A one-time session primer is not the default because it
would remain in later conversation context.

### 6. Do not modify OpenSpec core

OpenLore owns the agent integration and structural orientation. OpenSpec's command, templates, and
runtime need no change for this behavior.

## Risks / Trade-offs

- **Proposal trigger is not visible in a client hook** → confirm each client's event payload and
  detect only supported OpenSpec command/invocation forms; do not run proposal preparation on
  unrelated prompts.
- **Agent misclassifies an exploratory option as accepted** → explicitly require user-originated
  intent or user assent in the injected instruction and ask when ambiguous.
- **No analysis artifacts are present** → continue without orientation and disclose the limitation.
- **Codex hooks require trust/activation** → installation can register the hook, but the user must
  accept the client's trust mechanism before it runs.
- **On-demand Pi context depends on the model invoking orientation** → keep the existing orient-tool
  guidance prominent and let users opt back into the full digest when they prefer passive context.

## Migration Plan

Additive. Claude Code gains proposal-specific behavior through its existing integration. Pi changes
to on-demand standing context by default, with the previous full context behavior available through
an explicit setting. Codex becomes a detected and installable client surface. No OpenSpec core files
are migrated. Uninstall removes only hook entries owned by OpenLore, following the existing
managed-install ownership rules.
