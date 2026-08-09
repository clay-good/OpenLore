/**
 * Spec Generation Pipeline
 *
 * Orchestrates the multi-step LLM process to generate accurate specifications
 * in OpenSpec format from code analysis.
 */

import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import logger from '../../utils/logger.js';
import { SKELETON_EXCERPT_MAX_CHARS, SKELETON_STANDALONE_MAX_CHARS, STAGE_CHUNK_MAX_CHARS } from '../../constants.js';
import type { ProgressIndicator } from '../../utils/progress.js';
import type { LLMService } from '../services/llm-service.js';
import type { RepoStructure, LLMContext } from '../analyzer/artifact-generator.js';
import { buildGraphPromptSection, getFileGodFunctions, extractSubgraph } from '../analyzer/subgraph-extractor.js';
import { protectPrompt } from '../../utils/prompt-boundary.js';
import { getSkeletonContent, isSkeletonWorthIncluding } from '../analyzer/code-shaper.js';
import { detectLanguage } from '../analyzer/language-detection.js';
import type { DependencyGraphResult } from '../analyzer/dependency-graph.js';
import type { RefactorReport } from '../analyzer/refactor-analyzer.js';
import { isTestFile } from '../analyzer/artifact-generator.js';
import { runStage1 } from './stages/stage1-survey.js';
import { runStage2 } from './stages/stage2-entities.js';
import { runStage3 } from './stages/stage3-services.js';
import { runStage4 } from './stages/stage4-api.js';
import { runStage5 } from './stages/stage5-architecture.js';
import { runStage6 } from './stages/stage6-adr.js';
import { PROMPTS } from './prompts.js';
import { SUBSPEC_SCHEMA } from './schemas.js';
import type {
  ProjectSurveyResult,
  ExtractedEntity,
  ExtractedService,
  ExtractedEndpoint,
  ArchitectureSynthesis,
  ArchitecturePattern,
  EnrichedADR,
  PipelineResult,
  StageResult,
  PipelineOptions,
  PipelineContext,
  ServiceSubSpec,
  SemanticSearchFn,
} from '../../types/pipeline.js';

// Re-export all types for backward compatibility with external consumers
export type {
  ProjectCategory,
  ArchitecturePattern,
  ProjectSurveyResult,
  EntityProperty,
  EntityRelationship,
  Scenario,
  ExtractedEntity,
  ServiceOperation,
  ServiceSubSpec,
  ExtractedService,
  ExtractedEndpoint,
  ArchitectureLayer,
  ArchitectureSynthesis,
  EnrichedADR,
  PipelineResult,
  StageResult,
  PipelineOptions,
  PipelineContext,
} from '../../types/pipeline.js';

// ============================================================================
// SPEC GENERATION PIPELINE
// ============================================================================

/**
 * Spec Generation Pipeline
 */
export class SpecGenerationPipeline implements PipelineContext {
  llm: LLMService;
  options: Required<Omit<PipelineOptions, 'progress' | 'semanticSearch'>>;
  private progress?: ProgressIndicator;
  private semanticSearch?: SemanticSearchFn;
  /** Set at the start of run() and used by stage methods for graph-based prompts */
  private currentLLMContext?: LLMContext;
  /** Set at the start of run() and used by schemasFor() / routesFor() */
  private currentRepoStructure?: RepoStructure;

  constructor(llm: LLMService, options: PipelineOptions) {
    this.llm = llm;
    this.progress = options.progress;
    this.semanticSearch = options.semanticSearch;
    this.options = {
      outputDir: options.outputDir,
      skipStages: options.skipStages ?? [],
      resumeFrom: options.resumeFrom ?? '',
      force: options.force ?? false,
      maxRetries: options.maxRetries ?? 2,
      rootPath: options.rootPath ?? '',
      saveIntermediate: options.saveIntermediate ?? true,
      generateADRs: options.generateADRs ?? false,
      chunkMaxChars: options.chunkMaxChars ?? STAGE_CHUNK_MAX_CHARS,
    };
  }

