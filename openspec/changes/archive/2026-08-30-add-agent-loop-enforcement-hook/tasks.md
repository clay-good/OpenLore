# Tasks — add-agent-loop-enforcement-hook

## Implementation
- [x] `--agent-hook` mode on `openlore enforce` (enforce.ts:320-333, sibling of the git `--hook`
      at :324, which is unchanged): same collectGovernanceFindings (:190-237) +
      classifyFindings (:272) pipeline; concise remediation-first stderr rendering; exit 2 only
      when a finding resolves `blocking`, else exit 0
- [x] Reuse the impact-certificate advisory-safety discipline (impact-certificate.ts:162-173):
      any throw / unavailable source → caveat + exit 0, never a block
- [x] Optional `remediation` on GovernanceFinding (enforcement-policy.ts:47-58) and an optional
      static remediation TEMPLATE per code on FindingCodeSpec (:75-79), instantiated with the
      finding's `subject`; populate templates for the existing registry codes where a concrete
      action exists (never invent one)
- [x] Render remediation (when present) in agent-hook, git-hook (renderHuman, enforce.ts:299-318),
      and `openlore review` output
- [x] Opt-in `openlore setup` wiring: register the agent-hook as a Stop/PostToolUse entry in
      .claude/settings.json via the existing readClaudeSettings corrupt-refusal + idempotent
      merge (setup.ts:306-324, :327); never installed by default

## Verification
- [x] Exit-contract tests: blocking-classed finding → exit 2 with remediation-first stderr;
      advisory-only → exit 0 with one-line summaries; no policy declared → exit 0 always;
      injected source throw → caveat + exit 0
- [x] Remediation tests: code with template → instantiated remediation on the finding; code
      without template → message-only, no remediation field; template output deterministic
- [x] Installer tests: idempotent re-run adds one entry; corrupt settings.json → refusal, file
      untouched; uninstall removes only the openlore entry
- [x] Frozen-class composition test (with add-enforcement-baseline-ratchet, if landed): a frozen
      finding renders labeled-advisory in agent-hook mode and never exits 2
- [x] Full suite green

## Spec
- [x] `cli` delta: ADD AgentLoopEnforcementHook
- [x] `mcp-quality` delta: ADD RemediationFirstGovernanceFindings
