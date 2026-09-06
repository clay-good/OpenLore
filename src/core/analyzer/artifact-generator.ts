/**
 * Analysis Artifact Generator
 *
 * Takes all analysis results and generates structured output files
 * that will be consumed by the LLM generation phase and optionally by humans.
 */

import { mkdir, readFile, rm } from 'node:fs/promises';
import { join, basename, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import { atomicWriteFile } from '../decisions/atomic-store.js';
import { writeJsonAtomicStreaming } from './json-stream.js';
import { withAnalysisLock } from '../runtime/advisory-lock.js';
import {
  TOKENS_PER_CHAR_DEFAULT,
  PHASE2_FILE_CONTENT_MAX_CHARS,
  PHASE3_FILE_CONTENT_MAX_CHARS,
  DEPENDENCY_DIAGRAM_MAX_FILES,
  ARTIFACT_REPO_STRUCTURE,
  ARTIFACT_LLM_CONTEXT,
  ARTIFACT_MAPPING,
  ARTIFACT_REFACTOR_PRIORITIES,
  ARTIFACT_SCHEMA_INVENTORY,
  ARTIFACT_ROUTE_INVENTORY,
  ARTIFACT_UI_INVENTORY,
  ARTIFACT_CALL_GRAPH_DB,
  ARTIFACT_STYLE_FINGERPRINT,
  ARTIFACT_PARSE_HEALTH,
  MAX_HTML_INLINE_SCRIPT_CHARS,
} from '../../constants.js';
import { graphDigest, writeTraversalIndexArtifact } from './condensation.js';
import { CfgSpill, sweepLeakedCfgSpills } from './cfg-spill.js';
import { buildStyleFingerprint, type StyleFingerprint } from './style-fingerprint.js';
import { buildParseHealthReport, isLossyUtf8, type ParseHealthReport, type FileParseHealth } from './parse-health.js';
import {
  resolveMemoryStrategy,
  withCfgOverlayShed,
  SHED_DEEP_ANALYSIS_FILE_CAP,
  type MemoryDegradation,
} from './memory-strategy.js';
import type { ScoredFile, ProjectType } from '../../types/index.js';
import type { RepositoryMap } from './repository-mapper.js';
import type { DependencyGraphResult } from './dependency-graph.js';
import { toMermaidFormat, injectCallGraphEdges, IMPLICIT_IMPORT_LANGS, SAME_PACKAGE_IMPLICIT_LANGS } from './dependency-graph.js';
import type { UIComponent } from './ui-component-extractor.js';
import type { SchemaTable } from './schema-extractor.js';
import type { RouteInventory } from './http-route-parser.js';
import type { MiddlewareEntry } from './middleware-extractor.js';
import type { EnvVar } from './env-extractor.js';
import { classifyDomainFile } from './domain-naming.js';
import {
  reconcileRepositoryDomains,
  type DomainCandidateDecision,
  type DomainDecisionSummary,
  type DomainEvidenceRole,
  type DomainReconciliationResult,
} from './domain-reconciliation.js';

function escapeMarkdownInline(value: string): string {
  return value
    // eslint-disable-next-line no-control-regex -- escape repository-controlled line/control bytes
    .replace(/[\x00-\x1f\x7f-\x9f]/g, character =>
      `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`)
    .replace(/([\\`*_[\]<>#])/g, '\\$1');
}

// Canonical cross-language test-file predicate. Re-exported here for the many
// existing importers (e.g. spec-pipeline); the call-graph builder imports the
// same shared definition so the two can no longer drift.
export { isTestFile } from './test-file.js';
import { isTestFile } from './test-file.js';
import { describePass1Cache, type BufferedPass1FactCache } from './pass1-fact-cache.js';

/**
 * Deterministically shuffle `items`, seeded from a hash of the sorted string keys.
 *
 * Artifact bytes must be a pure function of the input (decision c6d1ad07): the
 * phase-3 validation sample embedded in llm-context.json needs the "spread across
 * leaves" intent WITHOUT the non-determinism of `Math.random()`. The seed is
 * DERIVED from the candidate set (not a chosen constant), so identical input trees
 * shuffle identically on every machine, and a different candidate set reshuffles.
 * mulberry32 is a small, well-distributed PRNG; the Fisher-Yates itself is unchanged.
 */
function seededShuffle<T>(items: readonly T[], keyOf: (item: T) => string): T[] {
  const seedHex = createHash('sha1')
    .update([...items].map(keyOf).sort().join('\n'))
    .digest('hex')
    .slice(0, 8);
  let state = parseInt(seedHex, 16) >>> 0;
  // mulberry32
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const shuffled = [...items];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}

// ============================================================================
// TYPES
// ============================================================================

/**
 * Architecture layer information
 */
export interface ArchitectureLayer {
  name: string;
  purpose: string;
  files: string[];
  representativeFile: string | null;
}

/**
 * Detected domain (maps to OpenSpec spec)
 */
export interface DetectedDomain {
  name: string;
  suggestedSpecPath: string;
  files: string[];
  entities: string[];
  keyFile: string | null;
  /** Production files that established this domain. */
  definingFiles?: string[];
  /** Behavioral evidence attached only after domain reconciliation. */
  supportingFiles?: string[];
}

/**
 * Entry point information
 */
export interface EntryPointInfo {
  file: string;
  type: 'application-entry' | 'api-entry' | 'test-entry' | 'build-entry';
  initializes: string[];
}

/**
 * Data flow information
 */
export interface DataFlowInfo {
  sources: string[];
  sinks: string[];
  transformers: string[];
}

/**
 * Key files by category
 */
export interface KeyFiles {
  schemas: string[];
  config: string[];
  auth: string[];
  database: string[];
  routes: string[];
  services: string[];
}

/**
 * Repository structure (JSON artifact)
 */
export interface RepoStructure {
  projectName: string;
  projectType: string;
  frameworks: string[];
  architecture: {
    pattern: 'layered' | 'modular' | 'microservices' | 'monolith' | 'unknown';
    layers: ArchitectureLayer[];
  };
  domains: DetectedDomain[];
  /** Bounded, deterministic audit trail for raw domain-candidate dispositions. */
  domainDecisions?: DomainCandidateDecision[];
  /** Explicit receipt when the bounded candidate-decision audit trail is truncated. */
  domainDecisionSummary?: DomainDecisionSummary;
  /** Analyzed source files not represented by any detected domain. */
  undomained?: string[];
  /** Role-aware disclosure for analyzed files outside final domains. */
  undomainedEvidence?: DomainEvidenceRole[];
  entryPoints: EntryPointInfo[];
  dataFlow: DataFlowInfo;
  keyFiles: KeyFiles;
  /** Detected UI components (React, Vue, Svelte, Angular) */
  uiComponents: UIComponent[];
  /** Detected database schema tables */
  schemas: SchemaTable[];
  /** Aggregated HTTP route inventory */
  routeInventory: RouteInventory;
  /** Detected middleware entries */
  middleware: MiddlewareEntry[];
  /** Detected environment variables */
  envVars: EnvVar[];
  statistics: {
    totalFiles: number;
    analyzedFiles: number;
    skippedFiles: number;
    avgFileScore: number;
    nodeCount: number;
    edgeCount: number;
    cycleCount: number;
    clusterCount: number;
    /** Raw directory + graph candidates observed before reconciliation. */
    rawDomainCandidateCount?: number;
    /** Generation-ready domains after reconciliation. */
    finalDomainCount?: number;
  };
}

/**
 * LLM context phase
 */
export interface LLMContextPhase {
  purpose: string;
  files: Array<{
    path: string;
    content?: string;
    tokens: number;
  }>;
  totalTokens?: number;
  estimatedTokens?: number;
}

/**
 * LLM context preparation
 */
export interface LLMContext {
  phase1_survey: LLMContextPhase;
  phase2_deep: LLMContextPhase;
  phase3_validation: LLMContextPhase;
  /** Compact signatures for ALL analyzed files — used by Stage 1 instead of bare file paths */
  signatures?: import('./signature-extractor.js').FileSignatureMap[];
  /** Static call graph: function→function relationships across all TS/Python files */
  callGraph?: import('./call-graph.js').SerializedCallGraph;
  /**
   * Digest over exactly the call-graph facts the precomputed traversal structure
   * depends on (change: shrink-traversal-index-invalidation-scope). Written here so
   * a reader recovers the persisted structure's invalidation key from the parsed
   * context — no hashing of the artifact on the read path — and so an incremental
   * flush that leaves the graph untouched carries it through unchanged, keeping the
   * structure valid. Absent when there is no `callGraph`.
   */
  graphDigest?: string;
  /** Reconciled ownership domains shared by standalone and agent-hosted consumers. */
  domains?: DetectedDomain[];
  /**
   * Present ONLY on a partial first-run index (change: refine-first-run-partial-serving),
   * which lives in its own runtime directory and is never an analysis artifact. Its
   * presence on a parsed context is the single signal that says "this answer was computed
   * from an index that is still being built" — the completeness receipt every consumer
   * discloses, and the reason negative conclusions are withheld. A published analysis
   * never carries it.
   */
  partial?: import('../runtime/partial-index.js').PartialIndexStamp;
  /**
   * Per-function CFG + reaching-definitions overlay (spec:
   * add-intraprocedural-cfg-dataflow-overlay). Transient: written to the SQLite
   * store but STRIPPED before llm-context.json is persisted, so it never enters
   * the always-resident graph or the hot cache.
   */
  cfgs?: Array<{ functionId: string; filePath: string; cfg: import('./cfg.js').FunctionCfg }>;
}

/**
 * All generated artifacts
 */
export interface AnalysisArtifacts {
  repoStructure: RepoStructure;
  summaryMarkdown: string;
  dependencyDiagram: string;
  llmContext: LLMContext;
  /**
   * Descriptive per-language idiom profile (change: add-codebase-style-fingerprint), computed in
   * the call-graph AST walk and rolled up to repo/region/file. Absent when no supported language
   * is present (fail-soft). Persisted as its own `style-fingerprint.json` to keep the hot
   * llm-context.json lean.
   */
  styleFingerprint?: StyleFingerprint;
  /**
   * Per-file parse health (change: add-parse-health-boundary-disclosure): the files where
   * extraction silently under-produced (tree-sitter ERROR/MISSING regions, a swallowed parse
   * failure, or a lossy encoding decode), rolled up per language. Absent on a clean repo (no
   * artifact written), so a healthy repo pays zero. Persisted as its own `parse-health.json`.
   */
  parseHealth?: ParseHealthReport;
  /**
   * A one-line note about the Pass-1 extraction lane, present ONLY when something degraded
   * (change: optimize-parallel-extraction-pool) — a worker failed, or the worker pool could
   * not be used at all. It describes HOW the facts were computed, never WHAT they are.
   * Returned rather than logged
   * because `build()` also runs inside `openlore mcp`, whose stdout is the JSON-RPC channel;
   * only the CLI renders it.
   */
  extractionLaneNote?: string;
  /**
   * A one-line note naming how many files reused memoized Pass-1 facts, how many were
   * re-extracted, and — when nothing was reused — why (change: optimize-hash-keyed-analyze).
   * Set whenever a memo was consulted; unlike the lane note this is not a degradation report
   * but the standing disclosure that keeps the reused lane from being silent.
   *
   * RETURNED, never logged, for the same stdout reason as {@link extractionLaneNote}: this
   * code path also runs inside the stdio MCP server. Today only the CLI epilogue renders it,
   * so an embedded caller that wants the disclosure must read it from here — exactly as with
   * {@link extractionLaneNote}.
   */
  pass1CacheNote?: string;
  /**
   * What the graceful-degradation ladder shed under memory pressure, if anything (change:
   * make-analyze-scale-to-any-repo). Undefined at full fidelity. Also recorded inside
   * {@link parseHealth} for persistence; surfaced here too so a caller renders the one-line CLI
   * disclosure without re-reading the artifact — the same pattern as {@link extractionLaneNote}.
   */
  memoryDegradation?: MemoryDegradation;
}

/** Pass-1 memo rows to persist, plus the live path set the memo is pruned against. */
interface Pass1MemoWrite {
  stamp: string;
  rows: Array<{ filePath: string; contentHash: string; facts: string }>;
  analyzedPaths: string[];
}

/**
 * Optional enrichment data produced by new extractors, passed into generate().
 */
export interface EnrichmentData {
  uiComponents?: UIComponent[];
  schemas?: SchemaTable[];
  routeInventory?: RouteInventory;
  middleware?: MiddlewareEntry[];
  envVars?: EnvVar[];
}

/**
 * Options for artifact generation
 */
export interface ArtifactGeneratorOptions {
  /** Root directory of the project */
  rootDir: string;
  /** Output directory for artifacts */
  outputDir: string;
  /** Maximum files to include in LLM deep analysis */
  maxDeepAnalysisFiles?: number;
  /** Maximum files for validation phase */
  maxValidationFiles?: number;
  /** Approximate tokens per character for estimation */
  tokensPerChar?: number;
  /**
   * Re-extract every file instead of reusing memoized Pass-1 facts, then repopulate the memo
   * (change: optimize-hash-keyed-analyze). The reference output the reused lane is verified
   * against.
   *
   * Deliberately NOT called `force`. "Force" already means "do not skip this run" to every
   * caller that has one, and most of those callers — a daemon rebuilding after an edit batch,
   * a watcher healing a stale store — want exactly the re-analysis and none of the re-parsing.
   * Conflating the two would have removed the benefit from precisely the incremental workload
   * this exists for. `analyze --force` on the command line sets both, because a human typing
   * it is asking to trust nothing.
   */
  reExtract?: boolean;
}

/**
 * Convert a serialised RepoStructure (from repo-structure.json on disk) back
 * to a minimal RepositoryMap-compatible object.  Only the fields that
 * consumers of the cached-analysis path actually use are populated; the
 * file-level arrays (`allFiles`, `highValueFiles`, etc.) are left empty
 * because the original per-file data is not persisted to disk.
 */
export function repoStructureToRepoMap(rs: RepoStructure): RepositoryMap {
  return {
    metadata: {
      projectName: rs.projectName,
      projectType: (rs.projectType === 'node-typescript' ? 'nodejs' : rs.projectType) as import('../../types/index.js').ProjectType,
      rootPath: '',
      analyzedAt: '',
      version: '',
    },
    summary: {
      totalFiles: rs.statistics.totalFiles,
      analyzedFiles: rs.statistics.analyzedFiles,
      skippedFiles: rs.statistics.skippedFiles,
      languages: [],
      frameworks: rs.frameworks.map(name => ({
        name,
        category: 'other' as const,
        confidence: 'medium' as const,
        evidence: [],
      })),
      directories: [],
    },
    highValueFiles: [],
    entryPoints: [],
    schemaFiles: [],
    configFiles: [],
    clusters: {
      byDirectory: {},
      byDomain: {},
      byLayer: { presentation: [], business: [], data: [], infrastructure: [] },
    },
    allFiles: [],
  };
}

// ============================================================================
// ARTIFACT GENERATOR
// ============================================================================

/**
 * Generates analysis artifacts from repository map and dependency graph
 */
export class AnalysisArtifactGenerator {
  private options: Required<ArtifactGeneratorOptions>;
  /** Style fingerprint computed during the last generateLLMContext (call-graph walk). */
  private _styleFingerprint?: StyleFingerprint;
  /** Parse-health report computed during the last generateLLMContext (call-graph walk). */
  private _parseHealth?: ParseHealthReport;
  /**
   * What the graceful-degradation ladder shed on the last build under memory pressure, if anything
   * (change: make-analyze-scale-to-any-repo). Undefined at full fidelity. Also folded into
   * `_parseHealth` for persistence; kept here so callers can render the one-line CLI disclosure
   * without re-reading the artifact.
   */
  private _memoryDegradation?: MemoryDegradation;
  /** Pass-1 extraction-lane degradation note from the last generateLLMContext, if any. */
  private _extractionLaneNote?: string;
  /**
   * Pass-1 memo rows produced by the last generateLLMContext, plus the paths that were
   * analyzed (so rows for deleted files can be pruned). Persisted by generateAndSave through
   * the same store handle that rebuilds the graph (change: optimize-hash-keyed-analyze).
   */
  private _pass1Memo?: Pass1MemoWrite;
  /** Off-heap overlay hand-off for this build; drained into `cfg_overlay` after `clearAll()`. */
  private _cfgSpill: CfgSpill | undefined;
  /** Files reused vs. re-extracted on the last build — surfaced by the analyze summary. */
  private _pass1CacheNote?: string;

  constructor(options: ArtifactGeneratorOptions) {
    this.options = {
      rootDir: options.rootDir,
      outputDir: options.outputDir,
      maxDeepAnalysisFiles: options.maxDeepAnalysisFiles ?? 20,
      maxValidationFiles: options.maxValidationFiles ?? 5,
      tokensPerChar: options.tokensPerChar ?? TOKENS_PER_CHAR_DEFAULT,
      reExtract: options.reExtract ?? false,
    };
  }

  /**
   * Generate all artifacts
   */
  async generate(
    repoMap: RepositoryMap,
    depGraph: DependencyGraphResult,
    enrichment?: EnrichmentData
  ): Promise<AnalysisArtifacts> {
    // Preserve the pre-call-graph dependency artifacts before generateLLMContext injects
    // synthesized cross-file call edges into depGraph for traversal consumers.
    const repoStructure = this.generateRepoStructure(repoMap, depGraph, enrichment);
    const dependencyDiagram = this.generateDependencyDiagram(depGraph);
    let summaryMarkdown = this.generateSummaryMarkdown(repoMap, depGraph, repoStructure);
    const llmContext = await this.generateLLMContext(repoMap, depGraph);
    llmContext.domains = repoStructure.domains;
    const domainFiles = new Set(repoStructure.domains.flatMap(domain => domain.files));
    const undomained = [...new Set(
      repoMap.allFiles.map(file => file.path).filter(path => !domainFiles.has(path)),
    )].sort();
    const scoredByPath = new Map(repoMap.allFiles.map(file => [file.path, file]));
    const evidenceByPath = new Map((repoStructure.undomainedEvidence ?? []).map(item => [item.path, item]));
    for (const path of undomained) {
      const scored = scoredByPath.get(path);
      if (scored) evidenceByPath.set(path, { path, ...classifyDomainFile(scored) });
    }
    repoStructure.undomained = undomained;
    repoStructure.undomainedEvidence = [...evidenceByPath.values()].sort((a, b) => a.path.localeCompare(b.path));
    if (repoStructure.undomained.length > 0) {
      const byRole = (role: DomainEvidenceRole['role']) => repoStructure.undomainedEvidence!
        .filter(item => item.role === role).map(item => item.path);
      const renderPaths = (paths: string[]) => {
        const visible = paths.slice(0, 20).map(escapeMarkdownInline).join(', ');
        return paths.length > 20 ? `${visible}, … (${paths.length - 20} more)` : visible;
      };
      const roleLines = (['defining', 'supporting', 'excluded'] as const)
        .map(role => ({ role, paths: byRole(role) }))
        .filter(item => item.paths.length > 0)
        .map(item => `- **${item.role}** (${item.paths.length}): ${renderPaths(item.paths)}`);
      const disclosure = `\n**Undomained analyzed evidence by role**:\n${roleLines.join('\n')}\n`;
      summaryMarkdown = summaryMarkdown.replace('\n## Dependency Insights', `${disclosure}\n## Dependency Insights`);
    }

    return {
      repoStructure,
      summaryMarkdown,
      dependencyDiagram,
      llmContext,
      styleFingerprint: this._styleFingerprint,
      parseHealth: this._parseHealth,
      extractionLaneNote: this._extractionLaneNote,
      pass1CacheNote: this._pass1CacheNote,
      memoryDegradation: this._memoryDegradation,
    };
  }

  /**
   * Generate and save all artifacts to disk
   */
  async generateAndSave(
    repoMap: RepositoryMap,
    depGraph: DependencyGraphResult,
    enrichment?: EnrichmentData,
    persistence: { precomputed?: AnalysisArtifacts; acquireLock?: boolean } = {},
  ): Promise<AnalysisArtifacts> {
    const artifacts = persistence.precomputed ?? await this.generate(repoMap, depGraph, enrichment);

    // Ensure output directory exists
    await mkdir(this.options.outputDir, { recursive: true });

    // The artifact-write critical section runs under the analysis lock so a concurrent
    // writer of the same directory — a watcher's persist, or the watcher's own self-heal
    // `analyze --force` — cannot interleave its set with ours (change:
    // harden-artifact-write-atomicity). Each individual write is already atomic (temp +
    // rename via atomicWriteFile); the lock adds set-level serialization on top.
    const persist = async (): Promise<void> => {
      // Strip the CFG/def-use overlay before persisting: it is DB-only and must
      // never enter the resident llm-context.json or the hot cache (spec:
      // add-intraprocedural-cfg-dataflow-overlay).
      // Stamp the context with the graph digest BEFORE streaming it, so the value the
      // traversal structure is keyed to travels inside the artifact the reader already
      // parses (change: shrink-traversal-index-invalidation-scope). Computed over the
      // graph, not the artifact bytes, so a later signature-only flush that rewrites the
      // context carries it through unchanged and the structure stays valid.
      const cg = artifacts.llmContext.callGraph;
      if (cg) artifacts.llmContext.graphDigest = graphDigest(cg);

      // Streamed, never materialized as one string: `JSON.stringify` caps at V8's 536,870,888-char
      // string ceiling and throws `RangeError: Invalid string length` past it, which failed the
      // whole analysis on a large repository after all the work was already done (see
      // `json-stream.ts`).
      const contextPath = join(this.options.outputDir, ARTIFACT_LLM_CONTEXT);
      await writeJsonAtomicStreaming(
        contextPath,
        { ...artifacts.llmContext, cfgs: undefined }
      );

      // Save each artifact
      const saves: Promise<void>[] = [
        atomicWriteFile(
          join(this.options.outputDir, ARTIFACT_REPO_STRUCTURE),
          JSON.stringify(artifacts.repoStructure, null, 2)
        ),
        atomicWriteFile(
          join(this.options.outputDir, 'SUMMARY.md'),
          artifacts.summaryMarkdown
        ),
        atomicWriteFile(
          join(this.options.outputDir, 'dependencies.mermaid'),
          artifacts.dependencyDiagram
        ),
      ];

      if (enrichment?.schemas) {
        saves.push(atomicWriteFile(
          join(this.options.outputDir, ARTIFACT_SCHEMA_INVENTORY),
          JSON.stringify(enrichment.schemas, null, 2)
        ));
      }

      if (enrichment?.uiComponents) {
        saves.push(atomicWriteFile(
          join(this.options.outputDir, ARTIFACT_UI_INVENTORY),
          JSON.stringify(enrichment.uiComponents, null, 2)
        ));
      }

      if (enrichment?.routeInventory) {
        saves.push(atomicWriteFile(
          join(this.options.outputDir, ARTIFACT_ROUTE_INVENTORY),
          JSON.stringify(enrichment.routeInventory, null, 2)
        ));
      }

      if (enrichment?.middleware) {
        const { ARTIFACT_MIDDLEWARE_INVENTORY } = await import('../../constants.js');
        saves.push(atomicWriteFile(
          join(this.options.outputDir, ARTIFACT_MIDDLEWARE_INVENTORY),
          JSON.stringify(enrichment.middleware, null, 2)
        ));
      }

      if (enrichment?.envVars) {
        const { ARTIFACT_ENV_INVENTORY } = await import('../../constants.js');
        saves.push(atomicWriteFile(
          join(this.options.outputDir, ARTIFACT_ENV_INVENTORY),
          JSON.stringify(enrichment.envVars, null, 2)
        ));
      }

      // Style fingerprint (change: add-codebase-style-fingerprint) — its own artifact so the hot
      // llm-context.json stays lean. Absent when no supported language is present. Fail-soft: a
      // descriptive side artifact must never reject `Promise.all(saves)` and thereby abort analysis
      // or skip the SQLite edge-store write below — so its write failure is swallowed (matching the
      // non-fatal treatment of the edge store), unlike the source-of-truth artifacts above.
      if (artifacts.styleFingerprint) {
        saves.push(
          atomicWriteFile(
            join(this.options.outputDir, ARTIFACT_STYLE_FINGERPRINT),
            JSON.stringify(artifacts.styleFingerprint, null, 2)
          ).catch(() => {})
        );
      }

      // Parse health (change: add-parse-health-boundary-disclosure) — its own artifact, absent on a
      // clean repo. Same fail-soft treatment as the style fingerprint: a disclosure side artifact must
      // never abort analysis, so its write failure is swallowed.
      //
      // When the report is absent, DELETE any stale artifact rather than leave it (change:
      // make-analyze-scale-to-any-repo). Without this, a repo that goes from degraded to clean — a
      // syntax error fixed, or (the case this change adds) a full-fidelity run after one that shed a
      // tier under memory pressure — would keep serving the previous run's disclosure, and two
      // full-fidelity runs would then differ on disk based only on history. Best-effort unlink.
      if (artifacts.parseHealth) {
        saves.push(
          atomicWriteFile(
            join(this.options.outputDir, ARTIFACT_PARSE_HEALTH),
            JSON.stringify(artifacts.parseHealth, null, 2)
          ).catch(() => {})
        );
      } else {
        saves.push(
          rm(join(this.options.outputDir, ARTIFACT_PARSE_HEALTH), { force: true }).catch(() => {})
        );
      }

      // Precomputed reachability structure (change: optimize-reachability-precompute):
      // SCC condensation + CSR adjacency, so the reachability tools traverse a lookup
      // instead of rebuilding adjacency per call. Stamped with the same graph digest
      // written into the context above, so a reader refuses any structure that does not
      // belong to the graph it is serving.
      //
      // Written CONCURRENTLY with the set above (change:
      // shrink-traversal-index-invalidation-scope): the reader now decides currency by
      // comparing the digest carried in the context to the structure's stamp, so write
      // order no longer matters — the mtime pre-check that once required "structure
      // strictly after context" is gone. Fail-soft like the other side artifacts: a
      // write failure means the next read builds in memory, never that analysis aborts.
      if (cg) {
        saves.push(
          writeTraversalIndexArtifact(this.options.outputDir, cg, artifacts.llmContext.graphDigest!).catch(() => {})
        );
      }

      await Promise.all(saves);
    };

    const persistAll = async (): Promise<void> => {
      await persist();
      // Write SQLite edge store inside the same set-level lock as the JSON
      // artifacts. It is additive and non-fatal, but a watcher must not observe a
      // database from one generation beside JSON from another.
      try {
        if (artifacts.llmContext.callGraph) {
          const dbPath = join(this.options.outputDir, ARTIFACT_CALL_GRAPH_DB);
          await writeEdgesToSQLite(
            artifacts.llmContext.callGraph, dbPath, this.options.rootDir, artifacts.llmContext.cfgs,
            this._pass1Memo, this._cfgSpill,
          );
        }
      } catch {
        // Non-fatal — JSON artifacts are the source of truth
      } finally {
        // Release the serialized memo rows unconditionally: on a cold or forced build they are
        // the whole corpus (tens of MB), and nothing after this point — continuity
        // carry-forward, the dependency-graph write, the fingerprint — has any use for them.
        this._pass1Memo = undefined;
        // The spill has either been drained into the table or abandoned; either way the file is
        // temporary and must not outlive the build.
        await this._cfgSpill?.dispose();
        this._cfgSpill = undefined;
      }
    };

    if (persistence.acquireLock === false) {
      await persistAll();
    } else {
      await withAnalysisLock(this.options.outputDir, persistAll);
    }

    return artifacts;
  }

  /**
   * The repository structure alone, without the call-graph pass.
   *
   * The partial first-run index (change: refine-first-run-partial-serving) is flushed at
   * phase boundaries that precede that pass, so it needs exactly this much and nothing
   * more. Deliberately a thin accessor rather than a second code path: the structure a
   * partial index serves is byte-for-byte the structure the completed build computes from
   * the same inputs, minus the undomained roll-up `generate()` layers on afterwards.
   */
  generateStructureOnly(
    repoMap: RepositoryMap,
    depGraph: DependencyGraphResult,
    enrichment?: EnrichmentData,
  ): RepoStructure {
    return this.generateRepoStructure(repoMap, depGraph, enrichment);
  }

  /**
   * Generate repo-structure.json
   */
  private generateRepoStructure(
    repoMap: RepositoryMap,
    depGraph: DependencyGraphResult,
    enrichment?: EnrichmentData
  ): RepoStructure {
    // Detect architecture pattern
    const architecturePattern = this.detectArchitecturePattern(repoMap, depGraph);

    // Generate layers
    const layers = this.generateArchitectureLayers(repoMap);

    // Generate domains from clusters
    const domainResult = this.generateDomains(repoMap, depGraph, enrichment);
    const domains = domainResult.domains;

    // Generate entry points
    const entryPoints = this.generateEntryPoints(repoMap);

    // Generate data flow
    const dataFlow = this.generateDataFlow(repoMap);

    // Generate key files
    const keyFiles = this.generateKeyFiles(repoMap);

    // Calculate statistics
    const avgScore = repoMap.allFiles.length > 0
      ? repoMap.allFiles.reduce((sum, f) => sum + f.score, 0) / repoMap.allFiles.length
      : 0;

    return {
      projectName: repoMap.metadata.projectName,
      projectType: this.formatProjectType(repoMap.metadata.projectType),
      frameworks: repoMap.summary.frameworks.map(f => f.name),
      architecture: {
        pattern: architecturePattern,
        layers,
      },
      domains,
      domainDecisions: domainResult.decisions,
      domainDecisionSummary: domainResult.decisionSummary,
      undomained: [],
      undomainedEvidence: domainResult.unattachedEvidence,
      entryPoints,
      dataFlow,
      keyFiles,
      uiComponents: enrichment?.uiComponents ?? [],
      schemas: enrichment?.schemas ?? [],
      routeInventory: enrichment?.routeInventory ?? { total: 0, byMethod: {}, byFramework: {}, routes: [] },
      middleware: enrichment?.middleware ?? [],
      envVars: enrichment?.envVars ?? [],
      statistics: {
        totalFiles: repoMap.summary.totalFiles,
        analyzedFiles: repoMap.summary.analyzedFiles,
        skippedFiles: repoMap.summary.skippedFiles,
        avgFileScore: Math.round(avgScore * 10) / 10,
        nodeCount: depGraph.statistics.nodeCount,
        edgeCount: depGraph.statistics.edgeCount,
        cycleCount: depGraph.statistics.cycleCount,
        clusterCount: depGraph.statistics.clusterCount,
        rawDomainCandidateCount: domainResult.rawCandidateCount,
        finalDomainCount: domains.length,
      },
    };
  }

  /**
   * Format project type for display
   */
  private formatProjectType(type: ProjectType): string {
    const mapping: Record<ProjectType, string> = {
      nodejs: 'node-typescript',
      python: 'python',
      rust: 'rust',
      go: 'go',
      java: 'java',
      ruby: 'ruby',
      php: 'php',
      unknown: 'unknown',
    };
    return mapping[type] ?? type;
  }

  /**
   * Detect architecture pattern from code structure
   */
  private detectArchitecturePattern(
    repoMap: RepositoryMap,
    _depGraph: DependencyGraphResult
  ): 'layered' | 'modular' | 'microservices' | 'monolith' | 'unknown' {
    const dirs = repoMap.summary.directories;
    const dirNames = dirs.map(d => basename(d.path).toLowerCase());

    // Check for layered architecture indicators
    const layeredIndicators = ['controllers', 'services', 'repositories', 'routes', 'models', 'views'];
    const hasLayeredStructure = layeredIndicators.filter(i => dirNames.some(d => d.includes(i))).length >= 3;

    // Check for modular/domain-driven indicators
    const moduleIndicators = ['modules', 'features', 'domains'];
    const hasModularStructure = moduleIndicators.some(i => dirNames.includes(i));

    // Check for microservices indicators
    const hasMultiplePackageJson = repoMap.configFiles.filter(f => f.name === 'package.json').length > 1;
    const hasDockerCompose = repoMap.configFiles.some(f => f.name.includes('docker-compose'));

    // Determine pattern
    if (hasMultiplePackageJson && hasDockerCompose) {
      return 'microservices';
    }
    if (hasModularStructure) {
      return 'modular';
    }
    if (hasLayeredStructure) {
      return 'layered';
    }
    if (repoMap.summary.totalFiles < 50) {
      return 'monolith';
    }

    return 'unknown';
  }

  /**
   * Generate architecture layers
   */
  private generateArchitectureLayers(repoMap: RepositoryMap): ArchitectureLayer[] {
    const layers: ArchitectureLayer[] = [];

    // API/Routes layer
    const apiFiles = repoMap.allFiles.filter(f =>
      f.directory.includes('routes') ||
      f.directory.includes('controllers') ||
      f.directory.includes('api') ||
      f.name.includes('route') ||
      f.name.includes('controller')
    );
    if (apiFiles.length > 0) {
      layers.push({
        name: 'API Layer',
        purpose: 'HTTP request handling and routing',
        files: apiFiles.map(f => f.path),
        representativeFile: apiFiles[0]?.path ?? null,
      });
    }

    // Service/Business layer
    const serviceFiles = repoMap.allFiles.filter(f =>
      f.directory.includes('services') ||
      f.directory.includes('business') ||
      f.directory.includes('domain') ||
      f.name.includes('service') ||
      f.name.includes('manager')
    );
    if (serviceFiles.length > 0) {
      layers.push({
        name: 'Service Layer',
        purpose: 'Business logic and domain operations',
        files: serviceFiles.map(f => f.path),
        representativeFile: serviceFiles[0]?.path ?? null,
      });
    }

    // Data/Repository layer
    const dataFiles = repoMap.allFiles.filter(f =>
      f.directory.includes('repositories') ||
      f.directory.includes('data') ||
      f.directory.includes('database') ||
      f.directory.includes('models') ||
      f.name.includes('repository') ||
      f.name.includes('model')
    );
    if (dataFiles.length > 0) {
      layers.push({
        name: 'Data Layer',
        purpose: 'Data access and persistence',
        files: dataFiles.map(f => f.path),
        representativeFile: dataFiles[0]?.path ?? null,
      });
    }

    // Infrastructure layer
    const infraFiles = repoMap.allFiles.filter(f =>
      f.directory.includes('infrastructure') ||
      f.directory.includes('config') ||
      f.directory.includes('middleware') ||
      f.directory.includes('utils') ||
      f.isConfig
    );
    if (infraFiles.length > 0) {
      layers.push({
        name: 'Infrastructure Layer',
        purpose: 'Configuration, middleware, and utilities',
        files: infraFiles.map(f => f.path),
        representativeFile: infraFiles[0]?.path ?? null,
      });
    }

    return layers;
  }

  /**
   * Generate domains from clusters
   */
  private generateDomains(
    repoMap: RepositoryMap,
    depGraph: DependencyGraphResult,
    enrichment?: EnrichmentData,
  ): Omit<DomainReconciliationResult, 'domains'> & { domains: DetectedDomain[] } {
    const result = reconcileRepositoryDomains(repoMap, depGraph, {
      entryFiles: repoMap.entryPoints.map(file => file.path),
      routeFiles: enrichment?.routeInventory?.routes.map(route => route.file) ?? [],
      schemaFiles: enrichment?.schemas?.map(schema => schema.file) ?? [],
    });
    return {
      ...result,
      domains: result.domains.map(domain => {
        const defining = [...domain.definingFiles].sort((a, b) => a.path.localeCompare(b.path));
        const supporting = [...domain.supportingFiles].sort((a, b) => a.path.localeCompare(b.path));
        const domainName = this.normalizeDomainName(domain.name);
        const keyFile = [...defining].sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))[0];
        return {
          name: domainName,
          suggestedSpecPath: `openspec/specs/${domainName}/spec.md`,
          files: [...defining, ...supporting].map(file => file.path),
          definingFiles: defining.map(file => file.path),
          supportingFiles: supporting.map(file => file.path),
          entities: this.extractEntities(defining),
          keyFile: keyFile?.path ?? null,
        };
      }),
    };
  }

  /**
   * Normalize domain name for OpenSpec path
   */
  private normalizeDomainName(name: string): string {
    return name
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '') || 'misc';
  }

  /**
   * Extract potential entity names from files
   */
  private extractEntities(files: ScoredFile[]): string[] {
    const entities: Set<string> = new Set();

    for (const file of files) {
      // Extract from file name. Strip the final extension generically so
      // non-JS languages don't leak it into the entity name (e.g. Java's
      // `VetController.java` must not become `VetControllerJava`). See #138.
      const name = file.name.replace(/\.[a-z0-9]+$/i, '');

      // Java/Kotlin marker files are not entities (package-info.java →
      // "PackageInfo", module-info.java → "ModuleInfo" would be noise).
      if (/^(package|module)-info$/i.test(name)) continue;

      // Convert to PascalCase as potential entity name
      const entityName = name
        .split(/[-_.]/)
        .map(part => part.charAt(0).toUpperCase() + part.slice(1))
        .join('');

      // Skip generic names
      const skipNames = ['Index', 'Types', 'Utils', 'Helpers', 'Constants', 'Test', 'Spec'];
      if (!skipNames.includes(entityName) && entityName.length > 2) {
        entities.add(entityName);
      }
    }

    return Array.from(entities).slice(0, 5); // Limit to top 5
  }

  /**
   * Generate entry points information
   */
  private generateEntryPoints(repoMap: RepositoryMap): EntryPointInfo[] {
    return repoMap.entryPoints.map(file => {
      // Determine entry point type
      let type: EntryPointInfo['type'] = 'application-entry';
      if (file.name.includes('test') || file.name.includes('spec')) {
        type = 'test-entry';
      } else if (file.name.includes('route') || file.name.includes('api')) {
        type = 'api-entry';
      } else if (file.name.includes('build') || file.name.includes('webpack')) {
        type = 'build-entry';
      }

      // Infer what gets initialized (simplified)
      const initializes: string[] = [];
      if (file.name.includes('app') || file.name === 'index.ts') {
        initializes.push('application');
      }
      if (file.directory.includes('database')) {
        initializes.push('database');
      }

      return {
        file: file.path,
        type,
        initializes,
      };
    });
  }

  /**
   * Generate data flow information
   */
  private generateDataFlow(repoMap: RepositoryMap): DataFlowInfo {
    const sources: string[] = [];
    const sinks: string[] = [];
    const transformers: string[] = [];

    for (const file of repoMap.allFiles) {
      const dir = file.directory.toLowerCase();
      const name = file.name.toLowerCase();

      // Sources: routes, controllers, APIs
      if (dir.includes('routes') || dir.includes('controllers') || dir.includes('api')) {
        sources.push(file.path);
      }
      // Sinks: repositories, database, storage
      else if (dir.includes('repositories') || dir.includes('database') || dir.includes('storage')) {
        sinks.push(file.path);
      }
      // Transformers: services, middleware
      else if (dir.includes('services') || dir.includes('middleware') || name.includes('service')) {
        transformers.push(file.path);
      }
    }

    return { sources, sinks, transformers };
  }

  /**
   * Generate key files by category
   */
  private generateKeyFiles(repoMap: RepositoryMap): KeyFiles {
    const keyFiles: KeyFiles = {
      schemas: [],
      config: [],
      auth: [],
      database: [],
      routes: [],
      services: [],
    };

    for (const file of repoMap.allFiles) {
      if (file.tooling) continue;
      const dir = file.directory.toLowerCase();
      const name = file.name.toLowerCase();

      if (dir.includes('models') || dir.includes('schemas') || name.includes('schema')) {
        keyFiles.schemas.push(file.path);
      }
      if (file.isConfig || dir.includes('config')) {
        keyFiles.config.push(file.path);
      }
      if (dir.includes('auth') || name.includes('auth')) {
        keyFiles.auth.push(file.path);
      }
      if (dir.includes('database') || dir.includes('db') || name.includes('database')) {
        keyFiles.database.push(file.path);
      }
      if (dir.includes('routes') || name.includes('route')) {
        keyFiles.routes.push(file.path);
      }
      if (dir.includes('services') || name.includes('service')) {
        keyFiles.services.push(file.path);
      }
    }

    return keyFiles;
  }

  /**
   * Generate SUMMARY.md
   */
  private generateSummaryMarkdown(
    repoMap: RepositoryMap,
    depGraph: DependencyGraphResult,
    repoStructure: RepoStructure
  ): string {
    const lines: string[] = [];

    // Header
    lines.push(`# Repository Analysis: ${repoMap.metadata.projectName}`);
    lines.push('');

    // Overview
    lines.push('## Overview');
    lines.push(`- **Type**: ${this.formatProjectTypeReadable(repoMap.metadata.projectType)}`);
    if (repoMap.summary.frameworks.length > 0) {
      lines.push(`- **Frameworks**: ${repoMap.summary.frameworks.map(f => f.name).join(', ')}`);
    }
    lines.push(`- **Files Analyzed**: ${repoMap.summary.analyzedFiles} of ${repoMap.summary.totalFiles} (${repoMap.summary.skippedFiles} skipped)`);
    if (repoMap.summary.truncated) {
      // Match the CLI/repo-map disclosure: this digest describes only a truncated prefix.
      lines.push(
        `- **⚠️ Partial corpus**: analysis stopped at the ${repoMap.summary.truncated.limit}-file cap; the map below covers only that prefix.`,
      );
    }
    lines.push(`- **Analysis Date**: ${repoMap.metadata.analyzedAt}`);
    lines.push('');

    // Architecture
    lines.push('## Architecture Pattern');
    lines.push(`This appears to be a **${repoStructure.architecture.pattern}** architecture.`);
    if (repoStructure.architecture.layers.length > 0) {
      lines.push('');
      lines.push('**Detected Layers:**');
      for (const layer of repoStructure.architecture.layers) {
        lines.push(`- ${layer.name}: ${layer.purpose} (${layer.files.length} files)`);
      }
    }
    lines.push('');

    // Languages
    if (repoMap.summary.languages.length > 0) {
      lines.push('## Language Breakdown');
      lines.push('| Language | Files | Percentage |');
      lines.push('|----------|-------|------------|');
      for (const lang of repoMap.summary.languages.slice(0, 5)) {
        lines.push(`| ${lang.language} | ${lang.fileCount} | ${lang.percentage.toFixed(1)}% |`);
      }
      lines.push('');
    }

    // Domains
    if (repoStructure.domains.length > 0) {
      lines.push('## Detected Domains');
      const rawCount = repoStructure.statistics.rawDomainCandidateCount ?? repoStructure.domains.length;
      lines.push(`Reconciled **${rawCount} raw candidates** into **${repoStructure.domains.length} generation-ready domains**.`);
      lines.push('These domains will become OpenSpec specifications:');
      lines.push('');
      lines.push('| Domain | Files | Key Entities | Spec Path |');
      lines.push('|--------|-------|--------------|-----------|');
      for (const domain of repoStructure.domains.slice(0, 10)) {
        const entities = domain.entities.slice(0, 3).join(', ') || '-';
        lines.push(`| ${domain.name} | ${domain.files.length} | ${entities} | \`${domain.suggestedSpecPath}\` |`);
      }
      lines.push('');
    }
    // Dependency insights
    lines.push('## Dependency Insights');

    // Most connected
    const topConnected = depGraph.rankings.byConnectivity.slice(0, 3);
    if (topConnected.length > 0) {
      lines.push('');
      lines.push('**Most Connected Files:**');
      for (const nodeId of topConnected) {
        const node = depGraph.nodes.find(n => n.id === nodeId);
        if (node) {
          const totalDegree = node.metrics.inDegree + node.metrics.outDegree;
          lines.push(`- \`${node.file.path}\` (${totalDegree} connections)`);
        }
      }
    }

    // Cycles
    if (depGraph.cycles.length > 0) {
      lines.push('');
      lines.push(`**Circular Dependencies**: ${depGraph.cycles.length} cycle(s) detected`);
      for (const cycle of depGraph.cycles.slice(0, 3)) {
        const cycleFiles = cycle.map(id => {
          const node = depGraph.nodes.find(n => n.id === id);
          return node ? basename(node.file.path) : basename(id);
        });
        lines.push(`- ${cycleFiles.join(' → ')}`);
      }
    }

    // HTTP cross-language edges
    if (depGraph.statistics.httpEdgeCount > 0) {
      lines.push('');
      lines.push(`**HTTP Cross-Language Edges**: ${depGraph.statistics.httpEdgeCount} edge(s) detected between JS/TS callers and Python route handlers`);
      lines.push(`  (${depGraph.statistics.importEdgeCount} static import edges + ${depGraph.statistics.httpEdgeCount} HTTP edges = ${depGraph.statistics.edgeCount} total)`);
    }

    // Orphans
    if (depGraph.rankings.orphanNodes.length > 0) {
      lines.push('');
      lines.push(`**Orphan Files**: ${depGraph.rankings.orphanNodes.length} file(s) with no imports or exports`);
    }
    lines.push('');

    // Top files
    lines.push('## Files Selected for Deep Analysis');
    lines.push('The following files were selected as most significant:');
    lines.push('');
    const topFiles = repoMap.highValueFiles.slice(0, 15);
    for (let i = 0; i < topFiles.length; i++) {
      const file = topFiles[i];
      const tags = file.tags.length > 0 ? ` - ${file.tags.join(', ')}` : '';
      lines.push(`${i + 1}. \`${file.path}\` (score: ${file.score})${tags}`);
    }
    lines.push('');

    // Recommendations
    lines.push('## Recommendations');
    const recommendations: string[] = [];

    if (depGraph.cycles.length > 0) {
      recommendations.push(`- Consider breaking the ${depGraph.cycles.length} circular dependency cycle(s)`);
    }
    if (depGraph.rankings.orphanNodes.length > 0) {
      recommendations.push(`- Review ${depGraph.rankings.orphanNodes.length} orphan file(s) that may be unused`);
    }
    if (depGraph.rankings.bridgeNodes.length > 0) {
      recommendations.push(`- The following files are critical bridges: ${depGraph.rankings.bridgeNodes.slice(0, 3).map(id => {
        const node = depGraph.nodes.find(n => n.id === id);
        return node ? `\`${basename(node.file.path)}\`` : '';
      }).filter(Boolean).join(', ')}`);
    }

    if (recommendations.length === 0) {
      recommendations.push('- No immediate architectural concerns detected');
    }

    for (const rec of recommendations) {
      lines.push(rec);
    }
    lines.push('');

    // ── UI Components ─────────────────────────────────────────────────────────
    if (repoStructure.uiComponents.length > 0) {
      const byFramework: Record<string, number> = {};
      for (const c of repoStructure.uiComponents) {
        byFramework[c.framework] = (byFramework[c.framework] ?? 0) + 1;
      }
      lines.push('## UI Components');
      lines.push(`**Total**: ${repoStructure.uiComponents.length} component(s)`);
      for (const [fw, count] of Object.entries(byFramework)) {
        lines.push(`- ${fw}: ${count}`);
      }
      lines.push('');
    }

    // ── Database Schemas ──────────────────────────────────────────────────────
    if (repoStructure.schemas.length > 0) {
      const byOrm: Record<string, number> = {};
      for (const t of repoStructure.schemas) {
        byOrm[t.orm] = (byOrm[t.orm] ?? 0) + 1;
      }
      lines.push('## Database Schemas');
      lines.push(`**Total tables/models**: ${repoStructure.schemas.length}`);
      for (const [orm, count] of Object.entries(byOrm)) {
        lines.push(`- ${orm}: ${count} model(s)`);
      }
      lines.push('');
    }

    // ── Route Inventory ───────────────────────────────────────────────────────
    if (repoStructure.routeInventory.total > 0) {
      const inv = repoStructure.routeInventory;
      lines.push('## API Routes');
      lines.push(`**Total routes**: ${inv.total}`);
      const methodSummary = Object.entries(inv.byMethod)
        .sort((a, b) => b[1] - a[1])
        .map(([m, n]) => `${m}: ${n}`)
        .join(', ');
      if (methodSummary) lines.push(`- By method: ${methodSummary}`);
      const frameworkSummary = Object.entries(inv.byFramework)
        .sort((a, b) => b[1] - a[1])
        .map(([f, n]) => `${f}: ${n}`)
        .join(', ');
      if (frameworkSummary) lines.push(`- By framework: ${frameworkSummary}`);
      lines.push('');
    }

    // ── Environment Variables ─────────────────────────────────────────────────
    if (repoStructure.envVars.length > 0) {
      lines.push('## Environment Variables');
      lines.push(`**Total**: ${repoStructure.envVars.length} variable(s)`);
      const required = repoStructure.envVars.filter(v => v.required);
      if (required.length > 0) {
        lines.push(`- Required (no default): ${required.map(v => v.name).join(', ')}`);
      }
      lines.push('');
    }

    // Footer
    lines.push('---');
    lines.push(`*Generated by openlore v${repoMap.metadata.version}*`);

    return lines.join('\n');
  }

  /**
   * Format project type for human reading
   */
  private formatProjectTypeReadable(type: ProjectType): string {
    const mapping: Record<ProjectType, string> = {
      nodejs: 'Node.js/TypeScript',
      python: 'Python',
      rust: 'Rust',
      go: 'Go',
      java: 'Java',
      ruby: 'Ruby',
      php: 'PHP',
      unknown: 'Unknown',
    };
    return mapping[type] ?? type;
  }

  /**
   * Generate dependency diagram in Mermaid format
   */
  private generateDependencyDiagram(depGraph: DependencyGraphResult): string {
    // Use the built-in Mermaid converter with clustering
    const lines: string[] = ['```mermaid'];

    // Generate diagram with top files
    const mermaid = toMermaidFormat(depGraph, DEPENDENCY_DIAGRAM_MAX_FILES);
    lines.push(mermaid);

    lines.push('```');

    return lines.join('\n');
  }

  /**
   * Generate LLM context preparation
   */
  private async generateLLMContext(
    repoMap: RepositoryMap,
    depGraph: DependencyGraphResult
  ): Promise<LLMContext> {
    // Pre-flight capacity estimate + degradation ladder (change: make-analyze-scale-to-any-repo).
    // Deterministic in the repository (file count + total source bytes, both already known from the
    // mapper); the heap available to THIS process is the only machine-dependent input, and it can
    // only shed work down a declared ladder — never alter a full-fidelity result. Decided ONCE
    // here, before the heavy passes, so an over-capacity repository takes the reduced path up front
    // rather than discovering the ceiling by crashing partway through.
    const memoryStrategy = resolveMemoryStrategy({
      analyzedFileCount: repoMap.allFiles.length,
      totalSourceBytes: repoMap.allFiles.reduce((sum, f) => sum + (f.size ?? 0), 0),
    });
    this._memoryDegradation = memoryStrategy.degradation;
    // Tier 2 sheds deep-analysis breadth: cap the top-files list (a floor with the caller's own
    // limit, so a caller already asking for fewer keeps its number).
    const maxDeepAnalysisFiles = memoryStrategy.shedDeepAnalysis
      ? Math.min(this.options.maxDeepAnalysisFiles, SHED_DEEP_ANALYSIS_FILE_CAP)
      : this.options.maxDeepAnalysisFiles;

    // Phase 1: Survey (repo structure summary)
    const phase1: LLMContextPhase = {
      purpose: 'Initial project categorization',
      files: [
        {
          path: ARTIFACT_REPO_STRUCTURE,
          tokens: 2000, // Estimate
        },
      ],
      // FIX 1: estimatedTokens → totalTokens pour cohérence avec phase2/phase3
      totalTokens: 2000,
    };

    // Phase 2: Deep analysis (top files by importance, excluding test files)
    const phase2Files: LLMContextPhase['files'] = [];
    const topFiles = repoMap.highValueFiles
      .filter(f => !isTestFile(f.path))
      .slice(0, maxDeepAnalysisFiles);

    for (const file of topFiles) {
      try {
        const content = await readFile(file.absolutePath, 'utf-8');
        const tokens = Math.ceil(content.length * this.options.tokensPerChar);
        phase2Files.push({
          path: file.path,
          content: content.slice(0, PHASE2_FILE_CONTENT_MAX_CHARS),
          tokens,
        });
      } catch {
        // File couldn't be read, skip
      }
    }

    const phase2: LLMContextPhase = {
      purpose: 'Core entity and logic extraction',
      files: phase2Files,
      // FIX 2: tokens peut être undefined → utiliser ?? 0
      totalTokens: phase2Files.reduce((sum, f) => sum + (f.tokens ?? 0), 0),
    };

    // Phase 3: Validation (random leaf nodes not in phase 2, excluding test files)
    const phase2Paths = new Set(phase2Files.map(f => f.path));
    // Indexed, not scanned: `find` inside `map` is O(files²), and leaves are a large fraction of
    // a real repository's nodes — 49s at 80,000 files, 8s at 39,000, against ~50ms either way.
    const nodeById = new Map(depGraph.nodes.map(n => [n.id, n]));
    const leafFiles = depGraph.rankings.leafNodes
      .map(id => nodeById.get(id)?.file)
      .filter((f): f is ScoredFile => f !== undefined)
      .filter(f => !phase2Paths.has(f.path))
      .filter(f => !isTestFile(f.path));

    // Seeded Fisher-Yates: spread the sample across leaves deterministically. The
    // seed is derived from the sorted candidate paths, so two analyzes of an
    // identical tree embed the SAME validation files in the SAME order — the
    // artifact stays a pure function of the input (decision c6d1ad07).
    const validationFiles = seededShuffle(leafFiles, f => f.path).slice(
      0,
      this.options.maxValidationFiles
    );

    const phase3Files: LLMContextPhase['files'] = [];
    for (const file of validationFiles) {
      try {
        const content = await readFile(file.absolutePath, 'utf-8');
        const tokens = Math.ceil(content.length * this.options.tokensPerChar);
        phase3Files.push({
          path: file.path,
          content: content.slice(0, PHASE3_FILE_CONTENT_MAX_CHARS),
          tokens,
        });
      } catch {
        // File couldn't be read, skip
      }
    }

    const phase3: LLMContextPhase = {
      purpose: 'Verification samples',
      files: phase3Files,
      totalTokens: phase3Files.reduce((sum, f) => sum + (f.tokens ?? 0), 0),
    };

    // Signature extraction + call graph for ALL analyzed files
    // Read each file once and reuse the content for both operations.
    // All dynamic imports grouped here; CALL_GRAPH_LANGS hoisted out of the loop.
    const { extractSignatures, detectLanguage, resolveHeaderLanguage } = await import('./signature-extractor.js');
    const { CallGraphBuilder, serializeCallGraph } = await import('./call-graph.js');
    const { describeExtractionLane } = await import('./extraction-pool.js');
    const { extractHtmlScripts } = await import('./html-script-extractor.js');
    const { extractScriptContainer, summarizeScriptContainers } = await import('./sfc-script-extractor.js');
    const { detectDuplicates } = await import('./duplicate-detector.js');
    const { analyzeForRefactoring } = await import('./refactor-analyzer.js');
    const { classifyYaml, isDockerfilePath } = await import('./iac/index.js');

    const CALL_GRAPH_LANGS = new Set([
      'Python', 'TypeScript', 'JavaScript', 'Go', 'Rust', 'Ruby', 'Java', 'C++', 'Swift',
      // Additional general-purpose languages (spec-08).
      'C#', 'Kotlin', 'PHP', 'C', 'Scala', 'Dart', 'Lua', 'Elixir', 'Bash',
      // Infrastructure-as-Code (spec-07) — projected onto the same graph primitives.
      'Terraform', 'Kubernetes', 'Helm', 'CloudFormation', 'Ansible',
      // Container layer (add-docker-container-graph).
      'Dockerfile', 'Docker Compose',
      // CI/CD layer (add-github-actions-workflow-graph).
      'GitHub Actions',
      // Azure IaC DSL (add-bicep-iac-graph).
      'Bicep',
    ]);
    // Helm charts: every file under a directory containing Chart.yaml is Helm.
    const chartDirs = repoMap.allFiles
      .filter(f => /(^|\/)Chart\.ya?ml$/.test(f.path.replace(/\\/g, '/')))
      .map(f => f.path.replace(/\\/g, '/').replace(/\/Chart\.ya?ml$/, ''));
    const isUnderChart = (p: string): boolean => {
      const posix = p.replace(/\\/g, '/');
      return chartDirs.some(d => posix === d || posix.startsWith(d + '/'));
    };
    // .h disambiguation (spec-08): default is C++, but a project with .c files and
    // no C++ sources means its headers are C. Bias toward C++ (superset) otherwise.
    const exts = new Set(repoMap.allFiles.map(f => (f.path.split('.').pop() ?? '').toLowerCase()));
    const hasCppSources = exts.has('cpp') || exts.has('cc') || exts.has('cxx') || exts.has('hpp');
    const hasCSources = exts.has('c');
    const headerLang = resolveHeaderLanguage(hasCSources, hasCppSources);
    /** Resolve a language: extension first, then IaC YAML disambiguation, then .h heuristic. */
    const resolveLang = (path: string, content: string): string => {
      const lang = detectLanguage(path);
      if (lang === 'C++' && /\.h$/i.test(path)) return headerLang;
      if (lang !== 'unknown') return lang;
      // Dockerfiles have no extension to switch on; detect them by name here (not in
      // detectLanguage), keeping the incremental watcher's deletion path untouched —
      // consistent with how all IaC YAML is resolved (add-docker-container-graph).
      if (isDockerfilePath(path)) return 'Dockerfile';
      if (isUnderChart(path)) return 'Helm';
      if (/\.(ya?ml|json)$/i.test(path)) return classifyYaml(path, content) ?? 'unknown';
      return 'unknown';
    };
    const signatures: import('./signature-extractor.js').FileSignatureMap[] = [];
    const callGraphFiles: Array<{ path: string; content: string; language: string }> = [];
    // Files whose UTF-8 decode was lossy (contained U+FFFD) — a parse-health signal captured at the
    // one central read, since the call-graph extractors never see the raw bytes (change:
    // add-parse-health-boundary-disclosure).
    const encodingFallback = new Map<string, string>(); // path → language
    // HTML files dropped whole because they exceeded MAX_HTML_INLINE_SCRIPT_CHARS. This was a
    // silent exclusion — the file simply never reached the graph, and nothing said so (change:
    // fix-analyze-native-abort-and-file-cost-budget).
    const sizeCapped: Array<{ path: string; language: string }> = [];
    const scriptContainerFiles: import('./sfc-script-extractor.js').ScriptContainerFileRecord[] = [];

    for (const file of repoMap.allFiles) {
      try {
        // Read raw bytes so an encoding fallback (invalid UTF-8) is detectable at the byte level —
        // a decoded string alone can't distinguish a lossy decode from a legit U+FFFD in the source.
        const bytes = await readFile(file.absolutePath);
        const content = bytes.toString('utf-8');
        const isTest = isTestFile(file.path);
        const scriptContainer = extractScriptContainer(file.path, content);
        if (scriptContainer) {
          scriptContainerFiles.push({
            filePath: file.path,
            format: scriptContainer.format,
            scriptBlockCount: scriptContainer.scriptBlockCount,
            extractedScriptBlockCount: scriptContainer.extractedScriptBlockCount,
          });
        }

        // Signatures: exclude test files
        if (!isTest) {
          const map = extractSignatures(file.path, content);
          if (map.entries.length > 0) {
            signatures.push(map);
          }
        }

        // Call graph — all supported languages, INCLUDING test files: the call-graph
        // builder marks test nodes `isTest` (excluded from hubs/entry-points/stats) and
        // derives `tested_by` edges from them, which the test-impact tools (spec-19) need.
        // Test nodes/edges are filtered out again when writing the production edge store.
        if (scriptContainer) {
          if (scriptContainer.sizeCapped) {
            sizeCapped.push({ path: file.path, language: scriptContainer.format });
          } else if (scriptContainer.lanes.length > 0) {
            if (isLossyUtf8(bytes)) encodingFallback.set(file.path, scriptContainer.format);
            callGraphFiles.push({
              path: file.path,
              content,
              language: scriptContainer.format,
            });
          }
          continue;
        }
        const lang = resolveLang(file.path, content);
        if (CALL_GRAPH_LANGS.has(lang)) {
          if (isLossyUtf8(bytes)) encodingFallback.set(file.path, lang);
          callGraphFiles.push({ path: file.path, content, language: lang });
        } else if (/\.html?$/i.test(file.path)) {
          if (content.length > MAX_HTML_INLINE_SCRIPT_CHARS) {
            // Oversized HTML is skipped (a bound on the per-file char-array allocation; the scan
            // itself is O(N)) — and now SAYS so. Dropping it silently made any inline script it
            // contained read as genuinely absent.
            sizeCapped.push({ path: file.path, language: lang === 'unknown' ? 'HTML' : lang });
          } else {
            // Inline <script> JS (decision 5b38bad2): blank everything outside the
            // script bodies (newlines preserved) so the JS extractor parses the
            // islands at their true offsets and node line numbers map to the HTML
            // file. Skip files with no inline JS.
            const blanked = extractHtmlScripts(content);
            if (blanked !== null) {
              callGraphFiles.push({ path: file.path, content: blanked, language: 'JavaScript' });
            }
          }
        }
      } catch {
        // skip unreadable files
      }
    }

    // Build call graph. Pass-1 extraction consults the per-file fact memo (change:
    // optimize-hash-keyed-analyze) so an unchanged file is not re-parsed: the memo is read
    // through a READ-mode store handle, which never mutates the store on a schema mismatch or
    // a corrupt DB — both simply read as "no memo", costing a full extraction and nothing
    // else. Writes are buffered and persisted by generateAndSave through the same handle that
    // rebuilds the graph.
    const memo = await this.openPass1Memo();
    let callGraphResult: import('./call-graph.js').CallGraphResult;
    try {
      // Hand the overlay off to disk as it is produced (issue #304). It is pure write-through —
      // built, persisted to `cfg_overlay`, then stripped — so holding it across the whole build
      // made its footprint a function of total analyzed source for no functional reason. A spill
      // that cannot be opened is simply absent, and the in-memory path is used unchanged.
      // Clear debris from any earlier build that was killed before it could clean up. Both
      // artifacts are process-owned, so only those whose owner is gone are removed.
      await sweepLeakedCfgSpills(this.options.outputDir);
      const { TextLineIndex } = await import('./text-line-index.js');
      await TextLineIndex.sweepLeakedStaging(this.options.outputDir);

      // The overlay starts in memory and spills to a file only if it outgrows the threshold
      // (issue #306), so `open` no longer touches the disk and cannot fail here — an unwritable
      // directory surfaces at overflow, where it degrades to a disclosed missing overlay.
      this._cfgSpill = await CfgSpill.open(this.options.outputDir);
      const builder = new CallGraphBuilder({
        ...(memo ? { pass1Cache: memo.cache } : {}),
        ...(this._cfgSpill ? { cfgSpill: this._cfgSpill } : {}),
      });
      // Tier 1 of the degradation ladder: when the overlay is shed, the decision is bound for the
      // WHOLE build via a build-scoped async-context store, and forwarded to each extraction worker
      // through `workerData`, so every function's `buildCfgFor` short-circuits — no overlay is
      // produced and the spill stays empty. The base call graph is unaffected. A no-op wrapper at
      // full fidelity (change: make-analyze-scale-to-any-repo).
      callGraphResult = await withCfgOverlayShed(
        memoryStrategy.shedCfgOverlay,
        () => builder.build(callGraphFiles),
      );
      await this._cfgSpill?.finish();
    } finally {
      memo?.close();
    }
    this._pass1Memo = memo
      ? { ...memo.cache.take(), analyzedPaths: callGraphFiles.map(f => f.path) }
      : undefined;
    this._pass1CacheNote = describePass1Cache(callGraphResult.pass1Cache);
    // Stash the lane note for the CLI to render. Never logged from here: this code path
    // also runs inside the stdio MCP server (change: optimize-parallel-extraction-pool).
    this._extractionLaneNote = callGraphResult.extractionLane
      ? describeExtractionLane(callGraphResult.extractionLane)
      : undefined;
    const callGraph = serializeCallGraph(callGraphResult);

    // Style fingerprint (change: add-codebase-style-fingerprint): roll the raw per-file idiom
    // counters tallied in the call-graph walk up to repo/region/file, attributing files to the
    // community holding the plurality of their functions. Absent when no supported language is
    // present (fail-soft). Stashed for generate()/generateAndSave() to persist.
    this._styleFingerprint = callGraphResult.styleByFile
      ? buildStyleFingerprint(
          [...callGraphResult.styleByFile.values()],
          callGraph.nodes.map(n => ({
            filePath: n.filePath,
            communityId: n.communityId,
            communityLabel: n.communityLabel,
          })),
        )
      : undefined;

    // Parse health (change: add-parse-health-boundary-disclosure): merge the per-file ERROR/MISSING
    // + parse-failure records tallied in the call-graph walk with the encoding-fallback records
    // captured at the central read, then roll up. `undefined` (no artifact) on a clean repo — every
    // consumer reads "no artifact" as "nothing degraded", so a healthy repo pays zero. Stashed for
    // generate()/generateAndSave() to persist as its own `parse-health.json`.
    const parseHealthRecords = new Map<string, FileParseHealth>(callGraphResult.parseHealthByFile);
    for (const [path, language] of encodingFallback) {
      const existing = parseHealthRecords.get(path);
      if (existing) existing.encodingFallback = true;
      else parseHealthRecords.set(path, { filePath: path, language, errorCount: 0, missingCount: 0, errorLines: [], encodingFallback: true });
    }
    for (const { path, language } of sizeCapped) {
      parseHealthRecords.set(path, {
        filePath: path, language, errorCount: 0, missingCount: 0, errorLines: [],
        exclusion: 'size-cap',
      });
    }
    this._parseHealth = buildParseHealthReport(
      [...parseHealthRecords.values()],
      undefined,
      this._memoryDegradation,
      callGraphResult.grammarUnavailable,
      summarizeScriptContainers(scriptContainerFiles),
    );

    // Intra-procedural CFG/def-use overlay (spec: add-intraprocedural-cfg-dataflow-overlay).
    // Transient: persisted to SQLite by writeEdgesToSQLite, then stripped before
    // llm-context.json is written so it never becomes resident.
    const cfgs = callGraphResult.cfgs
      ? Array.from(callGraphResult.cfgs.entries()).map(([functionId, cfg]) => ({
          functionId,
          filePath: callGraphResult.nodes.get(functionId)?.filePath ?? functionId.split('::')[0],
          cfg,
        }))
      : undefined;

    // Synthesize file-level dependency edges from the call graph so the viewer
    // shows a meaningful graph. Two cases:
    //  - import-less languages (Swift, C++, C): only when there are no import
    //    edges at all, matching the original behavior.
    //  - JVM languages (Java, Kotlin): always, because they import across
    //    packages but reference same-package classes with no import — the
    //    import-only graph misses most relationships. injectCallGraphEdges
    //    dedupes against existing import edges, so this never double-counts.
    const hasImplicitImportFiles = callGraphFiles.some(f => IMPLICIT_IMPORT_LANGS.has(f.language));
    const hasSamePackageImplicitFiles = callGraphFiles.some(f => SAME_PACKAGE_IMPLICIT_LANGS.has(f.language));
    if (
      (hasImplicitImportFiles && depGraph.statistics.importEdgeCount === 0) ||
      hasSamePackageImplicitFiles
    ) {
      // Dep-graph nodes are keyed by absolute path; the call graph keys files by
      // the repo-relative path. Resolve to absolute so the two id spaces line up
      // (otherwise no call edge ever matches a dep-graph node).
      const nodeMap = new Map<string, string>(
        Array.from(callGraphResult.nodes.values()).map(n => [
          n.id,
          isAbsolute(n.filePath) ? n.filePath : join(this.options.rootDir, n.filePath),
        ])
      );
      injectCallGraphEdges(depGraph, callGraphResult.edges, id => nodeMap.get(id));
    }

    // Duplicate detection — static analysis, no LLM (Types 1-2-3)
    const duplicates = detectDuplicates(callGraphFiles, callGraphResult);

    // Save duplicates
    try {
      await atomicWriteFile(
        join(this.options.outputDir, 'duplicates.json'),
        JSON.stringify(duplicates, null, 2)
      );
    } catch {
      // non-fatal if output dir doesn't exist yet
    }

    // Refactoring priorities (structural — enriched after generate)
    let mappings: import('./refactor-analyzer.js').MappingEntry[] | undefined;
    try {
      const mappingRaw = await readFile(join(this.options.outputDir, ARTIFACT_MAPPING), 'utf-8');
      const mappingJson = JSON.parse(mappingRaw);
      mappings = mappingJson.mappings as import('./refactor-analyzer.js').MappingEntry[];
    } catch {
      // mapping.json not yet available — that's fine
    }
    const refactorReport = analyzeForRefactoring(callGraph, mappings, duplicates);

    // Save refactor priorities
    try {
      await atomicWriteFile(
        join(this.options.outputDir, ARTIFACT_REFACTOR_PRIORITIES),
        JSON.stringify(refactorReport, null, 2)
      );
    } catch {
      // non-fatal
    }

    return {
      phase1_survey: phase1,
      phase2_deep: phase2,
      phase3_validation: phase3,
      signatures,
      callGraph,
      cfgs,
    };
  }

  /**
   * Open the Pass-1 fact memo for one build (change: optimize-hash-keyed-analyze), or
   * `undefined` when there is nothing to memoize against and nothing to gain.
   *
   * Every failure mode here degrades to "extract everything", which is exactly today's
   * behavior — the memo is an optimization and is never allowed to be the reason a build
   * fails or answers differently. But each mode NAMES itself (`noReuseReason`) so the
   * epilogue can tell an operator who asked for a full re-extraction apart from one whose
   * memo is quietly unavailable. Even a bypassed memo still buffers writes, so a forced run
   * REPOPULATES it rather than leaving the next run to pay full price.
   */
  private async openPass1Memo(): Promise<{ cache: BufferedPass1FactCache; close: () => void } | undefined> {
    const { BufferedPass1FactCache, computeExtractorStamp, factCacheDisabledByEnv } =
      await import('./pass1-fact-cache.js');
    const { EdgeStore } = await import('../services/edge-store.js');
    const requested = this.options.reExtract || factCacheDisabledByEnv();

    let stamp: string;
    try {
      stamp = computeExtractorStamp();
    } catch {
      // No trustworthy stamp means nothing may be reused AND nothing may be written under a
      // key that cannot be reproduced. Still return a cache, with no storage and no writes to
      // persist, so the epilogue reports the cause instead of falling silent — this is the
      // failure that most needs saying out loud.
      return { cache: new BufferedPass1FactCache(null, '', 'no-stamp'), close: () => {} };
    }

    // No store yet (a first-ever analyze) means no rows to read. Opening one here would
    // create an empty graph DB before the graph exists, which a concurrent reader would see
    // as an index that is present and empty — the one thing the store lifecycle forbids.
    if (!EdgeStore.exists(this.options.outputDir)) {
      return {
        cache: new BufferedPass1FactCache(null, stamp, requested ? 'requested' : 'no-index-yet'),
        close: () => {},
      };
    }
    try {
      const store = EdgeStore.open(EdgeStore.dbPath(this.options.outputDir));
      const close = (): void => { try { store.close(); } catch { /* already closed */ } };
      try {
        // A not-ready store (schema mismatch / quarantined corruption) must not be queried,
        // and an index that predates the memo — or came from a bundle, which strips it — has
        // no table to query. Both are whole-store conditions, established once here rather
        // than rediscovered as a swallowed error on every file. Either way the write buffer
        // is kept, so this run leaves the memo behind for the next one.
        const reason = requested
          ? 'requested'
          : store.notReady
            ? 'index-not-ready'
            : store.hasPass1Facts() ? undefined : 'memo-absent';
        return {
          cache: new BufferedPass1FactCache(store.notReady ? null : store, stamp, reason),
          close,
        };
      } catch (err) {
        // The handle is open but unusable — close it here, or it leaks for the life of the
        // process (which, in the serve/MCP daemon, is every analyze it ever runs).
        close();
        throw err;
      }
    } catch {
      return {
        cache: new BufferedPass1FactCache(null, stamp, requested ? 'requested' : 'store-unreadable'),
        close: () => {},
      };
    }
  }

}

