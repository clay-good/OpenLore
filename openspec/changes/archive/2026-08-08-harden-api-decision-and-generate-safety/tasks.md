# Tasks — harden-api-decision-and-generate-safety

## Implementation
- [x] Gate openloreSyncDecisions (api/decisions.ts:225-234) with the decision
      status-transition table (shared with fix-decision-status-transitions): a rejected
      decision cannot be flipped to approved via an explicit id
- [x] Remove the api-layer TLS mutation (api/generate.ts:167-172); rely on the LLM
      service-scoped sslVerify path (llm-service.ts:341-347); never key TLS on
      embedding.skipSslVerify for the whole process
- [x] Verification-evidence disclosure (api/decisions.ts:185-187, cli/commands/decisions.ts:643):
      a decision verified without a diff carries a distinct status or verificationEvidence:'none'
      surfaced by the gate/TUI
- [x] Save consolidation LLM logs (api/decisions.ts:142-149): add saveLogs().catch()

## Verification
- [x] Sync-guard test: openloreSyncDecisions({ids:['<rejected-id>']}) does NOT approve/sync it
- [x] TLS test: a config with only embedding.skipSslVerify does not set
      NODE_TLS_REJECT_UNAUTHORIZED for the process during openloreGenerate
- [x] Evidence test: consolidation in a non-git workspace labels decisions
      verificationEvidence:'none' (not an unqualified "verified")
- [x] Log test: openloreConsolidateDecisions writes an LLM log
- [x] Full suite green

## Spec
- [x] `api` delta: ADD ApiDecisionSyncRespectsStatusTransitions,
      ApiGenerateDoesNotMutateProcessTls
- [x] `verifier` delta: ADD DecisionVerificationDisclosesAbsentEvidence
