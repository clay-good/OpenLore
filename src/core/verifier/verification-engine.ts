/**
 * Spec Verification Engine
 *
 * Tests whether generated specs accurately describe the codebase by using
 * the specs to predict code behavior and comparing against actual files.
 */

import { readFile, writeFile, mkdir, access, readdir } from 'node:fs/promises';
import { join, basename, relative } from 'node:path';
import logger from '../../utils/logger.js';
import { VERIFICATION_PREDICTION_MAX_TOKENS } from '../../constants.js';
import type { LLMService } from '../services/llm-service.js';
import type { DependencyGraphResult, DependencyNode } from '../analyzer/dependency-graph.js';
import { ImportExportParser } from '../analyzer/import-parser.js';
import { protectPrompt } from '../../utils/prompt-boundary.js';
import { sanitizeForTerminal } from '../../utils/misc.js';

// ============================================================================
// TYPES
// ============================================================================

/**
 * Verification candidate file
 */
export interface VerificationCandidate {
  path: string;
  absolutePath: string;
  domain: string;
  usedInGeneration: boolean;
  complexity: number;
  lines: number;
  imports: number;
  exports: number;
}

/**
 * LLM prediction for a file
 */
export interface FilePrediction {
  predictedPurpose: string;
  predictedImports: string[];
  predictedExports: string[];
  predictedLogic: string[];
  relatedRequirements: string[];
  confidence: number;
  /** LLM-as-judge score: how accurately does the spec describe this file (0.0–1.0) */
  specAccuracyScore?: number;
  /** LLM-as-judge score: fraction of this file's behavior covered by spec requirements (0.0–1.0) */
  requirementCoverageScore?: number;
  reasoning: string;
}

interface JudgedFilePrediction extends FilePrediction {
  /** Actual provider response model that supplied the optional judge scores. */
  judgingModel: string;
}

/**
 * Match result for purpose
 */
export interface PurposeMatch {
  predicted: string;
  actual: string;
  similarity: number;
  provenance?:
    | { source: 'llm-judged'; model: string }
    | { source: 'keyword-fallback' };
}

export interface VerificationScoreComposition {
  kind: 'weighted-mixed-evidence-composite';
  weights: {
    purpose: 0.50;
    requirementCoverage: 0.35;
    imports: 0.05;
    exports: 0.10;
  };
}

const VERIFICATION_SCORE_COMPOSITION: VerificationScoreComposition = {
  kind: 'weighted-mixed-evidence-composite',
  weights: { purpose: 0.50, requirementCoverage: 0.35, imports: 0.05, exports: 0.10 },
};

/**
 * Match result for imports/exports
 */
export interface SetMatch {
  predicted: string[];
  actual: string[];
  precision: number;
  recall: number;
  f1Score: number;
  provenance?:
    | { source: 'llm-prediction-compared-deterministically'; model: string }
    | { source: 'deterministic' };
}

/**
 * Requirement coverage analysis
 */
export interface RequirementCoverage {
  relatedRequirements: string[];
  actuallyImplements: string[];
  coverage: number;
  evidence: 'llm-score' | 'keyword-match' | 'none';
  provenance?:
    | { source: 'llm-judged'; model: string }
    | { source: 'keyword-fallback' }
    | { source: 'none' };
}

export interface VerificationFailure {
  filePath: string;
  reason: string;
}

const MAX_VERIFICATION_FAILURE_REASON_LENGTH = 1_000;

function escapeMarkdownInline(value: string): string {
  return value
    .replace(/[\r\n\t]+/g, ' ')
    // eslint-disable-next-line no-control-regex -- persisted errors may contain control bytes
    .replace(/[\x00-\x1f\x7f-\x9f]/g, character =>
      `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`)
    .replace(/([\\`*_[\]<>#|])/g, '\\$1');
}

function requireUnitScore(value: unknown, field: string, fallback?: number): number | undefined {
  if (value === undefined && fallback !== undefined) return fallback;
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${field} must be a finite number between 0 and 1`);
  }
  return value;
}

function requirePresentUnitScore(value: unknown, field: string): number {
  const score = requireUnitScore(value, field);
  if (score === undefined) throw new Error(`${field} is required`);
  return score;
}

function optionalString(value: unknown, field: string): string {
  if (value === undefined) return '';
  if (typeof value !== 'string') throw new Error(`${field} must be a string`);
  return value;
}

function optionalStringArray(value: unknown, field: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new Error(`${field} must be an array of strings`);
  }
  return value;
}

function requireSafeModelId(value: unknown): string {
  if (typeof value !== 'string') throw new Error('completion model id must be a string');
  const model = value.trim();
  if (model.length === 0 || model.length > 200 || !/^[A-Za-z0-9._:/@+-]+$/.test(model)) {
    throw new Error('completion model id must be 1-200 safe identifier characters');
  }
  return model;
}

function describeVerificationError(error: unknown): string {
  let reason = 'Unknown verification error';
  try {
    if (error instanceof Error && typeof error.message === 'string' && error.message.trim()) {
      reason = error.message;
    } else if (typeof error === 'string' && error.trim()) {
      reason = error;
    } else {
      try {
        const serialized = JSON.stringify(error);
        if (serialized) reason = serialized;
      } catch {
        // A hostile thrown object may reject every coercion attempt.
      }
    }
  } catch {
    // Error subclasses may expose a throwing message getter.
  }

  const normalized = reason
    .replace(/[\r\n\t]+/g, ' ')
    // eslint-disable-next-line no-control-regex -- provider errors are untrusted input
    .replace(/[\x00-\x1f\x7f-\x9f]/g, '')
    .replace(/\s+/g, ' ')
    .trim() || 'Unknown verification error';
  if (normalized.length <= MAX_VERIFICATION_FAILURE_REASON_LENGTH) return normalized;
  const suffix = '... [truncated]';
  return `${normalized.slice(0, MAX_VERIFICATION_FAILURE_REASON_LENGTH - suffix.length)}${suffix}`;
}

/**
 * Result for a single file verification
 */
export interface VerificationResult {
  filePath: string;
  domain: string;
  purposeMatch: PurposeMatch;
  importMatch: SetMatch;
  exportMatch: SetMatch;
  requirementCoverage: RequirementCoverage;
  overallScore: number;
  scoreComposition?: VerificationScoreComposition;
  llmConfidence: number;
  llmConfidenceProvenance?: { source: 'llm-reported'; model: string };
  feedback: string[];
}

/**
 * Domain breakdown in report
 */
export interface DomainBreakdown {
  domain: string;
  specPath: string;
  filesVerified: number;
  averageScore: number;
  averageScoreBasis?: 'mean-of-weighted-mixed-evidence-composites';
  weakestArea: string;
}