  /**
   * Run the complete pipeline
   */
  async run(
    repoStructure: RepoStructure,
    llmContext: LLMContext,
    depGraph?: DependencyGraphResult,
    refactorReport?: RefactorReport
  ): Promise<PipelineResult> {
    this.currentLLMContext = llmContext;
    this.currentRepoStructure = repoStructure;
    const startTime = Date.now();
    let totalTokens = 0;
    const completedStages: string[] = [];
    const skippedStages: string[] = [];

    // Ensure output directory exists
    if (this.options.saveIntermediate) {
      await mkdir(this.options.outputDir, { recursive: true });
    }

    const totalStages = this.options.generateADRs ? 6 : 5;
    let stageNum = 0;

     const startStage = (name: string, label: string) => {
       stageNum++;
       if (this.progress) {
         this.progress.updateGeneration({ stage: stageNum, totalStages, stageName: label });
       } else {
         logger.analysis(`Running Stage ${stageNum}: ${label}`);
       }
     };

     // Helper to execute a pipeline stage with consistent error handling
     const executeStage = async <T extends object>(
       name: string,
       label: string,
       runner: () => Promise<StageResult<T>>,
       fallback: () => T | Promise<T>,
       normalize?: (data: T) => T,
       onSuccess?: (data: T) => void
     ): Promise<T> => {
       if (!this.shouldRunStage(name)) {
         skippedStages.push(name);
         const saved = await this.loadStageResult<T>(name);
         if (saved?.success && saved.data) {
           logger.analysis(`Resume: loaded ${name} from disk`);
           let data = saved.data;
           if (normalize) data = normalize(data);
           if (onSuccess) onSuccess(data);
           return data;
         }
         return fallback();
       }

       // Auto-resume: if a cached result exists on disk and --force is not set, skip the LLM call
       if (!this.options.force) {
         const cached = await this.loadStageResult<T>(name);
         if (cached?.success && cached.data) {
           logger.analysis(`Auto-resume: ${name} already complete, loading from disk`);
           skippedStages.push(name);
           let data = cached.data;
           if (normalize) data = normalize(data);
           if (onSuccess) onSuccess(data);
           return data;
         }
       }

       startStage(name, label);
       const result = await runner();

       if (result.success && result.data) {
         let data = result.data;
         if (normalize) data = normalize(data);
         totalTokens += result.tokens;
         completedStages.push(name);
         if (onSuccess) onSuccess(data);
         return data;
      } else {
        const errorMsg = result.error ?? 'Unknown error';
        this.progress?.stop();
        logger.warning(`${label} failed: ${errorMsg}`);
        if (name === 'survey' && /Unauthorized|401|403/i.test(errorMsg)) {
          throw new Error(`API authentication failed: ${errorMsg}. Check your API key`);
        }
        return await fallback();
      }
      };

      // Stage 1: Project Survey
      const survey = await executeStage(
        'survey',
        'Project Survey',
        async () => runStage1(this.llm, this.options, this.saveResult.bind(this), repoStructure, llmContext),
        () => this.getDefaultSurvey(repoStructure),
        data => ({
          ...data,
          frameworks: data.frameworks ?? [],
          suggestedDomains: data.suggestedDomains ?? [],
          schemaFiles: data.schemaFiles ?? [],
          serviceFiles: data.serviceFiles ?? [],
          apiFiles: data.apiFiles ?? [],
        })
      );

      // Stage 2: Entity Extraction
      let entities: ExtractedEntity[] = [];
      const schemaFiles = await this.resolveFiles(llmContext, survey.schemaFiles ?? [], await this.getSchemaFiles(llmContext));
      if (schemaFiles.length > 0) {
        entities = await executeStage(
          'entities',
          'Entity Extraction',
          async () => runStage2(this, survey, schemaFiles, (i, total, file) => {
            this.progress?.updateGeneration({ stage: stageNum, totalStages, stageName: `Entity Extraction ${i}/${total}: ${file}` });
          }),
          () => []
        );
      } else {
        logger.warning('No schema files found, skipping entity extraction');
        skippedStages.push('entities');
      }

      // Stage 3: Service Analysis
      let services: ExtractedService[] = [];
      const serviceFiles = await this.resolveFiles(llmContext, survey.serviceFiles ?? [], await this.getServiceFiles(llmContext));
      if (serviceFiles.length > 0) {
        services = await executeStage(
          'services',
          'Service Analysis',
          async () => runStage3(this, survey, entities, serviceFiles, (i, total, file) => {
            this.progress?.updateGeneration({ stage: stageNum, totalStages, stageName: `Service Analysis ${i}/${total}: ${file}` });
          }),
          () => []
        );
      } else {
        logger.warning('No service files found, skipping service analysis');
        skippedStages.push('services');
      }

       // Stage 4: API Extraction
       let endpoints: ExtractedEndpoint[] = [];
       const apiFiles = await this.resolveFiles(llmContext, survey.apiFiles ?? [], await this.getApiFiles(llmContext));
       if (apiFiles.length > 0) {
         endpoints = await executeStage(
           'api',
           'API Extraction',
           async () => runStage4(this, apiFiles, (i, total, file) => {
             this.progress?.updateGeneration({ stage: stageNum, totalStages, stageName: `API Extraction ${i}/${total}: ${file}` });
           }),
           () => []
         );
       } else {
         logger.warning('No API files found, skipping API extraction');
         skippedStages.push('api');
       }

       // Stage 5: Architecture Synthesis
       const architecture = await executeStage(
         'architecture',
         'Architecture Synthesis',
         async () => runStage5(this, survey, entities, services, endpoints, depGraph, llmContext.callGraph, refactorReport),
         () => this.getDefaultArchitecture(survey),
         data => ({
           ...data,
           layerMap: data.layerMap ?? [],
           integrations: data.integrations ?? [],
           keyDecisions: data.keyDecisions ?? [],
         })
       );

      // Stage 6: ADR Enrichment (optional)
      let adrs: EnrichedADR[] = [];
      if (this.options.generateADRs && this.shouldRunStage('adr')) {
        if (architecture.keyDecisions.length > 0) {
          adrs = await executeStage(
            'adr',
            'ADR Enrichment',
            async () => runStage6(this, architecture),
            () => [] as EnrichedADR[]
          );
        } else {
          logger.warning('No key decisions found, skipping ADR enrichment');
          skippedStages.push('adr');
        }
      }

    const duration = Date.now() - startTime;
    const costTracking = this.llm.getCostTracking();

    const pipelineResult: PipelineResult = {
      survey,
      entities,
      services,
      endpoints,
      architecture,
      adrs: adrs.length > 0 ? adrs : undefined,
      metadata: {
        totalTokens,
        estimatedCost: costTracking.estimatedCost,
        duration,
        completedStages,
        skippedStages,
      },
    };

    // Save final result
    if (this.options.saveIntermediate) {
      await this.saveResult('pipeline-result', pipelineResult);
    }

    logger.success(`Pipeline completed in ${(duration / 1000).toFixed(1)}s, ${totalTokens} tokens used`);

    return pipelineResult;
  }

