/**
 * Analysis Artifact Generator
 *
 * Takes all analysis results and generates structured output files
 * that will be consumed by the LLM generation phase and optionally by humans.
 */

import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { join, basename, isAbsolute } from 'node:path';
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
} from '../../constants.js';
import { buildStyleFingerprint, type StyleFingerprint } from './style-fingerprint.js';
import type { ScoredFile, ProjectType } from '../../types/index.js';
import type { RepositoryMap } from './repository-mapper.js';
import type { DependencyGraphResult } from './dependency-graph.js';
import { toMermaidFormat, injectCallGraphEdges, IMPLICIT_IMPORT_LANGS, SAME_PACKAGE_IMPLICIT_LANGS } from './dependency-graph.js';
import type { UIComponent } from './ui-component-extractor.js';
import type { SchemaTable } from './schema-extractor.js';
import type { RouteInventory } from './http-route-parser.js';
import type { MiddlewareEntry } from './middleware-extractor.js';
import type { EnvVar } from './env-extractor.js';

// Canonical cross-language test-file predicate. Re-exported here for the many
// existing importers (e.g. spec-pipeline); the call-graph builder imports the
// same shared definition so the two can no longer drift.
export { isTestFile } from './test-file.js';
import { isTestFile } from './test-file.js';

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

  constructor(options: ArtifactGeneratorOptions) {
    this.options = {
      rootDir: options.rootDir,
      outputDir: options.outputDir,
      maxDeepAnalysisFiles: options.maxDeepAnalysisFiles ?? 20,
      maxValidationFiles: options.maxValidationFiles ?? 5,
      tokensPerChar: options.tokensPerChar ?? TOKENS_PER_CHAR_DEFAULT,
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
    // Generate each artifact
    const repoStructure = this.generateRepoStructure(repoMap, depGraph, enrichment);
    const summaryMarkdown = this.generateSummaryMarkdown(repoMap, depGraph, repoStructure);
    const dependencyDiagram = this.generateDependencyDiagram(depGraph);
    const llmContext = await this.generateLLMContext(repoMap, depGraph);

    return {
      repoStructure,
      summaryMarkdown,
      dependencyDiagram,
      llmContext,
      styleFingerprint: this._styleFingerprint,
    };
  }

  /**
   * Generate and save all artifacts to disk
   */
  async generateAndSave(
    repoMap: RepositoryMap,
    depGraph: DependencyGraphResult,
    enrichment?: EnrichmentData
  ): Promise<AnalysisArtifacts> {
    const artifacts = await this.generate(repoMap, depGraph, enrichment);

    // Ensure output directory exists
    await mkdir(this.options.outputDir, { recursive: true });

    // Save each artifact
    const saves: Promise<void>[] = [
      writeFile(
        join(this.options.outputDir, ARTIFACT_REPO_STRUCTURE),
        JSON.stringify(artifacts.repoStructure, null, 2)
      ),
      writeFile(
        join(this.options.outputDir, 'SUMMARY.md'),
        artifacts.summaryMarkdown
      ),
      writeFile(
        join(this.options.outputDir, 'dependencies.mermaid'),
        artifacts.dependencyDiagram
      ),
      writeFile(
        join(this.options.outputDir, ARTIFACT_LLM_CONTEXT),
        // Strip the CFG/def-use overlay before persisting: it is DB-only and must
        // never enter the resident llm-context.json or the hot cache (spec:
        // add-intraprocedural-cfg-dataflow-overlay).
        JSON.stringify({ ...artifacts.llmContext, cfgs: undefined }, null, 2)
      ),
    ];

    if (enrichment?.schemas) {
      saves.push(writeFile(
        join(this.options.outputDir, ARTIFACT_SCHEMA_INVENTORY),
        JSON.stringify(enrichment.schemas, null, 2)
      ));
    }

    if (enrichment?.uiComponents) {
      saves.push(writeFile(
        join(this.options.outputDir, ARTIFACT_UI_INVENTORY),
        JSON.stringify(enrichment.uiComponents, null, 2)
      ));
    }

    if (enrichment?.routeInventory) {
      saves.push(writeFile(
        join(this.options.outputDir, ARTIFACT_ROUTE_INVENTORY),
        JSON.stringify(enrichment.routeInventory, null, 2)
      ));
    }

    if (enrichment?.middleware) {
      const { ARTIFACT_MIDDLEWARE_INVENTORY } = await import('../../constants.js');
      saves.push(writeFile(
        join(this.options.outputDir, ARTIFACT_MIDDLEWARE_INVENTORY),
        JSON.stringify(enrichment.middleware, null, 2)
      ));
    }

    if (enrichment?.envVars) {
      const { ARTIFACT_ENV_INVENTORY } = await import('../../constants.js');
      saves.push(writeFile(
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
        writeFile(
          join(this.options.outputDir, ARTIFACT_STYLE_FINGERPRINT),
          JSON.stringify(artifacts.styleFingerprint, null, 2)
        ).catch(() => {})
      );
    }

    await Promise.all(saves);

    // Write SQLite edge store alongside JSON artifacts (additive, non-fatal)
    if (artifacts.llmContext.callGraph) {
      try {
        const dbPath = join(this.options.outputDir, ARTIFACT_CALL_GRAPH_DB);
        await writeEdgesToSQLite(artifacts.llmContext.callGraph, dbPath, this.options.rootDir, artifacts.llmContext.cfgs);
      } catch {
        // Non-fatal — JSON artifacts are the source of truth
      }
    }

    return artifacts;
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
    const domains = this.generateDomains(repoMap, depGraph);

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
    depGraph: DependencyGraphResult
  ): DetectedDomain[] {
    const domains: DetectedDomain[] = [];

    // Use directory-based clusters from repo map
    for (const [dirName, files] of Object.entries(repoMap.clusters.byDomain)) {
      if (files.length === 0) continue;

      // Skip infrastructure directories
      const skipDirs = ['utils', 'helpers', 'common', 'shared', 'config', 'middleware'];
      if (skipDirs.includes(dirName.toLowerCase())) continue;

      // Extract potential entities from file names
      const entities = this.extractEntities(files);

      // Find the key file (highest score in domain)
      const keyFile = files.sort((a, b) => b.score - a.score)[0];

      // Generate suggested spec path
      const domainName = this.normalizeDomainName(dirName);

      domains.push({
        name: domainName,
        suggestedSpecPath: `openspec/specs/${domainName}/spec.md`,
        files: files.map(f => f.path),
        entities,
        keyFile: keyFile?.path ?? null,
      });
    }

    // Also consider clusters from dependency graph
    for (const cluster of depGraph.clusters) {
      const clusterName = this.normalizeDomainName(cluster.suggestedDomain);

      // Skip if already covered
      if (domains.some(d => d.name === clusterName)) continue;

      // Skip small clusters
      if (cluster.files.length < 2) continue;

      // Get file details
      const files = cluster.files
        .map(id => depGraph.nodes.find(n => n.id === id)?.file)
        .filter((f): f is ScoredFile => f !== undefined);

      if (files.length === 0) continue;

      const entities = this.extractEntities(files);
      const keyFile = files.sort((a, b) => b.score - a.score)[0];

      domains.push({
        name: clusterName,
        suggestedSpecPath: `openspec/specs/${clusterName}/spec.md`,
        files: files.map(f => f.path),
        entities,
        keyFile: keyFile?.path ?? null,
      });
    }

    return domains;
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
      .slice(0, this.options.maxDeepAnalysisFiles);

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
    const leafFiles = depGraph.rankings.leafNodes
      .map(id => depGraph.nodes.find(n => n.id === id)?.file)
      .filter((f): f is ScoredFile => f !== undefined)
      .filter(f => !phase2Paths.has(f.path))
      .filter(f => !isTestFile(f.path));

    // FIX 3: Fisher-Yates shuffle (sort(() => Math.random()) est biaisé + mute le tableau original)
    const shuffled = [...leafFiles];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    const validationFiles = shuffled.slice(0, this.options.maxValidationFiles);

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
    const { extractHtmlScripts } = await import('./html-script-extractor.js');
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
    // Skip inline-script extraction for very large HTML files: bounds the
    // same-length char-array allocation in extractHtmlScripts (the scan is O(N)).
    const MAX_HTML_INLINE_SCRIPT_CHARS = 1_000_000;
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

    for (const file of repoMap.allFiles) {
      try {
        const content = await readFile(file.absolutePath, 'utf-8');
        const isTest = isTestFile(file.path);

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
        const lang = resolveLang(file.path, content);
        if (CALL_GRAPH_LANGS.has(lang)) {
          callGraphFiles.push({ path: file.path, content, language: lang });
        } else if (/\.html?$/i.test(file.path) && content.length <= MAX_HTML_INLINE_SCRIPT_CHARS) {
          // Inline <script> JS (decision 5b38bad2): blank everything outside the
          // script bodies (newlines preserved) so the JS extractor parses the
          // islands at their true offsets and node line numbers map to the HTML
          // file. Skip files with no inline JS. Oversized HTML is skipped (a
          // bound on the per-file char-array allocation; the scan itself is O(N)).
          const blanked = extractHtmlScripts(content);
          if (blanked !== null) {
            callGraphFiles.push({ path: file.path, content: blanked, language: 'JavaScript' });
          }
        }
      } catch {
        // skip unreadable files
      }
    }

    // Build call graph
    const builder = new CallGraphBuilder();
    const callGraphResult = await builder.build(callGraphFiles);
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
      await writeFile(
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
      await writeFile(
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
): Promise<void> {
  const { EdgeStore } = await import('../services/edge-store.js');
  const store = EdgeStore.open(dbPath);
  try {
    store.clearAll();

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

    store.insertNodes(prodNodes, hubIds, entryIds);
    store.insertEdges(prodEdges);
    store.insertInheritanceEdges(inheritanceEdges);
    store.insertClasses(classes);

    // CFG/def-use overlay (spec: add-intraprocedural-cfg-dataflow-overlay).
    // Production functions only — keyed by the same normalized ids as nodes.
    if (cfgs && cfgs.length > 0) {
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