/**
 * Suggested improvement
 */
export interface SuggestedImprovement {
  domain: string;
  issue: string;
  suggestion: string;
}

/**
 * Complete verification report
 */
export interface VerificationReport {
  timestamp: string;
  specVersion: string;
  attemptedFiles: number;
  sampledFiles: number;
  failedFiles: number;
  failures: VerificationFailure[];
  aggregateBasis: 'successful-files';
  passedFiles: number;
  overallConfidence: number;
  overallConfidenceBasis?: {
    kind: 'mean-of-weighted-mixed-evidence-composites';
    scoreComposition: VerificationScoreComposition;
  };
  domainBreakdown: DomainBreakdown[];
  commonGaps: string[];
  recommendation: 'ready' | 'needs-review' | 'regenerate';
  recommendationBasis?: 'weighted-mixed-evidence-composite-threshold';
  recommendationQualification?: string;
  suggestedImprovements: SuggestedImprovement[];
  results: VerificationResult[];
}

/**
 * Engine options
 */
export interface VerificationEngineOptions {
  /** Root directory of the project */
  rootPath: string;
  /** Path to openspec directory */
  openspecPath: string;
  /** Output directory for reports */
  outputDir: string;
  /** Minimum complexity (lines) for candidate files */
  minComplexity?: number;
  /** Maximum complexity (lines) for candidate files */
  maxComplexity?: number;
  /** Number of files to sample per domain */
  filesPerDomain?: number;
  /** Passing threshold for overall score */
  passThreshold?: number;
  /** Files used in generation (to exclude) */
  generationContext?: string[];
}

/**
 * Loaded spec content
 */
interface LoadedSpec {
  domain: string;
  path: string;
  content: string;
}

// ============================================================================
// SYSTEM PROMPTS
// ============================================================================

const PREDICTION_SYSTEM_PROMPT = `You are testing the accuracy of OpenSpec specifications.

You will be given:
1. A set of specifications describing a software system (in OpenSpec format)
2. A file path within that system

Your task: Based ONLY on the specifications, predict:
- What this file likely does (purpose)
- What modules/files it probably imports
- What it probably exports (functions, classes, etc.)
- Key logic patterns you'd expect to see based on the spec requirements

Be specific. If the specs don't provide enough info, say so.

Respond with valid JSON only.`;

// ============================================================================
// VERIFICATION ENGINE
// ============================================================================

/**
 * Spec Verification Engine
 */
export class SpecVerificationEngine {
  private llm: LLMService;
  private options: Required<VerificationEngineOptions>;
  private specs: LoadedSpec[] = [];
  private fileDomainMap: Map<string, string> = new Map();
  private verificationContextPromise: Promise<void> | undefined;
  private parser: ImportExportParser;

  constructor(llm: LLMService, options: VerificationEngineOptions) {
    const passThreshold = options.passThreshold ?? 0.5;
    if (!Number.isFinite(passThreshold) || passThreshold < 0 || passThreshold > 1) {
      throw new Error('passThreshold must be a finite number between 0 and 1');
    }
    this.llm = llm;
    this.parser = new ImportExportParser();
    this.options = {
      rootPath: options.rootPath,
      openspecPath: options.openspecPath,
      outputDir: options.outputDir,
      minComplexity: options.minComplexity ?? 50,
      maxComplexity: options.maxComplexity ?? 500,
      filesPerDomain: options.filesPerDomain ?? 3,
      passThreshold,
      generationContext: options.generationContext ?? [],
    };
  }

  /**
   * Run full verification
   */
  async verify(
    depGraph: DependencyGraphResult,
    specVersion: string,
    selectedCandidates?: readonly VerificationCandidate[],
  ): Promise<VerificationReport> {
    const startTime = Date.now();

    // Load all specs and the file→domain mapping once. prepareCandidates() uses
    // the same boundary so previewed candidates keep their resolved domains.
    await this.ensureVerificationContext();

    if (this.specs.length === 0) {
      throw new Error('No specs found to verify against');
    }

    logger.analysis(`Loaded ${this.specs.length} spec(s) for verification`);

    // Select verification candidates
    const candidates = selectedCandidates ? [...selectedCandidates] : this.selectCandidates(depGraph);
    logger.discovery(`Selected ${candidates.length} candidate file(s) for verification`);

    if (candidates.length === 0) {
      throw new Error('No suitable verification candidates found');
    }

    // Run verification for each candidate
    const results: VerificationResult[] = [];
    const failures: VerificationFailure[] = [];
    for (let i = 0; i < candidates.length; i++) {
      const candidate = candidates[i];
      logger.analysis(`Verifying ${i + 1}/${candidates.length}: ${sanitizeForTerminal(candidate.path)}`);

      try {
        const result = await this.verifyFile(candidate);
        results.push(result);
      } catch (error) {
        const reason = describeVerificationError(error);
        failures.push({ filePath: candidate.path, reason });
        logger.warning(`Failed to verify ${sanitizeForTerminal(candidate.path)}: ${sanitizeForTerminal(reason)}`);
      }
    }

    // Generate report
    const report = this.generateReport(results, specVersion, failures);

    // Save report
    await this.saveReport(report);

    const duration = Date.now() - startTime;
    logger.success(`Verification complete in ${(duration / 1000).toFixed(1)}s`);

    return report;
  }

