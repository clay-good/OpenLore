/**
 * Programmatic API types for openlore
 *
 * These types define the options and results for the openlore API functions.
 * They are designed for programmatic consumers (like OpenSpec CLI) and are
 * free of CLI-specific concerns (no process.exit, no console.log).
 */

import type { RepositoryMap as CoreRepositoryMap } from '../core/analyzer/repository-mapper.js';
import type { DependencyGraphResult } from '../core/analyzer/dependency-graph.js';
import type { AnalysisArtifacts } from '../core/analyzer/artifact-generator.js';
import type { PipelineResult } from '../core/generator/spec-pipeline.js';
import type { GenerationReport } from '../core/generator/openspec-writer.js';
import type { VerificationReport } from '../core/verifier/verification-engine.js';
import type { DriftResult, DriftSeverity } from '../types/index.js';

// Re-export core types that consumers will need
export type { CoreRepositoryMap as RepositoryMap };
export type { DependencyGraphResult };
export type { AnalysisArtifacts };
export type { PipelineResult };
export type { GenerationReport };
export type { VerificationReport };
export type { DriftResult, DriftSeverity };

// ============================================================================
// PROGRESS REPORTING
// ============================================================================

/** Progress callback for consumers to show their own UI */
export type ProgressCallback = (event: ProgressEvent) => void;

export interface ProgressEvent {
  /** Which phase is reporting: 'init' | 'analyze' | 'generate' | 'verify' | 'drift' */
  phase: string;
  /** Human-readable step description */
  step: string;
  /** Current status of this step */
  status: 'start' | 'progress' | 'complete' | 'skip';
  /** Optional extra detail */
  detail?: string;
}

// ============================================================================
// BASE OPTIONS
// ============================================================================

/** Base options shared by all API functions */
export interface BaseOptions {
  /** Project root path. Default: process.cwd() */
  rootPath?: string;
  /** Path to openlore config file. Default: '.openlore/config.json' */
  configPath?: string;
  /** Progress callback for status updates */
  onProgress?: ProgressCallback;
}

// ============================================================================
// INIT
// ============================================================================

export interface InitApiOptions extends BaseOptions {
  /** Overwrite existing configuration */
  force?: boolean;
  /** Custom path for openspec/ output directory. Default: './openspec' */
  openspecPath?: string;
}

export interface InitResult {
  /** Path to the created config file */
  configPath: string;
  /** Path to the openspec directory */
  openspecPath: string;
  /** Detected project type */
  projectType: string;
  /** Whether a new config was created (false if already existed and !force) */
  created: boolean;
}

// ============================================================================
// ANALYZE
// ============================================================================

export interface AnalyzeApiOptions extends BaseOptions {
  /** Maximum files to analyze. Default: 500 */
  maxFiles?: number;
  /** Additional glob patterns to include */
  includePatterns?: string[];
  /** Additional glob patterns to exclude */
  excludePatterns?: string[];
  /** Force re-analysis even if recent analysis exists */
  force?: boolean;
  /**
   * Also re-extract every file rather than reusing the per-file extraction cache
   * (change: optimize-hash-keyed-analyze). Default false, because the reused lane is
   * byte-identical and `force` alone is what a rebuilding daemon or a healing watcher
   * wants — re-analysis without re-parsing. Set this only to verify the cache or to work
   * around a suspected one; `openlore analyze --force` sets it.
   */
  reExtract?: boolean;
  /** Output directory for analysis artifacts. Default: '.openlore/analysis/' */
  outputPath?: string;
}

export interface AnalyzeResult {
  repoMap: CoreRepositoryMap;
  depGraph: DependencyGraphResult;
  artifacts: AnalysisArtifacts;
  duration: number;
}

// ============================================================================
// GENERATE
// ============================================================================

export interface GenerateApiOptions extends BaseOptions {
  /** LLM provider to use */
  provider?: 'anthropic' | 'openai' | 'openai-compat' | 'copilot' | 'gemini' | 'gemini-cli' | 'claude-code' | 'mistral-vibe' | 'cursor-agent';
  /** LLM model name */
  model?: string;
  /** Custom LLM API base URL */
  apiBase?: string;
  /** Enable/disable SSL certificate verification. Default: true */
  sslVerify?: boolean;
  /** OpenAI-compatible base URL (for Mistral, Groq, Ollama, etc.) */
  openaiCompatBaseUrl?: string;
  /** LLM request timeout in milliseconds. Default: 120000 (2 minutes) */
  timeout?: number;
  /** Only generate specific domains */
  domains?: string[];
  /** Write mode for existing specs */
  writeMode?: 'replace' | 'merge' | 'skip';
  /** Generate Architecture Decision Records */
  adr?: boolean;
  /** Only generate ADRs (skip spec generation) */
  adrOnly?: boolean;
  /** Generate requirement-to-function mapping */
  mapping?: boolean;
  /** Preview what would be generated without writing */
  dryRun?: boolean;
  /** Path to analysis directory. Default: '.openlore/analysis/' */
  analysisPath?: string;
  /** Force regeneration from scratch, ignoring any cached stage results on disk */
  force?: boolean;
}

