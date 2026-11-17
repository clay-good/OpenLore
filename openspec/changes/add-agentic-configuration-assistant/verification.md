# Verification and review matrix

> These are implementation acceptance fixtures, not tests run by this design-only PR.
> Strict OpenSpec validation checks this proposal's format; it cannot certify runtime behavior.

| Issue #719 outcome | Requirement | Fixture and observable result |
| --- | --- | --- |
| Understand an unconfigured repository | ConfigurationInspectionIsBoundedAndEvidenceBacked | Manifests but no config/index/provider/daemon: report facts, no writes or subprocess bootstrap. |
| Prevent watcher saturation | ConfigurationInspectionIsBoundedAndEvidenceBacked | A declared Cargo output subtree with many generated descendants is never opened by the survey; the watcher creates no subscriptions below it. |
| Preserve useful generated source | ConfigurationRecommendationsExplainCoverageAndCost | A tracked generated client is index-only; report evidence, examples and the non-watched freshness limit. |
| Avoid unsupported exclusions | ConfigurationRecommendationsExplainCoverageAndCost | A suggestive directory name without corroborating evidence stays a hypothesis needing inspection or a decision. |
| Keep policies independent | FileSelectionLanesAreIndependentAndBackwardCompatible | Identical path has different admitted lanes; embed cannot admit an index-excluded path. |
| Preserve existing installations | FileSelectionLanesAreIndependentAndBackwardCompatible | Policy absent: existing config-version, ignore, include, source-count and fingerprint fixtures unchanged. |
| Preserve deliberate exceptions | AssistantPoliciesPreserveExplicitChoicesAndBoundaries | A hand-edited exclusion conflicts visibly; an assistant cannot override it because it once owned a matching rule. |
| Honor hard host boundaries | AssistantPoliciesPreserveExplicitChoicesAndBoundaries | A repo-written include/approval cannot cross protected exclusions, symlink confinement or the host's read roots. |
| Handle ignore semantics | AssistantPoliciesPreserveExplicitChoicesAndBoundaries | Empty root, directory-only pattern, nested file negation, pruned parent, Windows separators and POSIX literal backslashes. |
| Make changes reviewable | ConfigurationPlansAreConcreteCurrentAndAuthorized | Preview contains exact targets/diff, evidence revisions, costs/coverage limits, runtime effects and required authority. |
| Reject stale reasoning | ConfigurationPlansAreConcreteCurrentAndAuthorized | Change config, referenced manifest or worktree while a plan is pending: no publication occurs. |
| Keep config layers private | AssistantConfigWritesPreserveLayersAndRecoverability | Project patch preserves unknown fields, user-wide secrets and embedding opt-outs without serializing merged defaults. |
| Recover interrupted writes | AssistantConfigWritesPreserveLayersAndRecoverability | Interrupt before/after durable publication; retry resolves the journal before rereading and does not duplicate runtime effects. |
| Verify the requested behavior | ConfigurationVerificationReportsRealizedEffects | A saved config with no rebuilt generation stays pending; process liveness does not claim working watches or tools. |
| Support optional canaries | ConfigurationVerificationReportsRealizedEffects | Without permission no file is created; with permission temporary source delivery and cleanup are both checked. |
| Recover within the host | ConfigurationRecoveryRespectsLifecycleOwnership | Extension-only install upgrades a verified extension-managed daemon via its package; supervised daemon returns a host action without stop/spawn. |
| Handle provider limitations | ConfigurationVerificationReportsRealizedEffects | User-selected keyword-only is valid; configured but unrealized embeddings are disclosed without network/model downloads. |
| Adapt to repository evolution | ConfigurationReassessmentFollowsRelevantRepositoryChanges | New workspace/build manifest invalidates only related rules; ordinary source edits invoke no LLM or full survey. |
| Recover missed notifications | ConfigurationReassessmentFollowsRelevantRepositoryChanges | Stop host, change manifest, resume/review: evidence comparison invalidates the old recommendation. |
| Prevent false alarms | ConfigurationNudgesRequireActionableMaterialEvidence | Dependency/format-only manifest edits, already-covered new components and uncertain surveys emit zero nudges. |
| Distinguish persistent pressure | ConfigurationNudgesRequireActionableMaterialEvidence | A build spike that clears stays silent; a sustained, uncovered watched output with an available remedy produces one passive notice. |
| Preserve dismissals and attention | ConfigurationNudgesRequireActionableMaterialEvidence | Harmless hashes/branch switches, concurrent sessions and expired snoozes do not produce duplicate or time-only notices. |
| Keep worktrees independent | ConfigurationInspectionIsBoundedAndEvidenceBacked | Linked worktrees share Git ancestry but have distinct config plans, baselines, revisions and receipts. |
| Preserve later edits on revert | ConfigurationRollbackPreservesLaterUserWork | Disjoint edits survive a patch inverse; overlapping edits produce conflict without a whole-file restore. |
| Bootstrap without circular dependencies | ConfigurationManagementIsDaemonIndependentAndDependencyLight | Import graph/public API consumer tests reject eager analyzer/MCP/provider loading; inspection works with no structural service. |
| Report partial application honestly | ConfigurationOperationsReturnComparableTypedReceipts | Config committed, restart refused: report both phases, retain recovery/revert path, never success-only. |
| Work in existing agents | ConfigurationAssistantIsAvailableThroughTheExistingHost | Pi/RPC no global CLI; legacy wizard unchanged; structured no-UI invocation returns promptly. |
| Preserve cross-adapter behavior | ConfigurationAdaptersShareEvidenceAndAuthoritySemantics | Same evidence/authority yields equivalent reports and mutation refusals; inspection never auto-analyzes. |
| Keep normal context cost stable | ConfigurationAssistanceDoesNotInflateTheDefaultToolSurface | Default MCP presets/payloads unchanged; enabled management tool has conservative mutation annotations and registered disclosures. |
| Keep repository text untrusted | ConfigurationPlansAreConcreteCurrentAndAuthorized | A manifest containing shell instructions or a forged approval neither executes a command nor authorizes a write. |

