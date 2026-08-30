# Enforcement in the agent loop: a Stop-hook gate with remediation-first findings

> Status: PROPOSED (2026-07-03, e2e audit pass 3). Governance findings today reach an agent only
> at commit time (git pre-commit) or PR time (review action) — after the turn that introduced the
> violation is long over. Package the SAME finding set into the agent loop: an
> `openlore enforce --agent-hook` mode shaped for Claude Code Stop/PostToolUse hook semantics,
> plus a source-declared `remediation` template per finding code so the message tells the agent
> what to DO, not just what is wrong. Prior art: the now-documented tsarch/Sheriff Stop-hook
> pattern (https://www.angulararchitects.io/en/blog/architecture-beyond-layers-tsarch-for-ai-agents/) —
> the convergent finding that rules belong in deterministic checkers wired into the agent's turn.

## The gap

- **The gate fires after the loop, not in it.** `openlore enforce --hook` is a *git pre-commit*
  mode: stderr rendering, exit 1 on a blocking-classed finding (`src/cli/commands/enforce.ts:289-296`,
  option at `:324`). Claude Code's own hook surface (Stop/PostToolUse) has a different contract —
  exit 2 blocks and feeds stderr back to the model; exit 1 is a non-blocking error — so the
  existing mode cannot be wired into the agent loop as-is, and nothing else can. An agent that
  violates a declared policy learns about it turns later, at commit, when the fix is expensive.
  The advisory-safety discipline to reuse is already proven in
  `openlore impact-certificate --hook`: a throw or infrastructure failure NEVER blocks
  (`src/cli/commands/impact-certificate.ts:162-173`), human rendering goes to stderr (`:179`),
  and blocking is opt-in config (`:183-198`).
- **Findings state conclusions, not actions.** `GovernanceFinding` is
  `{ code, severity, source, subject, message }` (`enforcement-policy.ts:47-58`); the registry
  entry carries only `defaultClass`/`source`/`description` (`FindingCodeSpec`, `:75-79`). A
  message like "the change orphans 2 anchored memories" tells the agent what happened; the
  agentic-patterns feedback requirement is a message the agent can *act on* ("re-anchor or
  supersede memory X; see recall") — and nothing in the shape can carry it.
- **The installer plumbing already exists but is unused for this.** `openlore setup` writes
  Claude Code hooks into `.claude/settings.json` with an idempotent merge and a corrupt-settings
  refusal (`readClaudeSettings` + `CorruptSettingsError`, `src/cli/commands/setup.ts:306-324`;
  `installPanicCheckHook`, `:327`). The enforcement gate has no such wiring.

## What changes

1. **`openlore enforce --agent-hook`** (`src/cli/commands/enforce.ts` — a sibling mode to the
   existing git `--hook`, which is unchanged): runs the SAME pipeline —
   `collectGovernanceFindings` (`enforce.ts:190-237`) + `classifyFindings` (`enforce.ts:272`) —
   and emits a concise, remediation-first rendering shaped for the agent loop. Exit-code contract
   per Claude Code hook semantics: exit 0 when nothing blocks (advisory findings summarized, one
   line each); exit 2 with the remediation-first findings on stderr ONLY when a finding resolves
   to `blocking` via `enforcement.policy`. The impact-certificate discipline is reused exactly:
   any throw or unavailable source degrades to a caveat and exits 0 — an infrastructure failure
   never blocks the agent's turn.
2. **Installer wiring, on request.** `openlore setup` gains an opt-in flag to register the
   agent-hook as a Stop (or PostToolUse) entry in `.claude/settings.json`, reusing
   `readClaudeSettings`'s corrupt-settings refusal and the idempotent hook-entry merge
   (`setup.ts:306-324`, `:327-360`) — never clobbering user settings, never installed by default.
3. **A `remediation` field, source-declared and deterministic.** `GovernanceFinding` gains an
   optional `remediation: string` (`enforcement-policy.ts:47-58`), and `FindingCodeSpec` gains an
   optional per-code remediation TEMPLATE (`:75-79`) instantiated with the finding's `subject` —
   e.g. `architecture-layer-violation` → "Layer violation: {subject}; route through the declared
   interface layer instead of importing directly." Templates are static strings with subject
   interpolation: no LLM, no new constant, owned by the source like `severity`. Every renderer
   (agent-hook, git hook, `openlore review`) prints the remediation when present; a code without
   a template renders exactly as today — a remediation is never invented.
4. **Advisory-by-default unchanged.** Blocking stays opt-in via `enforcement.policy`
   (AdvisoryByDefault); the agent-hook adds a delivery channel, not authority.

Cross-references: `widen-architecture-rule-vocabulary` supplies the finding codes that benefit
most from remediation templates (its five new rule kinds each get one);
`add-enforcement-baseline-ratchet`'s `frozen` class composes — a frozen finding renders as frozen
(advisory, labeled) in agent-hook mode and never exits 2. `fix-commit-gate-delivery` (pass-3
sibling) is the complementary delivery fix at the git layer: it makes the pre-commit gate actually
reachable under `core.hooksPath` managers, while this change adds the in-turn agent channel — the
two do not share code paths beyond the installer plumbing.

## Why this is in scope

The enforcement machinery (registry, resolver, gate, review action) is built and deterministic;
what is missing is delivery at the moment the agent can still act cheaply. Both borrows are pure
packaging of existing computation — same findings, same policy, a new exit-code contract and a
static template field — local, no LLM, no new tuning constant, and doctrinally conservative
(advisory-by-default untouched, installer opt-in, corrupt-settings refusal reused).

## Impact

- Files: `src/cli/commands/enforce.ts` (agent-hook mode + remediation rendering),
  `mcp-handlers/enforcement-policy.ts` (optional `remediation` on the finding shape + template on
  `FindingCodeSpec`), `src/cli/commands/setup.ts` (opt-in Stop-hook wiring via the existing
  settings plumbing), `review.ts` rendering (print remediation when present); tests.
- Specs: `cli` — 1 ADDED requirement (AgentLoopEnforcementHook); `mcp-quality` — 1 ADDED
  requirement (RemediationFirstGovernanceFindings).
- Tool surface: unchanged (no new MCP tool, no tools/list payload-budget impact — this is a CLI
  mode plus a registry field).
- Risk: exit-code contract drift if Claude Code hook semantics change (mitigated: the contract is
  pinned in one function with a test, and the hook is opt-in); noisy Stop-hook on advisory-heavy
  repos (mitigated: advisory findings render as a one-line-each summary, and the ratchet sibling
  provides the freeze path).
