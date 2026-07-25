/**
 * openlore run command (default pipeline)
 *
 * Runs the full pipeline: init → analyze → generate in sequence.
 * Smart defaults skip unnecessary steps and detect existing setups.
 */

import { Command } from 'commander';
import { stat, mkdir, writeFile } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { createRequire } from 'node:module';
import { formatDuration, formatAge, readJsonFile, resolveLLMProvider, getAnalysisAge, estimateCost } from '../../utils/command-helpers.js';
import {
  ANALYSIS_REUSE_THRESHOLD_MS,
  DEFAULT_MAX_FILES,
  DEFAULT_ANTHROPIC_MODEL,
  OPENLORE_DIR,
  OPENLORE_ANALYSIS_SUBDIR,
  OPENLORE_LOGS_SUBDIR,
  OPENLORE_CONFIG_REL_PATH,
  OPENLORE_GENERATION_SUBDIR,
  OPENLORE_RUNS_SUBDIR,
  DEFAULT_OPENSPEC_PATH,
  ARTIFACT_REPO_STRUCTURE,
  ARTIFACT_LLM_CONTEXT,
  ARTIFACT_DEPENDENCY_GRAPH,
  ARTIFACT_GENERATION_REPORT,
} from '../../constants.js';
import { confirm } from '@inquirer/prompts';
import { logger } from '../../utils/logger.js';
import {
  detectProjectType,
  getProjectTypeName,
} from '../../core/services/project-detector.js';
import {
  getDefaultConfig,
  readOpenLoreConfig,
  writeOpenLoreConfig,
  openloreConfigExists,
  openspecDirExists,
  createOpenSpecStructure,
} from '../../core/services/config-manager.js';
import { ensureGitignored } from '../../core/services/gitignore-manager.js';
import { runAnalysis } from './analyze.js';
import {
  createLLMService,
  type LLMService,
} from '../../core/services/llm-service.js';
import {
  SpecGenerationPipeline,
  type PipelineResult,
} from '../../core/generator/spec-pipeline.js';
import {
  OpenSpecFormatGenerator,
} from '../../core/generator/openspec-format-generator.js';
import {
  OpenSpecWriter,
  type GenerationReport,
} from '../../core/generator/openspec-writer.js';
import { ADRGenerator } from '../../core/generator/adr-generator.js';
import type { RepoStructure, LLMContext } from '../../core/analyzer/artifact-generator.js';
import type { DependencyGraphResult } from '../../core/analyzer/dependency-graph.js';

const _require = createRequire(import.meta.url);
const { version: PKG_VERSION } = _require('../../../package.json') as { version: string };

// ============================================================================
// TYPES
// ============================================================================

interface RunOptions {
  force: boolean;
  reanalyze: boolean;
  model: string;
  dryRun: boolean;
  yes: boolean;
  maxFiles: number;
  adr: boolean;
}

