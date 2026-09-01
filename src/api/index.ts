/**
 * openlore Programmatic API
 * change: align-api-layer-with-cli-core
 *
 * This is the public API surface for openlore. Consumers (like OpenSpec CLI)
 * can import these functions to use openlore as a library.
 *
 * @example
 * ```typescript
 * import { openloreRun, openloreDrift } from 'openlore';
 *
 * // Run the full pipeline
 * const result = await openloreRun({
 *   rootPath: '/path/to/project',
 *   onProgress: (event) => console.log(event.step),
 * });
 *
 * // Check for drift
 * const drift = await openloreDrift({ rootPath: '/path/to/project' });
 * if (drift.hasDrift) {
 *   console.warn(`${drift.summary.total} drift issues found`);
 * }
 * ```
 */

// API functions
export { openloreInit } from './init.js';
export { openloreAnalyze } from './analyze.js';
export { openloreGenerate } from './generate.js';
export { openloreVerify } from './verify.js';
export { openloreDrift } from './drift.js';
export { openloreRun } from './run.js';
export { openloreAudit } from './audit.js';
export { openloreGetSpecRequirements } from './specs.js';
export { openloreRecordDecision, openloreConsolidateDecisions, openloreSyncDecisions } from './decisions.js';
// Daemon lifecycle for supervising hosts (change: extend-api-for-supervising-hosts). The
// serve-descriptor CONTRACT is deliberately NOT re-exported here — it ships on the
// `openlore/serve-descriptor` subpath so a host can import it without loading the analyzer this
// barrel pulls in. See src/api/serve-descriptor.ts.
export { openloreServe, ServeAlreadyRunningError } from './serve.js';
export { openloreHealth } from './health.js';
export { openloreIndexState } from './index-state.js';
export { openloreAnalysisStatus } from './analysis-status.js';
export { openloreFederationList } from './federation.js';

// API option/result types
export type {
  ProgressCallback,
  ProgressPhase,
  ProgressEvent,
  BaseOptions,
  InitApiOptions,
  InitResult,
  AnalyzeApiOptions,
  AnalyzeDegradation,
  AnalyzeIndexDegradation,
  AnalyzeResult,
  GenerateApiOptions,
  GenerateDryRunResult,
  GenerateCompletedResult,
  GenerateResult,
  VerifyApiOptions,
  VerifyResult,
  DriftApiOptions,
  AuditApiOptions,
  RunApiOptions,
  RunDryRunResult,
  RunCompletedResult,
  RunResult,
} from './types.js';
export type {
  RecordDecisionOptions,
  ConsolidateOptions,
  SyncDecisionsOptions,
  ConsolidateResult,
} from './decisions.js';
export type { SyncResult } from '../core/decisions/syncer.js';

// Re-export key core types that consumers will need
export type { AuditReport, DriftResult, DriftSeverity, OpenLoreConfig, PendingDecision, DecisionStore, DecisionStatus } from '../types/index.js';
export type { RepositoryMap } from './types.js';
export type { DependencyGraphResult } from '../core/analyzer/dependency-graph.js';
export type { PipelineResult } from '../core/generator/spec-pipeline.js';
export type { GenerationReport } from '../core/generator/openspec-writer.js';
export type { VerificationReport } from '../core/verifier/verification-engine.js';
export type { SpecRequirement } from './specs.js';
export type { ServeApiOptions } from './serve.js';
export type { HealthResult, HealthIndexDegradation, HealthReasonCode } from './health.js';
export type { IndexStateResult, IndexFingerprintConfig } from './index-state.js';
export type { AnalysisStatusResult } from './analysis-status.js';
export type { FederationListResult } from './federation.js';
export type { AnalysisOwnerPayload } from '../core/runtime/analysis-ownership.js';
export type { FederationRepoEntry, ConsultedRepo, RepoIndexState } from '../core/federation/types.js';
export type { ServeHandle } from '../cli/commands/serve.js';
export { OpenLoreError, errors, isOpenLoreError } from '../utils/errors.js';
export type { ErrorCode, ApiErrorCode } from '../utils/errors.js';
