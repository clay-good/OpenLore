/**
 * openlore generate command
 *
 * Generates OpenSpec specification files from analysis results using LLM.
 * Outputs to openspec/specs/ directory in standard OpenSpec format.
 */

import { Command } from 'commander';
import { allowInsecureTls } from '../../core/services/tls-scope.js';
import { confirm } from '@inquirer/prompts';
import { constants as fsConstants } from 'node:fs';
import { mkdir, mkdtemp, open, readdir, readFile, stat, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { logger } from '../../utils/logger.js';
import { resolveTrustedApiBase, resolveTrustedSslVerify, rejectRepoConfiguredTlsOptOut } from '../../core/services/repo-config-trust.js';
import { resolveOpenspecDir } from '../../utils/openspec-dir.js';
import { safeJoin } from '../../utils/path-confinement.js';
import { fileExists, formatDuration, formatAge, parseList, readJsonFile, resolveLLMProvider, estimateCost } from '../../utils/command-helpers.js';
import {
  DEFAULT_ANTHROPIC_MODEL,
  DEFAULT_OPENAI_MODEL,
  DEFAULT_OPENAI_COMPAT_MODEL,
  DEFAULT_COPILOT_MODEL,
  DEFAULT_GEMINI_MODEL,
  COST_CONFIRMATION_THRESHOLD,
  OPENLORE_DIR,
  OPENLORE_ANALYSIS_REL_PATH,
  OPENLORE_LOGS_SUBDIR,
  OPENLORE_OUTPUTS_SUBDIR,
  OPENLORE_GENERATION_SUBDIR,
  OPENLORE_CONFIG_REL_PATH,
  OPENSPEC_DIR,
  OPENSPEC_SPECS_SUBDIR,
  ARTIFACT_REPO_STRUCTURE,
  ARTIFACT_LLM_CONTEXT,
  ARTIFACT_DEPENDENCY_GRAPH,
  ARTIFACT_FINGERPRINT,
  ARTIFACT_GENERATION_REPORT,
  ARTIFACT_MAPPING,
  ARTIFACT_RAG_MANIFEST,
} from '../../constants.js';
import type { GenerateOptions } from '../../types/index.js';
import {
  readOpenLoreConfig,
  readOpenSpecConfig,
} from '../../core/services/config-manager.js';
import {
  createLLMService,
  type LLMService,
} from '../../core/services/llm-service.js';
import { isLlmLoggingEnabled } from '../../core/services/llm-logging-policy.js';
import {
  SpecGenerationPipeline,
  type PipelineResult,
} from '../../core/generator/spec-pipeline.js';
import {
  OpenSpecFormatGenerator,
  type GeneratedSpec,
} from '../../core/generator/openspec-format-generator.js';
import {
  OpenSpecWriter,
  shouldCleanStaleDomains,
  type GenerationReport,
  type WriteMode,
} from '../../core/generator/openspec-writer.js';
import { ADRGenerator } from '../../core/generator/adr-generator.js';
import type { RepoStructure, LLMContext } from '../../core/analyzer/artifact-generator.js';
import type { DependencyGraphResult } from '../../core/analyzer/dependency-graph.js';
import {
  requirementAnchorProposals,
  resolveSpecLinkIndex,
  verifyRequirementAnchors,
} from '../../core/generator/spec-link-service.js';
import type { SpecSymbolRef } from '../../core/generator/spec-link-index.js';
import { RagManifestGenerator } from '../../core/generator/rag-manifest-generator.js';
import { createProgress } from '../../utils/progress.js';
import { getShutdownManager, type ShutdownManager } from '../../utils/shutdown.js';
import { normalizeDomainName } from '../../core/generator/openspec-compat.js';
import { buildDomainEvidence, resolveDomainSelection } from '../../core/generator/domain-evidence.js';
import {
  readGenerationSnapshot,
  REQUIRED_ANALYSIS_ARTIFACTS,
  type GenerationManifest,
} from '../../core/runtime/analysis-generation.js';

// ============================================================================
// TYPES
// ============================================================================

interface ExtendedGenerateOptions extends GenerateOptions {
  merge?: boolean;
  noOverwrite?: boolean;
  /** Commander's storage key for `--no-overwrite` (default true; false when passed). */
  overwrite?: boolean;
  yes?: boolean;
  outputDir?: string;
  force?: boolean;
  /** Cheap plan-only alias: list the stages and domains, then stop. */
  plan?: boolean;
  /** Paid preview: run the real pipeline with every write redirected. */
  preview?: boolean;
}

interface AnalysisData {
  repoStructure: RepoStructure;
  llmContext: LLMContext;
  depGraph?: DependencyGraphResult;
  age: number;
  timestamp: string;
  generationCompatibility: GenerationManifest['compatibility'];
}

export type GenerateAnalysisLoadResult =
  | { state: 'ok'; data: AnalysisData }
  | { state: 'analysis-unavailable' }
  | { state: 'analysis-changed'; message: string };

type JsonArtifactReader = <T>(path: string, label: string) => Promise<T | null>;

export function normalizeGenerateOptions(options: Partial<ExtendedGenerateOptions>): ExtendedGenerateOptions {
  return {
    analysis: options.analysis ?? `${OPENLORE_ANALYSIS_REL_PATH}/`,
    model: options.model ?? '',
    dryRun: options.dryRun ?? false,
    plan: options.plan ?? false,
    preview: options.preview ?? false,
    domains: options.domains ?? [],
    adr: options.adr ?? false,
    adrOnly: options.adrOnly ?? false,
    merge: options.merge ?? false,
    // Commander stores `--no-overwrite` under the `overwrite` key (default true).
    noOverwrite: options.overwrite === false,
    yes: options.yes ?? false,
    outputDir: options.outputDir,
    quiet: false,
    verbose: false,
    noColor: false,
    config: OPENLORE_CONFIG_REL_PATH,
    force: options.force ?? false,
  };
}

/** Resolve an operator-supplied output path without rebasing an absolute path. */
export function resolveGenerateOutputPath(rootPath: string, outputDir: string): string {
  return resolve(rootPath, outputDir);
}

/**
 * Copy only ordinary files and directories from an untrusted repository tree.
 * Symlinks and special files are ignored; regular files are opened with NOFOLLOW
 * so a rename race cannot turn the validation into an external read.
 */
export async function copyRegularTree(sourceRoot: string, destinationRoot: string): Promise<void> {
  async function visit(relativePath: string): Promise<void> {
    const source = safeJoin(sourceRoot, relativePath || '.');
    let entries;
    try {
      entries = await readdir(source, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    await mkdir(safeJoin(destinationRoot, relativePath || '.'), { recursive: true });
    for (const entry of entries) {
      const child = join(relativePath, entry.name);
      // Inspect the directory entry itself before canonicalizing its target. A
      // symlink outside the root is something to skip, not an error that aborts
      // an otherwise-safe preview copy.
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        await visit(child);
        continue;
      }
      if (!entry.isFile()) continue;
      const sourcePath = safeJoin(sourceRoot, child);
      const handle = await open(sourcePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
      try {
        const verified = await handle.stat();
        if (!verified.isFile()) continue;
        // Re-confine and identify the path AFTER opening it. The handle is stable,
        // so a rename between directory enumeration and open cannot redirect the
        // subsequent read: an escaping parent is rejected, and a replaced path no
        // longer has the device/inode pair held by this handle.
        const currentPath = safeJoin(sourceRoot, child);
        const current = await stat(currentPath);
        if (current.dev !== verified.dev || current.ino !== verified.ino) continue;
        const destination = safeJoin(destinationRoot, child);
        await mkdir(dirname(destination), { recursive: true });
        await writeFile(destination, await handle.readFile());
      } finally {
        await handle.close();
      }
    }
  }
  await visit('');
}

/** Every `specs/<domain>/spec.md` under an openspec root, keyed by domain. */
async function readSpecTree(openspecRoot: string): Promise<Map<string, string>> {
  const specs = new Map<string, string>();
  const specsDir = join(openspecRoot, OPENSPEC_SPECS_SUBDIR);
  let entries;
  try {
    entries = await readdir(specsDir, { withFileTypes: true });
  } catch {
    return specs;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      specs.set(String(entry.name), await readFile(join(specsDir, String(entry.name), 'spec.md'), 'utf-8'));
    } catch {
      // A domain directory without a readable spec contributes nothing.
    }
  }
  return specs;
}

/**
 * Compare candidate specs generated into an isolated workspace with the specs
 * currently in the project.
 *
 * A normalized, line-count-level diff rather than a full text diff: the point is
 * to let a human see WHAT would change and by how much before paying to commit
 * it, not to reproduce `git diff` inside the CLI.
 */
export async function renderSpecPreviewDiff(projectRoot: string, previewRoot: string): Promise<string[]> {
  const [current, candidate] = await Promise.all([readSpecTree(projectRoot), readSpecTree(previewRoot)]);
  const domains = [...new Set([...current.keys(), ...candidate.keys()])].sort();
  const lines: string[] = [];

  if (domains.length === 0) return ['  (no specifications were generated)'];

  let changed = 0;
  for (const domain of domains) {
    const before = current.get(domain);
    const after = candidate.get(domain);
    if (after === undefined) {
      lines.push(`  = ${domain}  (untouched — not in this generation's scope)`);
      continue;
    }
    if (before === undefined) {
      changed++;
      lines.push(`  + ${domain}  (new spec, ${after.split('\n').length} lines)`);
      continue;
    }
    if (before === after) {
      lines.push(`  = ${domain}  (byte-identical)`);
      continue;
    }
    changed++;
    const delta = after.split('\n').length - before.split('\n').length;
    const sign = delta > 0 ? `+${delta}` : String(delta);
    lines.push(`  ~ ${domain}  (rewritten, ${sign} lines)`);
  }

  lines.push('');
  lines.push(changed === 0
    ? '  No specification would change.'
    : `  ${changed} specification(s) would change. Re-run without --preview to apply.`);
  return lines;
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Load analysis data from disk
 */
export async function loadAnalysis(
  analysisPath: string,
  readArtifact: JsonArtifactReader = readJsonFile,
): Promise<GenerateAnalysisLoadResult> {
  try {
    const snapshot = await readGenerationSnapshot(
      analysisPath,
      [...REQUIRED_ANALYSIS_ARTIFACTS],
      async () => {
        const repoStructure = await readArtifact<RepoStructure>(
          join(analysisPath, ARTIFACT_REPO_STRUCTURE), ARTIFACT_REPO_STRUCTURE,
        );
        const llmContext = await readArtifact<LLMContext>(
          join(analysisPath, ARTIFACT_LLM_CONTEXT), ARTIFACT_LLM_CONTEXT,
        );
        const depGraph = await readArtifact<DependencyGraphResult>(
          join(analysisPath, ARTIFACT_DEPENDENCY_GRAPH), ARTIFACT_DEPENDENCY_GRAPH,
        );
        // The fingerprint is not consumed by generation, but reading it inside
        // the snapshot makes the complete required artifact set part of this
        // attempt instead of merely trusting that its path exists.
        const fingerprint = await readArtifact<Record<string, unknown>>(
          join(analysisPath, ARTIFACT_FINGERPRINT), ARTIFACT_FINGERPRINT,
        );
        const stats = await stat(join(analysisPath, ARTIFACT_REPO_STRUCTURE));
        return {
          repoStructure,
          llmContext,
          depGraph,
          fingerprint,
          age: Date.now() - stats.mtime.getTime(),
          timestamp: stats.mtime.toISOString(),
        };
      },
    );

    if (snapshot.state !== 'ok') return snapshot;
    const value = snapshot.value;
    if (!value.repoStructure) return { state: 'analysis-unavailable' };
    if (snapshot.compatibility === 'manifest' && (!value.llmContext || !value.depGraph || !value.fingerprint)) {
      return { state: 'analysis-unavailable' };
    }
    return {
      state: 'ok',
      data: {
        repoStructure: value.repoStructure,
        llmContext: value.llmContext ?? {
          phase1_survey: { purpose: 'Initial survey', files: [], estimatedTokens: 0 },
          phase2_deep: { purpose: 'Deep analysis', files: [], totalTokens: 0 },
          phase3_validation: { purpose: 'Validation', files: [], totalTokens: 0 },
        },
        depGraph: value.depGraph ?? undefined,
        age: value.age,
        timestamp: value.timestamp,
        generationCompatibility: snapshot.compatibility,
      },
    };
  } catch (error) {
    logger.warning(`Failed to load analysis: ${(error as Error).message}`);
    return { state: 'analysis-unavailable' };
  }
}

/**
 * Estimate cost for the full generation pipeline (all stages).
 *
 * The pipeline makes multiple LLM calls:
 *   Stage 1 — 1 call  (survey)
 *   Stage 2 — 1 call per phase2_deep file  (entity extraction)
 *   Stage 3 — 1 call per phase2_deep file  (service analysis, same files as Stage 2)
 *   Stage 4 — 1 call  (API extraction, condensed context)
 *   Stage 5 — 1 call  (architecture synthesis, full context)
 *   Stage 6 — 1 call  (ADR, optional — not counted here)
 */

/**
 * Prompt user for confirmation. Uses @inquirer/prompts in TTY, auto-yes otherwise.
 */
async function promptConfirmation(message: string, autoYes: boolean): Promise<boolean> {
  if (autoYes) return true;

  if (!process.stdin.isTTY) {
    logger.warning(`${message} — use --yes to confirm in non-interactive mode`);
    return false;
  }

  return confirm({ message, default: true });
}

/**
 * Verify LLM API connectivity
 */
async function verifyApiConnectivity(llm: LLMService): Promise<boolean> {
  try {
    logger.debug('Verifying LLM API connectivity...');
    await llm.complete({
      systemPrompt: 'You are a test assistant.',
      userPrompt: 'Reply with just: OK',
      maxTokens: 5,
      temperature: 0,
    });
    return true;
  } catch (error) {
    logger.error(`LLM API verification failed: ${(error as Error).message}`);
    return false;
  }
}

// ============================================================================
// COMMAND
// ============================================================================

export const generateCommand = new Command('generate')
  .description('Generate OpenSpec files from analysis using LLM')
  .option(
    '--analysis <path>',
    'Path to existing analysis (skips re-analysis)',
    `${OPENLORE_ANALYSIS_REL_PATH}/`
  )
  .option(
    '--model <name>',
    'LLM model to use for generation (default depends on provider)'
  )
  .option(
    '--dry-run',
    'List the stages and domains that would run, then stop. No provider call, no cost, no writes.',
    false
  )
  .option(
    '--plan',
    'List the stages and domains that would run, then stop. No provider call, no cost, no writes.',
    false
  )
  .option(
    '--preview',
    'Run the real generation in an isolated temporary workspace and show the candidate spec diff. Provider calls and cost occur; the project tree is left byte-identical.',
    false
  )
  .option(
    '--domains <list>',
    'Only generate specific domains (comma-separated)',
    parseList
  )
  .option(
    '--merge',
    'Use merge strategy for existing specs',
    false
  )
  .option(
    '--no-overwrite',
    'Skip any existing spec files'
  )
  .option(
    '-y, --yes',
    'Skip confirmation prompts',
    false
  )
  .option(
    '--output-dir <path>',
    'Override openspec output location'
  )
  .option(
    '--adr',
    'Generate Architecture Decision Records alongside specs',
    false
  )
  .option(
    '--adr-only',
    'Only generate ADRs (skip spec generation)',
    false
  )
  .option(
    '--force',
    'Ignore cached stage results; full unfiltered generation also removes stale domains',
    false
  )
  .addHelpText(
    'after',
    `
Examples:
  $ openlore generate                Generate all specs from analysis
  $ openlore generate --dry-run      List planned stages/domains (free, no provider call)
  $ openlore generate --plan         Same free plan-only behavior, with an explicit name
  $ openlore generate --preview      Paid preview: generate in a temp workspace and diff
  $ openlore generate --domains auth,api,database
                                     Only generate specific domains
  $ openlore generate --model claude-opus-4-20250514
                                     Use a different model
  $ openlore generate --analysis ./my-analysis
                                     Use analysis from custom path
  $ openlore generate --merge        Merge with existing specs
  $ openlore generate --no-overwrite Skip existing spec files
  $ openlore generate --adr          Also generate ADRs
  $ openlore generate --adr-only     Only generate ADRs
  $ openlore generate -y             Skip confirmation prompts
  $ openlore generate                Auto-resumes from last completed stage if interrupted
  $ openlore generate --force        Re-run all LLM stages; full generation removes stale domains
  $ openlore generate --force --domains auth
                                     Re-run auth only; preserve every unselected domain
  $ openlore analyze --force && openlore generate --force
                                     Full reset: fresh static analysis + full regeneration

Output structure (OpenSpec format):
  openspec/
  ├── config.yaml              Project configuration (updated)
  ├── specs/
  │   ├── overview/spec.md     System overview
  │   ├── architecture/spec.md System architecture
  │   ├── {domain}/spec.md     Domain specifications
  │   └── api/spec.md          API specification (if applicable)
  └── decisions/               Architecture Decision Records (with --adr)
      ├── index.md             ADR index
      └── adr-NNNN-*.md        Individual decisions

Each spec.md follows OpenSpec conventions:
  - RFC 2119 keywords (SHALL, MUST, SHOULD, MAY)
  - Given/When/Then scenarios with #### headings
  - Technical notes linking to source files
`
  )
  .action(async function (this: Command, options: Partial<ExtendedGenerateOptions>) {
    const startTime = Date.now();
    const rootPath = process.cwd();
    const hasOperatorOutputDir = Boolean(options.outputDir);
    let previewRoot: string | null = null;
    let comparisonOpenspecRoot: string;
    let shutdownManager: ShutdownManager | null = null;
    const removePreview = async (): Promise<void> => {
      if (previewRoot) await rm(previewRoot, { recursive: true, force: true });
    };

    // Inherit global options (--api-base, --insecure, etc.)
    const globalOpts = this.optsWithGlobals?.() ?? {};

    const opts = normalizeGenerateOptions(options);

    try {
      // ========================================================================
      // PHASE 1: CONFIGURATION LOADING
      // ========================================================================
      logger.section('Loading Configuration');

      // Load openlore config
      const openloreConfig = await readOpenLoreConfig(rootPath);
      if (!openloreConfig) {
        logger.error('No openlore configuration found. Run "openlore init" first.');
        process.exitCode = 1;
        return;
      }

      if ([opts.dryRun, opts.plan, opts.preview].filter(Boolean).length > 1) {
        logger.error('Choose only one of --dry-run, --plan, or --preview.');
        process.exitCode = 1;
        return;
      }

      // A paid preview redirects EVERY project-target path into a throwaway
      // workspace: specs, mapping, config, manifests, backups. Redirecting through
      // the existing `--output-dir` plumbing means there is one isolation
      // mechanism, not a second parallel set of preview-only write paths.
      comparisonOpenspecRoot = options.outputDir
        ? resolveGenerateOutputPath(rootPath, options.outputDir)
        : resolveOpenspecDir(rootPath, openloreConfig.openspecPath);
      previewRoot = opts.preview ? await mkdtemp(join(tmpdir(), 'openlore-preview-')) : null;
      if (previewRoot) {
        shutdownManager = getShutdownManager(rootPath);
        shutdownManager.onCleanup(removePreview);
        // Merge/skip/config behavior must be evaluated against the current corpus,
        // not against an empty directory that makes every candidate look new.
        await copyRegularTree(comparisonOpenspecRoot, previewRoot);
        opts.outputDir = previewRoot;
      }

      // Determine openspec path
      const openspecPath = opts.outputDir ?? openloreConfig.openspecPath ?? OPENSPEC_DIR;
      // NOTE: `openspecPath` is the REQUESTED value (used for messages that describe
      // the request). `fullOpenspecPath` below is the confined, real destination —
      // anything describing where files went must use that one.
      // `--output-dir` is operator-supplied and may legitimately point anywhere;
      // `openspecPath` comes from the repo's own config.json and may not — it ends up
      // as a write target (the RAG manifest, synced specs) further down.
      const fullOpenspecPath = opts.outputDir
        ? resolveGenerateOutputPath(rootPath, opts.outputDir)
        : resolveOpenspecDir(rootPath, openloreConfig.openspecPath);

      // Load existing OpenSpec config if present
      const openspecConfig = await readOpenSpecConfig(fullOpenspecPath);

      logger.info('Project', openloreConfig.projectType);
      logger.info('OpenSpec path', openspecPath);
      if (openspecConfig?.context) {
        logger.info('Context', openspecConfig.context.substring(0, 50) + '...');
      }
      logger.blank();

      // ========================================================================
      // PHASE 2: ANALYSIS LOADING
      // ========================================================================
      logger.section('Loading Analysis');

      const analysisPath = join(rootPath, opts.analysis);

      // --force: clear intermediate stage files so no stale LLM output survives
      if (options.force === true && !opts.dryRun && !opts.plan && !opts.preview) {
        const generationDir = join(rootPath, OPENLORE_DIR, OPENLORE_GENERATION_SUBDIR);
        await rm(generationDir, { recursive: true, force: true });
        logger.discovery('--force: cleared generation cache');
      }

      const analysisData = await loadAnalysis(analysisPath);

      if (analysisData.state === 'analysis-changed') {
        logger.error(analysisData.message);
        process.exitCode = 1;
        return;
      }
      if (analysisData.state === 'analysis-unavailable') {
        logger.error('No analysis found. Run "openlore analyze" first.');
        process.exitCode = 1;
        return;
      }

      const { repoStructure, llmContext, depGraph, age, generationCompatibility } = analysisData.data;

      logger.discovery(`Using analysis from ${formatAge(age)}`);
      if (generationCompatibility === 'legacy') {
        logger.warning('Using a legacy analysis without a generation manifest; run "openlore analyze" to upgrade its coherence guarantee.');
      }
      logger.info('Files analyzed', repoStructure.statistics.analyzedFiles);
      logger.info('Domains detected', repoStructure.domains.map(d => d.name).join(', ') || 'None');
      logger.blank();

      if (opts.plan || opts.dryRun) {
        logger.section('Generation Plan');
        logger.discovery('Would run LLM generation pipeline with:');
        logger.listItem('Stage 1: Project Survey');
        logger.listItem('Stage 2: Entity Extraction');
        logger.listItem('Stage 3: Service Analysis');
        logger.listItem('Stage 4: API Extraction');
        logger.listItem('Stage 5: Architecture Synthesis');
        logger.blank();

        const availableDomains = buildDomainEvidence(repoStructure, llmContext).map(domain => domain.name);
        const selectedKeys = resolveDomainSelection(
          availableDomains,
          opts.domains,
        );
        const domainFilter = availableDomains
          .filter(name => selectedKeys.includes(normalizeDomainName(name)));
        logger.discovery('Domains to generate:');
        for (const domain of domainFilter) logger.listItem(domain);
        logger.blank();

        logger.discovery('Would write:');
        if (!opts.adrOnly) {
          logger.listItem(`${openspecPath}/specs/overview/spec.md`);
          logger.listItem(`${openspecPath}/specs/architecture/spec.md`);
          for (const domain of domainFilter) {
            logger.listItem(`${openspecPath}/specs/${normalizeDomainName(domain)}/spec.md`);
          }
          logger.listItem(`${openspecPath}/specs/api/spec.md (if applicable)`);
        }
        if (opts.adr || opts.adrOnly) logger.listItem(`${openspecPath}/decisions/ (if decisions are found)`);
        logger.blank();

        logger.success(`${opts.dryRun ? 'Dry run' : 'Plan'} complete. No provider call was made and no files were modified.`);
        return;
      }

      // ========================================================================
      // PHASE 3: PRE-FLIGHT CHECKS
      // ========================================================================
      logger.section('Pre-flight Checks');

      // Resolve provider from env vars + config
      const resolved = resolveLLMProvider(openloreConfig);
      if (!resolved) {
        logger.error('No LLM API key found.');
        logger.discovery('Set one of the following environment variables:');
        logger.discovery('  ANTHROPIC_API_KEY    → https://console.anthropic.com/');
        logger.discovery('  OPENAI_API_KEY       → https://platform.openai.com/');
        logger.discovery('  GEMINI_API_KEY       → https://aistudio.google.com/');
        logger.discovery('  OPENAI_COMPAT_API_KEY + OPENAI_COMPAT_BASE_URL  → Mistral, Groq, Ollama...');
        logger.discovery('  Or set provider to "codex-cli", "claude-code", "gemini-cli", "antigravity-cli", "cursor-agent", "mistral-vibe", or "copilot" (no API key needed).');
        process.exitCode = 1;
        return;
      }
      const effectiveProvider = resolved.provider;
      const effectiveBaseUrl = resolved.openaiCompatBaseUrl;

      // Resolve model with priority: CLI flag > config > provider default
      const defaultModels: Record<string, string> = {
        anthropic: DEFAULT_ANTHROPIC_MODEL,
        gemini: DEFAULT_GEMINI_MODEL,
        'openai-compat': DEFAULT_OPENAI_COMPAT_MODEL,
        copilot: DEFAULT_COPILOT_MODEL,
        openai: DEFAULT_OPENAI_MODEL,
        'claude-code': 'claude-code',
        'codex-cli': 'codex-cli',
        'mistral-vibe': 'mistral-vibe',
        'gemini-cli': 'gemini-cli',
        'antigravity-cli': 'antigravity-cli',
        'cursor-agent': 'cursor-agent',
      };
      const effectiveModel = opts.model || openloreConfig.generation.model || defaultModels[effectiveProvider];

      // Only `--insecure` (operator-supplied) may relax TLS. A repo-committed
      // `skipSslVerify` is refused — see repo-config-trust.ts. This sits ~85 lines
      // above the createLLMService call that also resolves sslVerify; both doors have
      // to be shut or the guarded one is decoration.
      rejectRepoConfiguredTlsOptOut('generation.skipSslVerify', openloreConfig.generation.skipSslVerify);
      rejectRepoConfiguredTlsOptOut('embedding.skipSslVerify', openloreConfig.embedding?.skipSslVerify);
      if (globalOpts.insecure) {
        allowInsecureTls('--insecure');
      }

      // Estimate cost
      const estimate = estimateCost(llmContext, effectiveProvider, effectiveModel);
      logger.info('Model', effectiveModel);
      logger.info('Estimated tokens', estimate.tokens.toLocaleString());
      logger.inference(`Estimated cost: ~$${estimate.cost.toFixed(2)}`);
      logger.blank();

      // Check for existing specs
      const specsPath = join(fullOpenspecPath, 'specs');
      if (await fileExists(specsPath)) {
        if (opts.merge) {
          logger.info('Mode', 'Merge with existing specs');
        } else if (opts.noOverwrite) {
          logger.info('Mode', 'Skip existing specs');
        } else {
          logger.warning('Existing specs will be replaced (backed up)');
        }
        logger.blank();
      }

      if (opts.preview) {
        logger.discovery('PAID PREVIEW — the real pipeline runs in an isolated temporary workspace.');
        logger.warning(`Provider calls and cost occur (estimated ~$${estimate.cost.toFixed(2)}). Use --dry-run for a free plan.`);
        logger.blank();
      }

      // Confirmation prompt. Plan mode never reaches a provider, so there is no
      // cost to confirm — prompting there would make the free preview interactive.
      if (!opts.plan && !opts.dryRun && estimate.cost > COST_CONFIRMATION_THRESHOLD) {
        const confirmed = await promptConfirmation(
          `Estimated cost: ~$${estimate.cost.toFixed(2)}. Continue? [Y/n]`,
          opts.yes ?? false
        );
        if (!confirmed) {
          logger.discovery('Cancelled by user');
          return;
        }
      }

      // ========================================================================
      // PHASE 4: LLM GENERATION
      // ========================================================================
      logger.section('Generating Specifications');

      // Create LLM service (CLI flags > env vars > config file)
      let llm: LLMService;
      try {
        llm = createLLMService({
          provider: effectiveProvider,
          model: effectiveModel,
          openaiCompatBaseUrl: effectiveBaseUrl,
          apiBase: resolveTrustedApiBase(globalOpts.apiBase, openloreConfig?.llm?.apiBase),
          sslVerify: resolveTrustedSslVerify(globalOpts.insecure, openloreConfig?.llm?.sslVerify),
          timeout: globalOpts.timeout ?? openloreConfig.generation?.timeout,
          enableLogging: isLlmLoggingEnabled(),
          logDir: previewRoot
            ? join(previewRoot, OPENLORE_DIR, OPENLORE_LOGS_SUBDIR)
            : safeJoin(rootPath, join(OPENLORE_DIR, OPENLORE_LOGS_SUBDIR)),
          logRoot: previewRoot ?? rootPath,
        });
      } catch (error) {
        logger.error(`Failed to create LLM service: ${(error as Error).message}`);
        process.exitCode = 1;
        return;
      }

      // Verify API connectivity
      if (!(await verifyApiConnectivity(llm))) {
        logger.error('Failed to connect to LLM API. Check your API key and network.');
        process.exitCode = 1;
        return;
      }

      // Wire semantic search if a vector index exists (used by pipeline + mapping)
      const analysisDir = join(rootPath, '.openlore', 'analysis');
      let semanticSearch: import('./../../core/generator/mapping-generator.js').SemanticSearchFn | undefined;
      {
        const { VectorIndex } = await import('../../core/analyzer/vector-index.js');
        if (VectorIndex.exists(analysisDir)) {
          const { resolveEmbedder } = await import('../../core/analyzer/embedder.js');
          const embedSvc = await resolveEmbedder(openloreConfig) ?? undefined;
          if (embedSvc) {
            const svc = embedSvc;
            semanticSearch = (query, limit) => VectorIndex.search(analysisDir, query, svc, { limit });
            logger.analysis('Vector index found — using semantic search for file selection');
          }
        }
      }

      // Run generation pipeline
      const progress = createProgress();
      progress.start('Generating specifications...');

      // A paid preview leaves the project byte-identical, so the intermediate stage
      // cache is redirected into the throwaway workspace as well — a preview must
      // not write (or overwrite) the project's stage output. The existing cache is
      // COPIED in first, so the preview still reuses whatever has already been paid
      // for instead of re-running every stage.
      const stageCacheDir = safeJoin(rootPath, join(OPENLORE_DIR, OPENLORE_GENERATION_SUBDIR));
      let pipelineOutputDir = stageCacheDir;
      if (previewRoot) {
        pipelineOutputDir = join(previewRoot, OPENLORE_DIR, OPENLORE_GENERATION_SUBDIR);
        await copyRegularTree(stageCacheDir, pipelineOutputDir);
      }

      const pipeline = new SpecGenerationPipeline(llm, {
        outputDir: pipelineOutputDir,
        rootPath,
        domains: opts.domains,
        saveIntermediate: true,
        generateADRs: opts.adr || opts.adrOnly,
        force: opts.force,
        progress,
        semanticSearch,
        chunkMaxChars: openloreConfig.generation?.chunkMaxChars,
      });

      let pipelineResult: PipelineResult;
      try {
        pipelineResult = await pipeline.run(repoStructure, llmContext, depGraph);
        progress.succeed('Pipeline completed');
      } catch (error) {
        progress.fail(`Pipeline failed: ${(error as Error).message}`);

        // Save logs on failure
        try {
          if (await llm.saveLogs()) {
            logger.discovery(opts.preview
              ? 'LLM logs were isolated with the preview workspace and will be discarded.'
              : `LLM logs saved to ${OPENLORE_DIR}/${OPENLORE_LOGS_SUBDIR}/`);
          }
        } catch {
          // Ignore log save errors
        }

        process.exitCode = 1;
        return;
      }

      // Show pipeline results
      const { metadata } = pipelineResult;
      logger.blank();
      logger.success('Pipeline completed');
      logger.info('Stages completed', metadata.completedStages.join(', '));
      if (metadata.skippedStages.length > 0) {
        logger.info('Stages skipped', metadata.skippedStages.join(', '));
      }
      logger.info('Total tokens', metadata.totalTokens.toLocaleString());
      logger.info('Cost', `$${metadata.estimatedCost.toFixed(4)}`);
      logger.info('Duration', formatDuration(metadata.duration));
      logger.blank();

      // ========================================================================
      // PHASE 5: FORMAT AND WRITE SPECS
      // ========================================================================
      logger.section('Writing OpenSpec Files');

      // Verify each requirement's proposed implementation symbol against the graph
      // BEFORE writing, so specs carry exact anchors the link index reads back.
      // A proposal that resolves to zero or several symbols yields no anchor.
      let verifiedAnchors: Map<string, SpecSymbolRef> | undefined;
      if (depGraph) {
        const anchors = verifyRequirementAnchors(requirementAnchorProposals(pipelineResult), depGraph);
        verifiedAnchors = anchors;
        logger.success(`Requirement anchors: ${anchors.size} verified against the current graph`);
      }

      // Generate formatted specs
      const formatGenerator = new OpenSpecFormatGenerator({
        version: openloreConfig.version,
        includeConfidence: true,
        includeTechnicalNotes: true,
        depGraph,
      });

      const allGeneratedSpecs = formatGenerator.generateSpecs(pipelineResult, verifiedAnchors);
      let generatedSpecs = opts.adrOnly ? [] : [...allGeneratedSpecs];

      // Filter by domains if specified
      if (!opts.adrOnly && opts.domains.length > 0) {
        const domainSet = new Set(opts.domains.map(normalizeDomainName));
        generatedSpecs = generatedSpecs.filter(spec => {
          // Always include overview and architecture
          if (spec.type === 'overview' || spec.type === 'architecture') {
            return true;
          }
          // Check if domain matches
          return domainSet.has(normalizeDomainName(spec.domain));
        });
        logger.info('Filtered to domains', opts.domains.join(', '));
      }

      // Generate ADRs if requested
      let adrSpecs: GeneratedSpec[] = [];
      if (opts.adr || opts.adrOnly) {
        const adrGenerator = new ADRGenerator({
          version: openloreConfig.version,
          includeMermaid: true,
        });
        adrSpecs = adrGenerator.generateADRs(pipelineResult);
        if (adrSpecs.length > 0) {
          logger.info('ADRs generated', adrSpecs.length);
          generatedSpecs = [...generatedSpecs, ...adrSpecs];
        } else {
          logger.warning('No architectural decisions found for ADR generation');
        }
      }
      const metadataSpecs = [...allGeneratedSpecs, ...adrSpecs];

      logger.info('Total files to write', generatedSpecs.length);
      logger.blank();

      // Determine write mode
      let writeMode: WriteMode = 'replace';
      if (opts.merge) {
        writeMode = 'merge';
      } else if (opts.noOverwrite) {
        writeMode = 'skip';
      }

      // Write specs
      const writer = new OpenSpecWriter({
        rootPath,
        openspecRoot: fullOpenspecPath,
        // A preview writes its backups, outputs, and logs into the throwaway
        // workspace too — otherwise "the project tree was not modified" is false.
        ...(previewRoot ? { openloreRoot: join(previewRoot, OPENLORE_DIR) } : {}),
        writeMode,
        version: openloreConfig.version,
        createBackups: true,
        updateConfig: hasOperatorOutputDir || opts.domains.length === 0,
        validateBeforeWrite: true,
        cleanBeforeWrite: shouldCleanStaleDomains(opts.force, opts.domains, opts.adrOnly),
      });

      let report: GenerationReport;
      try {
        report = await writer.writeSpecs(generatedSpecs, pipelineResult.survey, metadataSpecs);
      } catch (error) {
        logger.error(`Failed to write specs: ${(error as Error).message}`);
        process.exitCode = 1;
        return;
      }

      // Derive the mapping cache from the specs that were actually WRITTEN, under
      // the same deterministic contract the agent-hosted skills finalize through.
      // A failure here costs only the cache — audit and Repair re-derive in memory.
      try {
        const resolution = await resolveSpecLinkIndex({
          rootPath: opts.outputDir ? fullOpenspecPath : rootPath,
          openspecPath: opts.outputDir ? '.' : relative(rootPath, fullOpenspecPath) || OPENSPEC_DIR,
          persist: true,
          graph: depGraph,
        });
        if (resolution.state === 'available') {
          const { stats } = resolution.index;
          logger.success(
            `Spec link index: ${stats.linked}/${stats.totalRequirements} requirements linked ` +
            `(${stats.ambiguous} ambiguous, ${stats.unmapped} unmapped, ${stats.stale} stale) → ` +
            `${relative(rootPath, resolution.artifactPath) || ARTIFACT_MAPPING}`,
          );
        } else {
          logger.warning(`Spec link index unavailable (${resolution.reason}): ${resolution.remediation}`);
        }
      } catch (error) {
        logger.warning(`Could not derive the spec link index: ${(error as Error).message}`);
      }

      // Generate RAG manifest
      try {
        if (opts.domains.length > 0 && !hasOperatorOutputDir) {
          logger.warning('Scoped generation leaves the global RAG manifest unchanged. Run without --domains to refresh it.');
        } else {
          const manifestGen = new RagManifestGenerator();
          const manifest = manifestGen.generate(metadataSpecs, depGraph);
          const { writeFile } = await import('node:fs/promises');
          await writeFile(
            safeJoin(fullOpenspecPath, ARTIFACT_RAG_MANIFEST),
            JSON.stringify(manifest, null, 2),
            'utf-8',
          );
          // Report where it ACTUALLY went. `openloreConfig.openspecPath` is the
          // requested value, which may have been clamped back into the root — printing
          // it made the tool claim a destination it had deliberately refused to use.
          logger.success(`RAG manifest: ${manifest.domains.length} domains → ${relative(rootPath, join(fullOpenspecPath, ARTIFACT_RAG_MANIFEST)) || ARTIFACT_RAG_MANIFEST}`);
        }
      } catch (error) {
        logger.warning(`Could not generate RAG manifest: ${(error as Error).message}`);
      }

      // ========================================================================
      // PHASE 6: POST-GENERATION
      // ========================================================================
      if (previewRoot) {
        logger.blank();
        logger.section('Paid Preview');
        for (const line of await renderSpecPreviewDiff(comparisonOpenspecRoot!, previewRoot)) console.log(line);
        logger.blank();
        logger.success('Preview complete. The project tree was not modified.');
        return;
      }

      logger.blank();
      logger.section('Generation Complete');

      const duration = Date.now() - startTime;

      // Summary
      console.log('');
      if (report.filesWritten.length > 0) {
        console.log(`  ✓ ${report.filesWritten.length} spec(s) written`);
      }
      if (report.filesMerged.length > 0) {
        console.log(`  ✓ ${report.filesMerged.length} spec(s) merged`);
      }
      if (report.filesSkipped.length > 0) {
        console.log(`  ○ ${report.filesSkipped.length} spec(s) skipped (already exist)`);
      }
      if (report.filesBackedUp.length > 0) {
        console.log(`  ↩ ${report.filesBackedUp.length} backup(s) created`);
      }
      if (report.configUpdated) {
        console.log('  ✓ config.yaml updated');
      }

      // Warnings
      if (report.warnings.length > 0) {
        console.log('');
        console.log('  Warnings:');
        for (const warning of report.warnings.slice(0, 5)) {
          console.log(`    ⚠ ${warning}`);
        }
        if (report.warnings.length > 5) {
          console.log(`    ... and ${report.warnings.length - 5} more`);
        }
      }

      // Validation errors
      if (report.validationErrors.length > 0) {
        console.log('');
        console.log('  Validation errors:');
        for (const error of report.validationErrors.slice(0, 5)) {
          console.log(`    ✗ ${error}`);
        }
      }

      // Next steps
      console.log('');
      console.log('  Next steps:');
      for (let i = 0; i < report.nextSteps.length; i++) {
        console.log(`    ${i + 1}. ${report.nextSteps[i]}`);
      }

      console.log('');
      console.log(`  Total time: ${formatDuration(duration)}`);
      console.log(`  Report saved to: ${OPENLORE_DIR}/${OPENLORE_OUTPUTS_SUBDIR}/${ARTIFACT_GENERATION_REPORT}`);
      console.log('');

      // Save LLM logs
      try {
        await llm.saveLogs();
      } catch (logErr) {
        logger.debug(`LLM log save skipped: ${(logErr as Error).message}`);
      }

      logger.success('Done!');

    } catch (error) {
      logger.error(`Generate failed: ${(error as Error).message}`);
      if (process.env.DEBUG) {
        console.error(error);
      }
      process.exitCode = 1;
    } finally {
      // A preview workspace is disposable by definition: remove it whether the
      // pipeline succeeded, failed, or threw mid-provider-call.
      if (previewRoot) {
        await removePreview().catch(() => {});
        shutdownManager?.removeCleanup(removePreview);
      }
    }
  });