interface RunMetadata {
  version: string;
  timestamp: string;
  duration: number;
  steps: {
    init: { status: 'skipped' | 'completed'; reason?: string };
    analyze: { status: 'skipped' | 'completed'; reason?: string; filesAnalyzed?: number };
    generate: { status: 'skipped' | 'completed'; reason?: string; specsGenerated?: number };
  };
  result: 'success' | 'failure';
  error?: string;
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Get analysis age if it exists
 */

/**
 * Load analysis data from disk
 */
async function loadAnalysis(analysisPath: string): Promise<{
  repoStructure: RepoStructure;
  llmContext: LLMContext;
  depGraph?: DependencyGraphResult;
  age: number;
} | null> {
  try {
    const repoStructurePath = join(analysisPath, ARTIFACT_REPO_STRUCTURE);
    const llmContextPath = join(analysisPath, ARTIFACT_LLM_CONTEXT);
    const depGraphPath = join(analysisPath, ARTIFACT_DEPENDENCY_GRAPH);

    const repoStructure = await readJsonFile<RepoStructure>(repoStructurePath, ARTIFACT_REPO_STRUCTURE);
    if (!repoStructure) return null;

    const llmContext = await readJsonFile<LLMContext>(llmContextPath, ARTIFACT_LLM_CONTEXT) ?? {
      phase1_survey: { purpose: 'Initial survey', files: [], estimatedTokens: 0 },
      phase2_deep: { purpose: 'Deep analysis', files: [], totalTokens: 0 },
      phase3_validation: { purpose: 'Validation', files: [], totalTokens: 0 },
    };

    const depGraph = await readJsonFile<DependencyGraphResult>(depGraphPath, ARTIFACT_DEPENDENCY_GRAPH) ?? undefined;

    const stats = await stat(repoStructurePath);
    const age = Date.now() - stats.mtime.getTime();

    return { repoStructure, llmContext, depGraph, age };
  } catch {
    return null;
  }
}

/**
 * Estimate cost for generation
 */

/**
 * Save run metadata
 */
async function saveRunMetadata(rootPath: string, metadata: RunMetadata): Promise<void> {
  const runsDir = join(rootPath, OPENLORE_DIR, OPENLORE_RUNS_SUBDIR);
  await mkdir(runsDir, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `${timestamp}.json`;

  await writeFile(
    join(runsDir, filename),
    JSON.stringify(metadata, null, 2)
  );
}

/**
 * Display the pipeline banner
 */
function displayBanner(projectName: string, projectType: string, rootPath: string): void {
  const versionLabel = `openlore v${PKG_VERSION}`;
  const title = `${versionLabel} — OpenSpec Reverse Engineering Tool`;
  const width = Math.max(53, title.length + 4);
  const pad = (s: string) => s + ' '.repeat(width - s.length - 2);
  console.log('');
  console.log(`╭${'─'.repeat(width - 2)}╮`);
  console.log(`│  ${pad(title)}│`);
  console.log(`╰${'─'.repeat(width - 2)}╯`);
  console.log('');
  console.log(`  Project: ${projectName}`);
  console.log(`  Type: ${projectType}`);
  console.log(`  Path: ${rootPath}`);
  console.log('');
}

/**
 * Display the completion banner
 */
function displayCompletionBanner(): void {
  console.log('');
  console.log('╭─────────────────────────────────────────────────────╮');
  console.log('│  Specifications generated successfully!              │');
  console.log('│                                                      │');
  console.log('│  Review your specs:  openspec list --specs          │');
  console.log('│  Validate structure: openspec validate --all        │');
  console.log('│  Test accuracy:      openlore verify                │');
  console.log('│  Start a change:     openspec change my-feature     │');
  console.log('╰─────────────────────────────────────────────────────╯');
  console.log('');
}

// ============================================================================
// COMMAND
// ============================================================================

export const runCommand = new Command('run')
  .description('Run the full openlore pipeline (init → analyze → generate)')
  .option(
    '--force',
    'Reinitialize even if config exists',
    false
  )
  .option(
    '--reanalyze',
    'Force fresh analysis even if recent exists',
    false
  )
  .option(
    '--model <name>',
    'LLM model to use for generation',
    DEFAULT_ANTHROPIC_MODEL
  )
  .option(
    '--dry-run',
    'Show what would be done without making changes',
    false
  )
  .option(
    '-y, --yes',
    'Skip all confirmation prompts',
    false
  )
  .option(
    '--max-files <n>',
    'Maximum files to analyze (default: 100000)',
    '100000'
  )
  .option(
    '--adr',
    'Also generate Architecture Decision Records',
    false
  )
  .addHelpText(
    'after',
    `
Examples:
  $ openlore run                     Run full pipeline with smart defaults
  $ openlore run --force             Reinitialize and re-analyze
  $ openlore run --reanalyze         Force fresh analysis
  $ openlore run --model claude-opus-4-20250514
                                     Use a different model
  $ openlore run --dry-run           Preview what would happen
  $ openlore run -y                  Skip all prompts

Smart Defaults:
  - Skips init if .openlore/config.json exists
  - Skips analyze if recent analysis exists (< 1 hour old)
  - Always runs generate (the main purpose)
  - Detects and works with existing openspec/ setup

The pipeline saves run metadata to .openlore/runs/ for tracking.
`
  )
  .action(async function (this: Command, options: Partial<RunOptions>) {
    const startTime = Date.now();
    const rootPath = process.cwd();

    // Inherit global options (--api-base, --insecure, etc.)
    const globalOpts = this.optsWithGlobals?.() ?? {};

    const opts: RunOptions = {
      force: options.force ?? false,
      reanalyze: options.reanalyze ?? false,
      model: options.model ?? DEFAULT_ANTHROPIC_MODEL,
      dryRun: options.dryRun ?? false,
      yes: options.yes ?? false,
      maxFiles: typeof options.maxFiles === 'string'
        ? parseInt(options.maxFiles, 10)
        : options.maxFiles ?? DEFAULT_MAX_FILES,
      adr: options.adr ?? false,
    };

    if (isNaN(opts.maxFiles) || opts.maxFiles < 1) {
      logger.error('--max-files must be a positive integer');
      process.exitCode = 1;
      return;
    }

    const metadata: RunMetadata = {
      version: PKG_VERSION,
      timestamp: new Date().toISOString(),
      duration: 0,
      steps: {
        init: { status: 'skipped' },
        analyze: { status: 'skipped' },
        generate: { status: 'skipped' },
      },
      result: 'success',
    };

    try {
      // ========================================================================
      // PRE-FLIGHT: DETECT PROJECT
      // ========================================================================
      const detection = await detectProjectType(rootPath);
      const projectName = basename(rootPath);
      const projectTypeName = getProjectTypeName(detection.projectType);

      displayBanner(projectName, projectTypeName, rootPath);

      if (opts.dryRun) {
        logger.discovery('DRY RUN - No changes will be made');
        console.log('');
      }

      // ========================================================================
      // STEP 1/3: INITIALIZATION
      // ========================================================================
      console.log('[Step 1/3] Initialization');

      const configExists = await openloreConfigExists(rootPath);
      let openloreConfig = configExists ? await readOpenLoreConfig(rootPath) : null;

      if (configExists && !opts.force) {
        console.log(`   ✓ Configuration exists (${OPENLORE_CONFIG_REL_PATH})`);
        metadata.steps.init = { status: 'skipped', reason: 'Config exists' };
      } else {
        if (opts.dryRun) {
          console.log(`   → Would create ${OPENLORE_CONFIG_REL_PATH}`);
          console.log(`   → Would detect project type: ${projectTypeName}`);
        } else {
          // Create config
          const openspecPath = DEFAULT_OPENSPEC_PATH;
          openloreConfig = getDefaultConfig(detection.projectType, openspecPath);
          await writeOpenLoreConfig(rootPath, openloreConfig);
          console.log(`   ✓ Created ${OPENLORE_CONFIG_REL_PATH}`);

          // Create openspec directory if needed
          const fullOpenspecPath = join(rootPath, openspecPath);
          if (!(await openspecDirExists(fullOpenspecPath))) {
            await createOpenSpecStructure(fullOpenspecPath);
            console.log('   ✓ Created openspec/ directory');
          } else {
            console.log(`   ✓ OpenSpec directory exists (${DEFAULT_OPENSPEC_PATH})`);
          }

          // Ensure .openlore/ analysis artifacts (multi-MB lance binaries) are
          // ignored, creating .gitignore when absent so a fresh `git init` repo
          // doesn't leak them into git status and diff-based tools.
          const gitignoreResult = await ensureGitignored(rootPath, `${OPENLORE_DIR}/`, 'openlore analysis artifacts');
          if (gitignoreResult === 'created') {
            console.log(`   ✓ Created .gitignore with ${OPENLORE_DIR}/`);
          } else if (gitignoreResult === 'appended') {
            console.log(`   ✓ Added ${OPENLORE_DIR}/ to .gitignore`);
          }

          metadata.steps.init = { status: 'completed' };
        }
      }

      // Ensure we have config
      if (!openloreConfig && !opts.dryRun) {
        openloreConfig = await readOpenLoreConfig(rootPath);
        if (!openloreConfig) {
          throw new Error('Failed to load configuration');
        }
      }

      // Check openspec directory
      const openspecPath = openloreConfig?.openspecPath ?? DEFAULT_OPENSPEC_PATH;
      const fullOpenspecPath = join(rootPath, openspecPath);
      if (await openspecDirExists(fullOpenspecPath)) {
        console.log(`   ✓ OpenSpec directory exists (${openspecPath})`);
      }

      console.log('');

      // ========================================================================
      // STEP 2/3: ANALYSIS
      // ========================================================================
      console.log('[Step 2/3] Analysis');

      const analysisPath = join(rootPath, OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR);
      const analysisAge = await getAnalysisAge(analysisPath);

      let analysisData: {
        repoStructure: RepoStructure;
        llmContext: LLMContext;
        depGraph?: DependencyGraphResult;
        age: number;
      } | null = null;

      if (analysisAge !== null && analysisAge < ANALYSIS_REUSE_THRESHOLD_MS && !opts.reanalyze && !opts.force) {
        // Use existing analysis
        console.log(`   ✓ Recent analysis found (${formatAge(analysisAge)})`);

        analysisData = await loadAnalysis(analysisPath);
        if (analysisData) {
          const { repoStructure } = analysisData;
          console.log(`   Using existing analysis: ${repoStructure.statistics.analyzedFiles} files, ${repoStructure.domains.length} domains`);
          console.log(`   Detected domains: ${repoStructure.domains.map(d => d.name).join(', ') || 'None'}`);
          metadata.steps.analyze = {
            status: 'skipped',
            reason: `Recent analysis (${formatAge(analysisAge)})`,
            filesAnalyzed: repoStructure.statistics.analyzedFiles,
          };
        }
      }

      if (!analysisData) {
        if (opts.dryRun) {
          console.log('   → Would scan codebase for files');
          console.log('   → Would build dependency graph');
          console.log('   → Would generate analysis artifacts');
        } else {
          console.log('   Running analysis...');

          await mkdir(analysisPath, { recursive: true });

          const result = await runAnalysis(rootPath, analysisPath, {
            maxFiles: opts.maxFiles,
            include: [],
            exclude: [],
          });

          analysisData = {
            repoStructure: result.artifacts.repoStructure,
            llmContext: result.artifacts.llmContext,
            depGraph: result.depGraph,
            age: 0,
          };

          console.log(`   ✓ Analyzed ${result.repoMap.summary.analyzedFiles} files`);
          console.log(`   ✓ Found ${result.depGraph.statistics.clusterCount} clusters`);
          console.log(`   Detected domains: ${result.artifacts.repoStructure.domains.map(d => d.name).join(', ') || 'None'}`);

          metadata.steps.analyze = {
            status: 'completed',
            filesAnalyzed: result.repoMap.summary.analyzedFiles,
          };
        }
      }

      console.log('');

      // ========================================================================
      // STEP 3/3: GENERATION
      // ========================================================================
      console.log('[Step 3/3] Generation');

      if (!analysisData && !opts.dryRun) {
        throw new Error('No analysis data available for generation');
      }

      // Check for API key
      const resolved = resolveLLMProvider(openloreConfig ?? undefined);
      if (!resolved) {
        console.log('   ✗ No LLM API key found');
        console.log('');
        logger.error('Set ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY, or OPENAI_COMPAT_API_KEY + OPENAI_COMPAT_BASE_URL.');
        logger.info('No API key?', 'With the Claude Code CLI installed, set generation.provider to "claude-code" in .openlore/config.json — generate/verify/drift run with no API key.');
        metadata.result = 'failure';
        metadata.error = 'No LLM API key';
        process.exitCode = 1;
        return;
      }

      // Estimate cost
      if (analysisData) {
        const estimate = estimateCost(analysisData.llmContext, resolved.provider, opts.model);
        console.log(`   Estimated cost: ~$${estimate.cost.toFixed(2)}`);

        // Confirmation prompt
        if (!opts.dryRun && !opts.yes && estimate.cost > 0.1) {
          if (process.stdin.isTTY) {
            const shouldContinue = await confirm({
              message: `Estimated cost: ~$${estimate.cost.toFixed(2)}. Continue?`,
              default: true,
            });
            if (!shouldContinue) {
              console.log('   Cancelled by user');
              metadata.result = 'failure';
              metadata.error = 'Cancelled by user';
              return;
            }
          }
        }
      }

      if (opts.dryRun) {
        console.log('');
        console.log('   → Would run LLM generation pipeline:');
        console.log('   ├─ Project Survey');
        console.log('   ├─ Entity Extraction');
        console.log('   ├─ Service Analysis');
        console.log('   ├─ API Extraction');
        console.log('   └─ Architecture Synthesis');
        console.log('');
        console.log('   → Would write specifications:');
        console.log(`   ├─ ${openspecPath}/specs/overview/spec.md`);
        console.log(`   ├─ ${openspecPath}/specs/architecture/spec.md`);
        if (analysisData) {
          for (const domain of analysisData.repoStructure.domains.slice(0, 5)) {
            console.log(`   ├─ ${openspecPath}/specs/${domain.name}/spec.md`);
          }
        }
        console.log(`   └─ ${openspecPath}/specs/api/spec.md (if applicable)`);
        console.log('');
        console.log('DRY RUN COMPLETE - No changes were made');
        return;
      }

      let llm: LLMService;
      try {
        llm = createLLMService({
          provider: resolved.provider,
          openaiCompatBaseUrl: resolved.openaiCompatBaseUrl,
          model: opts.model,
          apiBase: globalOpts.apiBase ?? openloreConfig?.llm?.apiBase,
          sslVerify: globalOpts.insecure != null ? !globalOpts.insecure : openloreConfig?.llm?.sslVerify ?? true,
          timeout: globalOpts.timeout ?? openloreConfig?.generation?.timeout,
          enableLogging: true,
          logDir: join(rootPath, OPENLORE_DIR, OPENLORE_LOGS_SUBDIR),
        });
      } catch (error) {
        throw new Error(`Failed to create LLM service: ${(error as Error).message}`, { cause: error });
      }

      console.log('');
      console.log('   Generating specifications...');

      // Run generation pipeline
      const pipeline = new SpecGenerationPipeline(llm, {
        outputDir: join(rootPath, OPENLORE_DIR, OPENLORE_GENERATION_SUBDIR),
        saveIntermediate: true,
        generateADRs: opts.adr,
      });

      let pipelineResult: PipelineResult;
      try {
        pipelineResult = await pipeline.run(
          analysisData!.repoStructure,
          analysisData!.llmContext,
          analysisData!.depGraph
        );
      } catch (error) {
        await llm.saveLogs().catch((e) => logger.debug(`Failed to save LLM logs: ${(e as Error).message}`));
        throw new Error(`Pipeline failed: ${(error as Error).message}`, { cause: error });
      }

      console.log('   ├─ Project Survey ✓');
      console.log('   ├─ Entity Extraction ✓');
      console.log('   ├─ Service Analysis ✓');
      console.log('   ├─ API Extraction ✓');
      console.log(`   ${opts.adr ? '├' : '└'}─ Architecture Synthesis ✓`);
      if (opts.adr) {
        const adrStatus = pipelineResult.adrs && pipelineResult.adrs.length > 0
          ? `✓ (${pipelineResult.adrs.length} decisions)`
          : '○ (no decisions found)';
        console.log(`   └─ ADR Enrichment ${adrStatus}`);
      }
      console.log('');

      // Format and write specs
      console.log('   Writing OpenSpec specifications...');

      const formatGenerator = new OpenSpecFormatGenerator({
        version: openloreConfig?.version ?? '1.0.0',
        includeConfidence: true,
        includeTechnicalNotes: true,
      });

      const generatedSpecs = formatGenerator.generateSpecs(pipelineResult);

      // Generate ADRs if requested
      if (opts.adr && pipelineResult.adrs && pipelineResult.adrs.length > 0) {
        const adrGenerator = new ADRGenerator({
          version: openloreConfig?.version ?? '1.0.0',
          includeMermaid: true,
        });
        const adrSpecs = adrGenerator.generateADRs(pipelineResult);
        generatedSpecs.push(...adrSpecs);
      }

      const writer = new OpenSpecWriter({
        rootPath,
        writeMode: 'replace',
        version: openloreConfig?.version ?? '1.0.0',
        createBackups: true,
        updateConfig: true,
        validateBeforeWrite: true,
      });

      let report: GenerationReport;
      try {
        report = await writer.writeSpecs(generatedSpecs, pipelineResult.survey);
      } catch (error) {
        throw new Error(`Failed to write specs: ${(error as Error).message}`, { cause: error });
      }

      // Display written files
      for (let i = 0; i < report.filesWritten.length; i++) {
        const file = report.filesWritten[i];
        const isLast = i === report.filesWritten.length - 1;
        const prefix = isLast ? '└─' : '├─';
        console.log(`   ${prefix} ${file} ✓`);
      }

      // Save LLM logs
      await llm.saveLogs().catch((e) => logger.debug(`Failed to save LLM logs: ${(e as Error).message}`));

      metadata.steps.generate = {
        status: 'completed',
        specsGenerated: report.filesWritten.length,
      };

      // ========================================================================
      // COMPLETION
      // ========================================================================
      displayCompletionBanner();

      const duration = Date.now() - startTime;
      metadata.duration = duration;

      console.log(`   Full report: ${OPENLORE_DIR}/outputs/${ARTIFACT_GENERATION_REPORT}`);
      console.log(`   Total time: ${formatDuration(duration)}`);
      console.log('');

      // Save run metadata
      await saveRunMetadata(rootPath, metadata);

    } catch (error) {
      const duration = Date.now() - startTime;
      metadata.duration = duration;
      metadata.result = 'failure';
      metadata.error = (error as Error).message;

      await saveRunMetadata(rootPath, metadata).catch((e) => logger.debug(`Failed to save run metadata: ${(e as Error).message}`));

      logger.error(`Pipeline failed: ${(error as Error).message}`);
      if (process.env.DEBUG) {
        console.error(error);
      }
      process.exitCode = 1;
    }
  });