  /**
   * Check if a stage should run
   */
  private shouldRunStage(stage: string): boolean {
    if (this.options.skipStages.includes(stage)) {
      return false;
    }

    if (this.options.resumeFrom) {
      const stages = ['survey', 'entities', 'services', 'api', 'architecture', 'adr'];
      const resumeIndex = stages.indexOf(this.options.resumeFrom);
      const currentIndex = stages.indexOf(stage);
      return currentIndex >= resumeIndex;
    }

    return true;
  }

  /**
   * Split file content into chunks, breaking only on blank lines (function/class boundaries).
   * A chunk is emitted when its size exceeds maxChars and a blank line is encountered.
   * overlapLines trailing lines from the previous chunk are prepended to the next one,
   * preserving context (e.g. class declaration visible when processing its methods).
   */
  chunkContent(content: string, maxChars: number, overlapLines = 10): string[] {
    if (content.length <= maxChars) return [content];

    const lines = content.split('\n');
    const chunks: string[] = [];
    let currentLines: string[] = [];
    let currentSize = 0;

    for (const line of lines) {
      currentLines.push(line);
      currentSize += line.length + 1;

      // Break only at blank lines once the threshold is reached
      if (currentSize >= maxChars && line.trim() === '') {
        const chunk = currentLines.join('\n').trim();
        if (chunk.length > 0) chunks.push(chunk);
        // Carry over the last N lines as overlap for the next chunk
        const overlap = currentLines.slice(-overlapLines);
        currentLines = [...overlap];
        currentSize = overlap.reduce((s, l) => s + l.length + 1, 0);
      }
    }

    const remaining = currentLines.join('\n').trim();
    if (remaining.length > 0) chunks.push(remaining);

    return chunks;
  }