export interface GenerateResult {
  report: GenerationReport;
  pipelineResult: PipelineResult;
  duration: number;
}

// ============================================================================
// VERIFY
// ============================================================================

export interface VerifyApiOptions extends BaseOptions {
  /** LLM provider to use */
  provider?: 'anthropic' | 'openai' | 'openai-compat' | 'copilot' | 'gemini' | 'gemini-cli' | 'claude-code' | 'mistral-vibe' | 'cursor-agent';
  /** LLM model name */
  model?: string;
  /** Custom LLM API base URL */
  apiBase?: string;
  /** Base URL for OpenAI-compatible endpoint (Ollama, Mistral, etc.) */
  openaiCompatBaseUrl?: string;
  /** Enable/disable SSL certificate verification. Default: true */
  sslVerify?: boolean;
  /** LLM request timeout in milliseconds. Default: 120000 (2 minutes) */
  timeout?: number;
  /** Number of files to sample for verification. Default: 5 */
  samples?: number;
  /** Minimum confidence score to pass. Default: 0.5 */
  threshold?: number;
  /** Only verify specific domains */
  domains?: string[];
}

export interface VerifyResult {
  report: VerificationReport;
  duration: number;
}

// ============================================================================
// DRIFT
// ============================================================================

export interface DriftApiOptions extends BaseOptions {
  /** Git ref to compare against. Default: 'auto' (auto-detect main/master) */
  baseRef?: string;
  /** Specific files to check */
  files?: string[];
  /** Only check specific domains */
  domains?: string[];
  /** Use LLM for deeper semantic comparison */
  llmEnhanced?: boolean;
  /** LLM provider (required if llmEnhanced is true) */
  provider?: 'anthropic' | 'openai' | 'openai-compat' | 'copilot' | 'gemini' | 'gemini-cli' | 'claude-code' | 'mistral-vibe' | 'cursor-agent';
  /** LLM model name (used when llmEnhanced is true) */
  model?: string;
  /** Custom LLM API base URL */
  apiBase?: string;
  /** Base URL for OpenAI-compatible endpoint (Ollama, Mistral, etc.) */
  openaiCompatBaseUrl?: string;
  /** Enable/disable SSL certificate verification. Default: true */
  sslVerify?: boolean;
  /** LLM request timeout in milliseconds. Default: 120000 (2 minutes) */
  timeout?: number;
  /** Exit threshold severity. Default: 'warning' */
  failOn?: DriftSeverity;
  /** Maximum changed files to analyze. Default: 100 */
  maxFiles?: number;
}

// DriftResult is re-exported from types/index.ts

// ============================================================================
// RUN (Full Pipeline)
// ============================================================================

export interface RunApiOptions extends BaseOptions {
  /** Reinitialize even if config exists */
  force?: boolean;
  /** Force fresh analysis even if recent exists */
  reanalyze?: boolean;
  /**
   * Also re-extract every file rather than reusing the per-file extraction cache
   * (change: optimize-hash-keyed-analyze). Default false: the reused lane is byte-identical,
   * so `reanalyze` alone already produces a complete, current analysis.
   */
  reExtract?: boolean;
  /** LLM provider to use */
  provider?: 'anthropic' | 'openai' | 'openai-compat' | 'copilot' | 'gemini' | 'gemini-cli' | 'claude-code' | 'mistral-vibe' | 'cursor-agent';
  /** LLM model name */
  model?: string;
  /** Custom LLM API base URL */
  apiBase?: string;
  /** Enable/disable SSL certificate verification. Default: true */
  sslVerify?: boolean;
  /** OpenAI-compatible base URL */
  openaiCompatBaseUrl?: string;
  /** LLM request timeout in milliseconds. Default: 120000 (2 minutes) */
  timeout?: number;
  /** Maximum files to analyze. Default: 500 */
  maxFiles?: number;
  /** Generate Architecture Decision Records */
  adr?: boolean;
  /** Preview what would happen without changes */
  dryRun?: boolean;
}

export interface RunResult {
  init: InitResult;
  analysis: AnalyzeResult;
  generation: GenerateResult;
  duration: number;
}

// ============================================================================
// AUDIT
// ============================================================================

export interface AuditApiOptions extends BaseOptions {
  /** Maximum uncovered functions to include in the report. Default: 50 */
  maxUncovered?: number;
  /** Minimum fanIn to flag a hub as a gap. Default: 5 */
  hubThreshold?: number;
  /** Save audit report to .openlore/analysis/audit-report.json. Default: true */
  save?: boolean;
}

export type { AuditReport } from '../types/index.js';
