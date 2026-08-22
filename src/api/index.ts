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
export { OpenLoreError, errors, isOpenLoreError } from '../utils/errors.js';
export type { ErrorCode, ApiErrorCode } from '../utils/errors.js';
