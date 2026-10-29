# Tasks

## 1. Proposal intent preparation

- [ ] 1.1 Define the injected instruction for deriving requested outcome, accepted decisions,
      constraints, and unresolved questions from the conversation
- [ ] 1.2 Define the actionable-request check; exploration, questions, and assistant suggestions
      without user assent must lead to clarification before proposal files are created
- [ ] 1.3 Ensure the brief is passed to `orient()` before proposal artifacts are authored and that
      missing orientation evidence is disclosed without blocking an otherwise actionable request

## 2. Agent integrations

- [ ] 2.1 Extend Claude Code's managed `UserPromptSubmit` / `orient --inject` path to detect
      proposal invocations and supply the proposal-specific preparation instruction
- [ ] 2.2 Add proposal-trigger detection and preparation to the Pi extension hook
- [ ] 2.3 Make Pi on-demand context the default: omit the repeated architecture digest and spec
      index, retain them under an explicit full-context setting, and inject only the short
      proposal instruction for recognized proposal invocations
- [ ] 2.4 Add Codex prompt-submission hook and MCP-server adapter; register both in OpenLore
      install/detection flows, preserving Codex trust and activation requirements
- [ ] 2.5 Verify supported OpenSpec proposal invocation forms are recognized and unrelated prompts
      remain unchanged
- [ ] 2.6 Preserve ownership-safe install/uninstall behavior for managed hook configuration

## 3. Specification and verification

- [ ] 3.1 Add the `openspec` requirements and scenarios from this change to the canonical spec
- [ ] 3.2 Verify a concise `propose` follow-up uses the earlier user request and calls `orient()`
      before creating proposal artifacts
- [ ] 3.3 Verify an explore-then-propose conversation with no concrete ask requests clarification
      and creates no proposal artifacts
- [ ] 3.4 Verify unselected alternatives remain unresolved and are not attributed to the user
- [ ] 3.5 Verify missing analysis artifacts disclose the limitation and do not block a clear request
- [ ] 3.6 Verify non-proposal prompts do not invoke proposal-specific preparation
- [ ] 3.7 Verify default Pi turns omit the standing digest and spec index, full mode restores them,
      and proposal turns receive only the concise preparation instruction
- [ ] 3.8 Run `openspec validate --strict` and the relevant Pi, Codex-install, and hook tests
