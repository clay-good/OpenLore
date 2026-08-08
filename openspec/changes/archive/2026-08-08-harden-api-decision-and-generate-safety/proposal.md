# The API's decision-sync force-approves rejected decisions, its generate disables TLS process-globally, and it stamps "verified" with no evidence

> Status: PROPOSED (2026-07-03, e2e audit pass 4). Three unsafe behaviors in the programmatic
> API's decision and generate paths, each on the public embeddable surface. The most serious
> mirrors a defect `fix-decision-status-transitions` already found on the *MCP handler* — but
> that change never mentions the API path, which has the identical bypass. Sibling to
> `align-api-layer-with-cli-core` (the fork/contract theme); this one is the trust/safety
> subset.

## The gap

- **(a) `openloreSyncDecisions({ ids })` force-approves any listed decision, rejected
  included.** `api/decisions.ts:225-234` flips any decision whose status isn't `approved` to
  `approved` in memory with no status-transition guard, and `syncApprovedDecisions` then writes
  it into `spec.md` and persists `status: 'synced'` (`syncer.ts:45-61,80`). A human rejects
  `abc12345` via `reject_decision`; any embedder calling
  `openloreSyncDecisions({ ids: ['abc12345'] })` launders the rejected verdict into the specs
  and makes it durable — the gate's own sync tool defeating the gate.
  `fix-decision-status-transitions` covers the identical bypass at
  `mcp-handlers/decisions.ts:306-310` but not this API surface; the same transition table must
  gate `openloreSyncDecisions`.
- **(b) `openloreGenerate` disables TLS verification process-globally, permanently, from the
  wrong knob.** `api/generate.ts:167-172` sets `process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'`
  — for the whole host process, never restored — and the trigger includes
  `embedding?.skipSslVerify`, so an embedding-endpoint setting disables cert validation for
  *every* HTTPS connection in the embedder's process (its own API calls included). No sibling
  API function does this; `createLLMService` already owns a deliberate, documented, LLM-scoped
  version (`llm-service.ts:341-347`), making the api-layer copy redundant.
- **(c) Decision verification silently self-affirms when no diff is available.**
  `api/decisions.ts:185-187` (and `cli/commands/decisions.ts:643`) stamps every
  LLM-consolidated decision `status: 'verified', confidence: 'medium'` when the project isn't
  a git repo or diff-building failed — "verified" with zero evidence, no disclosing flag. An
  embedder consolidating in a non-git workspace (tarball checkout) sends hallucinated
  decisions to the approve gate labeled identically to diff-verified ones. Not covered by
  `harden-llm-output-contract` (output shape) or `harden-decision-consolidation` (spawn/CAS).
- **(d) Minor: `openloreConsolidateDecisions` never saves its LLM logs.**
  `api/decisions.ts:142-149` creates the service with `enableLogging: true` but calls
  `saveLogs()` on no path (generate/verify/drift all do), so consolidation runs leave no log.

## What changes

1. **Gate `openloreSyncDecisions` with the decision status-transition table** (share the one
   `fix-decision-status-transitions` introduces): a `rejected` decision cannot be resurrected
   to `approved` via an explicit id; only a legitimate transition syncs.
2. **Remove the api-layer TLS mutation.** Rely on the service-level path keyed strictly on the
   LLM `sslVerify` setting; if a process-global effect is ever needed, scope and disclose it,
   and never key it on the embedding knob.
3. **Disclose absent verification evidence.** A decision verified without a diff carries a
   distinct status or `verificationEvidence: 'none'` surfaced by the gate/TUI, so "verified"
   always means "checked against evidence."
4. **Save consolidation logs** (add the `saveLogs().catch()` the sibling paths use).

## Why this is in scope

The decision store and the specs it feeds are the substrate's trust anchors; an API that can
launder a rejected decision into the specs, silently weaken a host's TLS, or label an
unevidenced decision "verified" undermines exactly the guarantees the governance subsystem
exists to provide.

## Impact

- Files: `src/api/decisions.ts` (transition gate, verification-evidence flag, saveLogs),
  `src/api/generate.ts` (remove TLS mutation), the shared decision status-transition table
  (with `fix-decision-status-transitions`).
- Specs: `api` — 2 ADDED (ApiDecisionSyncRespectsStatusTransitions,
  ApiGenerateDoesNotMutateProcessTls); `verifier` — 1 ADDED
  (DecisionVerificationDisclosesAbsentEvidence).
- No new tool. Risk: low — all four are behavior corrections toward safety. Verify: a rejected
  decision cannot be synced via id; an embedding-only skipSslVerify does not disable process
  TLS; a non-git consolidation labels decisions without evidence distinctly.