  /**
   * Resolve and bound the exact candidate set that a later verify() call will use.
   * Specs and mapping must be loaded first because domain assignment is part of
   * candidate identity, not a display-only annotation.
   */
  async prepareCandidates(
    depGraph: DependencyGraphResult,
    limit?: number,
  ): Promise<VerificationCandidate[]> {
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
      throw new Error('candidate limit must be a positive integer');
    }
    await this.ensureVerificationContext();
    if (this.specs.length === 0) {
      throw new Error('No specs found to verify against');
    }
    const candidates = this.selectCandidates(depGraph);
    return limit === undefined ? candidates : candidates.slice(0, limit);
  }

  private async ensureVerificationContext(): Promise<void> {
    if (!this.verificationContextPromise) {
      this.verificationContextPromise = (async () => {
        await this.loadSpecs();
        if (this.specs.length === 0) {
          throw new Error('No specs found to verify against');
        }
        await this.loadFileDomainMap();
      })().catch(error => {
        this.verificationContextPromise = undefined;
        throw error;
      });
    }
    await this.verificationContextPromise;
  }

  /**
   * Load all specs from openspec directory
   */
  private async loadSpecs(): Promise<void> {
    this.specs = [];
    const specsDir = join(this.options.openspecPath, 'specs');

    try {
      await access(specsDir);
    } catch {
      return;
    }

    const entries = await readdir(specsDir, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const specPath = join(specsDir, entry.name, 'spec.md');
      try {
        const content = await readFile(specPath, 'utf-8');
        this.specs.push({
          domain: entry.name,
          path: relative(this.options.rootPath, specPath),
          content,
        });
      } catch {
        // Spec doesn't exist for this domain
      }
    }
  }

  /**
   * Load file→domain mapping from .openlore/analysis/mapping.json.
   * Falls back silently if the file doesn't exist (e.g. before first analysis run).
   */
  private async loadFileDomainMap(): Promise<void> {
    this.fileDomainMap = new Map();
    const mappingPath = join(this.options.rootPath, '.openlore', 'analysis', 'mapping.json');
    try {
      const raw = await readFile(mappingPath, 'utf-8');
      const data = JSON.parse(raw) as {
        mappings?: Array<{ domain: string; functions?: Array<{ file: string }> }>;
      };
      // Count how many distinct domains each file appears in
      const fileDomains = new Map<string, Set<string>>();
      for (const entry of data.mappings ?? []) {
        for (const fn of entry.functions ?? []) {
          if (!fn.file || !entry.domain) continue;
          if (!fileDomains.has(fn.file)) fileDomains.set(fn.file, new Set());
          fileDomains.get(fn.file)!.add(entry.domain);
        }
      }
      // Only map files that belong to exactly one domain — cross-cutting files
      // (e.g. constants.ts, logger.ts) appear in many domains and can't be fairly
      // verified against any single spec.
      for (const [file, domains] of fileDomains) {
        if (domains.size === 1) {
          this.fileDomainMap.set(file, [...domains][0]);
        }
      }
      logger.analysis(`Loaded file→domain mapping for ${this.fileDomainMap.size} file(s)`);
    } catch {
      // mapping.json not available — inferDomain falls back to path heuristics
    }
  }

  /**
   * Select verification candidate files
   */
  selectCandidates(depGraph: DependencyGraphResult): VerificationCandidate[] {
    const candidates: VerificationCandidate[] = [];
    const usedPaths = new Set(this.options.generationContext);

    // Group files by domain
    const filesByDomain = new Map<string, DependencyNode[]>();

    for (const node of depGraph.nodes) {
      // Skip files used in generation
      if (usedPaths.has(node.file.path)) continue;

      // Skip test files
      if (node.file.isTest) continue;

      // Skip generated files
      if (node.file.isGenerated) continue;

      // Skip non-source files (config, manifests, markup, data)
      const ext = node.file.path.split('.').pop()?.toLowerCase() ?? '';
      const sourceExts = new Set(['ts', 'tsx', 'js', 'jsx', 'py', 'go', 'rs', 'rb', 'java', 'cpp', 'c', 'cs', 'swift', 'kt']);
      if (!sourceExts.has(ext)) continue;

      // Skip files outside complexity range
      if (node.file.lines < this.options.minComplexity) continue;
      if (node.file.lines > this.options.maxComplexity) continue;

      // Determine domain from path — skip files with no matching spec
      // (only filter misc when specs are loaded; without specs every file maps to misc)
      const domain = this.inferDomain(node.file.path);
      if (domain === 'misc' && this.specs.length > 0) continue;

      if (!filesByDomain.has(domain)) {
        filesByDomain.set(domain, []);
      }
      filesByDomain.get(domain)!.push(node);
    }

    // Select files from each domain
    for (const [domain, nodes] of filesByDomain) {
      // Prefer high-connectivity (core) files — they're what specs actually describe
      // and are more likely to have docstrings. Leaf/utility nodes were previously
      // preferred (ascending sort) but produced systematically low scores.
      const sorted = nodes.sort((a, b) => {
        const aConnectivity = a.metrics.inDegree + a.metrics.outDegree;
        const bConnectivity = b.metrics.inDegree + b.metrics.outDegree;
        return bConnectivity - aConnectivity;
      });

      // Take up to filesPerDomain
      const selected = sorted.slice(0, this.options.filesPerDomain);

      for (const node of selected) {
        candidates.push({
          path: node.file.path,
          absolutePath: node.file.absolutePath,
          domain,
          usedInGeneration: false,
          complexity: node.file.lines,
          lines: node.file.lines,
          imports: node.metrics.outDegree,
          exports: node.exports.length,
        });
      }
    }

    return candidates;
  }

  /**
   * Resolve the spec domain for a file.
   *
   * Priority:
   * 1. mapping.json lookup — deterministic, built from the analysis run.
   * 2. Path heuristic — walk segments, match against known spec domain names
   *    (exact, then prefix ≥4 chars to handle utils→utilities etc.).
   * 3. Fallback — first meaningful non-structural segment.
   */
  private inferDomain(filePath: string): string {
    // 1. Deterministic lookup from mapping.json
    const mapped = this.fileDomainMap.get(filePath);
    if (mapped) return mapped;

    // 2. Path-based matching against known spec domains
    const knownDomains = this.specs.map(s => s.domain);
    const structural = new Set(['src', 'lib', 'app', 'core', 'utils', 'helpers', 'common', 'shared']);
    const rawParts = filePath.replace(/\\/g, '/').split('/');
    const segments = rawParts.map((p, i) =>
      i === rawParts.length - 1 ? p.replace(/\.[^.]+$/, '').toLowerCase() : p.toLowerCase()
    );

    // Exact match against known domains — iterate deepest-first (reverse) so that
    // src/core/services/mcp-handlers/x.ts matches "mcp-handlers" not "services".
    const reversed = [...segments].reverse();
    for (const seg of reversed) {
      if (!structural.has(seg) && knownDomains.includes(seg)) return seg;
    }
    for (const seg of reversed) {
      if (structural.has(seg) && knownDomains.includes(seg)) return seg;
    }

    // Shared-prefix match (≥4 chars) — deepest-first, e.g. "utils"→"utilities"
    const commonPrefixLen = (a: string, b: string): number => {
      let i = 0;
      while (i < a.length && i < b.length && a[i] === b[i]) i++;
      return i;
    };
    for (const seg of reversed) {
      if (seg.length < 4) continue;
      const hit = knownDomains.find(d => commonPrefixLen(seg, d) >= 4);
      if (hit) return hit;
    }

    // No match found — return 'misc' rather than inventing a phantom domain
    // from the filename (which would score 0% against a non-existent spec).
    return 'misc';
  }

  /**
   * Verify a single file
   */
  async verifyFile(candidate: VerificationCandidate): Promise<VerificationResult> {
    // Read actual file first — content is passed to getPrediction for LLM-as-judge scoring
    const fileContent = await readFile(candidate.absolutePath, 'utf-8');
    const fileAnalysis = await this.parser.parseFile(candidate.absolutePath);

    // Get prediction from LLM (includes spec accuracy score via LLM-as-judge)
    const prediction = await this.getPrediction(candidate, fileContent);

    // Compare prediction to actual
    const domainSpec = this.specs.find((spec) => spec.domain === candidate.domain);
    const purposeMatch = this.comparePurpose(
      prediction.predictedPurpose,
      fileContent,
      prediction.specAccuracyScore,
      prediction.judgingModel,
      domainSpec?.content ?? '',
    );
    const importMatch = this.analyzeImportCoverage(fileAnalysis.imports.map(i => i.source), candidate.domain);
    const exportMatch = this.compareExports(
      prediction.predictedExports,
      fileAnalysis.exports.map(e => e.name),
      prediction.judgingModel,
    );
    const requirementCoverage = this.analyzeRequirementCoverage(
      candidate.domain,
      fileContent,
      prediction.requirementCoverageScore,
      prediction.judgingModel,
    );

    // Calculate overall score
    const overallScore = this.calculateOverallScore(purposeMatch, importMatch, exportMatch, requirementCoverage);

    // Generate feedback
    const feedback = this.generateFeedback(candidate, prediction, purposeMatch, importMatch, exportMatch, requirementCoverage);

    return {
      filePath: candidate.path,
      domain: candidate.domain,
      purposeMatch,
      importMatch,
      exportMatch,
      requirementCoverage,
      overallScore,
      scoreComposition: VERIFICATION_SCORE_COMPOSITION,
      llmConfidence: prediction.confidence,
      llmConfidenceProvenance: { source: 'llm-reported', model: prediction.judgingModel },
      feedback,
    };
  }

  /**
   * Build specs context string capped at maxChars to avoid silent LLM token overflow.
   * Specs are included in order; the last spec may be truncated if the budget is tight.
   */
  private buildSpecsContext(maxChars: number): string {
    const parts: string[] = [];
    let total = 0;
    for (const s of this.specs) {
      const header = `=== ${s.domain} (${s.path}) ===\n`;
      const budget = maxChars - total - header.length;
      if (budget <= 0) break;
      const body = s.content.length > budget
        ? s.content.slice(0, budget) + '\n[truncated]'
        : s.content;
      parts.push(header + body);
      total += header.length + body.length;
    }
    return parts.join('\n\n');
  }

  /**
   * Get prediction from LLM.
   *
   * When fileContent is provided the prompt uses an LLM-as-judge approach:
   * the model sees both the spec and the actual file content, and returns a
   * specAccuracyScore (0–1) measuring how well the spec describes the file.
   * This replaces the brittle Jaccard keyword-overlap used for purposeMatch.
   */
  private async getPrediction(candidate: VerificationCandidate, fileContent?: string): Promise<JudgedFilePrediction> {
    // Prefer the candidate's own domain spec; fall back to full context if not found.
    const domainSpec = this.specs.find(s => s.domain === candidate.domain);
    const specsContent = domainSpec
      ? `=== ${domainSpec.domain} (${domainSpec.path}) ===\n${domainSpec.content}`
      : this.buildSpecsContext(24_000);

    // Include a trimmed excerpt of the actual file so the LLM can score spec accuracy
    const fileExcerpt = fileContent
      ? `\n\n=== Actual file content (${candidate.path}) ===\n${fileContent.slice(0, 3000)}${fileContent.length > 3000 ? '\n[truncated]' : ''}`
      : '';

    const judgeInstruction = fileContent
      ? `\nAlso set:
- "specAccuracyScore": float 0.0–1.0 — how accurately the spec describes this specific file's purpose and behavior (1.0 = spec perfectly describes this file, 0.0 = spec is irrelevant).
- "requirementCoverageScore": float 0.0–1.0 — of the requirements in the spec that are relevant to THIS file specifically, what fraction does the file actually implement? Ignore requirements that clearly belong to other files in the domain.`
      : '';

    const analysisInstruction = `Predict the target file from the supplied specifications and file excerpt.
The specs may contain entries attributed to specific files using \`> \`path\`\` markers.
Focus only on entries attributed to the target path. Ignore entries attributed to other files.
If no entries are attributed to the target path, use only the general domain purpose.${judgeInstruction}

Respond in JSON:
{
  "predictedPurpose": "...",
  "predictedImports": ["...", "..."],
  "predictedExports": ["...", "..."],
  "predictedLogic": ["...", "..."],
  "relatedRequirements": ["RequirementName1", "RequirementName2"],
  "confidence": 0.0-1.0,
  "specAccuracyScore": 0.0-1.0,
  "requirementCoverageScore": 0.0-1.0,
  "reasoning": "..."
}`;
    const prompts = protectPrompt(
      `${PREDICTION_SYSTEM_PROMPT}\n\n${analysisInstruction}`,
      `Specifications:\n${specsContent}${fileExcerpt}\n\nTarget path: ${candidate.path}`,
    );

    try {
      const completion = await this.llm.completeJSONWithMetadata<FilePrediction>({
        ...prompts,
        temperature: 0.3,
        maxTokens: VERIFICATION_PREDICTION_MAX_TOKENS,
      });
      const prediction = completion.data;
      if (!prediction || typeof prediction !== 'object' || Array.isArray(prediction)) {
        throw new Error('verification prediction must be a JSON object');
      }

      return {
        predictedPurpose: optionalString(prediction.predictedPurpose, 'predictedPurpose'),
        predictedImports: optionalStringArray(prediction.predictedImports, 'predictedImports'),
        predictedExports: optionalStringArray(prediction.predictedExports, 'predictedExports'),
        predictedLogic: optionalStringArray(prediction.predictedLogic, 'predictedLogic'),
        relatedRequirements: optionalStringArray(prediction.relatedRequirements, 'relatedRequirements'),
        confidence: requirePresentUnitScore(prediction.confidence, 'confidence'),
        specAccuracyScore: requireUnitScore(prediction.specAccuracyScore, 'specAccuracyScore'),
        requirementCoverageScore: requireUnitScore(prediction.requirementCoverageScore, 'requirementCoverageScore'),
        reasoning: optionalString(prediction.reasoning, 'reasoning'),
        judgingModel: requireSafeModelId(completion.response.model),
      };
    } catch (error) {
      logger.warning(`Prediction failed for ${sanitizeForTerminal(candidate.path)}: ${sanitizeForTerminal(describeVerificationError(error))}`);
      // Re-throw so verify() skips this file rather than recording a misleading 0% score
      throw error;
    }
  }

  /**
   * Compare predicted purpose to actual file content.
   *
   * When specAccuracyScore is provided (LLM-as-judge), it is used directly as
   * the similarity score — this is far more reliable than keyword overlap because
   * the LLM has seen the actual file and can assess whether the spec describes it.
   * Falls back to Jaccard keyword overlap when no LLM score is available.
   */
  private comparePurpose(
    predicted: string,
    fileContent: string,
    specAccuracyScore?: number,
    judgingModel?: string,
    deterministicSpecText: string = '',
  ): PurposeMatch {
    const actual = this.extractPurpose(fileContent);

    if (typeof specAccuracyScore === 'number') {
      if (!judgingModel) throw new Error('LLM-judged purpose score is missing its model provenance');
      return {
        predicted,
        actual,
        similarity: specAccuracyScore,
        provenance: { source: 'llm-judged', model: judgingModel },
      };
    }

    return {
      predicted,
      actual,
      similarity: this.calculateSimilarity(deterministicSpecText, actual),
      provenance: { source: 'keyword-fallback' },
    };
  }

  /**
   * Extract purpose from file content (comments, docstrings)
   */
  private extractPurpose(content: string): string {
    const lines = content.split('\n');
    const parts: string[] = [];

    // 1. Module-level JSDoc block (/** ... */)
    let inBlockComment = false;
    for (let i = 0; i < lines.length; i++) {
      const trimmed = lines[i].trim();
      if (trimmed.startsWith('/**')) { inBlockComment = true; continue; }
      // `break` ends the scan, so clearing the flag here would be a dead store.
      if (trimmed.startsWith('*/') || trimmed.endsWith('*/')) break;
      if (inBlockComment) {
        const comment = trimmed.replace(/^\*\s*/, '').trim();
        if (comment && !comment.startsWith('@')) parts.push(comment);
      }
      // Single-line // comments near the top
      if (trimmed.startsWith('//') && !inBlockComment && parts.length < 3 && i < 30) {
        parts.push(trimmed.replace(/^\/\/\s*/, ''));
      }
    }

    // 2. Exported identifier names — split camelCase/PascalCase/snake_case into words.
    // This gives the verifier vocabulary to match against even when comments are absent.
    // E.g. "readOpenLoreConfig" → "read Spec Gen Config"; "OPENLORE_DIR" → "spec gen dir".
    const exportMatches = content.matchAll(
      /^export\s+(?:default\s+)?(?:async\s+)?(?:function|class|const|let|var|interface|type|enum)\s+(\w+)/gm
    );
    const identWords: string[] = [];
    for (const m of exportMatches) {
      const name = m[1];
      // Split on underscores and camelCase boundaries
      const words = name
        .replace(/_+/g, ' ')
        .replace(/([a-z])([A-Z])/g, '$1 $2')
        .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
        .toLowerCase()
        .split(/\s+/)
        .filter(w => w.length > 2);
      identWords.push(...words);
    }
    if (identWords.length > 0) {
      parts.push(identWords.join(' '));
    }

    return parts.join(' ').slice(0, 800);
  }

  /**
   * Calculate text similarity using keyword overlap
   */
  private calculateSimilarity(text1: string, text2: string): number {
    if (!text1 || !text2) return 0;

    const words1 = this.extractKeywords(text1);
    const words2 = this.extractKeywords(text2);

    if (words1.size === 0 || words2.size === 0) return 0;

    let matches = 0;
    for (const word of words1) {
      if (words2.has(word)) matches++;
    }

    // Jaccard similarity
    const union = new Set([...words1, ...words2]);
    return matches / union.size;
  }

  /**
   * Normalize a word for similarity comparison by truncating to its first 5
   * characters. This is more robust than suffix-stripping for technical
   * English: "generate/generates/generating/generation" all share the prefix
   * "gener", "verify/verification/verifies" share "verif", etc.
   * Tested against 26 word pairs: 18/26 correct matches, 0 false positives.
   */
  private normalize(word: string): string {
    return word.slice(0, 5);
  }

  /**
   * Extract keywords from text
   */
  private extractKeywords(text: string): Set<string> {
    const words = text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 3);

    // Filter out common words
    const stopwords = new Set(['the', 'and', 'for', 'this', 'that', 'with', 'are', 'from', 'has', 'have', 'will', 'can', 'all', 'each', 'which', 'when', 'there', 'been', 'being', 'their', 'would', 'could', 'should']);

    return new Set(
      words.filter(w => !stopwords.has(w)).map(w => this.normalize(w))
    );
  }

  /**
   * Analyze import coverage using spec content rather than LLM predictions.
   * For each actual import (normalized to module name), checks whether it is
   * mentioned in the domain's spec text (exact name or hyphen→space variant).
   * This is a spec-completeness check: are the modules the file depends on
   * actually described in the spec?
   *
   * Returns a SetMatch where:
   *   - actual   = all normalized actual import module names
   *   - predicted = subset of actual imports that appear in the spec text
   *   - f1Score  = recall = fraction of actual imports covered by spec
   */
  private analyzeImportCoverage(actualImports: string[], domain: string): SetMatch {
    const normalized = actualImports.map(a => this.normalizeImport(a));
    const spec = this.specs.find(s => s.domain === domain);
    const specLower = spec ? spec.content.toLowerCase() : '';

    const covered: string[] = [];
    if (specLower.length > 0) {
      for (const name of normalized) {
        if (!name || name.length < 2) continue;
        // Match literal (e.g. "config-manager") or with spaces (e.g. "config manager")
        if (specLower.includes(name) || specLower.includes(name.replace(/-/g, ' '))) {
          covered.push(name);
        }
      }
    }

    const total = normalized.length;
    const coverage = total > 0 ? covered.length / total : 0;
    return {
      predicted: covered,   // imports mentioned in spec
      actual: normalized,   // all actual imports
      precision: coverage,
      recall: coverage,
      f1Score: coverage,
      provenance: { source: 'deterministic' },
    };
  }

  /**
   * Normalize import path for comparison.
   * Strips file extensions and the first leading `./` or `../` prefix,
   * then extracts the final path segment (module name) in lowercase.
   * Deeply-nested relative paths (e.g. `../../foo`) are handled correctly
   * because only the last segment is used for comparison.
   */
  private normalizeImport(importPath: string): string {
    const normalized = importPath
      .replace(/\\/g, '/')
      .replace(/\.(js|ts|jsx|tsx|mjs|cjs)$/, '')
      .replace(/^\.\//, '')
      .replace(/^\.\.\//, '');

    const parts = normalized.split('/');
    return parts[parts.length - 1].toLowerCase();
  }

  /**
   * Compare predicted exports to actual
   */
  private compareExports(predicted: string[], actual: string[], judgingModel?: string): SetMatch {
    if (!judgingModel) throw new Error('LLM-predicted export match is missing its model provenance');
    return {
      ...this.calculateSetMatch(
      predicted.map(p => p.toLowerCase()),
      actual.map(a => a.toLowerCase())
      ),
      provenance: { source: 'llm-prediction-compared-deterministically', model: judgingModel },
    };
  }

  /**
   * Calculate precision, recall, F1 for set comparison
   */
  private calculateSetMatch(predicted: string[], actual: string[]): SetMatch {
    const predictedSet = new Set(predicted);
    const actualSet = new Set(actual);

    let truePositives = 0;
    for (const p of predictedSet) {
      if (actualSet.has(p)) truePositives++;
    }

    const precision = predictedSet.size > 0 ? truePositives / predictedSet.size : 0;
    const recall = actualSet.size > 0 ? truePositives / actualSet.size : 0;
    const f1Score = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;

    return {
      predicted,
      actual,
      precision,
      recall,
      f1Score,
    };
  }

  /**
   * Parse requirements from a spec's markdown content.
   * Returns an array of { name, description } extracted from
   * "### Requirement: Name\n\nThe system SHALL ..." blocks.
   */
  private parseSpecRequirements(specContent: string): Array<{ name: string; description: string }> {
    const requirements: Array<{ name: string; description: string }> = [];
    const lines = specContent.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(/^###\s+Requirement:\s+(.+)/i);
      if (!m) continue;
      const name = m[1].trim();
      // Look ahead for the description line (first non-empty line after the heading)
      let description = '';
      for (let j = i + 1; j < Math.min(i + 5, lines.length); j++) {
        const l = lines[j].trim();
        if (l.length > 0) { description = l; break; }
      }
      if (name) requirements.push({ name, description });
    }
    return requirements;
  }

  /**
   * Analyze requirement coverage.
   *
   * When llmScore is provided (LLM-as-judge), it is used directly — the LLM
   * has seen both the spec and the file and scores only the requirements
   * relevant to this specific file, avoiding the false penalty of a domain
   * spec covering many files where each file implements only a small subset.
   *
   * Falls back to keyword matching when no LLM score is available.
   */
  private analyzeRequirementCoverage(
    domain: string,
    fileContent: string,
    llmScore?: number,
    judgingModel?: string,
  ): RequirementCoverage {
    const spec = this.specs.find(s => s.domain === domain);
    if (!spec) {
      return { relatedRequirements: [], actuallyImplements: [], coverage: 0, evidence: 'none', provenance: { source: 'none' } };
    }

    const requirements = this.parseSpecRequirements(spec.content);
    const relatedRequirements = requirements.map(r => r.name);

    // LLM-as-judge: the scalar is evidence for aggregate coverage only. It cannot
    // support named per-requirement membership claims.
    if (typeof llmScore === 'number') {
      if (!judgingModel) throw new Error('LLM-judged requirement coverage is missing its model provenance');
      return {
        relatedRequirements,
        actuallyImplements: [],
        coverage: llmScore,
        evidence: 'llm-score',
        provenance: { source: 'llm-judged', model: judgingModel },
      };
    }

    if (requirements.length === 0) {
      return { relatedRequirements: [], actuallyImplements: [], coverage: 0, evidence: 'none', provenance: { source: 'none' } };
    }

    const contentLower = fileContent.toLowerCase();
    const actuallyImplements: string[] = [];

    for (const req of requirements) {
      const source = req.description.length > 0 ? req.description : req.name;
      const keywords = source
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter(w => w.length > 3 && !['shall', 'system', 'when', 'given', 'then', 'that', 'this', 'with', 'from', 'have', 'will'].includes(w));

      if (keywords.length === 0) continue;
      const matched = keywords.filter(w => contentLower.includes(w));
      if (matched.length >= Math.ceil(keywords.length * 0.5)) {
        actuallyImplements.push(req.name);
      }
    }

    const coverage = actuallyImplements.length / requirements.length;
    return {
      relatedRequirements,
      actuallyImplements,
      coverage,
      evidence: 'keyword-match',
      provenance: { source: 'keyword-fallback' },
    };
  }

  /**
   * Calculate overall score (weighted combination)
   */
  private calculateOverallScore(
    purposeMatch: PurposeMatch,
    importMatch: SetMatch,
    exportMatch: SetMatch,
    requirementCoverage: RequirementCoverage
  ): number {
    // Weighted combination (total = 1.0):
    //   Purpose:      50%  — LLM-as-judge: how well the spec describes this file
    //   Requirements: 35%  — LLM-as-judge: fraction of file-relevant requirements covered
    //   Imports:       5%  — fraction of actual imports mentioned in spec
    //                        (low weight: library deps are never in specs, so ceiling ~20%)
    //   Exports:      10%  — F1 of LLM-predicted vs actual exports
    return (
      purposeMatch.similarity * 0.50 +
      requirementCoverage.coverage * 0.35 +
      importMatch.f1Score * 0.05 +
      exportMatch.f1Score * 0.10
    );
  }

  /**
   * Generate feedback for gaps
   */
  private generateFeedback(
    candidate: VerificationCandidate,
    prediction: FilePrediction,
    purposeMatch: PurposeMatch,
    importMatch: SetMatch,
    exportMatch: SetMatch,
    requirementCoverage: RequirementCoverage
  ): string[] {
    const feedback: string[] = [];

    // Low purpose match
    if (purposeMatch.similarity < 0.3) {
      feedback.push(`Purpose mismatch: specs don't clearly describe what ${basename(candidate.path)} does`);
    }

    // Missing imports
    const missingImports = importMatch.actual.filter(a => !importMatch.predicted.includes(a));
    if (missingImports.length > 0) {
      feedback.push(`Missing dependencies: specs don't mention ${missingImports.slice(0, 3).join(', ')}`);
    }

    // Missing exports
    const missingExports = exportMatch.actual.filter(a => !exportMatch.predicted.includes(a));
    if (missingExports.length > 0) {
      const model = exportMatch.provenance?.source === 'llm-prediction-compared-deterministically'
        ? exportMatch.provenance.model
        : 'model provenance unavailable';
      feedback.push(
        `LLM-predicted export mismatch: ${model} did not predict ${missingExports.slice(0, 3).join(', ')}; ` +
        'this is not proof that the specs omit them',
      );
    }

    // Low requirement coverage
    if (requirementCoverage.evidence === 'llm-score' && requirementCoverage.coverage < 0.5) {
      const model = requirementCoverage.provenance?.source === 'llm-judged'
        ? requirementCoverage.provenance.model
        : 'model provenance unavailable';
      feedback.push(
        `Requirement coverage: ${(requirementCoverage.coverage * 100).toFixed(0)}% (LLM-judged by ${model}; no per-requirement claims)`,
      );
    } else if (requirementCoverage.evidence === 'keyword-match' && requirementCoverage.coverage < 0.5) {
      const missing = requirementCoverage.relatedRequirements.filter(r => !requirementCoverage.actuallyImplements.includes(r));
      if (missing.length > 0) {
        feedback.push(`Requirements ${missing.slice(0, 2).join(', ')} don't appear to be implemented in this file`);
      }
    }

    // Low confidence from LLM
    if (prediction.confidence < 0.5) {
      feedback.push(`LLM had low confidence: "${prediction.reasoning}"`);
    }

    return feedback;
  }

  /**
   * Generate verification report
   */
  private generateReport(
    results: VerificationResult[],
    specVersion: string,
    failures: VerificationFailure[] = [],
  ): VerificationReport {
    const passedFiles = results.filter(r => r.overallScore >= this.options.passThreshold).length;
    const overallConfidence = results.length > 0
      ? results.reduce((sum, r) => sum + r.overallScore, 0) / results.length
      : 0;

    // Domain breakdown
    const domainResults = new Map<string, VerificationResult[]>();
    for (const result of results) {
      if (!domainResults.has(result.domain)) {
        domainResults.set(result.domain, []);
      }
      domainResults.get(result.domain)!.push(result);
    }

    const domainBreakdown: DomainBreakdown[] = [];
    for (const [domain, domainRes] of domainResults) {
      const avgScore = domainRes.reduce((sum, r) => sum + r.overallScore, 0) / domainRes.length;

      // Find weakest area
      const avgPurpose = domainRes.reduce((sum, r) => sum + r.purposeMatch.similarity, 0) / domainRes.length;
      const avgImport = domainRes.reduce((sum, r) => sum + r.importMatch.f1Score, 0) / domainRes.length;
      const avgExport = domainRes.reduce((sum, r) => sum + r.exportMatch.f1Score, 0) / domainRes.length;
      const avgReq = domainRes.reduce((sum, r) => sum + r.requirementCoverage.coverage, 0) / domainRes.length;

      const areas = [
        { name: 'purpose', score: avgPurpose },
        { name: 'imports', score: avgImport },
        { name: 'exports', score: avgExport },
        { name: 'requirements', score: avgReq },
      ];
      const weakest = areas.sort((a, b) => a.score - b.score)[0];

      domainBreakdown.push({
        domain,
        specPath: `openspec/specs/${domain}/spec.md`,
        filesVerified: domainRes.length,
        averageScore: avgScore,
        averageScoreBasis: 'mean-of-weighted-mixed-evidence-composites',
        weakestArea: weakest.name,
      });
    }

    // Common gaps
    const allFeedback = results.flatMap(r => r.feedback);
    const feedbackCounts = new Map<string, number>();
    for (const fb of allFeedback) {
      // Normalize feedback for grouping
      const key = fb.split(':')[0];
      feedbackCounts.set(key, (feedbackCounts.get(key) ?? 0) + 1);
    }
    const commonGaps = Array.from(feedbackCounts.entries())
      .filter(([_, count]) => count >= 2)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([gap, _]) => gap);

    // Suggested improvements
    const suggestedImprovements: SuggestedImprovement[] = [];
    for (const breakdown of domainBreakdown) {
      if (breakdown.averageScore < 0.7) {
        suggestedImprovements.push({
          domain: breakdown.domain,
          issue: `Low weighted mixed-evidence composite score (${(breakdown.averageScore * 100).toFixed(0)}%)`,
          suggestion: `Review and enhance ${breakdown.specPath}, especially ${breakdown.weakestArea} descriptions`,
        });
      }
    }

    // Recommendation
    let recommendation: 'ready' | 'needs-review' | 'regenerate';
    if (overallConfidence >= this.options.passThreshold) {
      recommendation = 'ready';
    } else if (overallConfidence >= 0.5) {
      recommendation = 'needs-review';
    } else {
      recommendation = 'regenerate';
    }
    const recommendationQualification = failures.length > 0
      ? `${failures.length} of ${results.length + failures.length} attempted files could not be verified; aggregates cover successful files only.`
      : undefined;
    if (recommendation === 'ready' && failures.length > 0) recommendation = 'needs-review';

    return {
      timestamp: new Date().toISOString(),
      specVersion,
      attemptedFiles: results.length + failures.length,
      sampledFiles: results.length,
      failedFiles: failures.length,
      failures,
      aggregateBasis: 'successful-files',
      passedFiles,
      overallConfidence,
      overallConfidenceBasis: {
        kind: 'mean-of-weighted-mixed-evidence-composites',
        scoreComposition: VERIFICATION_SCORE_COMPOSITION,
      },
      domainBreakdown,
      commonGaps,
      recommendation,
      recommendationBasis: 'weighted-mixed-evidence-composite-threshold',
      ...(recommendationQualification ? { recommendationQualification } : {}),
      suggestedImprovements,
      results,
    };
  }

  /**
   * Save verification report
   */
  private async saveReport(report: VerificationReport): Promise<void> {
    await mkdir(this.options.outputDir, { recursive: true });

    // Save JSON report
    const jsonPath = join(this.options.outputDir, 'report.json');
    await writeFile(jsonPath, JSON.stringify(report, null, 2), 'utf-8');
    logger.discovery(`Saved JSON report to ${relative(this.options.rootPath, jsonPath)}`);

    // Save Markdown report
    const mdPath = join(this.options.outputDir, 'REPORT.md');
    const markdown = this.generateMarkdownReport(report);
    await writeFile(mdPath, markdown, 'utf-8');
    logger.discovery(`Saved Markdown report to ${relative(this.options.rootPath, mdPath)}`);
  }

  /**
   * Generate markdown report
   */
  private generateMarkdownReport(report: VerificationReport): string {
    const lines: string[] = [];

    lines.push('# Spec Verification Report');
    lines.push('');
    lines.push(`Generated: ${report.timestamp}`);
    lines.push(`Spec Version: ${escapeMarkdownInline(report.specVersion)}`);
    lines.push('');

    // Summary
    lines.push('## Summary');
    lines.push('');
    lines.push(`| Metric | Value |`);
    lines.push(`|--------|-------|`);
    lines.push(`| Files Attempted | ${report.attemptedFiles} |`);
    lines.push(`| Files Verified Successfully | ${report.sampledFiles} |`);
    lines.push(`| Files Failed Verification | ${report.failedFiles} |`);
    lines.push(`| Files Passed | ${report.passedFiles} (${report.sampledFiles > 0 ? ((report.passedFiles / report.sampledFiles) * 100).toFixed(0) : 'N/A'}%) |`);
    const overallBasis = report.overallConfidenceBasis
      ? 'weighted mixed-evidence composite: purpose 50%, requirements 35%, imports 5%, exports 10%'
      : 'provenance unavailable';
    lines.push(`| Overall Composite Confidence | ${(report.overallConfidence * 100).toFixed(1)}% (${overallBasis}) |`);
    lines.push(`| Recommendation | **${report.recommendation}** |`);
    lines.push(`| Recommendation Basis | ${report.recommendationBasis ?? 'provenance unavailable'} |`);
    lines.push(`| Aggregate Basis | ${report.aggregateBasis} |`);
    lines.push('');

    if (report.recommendationQualification) {
      lines.push(`> ${escapeMarkdownInline(report.recommendationQualification)}`);
      lines.push('');
    }

    // Recommendation explanation
    lines.push('### Recommendation');
    if (report.failedFiles > 0) {
      lines.push('⚠️ Verification was incomplete; review the failed files before relying on this result.');
    } else if (report.recommendation === 'ready') {
      lines.push('✅ The weighted mixed-evidence composite meets the configured readiness threshold.');
    } else if (report.recommendation === 'needs-review') {
      lines.push('⚠️ Specs need review. Some gaps were identified that should be addressed.');
    } else {
      lines.push('❌ Specs have significant gaps. Consider regenerating with improved context.');
    }
    lines.push('');

    if (report.failures.length > 0) {
      lines.push('## Verification Failures');
      lines.push('');
      for (const failure of report.failures) {
        lines.push(`- ${escapeMarkdownInline(failure.filePath)}: ${escapeMarkdownInline(failure.reason)}`);
      }
      lines.push('');
    }

    // Domain breakdown
    lines.push('## Domain Breakdown');
    lines.push('');
    lines.push('| Domain | Spec Path | Files | Avg Composite Score | Weakest Area |');
    lines.push('|--------|-----------|-------|-----------|--------------|');
    for (const domain of report.domainBreakdown) {
      const scorePercent = (domain.averageScore * 100).toFixed(0);
      lines.push(`| ${escapeMarkdownInline(domain.domain)} | ${escapeMarkdownInline(domain.specPath)} | ${domain.filesVerified} | ${scorePercent}% | ${escapeMarkdownInline(domain.weakestArea)} |`);
    }
    lines.push('');

    // Common gaps
    if (report.commonGaps.length > 0) {
      lines.push('## Common Gaps');
      lines.push('');
      for (const gap of report.commonGaps) {
        lines.push(`- ${escapeMarkdownInline(gap)}`);
      }
      lines.push('');
    }

    // Suggested improvements
    if (report.suggestedImprovements.length > 0) {
      lines.push('## Suggested Improvements');
      lines.push('');
      for (const improvement of report.suggestedImprovements) {
        lines.push(`### ${escapeMarkdownInline(improvement.domain)}`);
        lines.push(`- **Issue**: ${escapeMarkdownInline(improvement.issue)}`);
        lines.push(`- **Suggestion**: ${escapeMarkdownInline(improvement.suggestion)}`);
        lines.push('');
      }
    }

    // Detailed results
    lines.push('## Detailed Results');
    lines.push('');
    for (const result of report.results) {
      const scorePercent = (result.overallScore * 100).toFixed(0);
      const status = result.overallScore >= this.options.passThreshold ? '✅' : '❌';
      lines.push(`### ${status} ${escapeMarkdownInline(result.filePath)}`);
      lines.push('');
      lines.push(`- **Domain**: ${escapeMarkdownInline(result.domain)}`);
      const scoreBasis = result.scoreComposition
        ? 'weighted mixed-evidence composite: purpose 50%, requirements 35%, imports 5%, exports 10%'
        : 'provenance unavailable';
      lines.push(`- **Overall Composite Score**: ${scorePercent}% (${scoreBasis})`);
      const confidenceEvidence = result.llmConfidenceProvenance
        ? `llm-reported: ${escapeMarkdownInline(result.llmConfidenceProvenance.model)}`
        : 'provenance unavailable';
      lines.push(`- **LLM Confidence**: ${(result.llmConfidence * 100).toFixed(0)}% (${confidenceEvidence})`);
      lines.push('');
      lines.push('| Category | Score |');
      lines.push('|----------|-------|');
      const purposeEvidence = result.purposeMatch.provenance?.source === 'llm-judged'
        ? `llm-judged: ${escapeMarkdownInline(result.purposeMatch.provenance.model)}`
        : result.purposeMatch.provenance?.source === 'keyword-fallback'
          ? 'keyword-fallback'
          : 'provenance unavailable';
      const requirementEvidence = result.requirementCoverage.provenance?.source === 'llm-judged'
        ? `llm-judged: ${escapeMarkdownInline(result.requirementCoverage.provenance.model)}`
        : result.requirementCoverage.provenance?.source === 'keyword-fallback'
          ? 'keyword-fallback'
          : result.requirementCoverage.provenance?.source === 'none'
            ? 'none'
            : 'provenance unavailable';
      lines.push(`| Purpose Match | ${(result.purposeMatch.similarity * 100).toFixed(0)}% (${purposeEvidence}) |`);
      const importEvidence = result.importMatch.provenance?.source === 'deterministic'
        ? 'deterministic'
        : 'provenance unavailable';
      const exportEvidence = result.exportMatch.provenance?.source === 'llm-prediction-compared-deterministically'
        ? `deterministic comparison over ${escapeMarkdownInline(result.exportMatch.provenance.model)} prediction`
        : 'provenance unavailable';
      lines.push(`| Import Match (F1) | ${(result.importMatch.f1Score * 100).toFixed(0)}% (${importEvidence}) |`);
      lines.push(`| Export Match (F1) | ${(result.exportMatch.f1Score * 100).toFixed(0)}% (${exportEvidence}) |`);
      lines.push(`| Requirement Coverage | ${(result.requirementCoverage.coverage * 100).toFixed(0)}% (${requirementEvidence}) |`);
      lines.push('');

      if (result.feedback.length > 0) {
        lines.push('**Feedback:**');
        for (const fb of result.feedback) {
          lines.push(`- ${escapeMarkdownInline(fb)}`);
        }
        lines.push('');
      }
    }

    lines.push('---');
    lines.push('*Generated by openlore verify*');

    return lines.join('\n');
  }

  /**
   * Get list of domains from loaded specs.
   * If specs have not been loaded yet (i.e., verify() has not been called),
   * triggers an eager load so callers can preview domains without a full LLM run.
   */
  async getDomains(): Promise<string[]> {
    await this.ensureVerificationContext();
    return this.specs.map(s => s.domain);
  }
}

// ============================================================================
// CONVENIENCE FUNCTIONS
// ============================================================================

/**
 * Run verification on a project
 */
export async function verifySpecs(
  llm: LLMService,
  depGraph: DependencyGraphResult,
  options: VerificationEngineOptions,
  specVersion: string
): Promise<VerificationReport> {
  const engine = new SpecVerificationEngine(llm, options);
  return engine.verify(depGraph, specVersion);
}