  /**
   * For a large file, try to build a graph-based prompt section.
   * Returns null when the file is small enough for raw chunking and has no graph data.
   *
   * Priority:
   *  1. Graph section (god functions) + optional skeleton supplement  — richest representation
   *  2. Standalone skeleton for large files without god functions     — avoids [PARTIAL SPEC]
   *  3. null → caller falls back to raw AST chunking
   *
   * The skeleton fallback fires when content would be split (> STAGE_CHUNK_MAX_CHARS) and
   * the skeleton achieves ≥ 20% size reduction AND fits within SKELETON_STANDALONE_MAX_CHARS.
   */
  graphPromptFor(filePath: string, content?: string): string | null {
    const ctx = this.currentLLMContext;

    // ── Path 1: graph section exists (file has god functions) ──────────────
    if (ctx?.callGraph) {
      const graphSection = buildGraphPromptSection(ctx.callGraph, ctx.signatures, filePath);
      if (graphSection) {
        if (!content) return graphSection;

        const language = detectLanguage(filePath);
        const skeleton = getSkeletonContent(content, language);

        if (isSkeletonWorthIncluding(content, skeleton)) {
          // Cap skeleton to avoid overwhelming the prompt
          const skeletonExcerpt = skeleton.length > SKELETON_EXCERPT_MAX_CHARS
            ? skeleton.slice(0, SKELETON_EXCERPT_MAX_CHARS) + '\n... [skeleton truncated]'
            : skeleton;
          return `${graphSection}\n\nFunction skeleton (logs/comments stripped):\n${skeletonExcerpt}`;
        }

        return graphSection;
      }
    }

    // ── Path 2: skeleton fallback for large files without god functions ─────
    // Avoids splitting files into multiple chunks (and the resulting [PARTIAL SPEC] marker)
    // when the skeleton alone is a complete, noise-free representation.
    if (content && content.length > this.options.chunkMaxChars) {
      const language = detectLanguage(filePath);
      const skeleton = getSkeletonContent(content, language);
      if (isSkeletonWorthIncluding(content, skeleton) && skeleton.length <= SKELETON_STANDALONE_MAX_CHARS) {
        return `Function skeleton (logs/comments stripped):\n${skeleton}`;
      }
    }

    return null;
  }

  signaturesFor(filePath: string): string | null {
    const sigs = this.currentLLMContext?.signatures;
    if (!sigs) return null;
    const fileMap = sigs.find(s => s.path === filePath);
    if (!fileMap || fileMap.entries.length === 0) return null;
    return fileMap.entries
      .map(e => `- ${e.signature}${e.docstring ? ` — ${e.docstring}` : ''}`)
      .join('\n');
  }

  schemasFor(filePath: string): string | null {
    const schemas = this.currentRepoStructure?.schemas;
    if (!schemas || schemas.length === 0) return null;
    const fileSchemas = schemas.filter(s => s.file === filePath);
    if (fileSchemas.length === 0) return null;
    return fileSchemas.map(s => {
      const fields = s.fields
        .map(f => `${f.name} (${f.type}${f.nullable ? '' : ', required'})`)
        .join(', ');
      return `- ${s.name} [${s.orm}]: ${fields}`;
    }).join('\n');
  }

  routesFor(filePath: string): string | null {
    const routes = this.currentRepoStructure?.routeInventory?.routes;
    if (!routes || routes.length === 0) return null;
    const fileRoutes = routes.filter(r => r.file === filePath);
    if (fileRoutes.length === 0) return null;
    return fileRoutes.map(r =>
      `- ${r.method} ${r.path}${r.handler ? ` → ${r.handler}` : ''}`
    ).join('\n');
  }

