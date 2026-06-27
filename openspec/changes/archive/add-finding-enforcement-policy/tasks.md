# Tasks — finding enforcement policy

> Status: IMPLEMENTED 2026-06-23. Adjustments from build: the policy lives in a dedicated
> `enforcement-policy.ts` module (a `FINDING_CODE_REGISTRY`, not `tool-contract.ts`) and `readOpenLoreConfig`
> was left untouched (a tolerant `normalizeEnforcementPolicy` consumes the raw block, matching how
> `blastRadius`/`impactCertificate` are read) — surgical, no entanglement. The unified gate is a new
> `openlore enforce` command. One scoped deferral noted under C.

## A. Unified enforcement policy (config + resolver)

- [x] Extend `OpenLoreConfig` with an optional `enforcement.policy` map (`code → blocking | advisory | off`);
      a tolerant `normalizeEnforcementPolicy` degrades absent/empty/malformed to "no policy" without
      throwing → verified: `enforcement-policy.test.ts`.
- [x] Emit a non-failing config finding for a policy entry whose code no installed source emits
      (`unknownPolicyCodes`) → verified: unknown-code retained, surfaced in the gate JSON, no throw.
- [x] Add a pure `resolveEnforcementClass(code, policy, severity)` helper with precedence
      `off > blocking > advisory > source-default`, order-independent (precedence core exposed as
      `applyPolicyPrecedence` for direct testing) → verified: shuffled-order + each-branch unit tests.

## B. Findings carry a stable code + intrinsic severity

- [x] Register the finding codes (blast-radius orphan patterns, impact-cert per-severity surface codes,
      `stale-decision-reference`) with a source-declared default + description in `FINDING_CODE_REGISTRY`;
      emit findings in the unified `GovernanceFinding` shape → verified: registry tests.
- [x] Make the legacy per-surface `block: [...]` configs thin sugar that lowers onto the unified policy
      (`lowerLegacyBlockConfig` / `effectivePolicy`) → verified: `block: ["critical"]` and the equivalent
      `enforcement.policy` resolve identically; a direct policy entry wins over inherited sugar.

## C. `stale-decision-reference` finding

- [x] Implement a deterministic walk over the decision store + anchored memory + synced specs flagging a
      live, authoritative artifact referencing a superseded decision; supersession edge exempt
      (`findStaleDecisionReferences`) → verified: the four mcp-handlers scenarios + extras.
- [x] Surface it through `recall` (freshness-verdict `staleDecisionRef` signal; suppresses `verifiedCurrent`)
      and contribute it to the gate → verified: `recall-stale-decision-reference.test.ts`.
      **DEFERRED:** the `verify_claim` receipt clause — `verify_claim`'s claim model is structural-only and
      has no decision-reference claim to rest on; `recall` + the gate cover the surfacing intent (documented
      in the promoted mcp-handlers spec).

## D. Unified gate pass

- [x] `openlore enforce` collects findings from all in-scope sources, resolves each class via the resolver,
      fails only on a `blocking` finding, sorts by a stable key → verified: unit + e2e (real git pre-commit
      blocks under `stale-decision-reference: blocking`, passes with no policy).
- [x] List `off`-classed findings as informational, distinct from advisory → verified: `off` finding
      appears marked silenced and does not fail the gate.

## E. Docs + drift

- [x] Documented `enforcement.policy` + the finding-code catalogue in `docs/configuration.md`, and
      `openlore enforce` in `docs/cli-reference.md`; promoted the spec deltas into
      `openspec/specs/{config,mcp-handlers,cli}/spec.md`; ran spec drift before PR.
- [x] Noted in `CLAUDE.md` that a new governance finding must register a stable code in
      `FINDING_CODE_REGISTRY` (mirrors the `tool-contract.ts` classification gate).

## Decisions (per project CLAUDE.md)

> The `record_decision` MCP tool is not in the active lean tool surface this session, so the two design
> choices are captured here + in the promoted spec decision notes rather than via the MCP gate.

- [x] Unified enforcement policy shape (`code → class`) + precedence `off > blocking > advisory > default`,
      superseding the per-surface `block: [...]` configs (which lower onto it).
- [x] `stale-decision-reference` as a deterministic finding over the decision graph, supersession edge
      exempt, orphaned/invalidated memories excluded from "authoritative".