// ============================================================================
// SQLITE GRAPH STORE
// ============================================================================

/**
 * Writes the full call graph (nodes, edges, classes, inheritance) to SQLite.
 * Full rebuild on every analyze — incremental updates handled by the watcher.
 * Additive alongside llm-context.json; backward compat preserved.
 */
export async function writeEdgesToSQLite(
  callGraph: import('./call-graph.js').SerializedCallGraph,
  dbPath: string,
  rootPath?: string,
  cfgs?: Array<{ functionId: string; filePath: string; cfg: import('./cfg.js').FunctionCfg }>,
  pass1Memo?: Pass1MemoWrite,
  cfgSpill?: CfgSpill,
): Promise<void> {
  const { EdgeStore } = await import('../services/edge-store.js');
  // Analyze/write path: this is the one site allowed to drop-and-rebuild on a
  // SCHEMA_VERSION bump (and reopen fresh past a quarantined corrupt store), because
  // it repopulates the store immediately below (change: harden-index-store-lifecycle).
  const store = EdgeStore.openForAnalyze(dbPath);
  try {
    // Normalize absolute paths to relative — vector index uses relative IDs; DB must match.
    const prefix = rootPath ? (rootPath.endsWith('/') ? rootPath : rootPath + '/') : '';
    const norm = (s: string): string => (prefix && s.startsWith(prefix)) ? s.slice(prefix.length) : s;

    const nodes = prefix
      ? callGraph.nodes.map(n => ({ ...n, id: norm(n.id), filePath: norm(n.filePath) }))
      : callGraph.nodes;
    const edges = prefix
      ? callGraph.edges.map(e => ({ ...e, callerId: norm(e.callerId), calleeId: norm(e.calleeId) }))
      : callGraph.edges;
    const classes = prefix
      ? callGraph.classes.map(c => ({ ...c, id: norm(c.id), filePath: norm(c.filePath), methodIds: c.methodIds.map(norm) }))
      : callGraph.classes;
    const inheritanceEdges = prefix
      ? callGraph.inheritanceEdges.map(e => ({ ...e, parentId: norm(e.parentId), childId: norm(e.childId) }))
      : callGraph.inheritanceEdges;

    const hubIds   = new Set(callGraph.hubFunctions.map(n => norm(n.id)));
    const entryIds = new Set(callGraph.entryPoints.map(n => norm(n.id)));

    // The edge store is the PRODUCTION call graph: test nodes + their edges (and the
    // derived `tested_by` edges) live only in llm-context.json for the test-impact
    // tools. Filtering them here keeps analyze_impact / search / blast-radius — which
    // read the edge store — production-only and unchanged by test inclusion.
    const testNodeIds = new Set(nodes.filter(n => n.isTest).map(n => n.id));
    const prodNodes = nodes.filter(n => !n.isTest);
    const prodEdges = edges.filter(e =>
      e.kind !== 'tested_by' && !testNodeIds.has(e.callerId) && !testNodeIds.has(e.calleeId));

    // The production graph is one generation. Keep clear + every derived table in
    // one SQLite transaction so WAL readers continue to see the previous complete
    // graph until this replacement commits. A throw (including a failed CFG spill
    // drain) rolls the whole replacement back instead of leaving a half-built store
    // (change: harden-analyze-rebuild-atomicity).
    await store.transactionAsync(async () => {
      store.clearAll();
      store.insertNodes(prodNodes, hubIds, entryIds);
      store.insertEdges(prodEdges);
      store.insertInheritanceEdges(inheritanceEdges);
      store.insertClasses(classes);
      // SQLite is explicitly the production graph. Recompute its structural
      // metrics from the persisted production edges so full and scoped
      // publications share one contract even when llm-context retains test edges.
      store.recomputeStructuralMetrics();

    // CFG/def-use overlay (spec: add-intraprocedural-cfg-dataflow-overlay).
    // Production functions only — keyed by the same normalized ids as nodes.
    if (cfgSpill && !cfgSpill.failed) {
      // Drained here, AFTER `clearAll()` above — rows written during the build would have been
      // erased by it (change: harden-index-store-lifecycle). Normalization and the test-function
      // filter are applied identically to the in-memory path below, so the resulting table is the
      // same either way.
      await store.insertCfgRowsStreaming((async function* () {
        for await (const row of cfgSpill.drain()) {
          const functionId = norm(row.functionId);
          if (testNodeIds.has(functionId)) continue;
          yield { functionId, filePath: norm(row.filePath), cfgJson: row.cfgJson };
        }
      })());
    } else if (cfgs && cfgs.length > 0) {
      const normCfgs = cfgs
        .map(c => ({ functionId: norm(c.functionId), filePath: norm(c.filePath), cfg: c.cfg }))
        .filter(c => !testNodeIds.has(c.functionId));
      store.insertCfgs(normCfgs);
    }

    // Project the decision store onto first-class graph nodes + `affects` edges
    // (spec-16). Derived, like IaC: the JSON store stays authoritative. Active
    // decisions only; an empty/legacy store projects to nothing. Best-effort —
    // a malformed store must never fail the code-graph write.
    if (rootPath) {
      try {
        const { loadDecisionStore } = await import('../decisions/store.js');
        const { projectDecisions } = await import('../decisions/project.js');
        const decisionStore = await loadDecisionStore(rootPath);
        const projected = projectDecisions(decisionStore);
        const decisionNodes = projected.nodes.map(n => ({
          ...n,
          affectedFiles: n.affectedFiles.map(norm),
        }));
        const decisionEdges = projected.edges.map(e => ({ ...e, filePath: norm(e.filePath) }));
        store.insertDecisions(decisionNodes, decisionEdges);
      } catch {
        // Decision projection is additive; never block the graph write.
      }

      // Project local git/gh provenance onto the same files (spec-18). Local-only,
      // bounded, best-effort: a non-git/shallow repo yields nothing and never blocks
      // the graph write. Nothing is uploaded anywhere.
      try {
        const { extractProvenance } = await import('../provenance/git-provenance.js');
        const provFiles = [...new Set(
          nodes.filter(n => !n.isExternal).map(n => n.filePath),
        )];
        const provenance = await extractProvenance(rootPath, provFiles);
        if (provenance.length > 0) store.insertProvenance(provenance);
      } catch {
        // Provenance is additive and local-only; never block the graph write.
      }

      // Mine change coupling & volatility from local git history (spec-22).
      // Local-only, bounded, best-effort; advisory signals, never blocks analyze.
      try {
        const { analyzeChangeCoupling } = await import('../provenance/change-coupling.js');
        const coupling = await analyzeChangeCoupling(rootPath);
        if (coupling.churn.size > 0) store.insertChangeCoupling(coupling);
      } catch {
        // Change-coupling is additive and local-only; never block the graph write.
      }
    }

    // Persist the Pass-1 fact memo (change: optimize-hash-keyed-analyze) through the handle
    // that just rebuilt the graph, so the memo and the graph it produced are written in the
    // same operation and cannot disagree about which revision they describe. `clearAll` above
    // deliberately left the memo intact; here it is REPLACED for every re-extracted file and
    // PRUNED for every file that left the analyzed set — a deleted file leaves no facts a
    // later run could serve. Additive + best-effort: losing the memo costs the next run a
    // full extraction, never a wrong answer.
    if (pass1Memo) {
      try {
        // One transaction: replace-then-prune is a single "the memo now describes THIS tree"
        // step, and a crash between the halves would otherwise leave rows for files that are
        // gone (harmless — they are key-guarded and never looked up — but it would make the
        // sentence above literally untrue).
        store.transaction(() => {
          store.putPass1Facts(pass1Memo.rows, pass1Memo.stamp);
          store.prunePass1Facts(pass1Memo.analyzedPaths);
        });
      } catch {
        // A memo that cannot be written is simply a memo the next run will not find.
      }
    }
    });

    // Index integrity attestation (change: add-index-integrity-attestation). Records
    // what this build committed to the production graph so a later load can reconcile
    // the on-disk store against it and refuse to serve a half-built/truncated index as
    // complete. Computed from the same production set that was just inserted, so the
    // counts reconcile exactly. Additive + best-effort — a failure here never fails the
    // graph write (the JSON artifacts remain the source of truth).
    try {
      const { SCHEMA_VERSION } = await import('../services/edge-store.js');
      const { computeAttestation, writeAttestation } = await import('./index-attestation.js');
      const { dirname } = await import('node:path');
      // Count the SAME population the load recounts: internal (non-external),
      // non-test nodes — matching EdgeStore.countNodes()/countFiles() (WHERE
      // is_external = 0). prodEdges/classes already match countEdges()/countClasses()
      // one-to-one. Counting external nodes here would inflate `committed` and
      // falsely flag a healthy index as `degraded`.
      const internalProdNodes = prodNodes.filter(n => !n.isExternal);
      const attestation = computeAttestation(SCHEMA_VERSION, internalProdNodes, prodEdges, classes);
      await writeAttestation(dirname(dbPath), attestation);
    } catch {
      // Attestation is additive; never block the graph write.
    }
  } finally {
    store.close();
  }
}

// ============================================================================
// CONVENIENCE FUNCTIONS
// ============================================================================

/**
 * Generate all artifacts
 */
export async function generateArtifacts(
  repoMap: RepositoryMap,
  depGraph: DependencyGraphResult,
  options: ArtifactGeneratorOptions
): Promise<AnalysisArtifacts> {
  const generator = new AnalysisArtifactGenerator(options);
  return generator.generate(repoMap, depGraph);
}

/**
 * Generate and save all artifacts
 */
export async function generateAndSaveArtifacts(
  repoMap: RepositoryMap,
  depGraph: DependencyGraphResult,
  options: ArtifactGeneratorOptions
): Promise<AnalysisArtifacts> {
  const generator = new AnalysisArtifactGenerator(options);
  return generator.generateAndSave(repoMap, depGraph);
}