  /**
   * Generate sub-specifications for the direct callees of god functions in a file.
   * Makes a single batched LLM call covering all callees at once.
   * Returns [] when no graph data or no god functions are found.
   */
  async generateSubSpecs(
    filePath: string,
    parentName: string,
    parentPurpose: string,
  ): Promise<ServiceSubSpec[]> {
    const callGraph = this.currentLLMContext?.callGraph;
    if (!callGraph) return [];

    const godFunctions = getFileGodFunctions(callGraph, filePath);
    if (godFunctions.length === 0) return [];

    // Collect unique direct callees across all god functions in this file
    const seenCallees = new Set<string>();
    const calleeInfos: Array<{
      name: string;
      signature?: string;
      docstring?: string;
      subcallees: string[];
    }> = [];

    for (const godFn of godFunctions) {
      const sub = extractSubgraph(callGraph, godFn);
      const directCallees = [...new Set(
        sub.edges.filter(([from]) => from === godFn.name).map(([, to]) => to)
      )];

      for (const calleeName of directCallees) {
        if (seenCallees.has(calleeName)) continue;
        seenCallees.add(calleeName);

        const sigEntry = this.currentLLMContext?.signatures
          ?.flatMap(s => s.entries)
          .find(e => e.name === calleeName);

        const subcallees = [...new Set(
          sub.edges.filter(([from]) => from === calleeName).map(([, to]) => to)
        )];

        calleeInfos.push({
          name: calleeName,
          signature: sigEntry?.signature,
          docstring: sigEntry?.docstring,
          subcallees,
        });
      }
    }

    if (calleeInfos.length === 0) return [];

    try {
      const result = await this.llm.completeJSON<ServiceSubSpec[]>({
        ...protectPrompt(
          PROMPTS.stage3_subspec_system,
          PROMPTS.stage3_subspec(parentName, parentPurpose, calleeInfos),
        ),
        temperature: 0.3,
        maxTokens: 4000,
      }, SUBSPEC_SCHEMA);
      if (Array.isArray(result)) {
        // Ensure callee field is set — LLM sometimes names it differently
        for (const sub of result) {
          if (!sub.callee) {
            const matched = calleeInfos.find(
              c => c.name === sub.name ||
              c.name.toLowerCase().includes((sub.name ?? '').toLowerCase())
            );
            sub.callee = matched?.name ?? sub.name;
          }
          sub.operations = sub.operations ?? [];
        }
        return result;
      }
    } catch (error) {
      logger.warning(`Sub-specs: failed for ${parentName}: ${(error as Error).message}`);
    }
    return [];
  }

  /**
   * Generation retrieval strategy: semantic-first → depth-N graph expansion.
   *
   * 1. Semantic search identifies seed files relevant to the query.
   * 2. BFS graph expansion up to `depth` hops adds callee files so indirect
   *    implementations are not missed. Score decays by λ^hop (λ=0.6) — used
   *    only for logging; all resolved files are passed to the LLM stage.
   */
  private async semanticFiles(
    query: string,
    context: LLMContext,
    limit = 15,
    depth = 2,
  ): Promise<Array<{ path: string; content: string }>> {
    if (!this.semanticSearch) return [];
    try {
      const results = await this.semanticSearch(query, limit);
      const seen = new Set<string>();
      const files: Array<{ path: string; content: string }> = [];

      const resolveFile = async (fp: string): Promise<void> => {
        if (seen.has(fp) || isTestFile(fp)) return;
        seen.add(fp);
        const deep = context.phase2_deep.files.find(f => f.path === fp);
        if (deep?.content) {
          files.push({ path: fp, content: deep.content });
        } else if (this.options.rootPath) {
          try {
            const content = await readFile(resolve(this.options.rootPath, fp), 'utf-8');
            if (content.trim()) files.push({ path: fp, content });
          } catch { /* file not readable, skip */ }
        }
      };

      // Step 1: resolve semantic seed files
      for (const r of results) await resolveFile(r.record.filePath);
      const seedCount = files.length;

      // Step 2: depth-N BFS callee expansion (RIG-21)
      const cg = context.callGraph;
      if (cg && seedCount > 0) {
        const calleeMap = new Map<string, string[]>();
        for (const e of cg.edges) {
          if (!e.calleeId) continue;
          const list = calleeMap.get(e.callerId) ?? [];
          list.push(e.calleeId);
          calleeMap.set(e.callerId, list);
        }
        const nodeFile = new Map(cg.nodes.map(n => [n.id, n.filePath]));
        const seedPaths = new Set(seen);
        let frontier = cg.nodes.filter(n => seedPaths.has(n.filePath)).map(n => n.id);

        for (let hop = 1; hop <= depth && frontier.length > 0; hop++) {
          const beforeHop = files.length;
          const nextFrontier: string[] = [];
          for (const nodeId of frontier) {
            for (const calleeId of calleeMap.get(nodeId) ?? []) {
              const calleePath = nodeFile.get(calleeId);
              if (calleePath && !seen.has(calleePath)) {
                await resolveFile(calleePath);
                nextFrontier.push(calleeId);
              }
            }
          }
          const hopAdded = files.length - beforeHop;
          if (hopAdded > 0) logger.analysis(`Graph expansion depth ${hop}: +${hopAdded} files`);
          frontier = nextFrontier;
        }
      }

      return files;
    } catch (err) {
      logger.warning(`Semantic file selection failed (${query}): ${(err as Error).message}`);
      return [];
    }
  }