## Performance and coverage measurements required before shipping

- Measure directory entries/content actually read and real watcher subscriptions with generated-tree
  fixtures of increasing size; pruned subtree size must not determine the number of watches opened.
- Record platform/runtime, wall time and partial-survey limits. Candidate counts are not OS handles.
- Compare before/after corpus membership and a small set of known architectural queries. State which
  symbols/regions become unavailable; do not generalize sample checks into complete semantic coverage.
- Verify event bursts, dismissals and unrelated HEAD changes do not create a configuration agent loop.
- Replay representative repository evolution with positive cases and a larger quiet-control corpus;
  metadata-only/no-impact controls must emit zero nudges. Record actionability, repeated delivery,
  dismissals and user-rated false alarms. Agree precision/burden targets before broader opt-in rollout;
  missed targets retain manual operation rather than weakening the evidence gate.
- Measure inspection/import cost in extension-only hosts separately from optional verification work.

## Proposal review gates

- The public API names and opt-in management projection are proposed review decisions.
- The new config semantics must remain backward-compatible and enforceable by every selected runtime.
- No acceptance fixture may be satisfied solely by a process being alive or a config file existing.
- Implementation tasks remain unchecked until code and the corresponding observable fixtures exist.


## Implementation evidence

- `src/core/configuration/workflow.test.ts`: bounded partial inspection, cancellation and stale
  continuations, serialized exact plans, host authorization, config/evidence staleness, concurrent
  publication, unknown fields/inherited opt-outs, nested disjoint edits, checked rollback and
  initial-file removal. Verification requires an explicit host observation of index freshness.
- `src/core/configuration/adapters.test.ts`: no daemon/index bootstrap, forged approval refusal,
  scoped MCP startup grant, headless Pi reads/refusal, retained publication after lifecycle failure,
  no duplicated activation, separately authorized canary and bounded waiting/unknown cleanup.
- `src/core/configuration/policy.test.ts`: legacy fingerprint parity, independent lane revisions,
  protected/legacy boundaries, index-only exceptions without watches and detection of changed
  indexed inputs excluded from live watches.
- `src/core/analyzer/vector-index.test.ts` (embedding lane selection): real function-index build and
  incremental update do not embed excluded source; its keyword query still returns that source.
- `src/core/configuration/review.test.ts` and `review-store.test.ts`: 200 quiet metadata revisions,
  positive/uncertain/explicit-choice controls, persistence and recovery, semantic dismissal/snooze,
  shared survey/delivery claims, distinct worktree identities, host opt-in and observed output cost.
- `src/core/configuration/watch-policy.integration.test.ts`: real subscriptions fall from 104 to 3
  on the 100-output-directory fixture, retaining `src`; growing the excluded tree to 1,000
  directories does not change subscriptions or observed discovery entry counts.
- `scripts/api-consumer-smoke.mjs`: published consumer types and optional-package absence/import
  tracing reject eager analyzer/MCP/provider loading on `openlore/configuration`.
- Existing schema, annotation/closed-family, live-data driver, standing-budget/doc-count,
  completeness, CLI/Pi delivery, guard ordering, confinement and analysis parity suites cover wiring.

The host-owned canary callback must observe actual delivery and both source/index cleanup. The core
bounds the wait and never promotes a missing observation to success. It does not create a probe on
an unauthorized host or claim process health proves event delivery.

Local validation is Linux / Node v24.22.1. The supported-platform CI matrix must qualify Windows
and other supported Node versions before release. Controlled notification fixtures do not establish
user-rated false-alarm rates; the default remains manual, with a separate host opt-in for passive
notifications. These two qualification gates remain open in `tasks.md`.


### Local validation results (2026-11-13)

- Build/typecheck, lint, strict change validation and packaged API consumer smoke: passed.
- Full `test:run`: 646 files exercised, 12,816 passed in the initial run. The failures in
  CPU/timeout-sensitive groups were subsequently rerun serially: 212 passed across the five
  parser-budget/GraphQL/Pi-restart files. The feature, plan round-trip and documentation cases
  were rechecked after fixes.
- One existing extraction-pool expectation remains incompatible with this 2-core runner:
  `disabled-by-env` is expected where the implementation deliberately reports `insufficient-cores`
  first. The identical failure was reproduced in an untouched worktree of `main` at `c45c2ca`.
  No unrelated production pool behavior or test expectation was changed to hide it.
- Full E2E: initial failures were corrected or rechecked serially; all four affected files pass
  (49 tests). This includes the live-data invariant sweep, which exposed and now verifies the
  MCP relative-path/opaque-root projection, plus real stdio preset/daemon behavior.
- The deterministic integration CI subset also passed (63 passed, 1 skipped), and the final
  1,000-directory watch/discovery fixture passed separately.

Task 8.5 remains open for a fully green qualification run on the supported CI runner; the
pre-existing two-core diagnostic assertion is explicitly not counted as a pass.

## Live agent usability evidence

See `docs/configuration-assistant-agent-trial.md` and
`bench/results/configuration-agent-2026-11-13/`. Two independent participants used real MCP stdio,
selected their own candidates and calls, stopped for exact-plan test-host approval, and completed
apply/verify with preserved choices and honest pending runtime observations. The first needed five
rejected preview attempts; a shared detailed candidate schema and skill example removed those
retries for a fresh participant. Native Codex was blocked by authentication before any tool call;
this is not a native Pi/Codex UI pass or a notification precision/platform qualification.