  /** Name-based heuristic fallback for schema/entity/type files. */
  private heuristicSchemaFiles(context: LLMContext): Array<{ path: string; content: string }> {
    return context.phase2_deep.files
      .filter(f => {
        const name = f.path.toLowerCase();
        return (
          name.includes('model') ||
          name.includes('schema') ||
          name.includes('entity') ||
          name.includes('types') ||
          name.includes('interface')
        );
      })
      .map(f => ({ path: f.path, content: f.content ?? '' }))
      .filter(f => f.content.length > 0);
  }

  /** Name-based heuristic fallback for service/business-logic files. */
  private heuristicServiceFiles(context: LLMContext): Array<{ path: string; content: string }> {
    return context.phase2_deep.files
      .filter(f => {
        const name = f.path.toLowerCase();
        return (
          name.includes('service') ||
          name.includes('manager') ||
          name.includes('handler') ||
          name.includes('controller') ||
          name.includes('use-case') ||
          name.includes('usecase')
        );
      })
      .map(f => ({ path: f.path, content: f.content ?? '' }))
      .filter(f => f.content.length > 0);
  }

  /** Name-based heuristic fallback for API/route files. */
  private heuristicApiFiles(context: LLMContext): Array<{ path: string; content: string }> {
    return context.phase2_deep.files
      .filter(f => {
        const name = f.path.toLowerCase();
        return (
          name.includes('route') ||
          name.includes('api') ||
          name.includes('endpoint') ||
          name.includes('controller') ||
          name.includes('rest')
        );
      })
      .map(f => ({ path: f.path, content: f.content ?? '' }))
      .filter(f => f.content.length > 0);
  }

  /**
   * Get schema files — semantic-first, name-heuristic fallback.
   */
  private async getSchemaFiles(context: LLMContext): Promise<Array<{ path: string; content: string }>> {
    const semantic = await this.semanticFiles(
      'data model entity schema type interface database structure',
      context
    );
    if (semantic.length > 0) {
      logger.analysis(`Schema files: ${semantic.length} via semantic search`);
      return semantic;
    }
    const fallback = this.heuristicSchemaFiles(context);
    if (this.semanticSearch && fallback.length > 0) {
      logger.warning('Schema semantic search returned no results, falling back to name heuristics');
    }
    return fallback;
  }

  /**
   * Get service files — semantic-first, name-heuristic fallback.
   */
  private async getServiceFiles(context: LLMContext): Promise<Array<{ path: string; content: string }>> {
    const semantic = await this.semanticFiles(
      'service business logic manager handler use case orchestration',
      context
    );
    if (semantic.length > 0) {
      logger.analysis(`Service files: ${semantic.length} via semantic search`);
      return semantic;
    }
    const fallback = this.heuristicServiceFiles(context);
    if (this.semanticSearch && fallback.length > 0) {
      logger.warning('Service semantic search returned no results, falling back to name heuristics');
    }
    return fallback;
  }

  /**
   * Get API files — semantic-first, name-heuristic fallback.
   */
  private async getApiFiles(context: LLMContext): Promise<Array<{ path: string; content: string }>> {
    const semantic = await this.semanticFiles(
      'API route endpoint REST controller HTTP request response',
      context
    );
    if (semantic.length > 0) {
      logger.analysis(`API files: ${semantic.length} via semantic search`);
      return semantic;
    }
    const fallback = this.heuristicApiFiles(context);
    if (this.semanticSearch && fallback.length > 0) {
      logger.warning('API semantic search returned no results, falling back to name heuristics');
    }
    return fallback;
  }

  /**
   * Resolve file paths identified by Stage 1 LLM to actual file content.
   * First looks in phase2_deep (already in memory); if not found and rootPath is set,
   * reads the file from disk so that files outside the top-20 scored set can still
   * be analyzed in later stages.
   * Falls back to the provided heuristic list if no paths resolve.
   */
  private async resolveFiles(
    context: LLMContext,
    llmPaths: string[],
    fallback: Array<{ path: string; content: string }>
  ): Promise<Array<{ path: string; content: string }>> {
    // Guard: never pass test files to the LLM stages regardless of what Stage 1 suggested
    const safePaths = llmPaths.filter(p => !isTestFile(p));
    if (safePaths.length === 0) {
      return fallback.filter(f => !isTestFile(f.path));
    }
    llmPaths = safePaths;

    const allFiles = context.phase2_deep.files;
    const resolved: Array<{ path: string; content: string }> = [];

    for (const p of llmPaths) {
      // 1. Look in phase2_deep (already loaded in memory)
      const found = allFiles.find(f => f.path === p || f.path.endsWith('/' + p) || p.endsWith('/' + f.path));
      if (found?.content) {
        resolved.push({ path: found.path, content: found.content });
        continue;
      }
      // 2. Read from disk when rootPath is configured (covers files outside phase2_deep)
      if (this.options.rootPath) {
        try {
          const absPath = resolve(this.options.rootPath, p);
          // Prevent path traversal outside the project root
          if (!absPath.startsWith(resolve(this.options.rootPath))) continue;
          const content = await readFile(absPath, 'utf-8');
          resolved.push({ path: p, content });
        } catch {
          // file not found or unreadable — skip
        }
      }
    }

    return resolved.length > 0 ? resolved : fallback;
  }

  /**
   * Get default survey when stage is skipped
   */
  private getDefaultSurvey(repoStructure: RepoStructure): ProjectSurveyResult {
    return {
      projectCategory: 'other',
      primaryLanguage: repoStructure.projectType,
      frameworks: repoStructure.frameworks,
      architecturePattern: repoStructure.architecture.pattern as ArchitecturePattern,
      domainSummary: `A ${repoStructure.projectType} project`,
      suggestedDomains: repoStructure.domains.map(d => d.name),
      confidence: 0.5,
      schemaFiles: [],
      serviceFiles: [],
      apiFiles: [],
    };
  }

  /**
   * Get default architecture when stage is skipped
   */
  private getDefaultArchitecture(survey: ProjectSurveyResult): ArchitectureSynthesis {
    return {
      systemPurpose: survey.domainSummary,
      architectureStyle: survey.architecturePattern,
      layerMap: [],
      dataFlow: 'Unknown',
      integrations: [],
      securityModel: 'Unknown',
      keyDecisions: [],
    };
  }

  /**
   * Save intermediate result
   */
  async saveResult(name: string, data: unknown): Promise<void> {
    const filepath = join(this.options.outputDir, `${name}.json`);
    await writeFile(filepath, JSON.stringify(data, null, 2));
    logger.debug(`Saved ${name} to ${filepath}`);
  }

  /**
   * Map short stage name to the filename used by saveResult.
   */
  private stageFileName(stage: string): string {
    const map: Record<string, string> = {
      survey: 'stage1-survey',
      entities: 'stage2-entities',
      services: 'stage3-services',
      api: 'stage4-api',
      architecture: 'stage5-architecture',
      adr: 'stage6-adr-enrichment',
    };
    return map[stage] ?? `stage-${stage}`;
  }

  /**
   * Load previous stage result (for resume)
   */
  async loadStageResult<T>(stage: string): Promise<StageResult<T> | null> {
    try {
      const filepath = join(this.options.outputDir, `${this.stageFileName(stage)}.json`);

      // Invalidate cache if analysis (llm-context.json) is newer than the stage file.
      // This ensures that running `openlore analyze` followed by `openlore generate`
      // always re-runs the pipeline rather than serving stale LLM results.
      if (this.options.rootPath) {
        const analysisFile = join(this.options.rootPath, '.openlore', 'analysis', 'llm-context.json');
        try {
          const [stageStat, analysisStat] = await Promise.all([stat(filepath), stat(analysisFile)]);
          if (analysisStat.mtimeMs > stageStat.mtimeMs) {
            logger.analysis(`Auto-resume: ${stage} cache is older than analysis — will re-run`);
            return null;
          }
        } catch {
          // Either file missing — fall through to normal load/null
        }
      }

      const content = await readFile(filepath, 'utf-8');
      return JSON.parse(content) as StageResult<T>;
    } catch {
      return null;
    }
  }
}

// ============================================================================
// CONVENIENCE FUNCTIONS
// ============================================================================

/**
 * Run the spec generation pipeline
 */
export async function runSpecGenerationPipeline(
  llm: LLMService,
  repoStructure: RepoStructure,
  llmContext: LLMContext,
  options: PipelineOptions,
  depGraph?: DependencyGraphResult,
  refactorReport?: RefactorReport
): Promise<PipelineResult> {
  const pipeline = new SpecGenerationPipeline(llm, options);
  return pipeline.run(repoStructure, llmContext, depGraph, refactorReport);
}
