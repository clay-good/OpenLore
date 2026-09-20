import { realpath } from 'node:fs/promises';
import { ANALYSIS_ARTIFACT_MAX_BYTES, readArtifactBounded } from '../../utils/bounded-artifact-read.js';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import {
  OPENSPEC_DECISIONS_SUBDIR,
  OPENSPEC_DIR,
  OPENSPEC_SPECS_SUBDIR,
  SOURCE_SCAN_MAX_FILE_BYTES,
} from '../../constants.js';
import type { OpenLoreConfig } from '../../types/index.js';
import { fileExists } from '../../utils/command-helpers.js';
import { resolveOpenspecDir } from '../../utils/openspec-dir.js';
import { safeJoin } from '../../utils/path-confinement.js';
import { mapFilesBounded, readSourceCapped } from './bounded-file-scan.js';
import type { LLMContext } from './artifact-generator.js';
import type { Embedder } from './embedding-service.js';
import { embedderMode, indexCapabilityAgreement, resolveEmbedder } from './embedder.js';
import { mergeAnalysisPatterns } from './analysis-core.js';
import { FileWalker } from './file-walker.js';
import { SpecVectorIndex } from './spec-vector-index.js';
import { TextLineIndex } from './text-line-index.js';
import { VectorIndex, VectorIndexLockContendedError } from './vector-index.js';
import { loadRepositoryVocabulary } from './repo-vocabulary.js';
import { atomicWriteFile } from '../decisions/atomic-store.js';
import { analysisGeneratedExcludes } from './analysis-core.js';

const TEXT_INDEX_MAX_FILE_BYTES = 2_000_000;

export interface IndexReport {
  index: 'function' | 'text' | 'spec';
  status: 'start' | 'complete' | 'skip' | 'warning';
  detail?: string;
}

export interface IndexReporter {
  report(event: IndexReport): void;
}

export interface AnalysisIndexResult {
  functionIndex: 'built' | 'skipped' | 'degraded';
  textIndex: 'built' | 'skipped';
  specIndex: 'built' | 'skipped';
  degraded: Array<{ index: IndexReport['index']; reason: string }>;
}

export interface BuildAnalysisIndexesOptions {
  rootPath: string;
  outputPath: string;
  config: OpenLoreConfig | null;
  llmContext?: LLMContext | null;
  force?: boolean;
  keywordOnly?: boolean;
  freshSpecDirectory?: boolean;
  include?: string[];
  exclude?: string[];
  reporter?: IndexReporter;
  /** Analysis generation this index set consumes; enables verified cache reuse. */
  generationId?: string;
  /**
   * Wait for another process's index mutation instead of failing on contention.
   * Off by default: a silent wait on a hung holder is how a build appears to hang.
   */
  waitForLock?: boolean;
}

export interface BuildSpecIndexOptions {
  rootPath: string;
  outputPath: string;
  config: OpenLoreConfig | null;
  keywordOnly?: boolean;
  reporter?: IndexReporter;
}

function describePopulation(result: { total: number; productionFunctions: number; testFunctions: number; signatureOnlySymbols: number }): string {
  return result.testFunctions + result.signatureOnlySymbols === 0
    ? `${result.productionFunctions} functions`
    : `${result.productionFunctions} call-graph functions + ${result.testFunctions} test functions + ${result.signatureOnlySymbols} signature-only symbols; ${result.total} indexed repo symbols`;
}

async function loadContext(outputPath: string, supplied: LLMContext | null | undefined): Promise<LLMContext> {
  if (supplied) return supplied;
  // The bounded reader, not `readFile`: every `.openlore/analysis/` artifact is
  // repository-controlled input, and a committed FIFO at this path blocks inside `open()` on a
  // libuv worker for good — a hang no `process.exit` can interrupt. It also refuses a symlink
  // (which would redirect the read out of the analysis directory) and an oversized file.
  const path = join(outputPath, 'llm-context.json');
  const read = await readArtifactBounded(path, ANALYSIS_ARTIFACT_MAX_BYTES);
  if (!read) throw new Error(`Unreadable analysis artifact: ${path}`);
  return JSON.parse(read.text) as LLMContext;
}

async function buildTextIndex(
  rootPath: string,
  outputPath: string,
  configured: OpenLoreConfig['analysis'] | undefined,
  include: string[],
  exclude: string[],
  protectedExcludePatterns: string[],
): Promise<{ lines: number; files: number }> {
  const patterns = mergeAnalysisPatterns(configured, include, exclude);
  const walk = await new FileWalker(rootPath, {
    includePatterns: patterns.includePatterns,
    restrictedIncludePatterns: configured?.includePatterns,
    excludePatterns: patterns.excludePatterns,
    protectedExcludePatterns,
  }).walk();
  const candidates = walk.files.filter(file => file.size <= TEXT_INDEX_MAX_FILE_BYTES);
  async function* streamFiles(): AsyncGenerator<{ filePath: string; content: string }> {
    const chunkSize = 32;
    for (let offset = 0; offset < candidates.length; offset += chunkSize) {
      const slice = candidates.slice(offset, offset + chunkSize);
      const contents = await mapFilesBounded(
        slice.map(file => file.absolutePath),
        absolutePath => readSourceCapped(absolutePath, TEXT_INDEX_MAX_FILE_BYTES),
      );
      for (let index = 0; index < slice.length; index++) {
        const content = contents[index];
        if (content !== null) yield { filePath: slice[index].path, content };
      }
    }
  }
  return TextLineIndex.build(outputPath, streamFiles());
}

async function buildSpecIndexWithEmbedder(
  options: BuildSpecIndexOptions,
  embedder: Embedder | null,
): Promise<'built' | 'skipped'> {
  const emit = (event: IndexReport): void => options.reporter?.report(event);
  emit({ index: 'spec', status: 'start' });
  const openspecRoot = resolveOpenspecDir(options.rootPath, options.config?.openspecPath ?? OPENSPEC_DIR);
  const specsDir = join(openspecRoot, OPENSPEC_SPECS_SUBDIR);
  if (!(await fileExists(specsDir))) {
    emit({ index: 'spec', status: 'skip', detail: 'No OpenSpec specs directory.' });
    return 'skipped';
  }
  await SpecVectorIndex.build(
    options.outputPath,
    specsDir,
    embedder,
    join(options.outputPath, 'mapping.json'),
    join(openspecRoot, OPENSPEC_DECISIONS_SUBDIR),
  );
  emit({ index: 'spec', status: 'complete' });
  return 'built';
}

/** Spec-only fast path used by `analyze --reindex-specs`. */
export async function buildSpecIndex(options: BuildSpecIndexOptions): Promise<'built' | 'skipped'> {
  let embedder: Embedder | null = null;
  try {
    if (!options.keywordOnly) embedder = await resolveEmbedder(options.config);
    return await buildSpecIndexWithEmbedder(options, embedder);
  } catch (error) {
    const message = (error as Error).message;
    options.reporter?.report({
      index: 'spec',
      status: message.includes('exists but contains no spec.md files') ? 'skip' : 'warning',
      detail: message,
    });
    return 'skipped';
  }
}

/** Build the three search indexes without owning a terminal or global logger. */
const INDEX_GENERATION_FILE = 'analysis-indexes.json';
const indexBuilds = new Map<string, Promise<void>>();

interface IndexGenerationReceipt {
  generationId: string;
  configurationHash: string;
  result: AnalysisIndexResult;
  specSkipDetail?: string;
  /**
   * A semantic-index failure observed OUTSIDE a full build — the watcher's incremental
   * embed. It used to exist only as a line in `.openlore/serve.log`, where no surface an
   * operator or an agent consults could ever see it (spec `cli`
   * IndexBuildFailureIsVisibleOutsideTheDaemonLog).
   */
  embedFailure?: IndexEmbedFailure;
}

/** A semantic-index failure recorded for the surfaces that report index state. */
export interface IndexEmbedFailure {
  /** ISO timestamp of the failure. */
  at: string;
  /** Message, already sanitized by the caller. */
  reason: string;
  /** The configured endpoint, when the failure was a remote one. */
  endpoint?: string;
}

function indexConfigurationHash(options: BuildAnalysisIndexesOptions): string {
  return createHash('sha256').update(JSON.stringify({
    keywordOnly: options.keywordOnly ?? false,
    embedding: options.config?.embedding ?? null,
    retrieval: options.config?.retrieval ?? null,
    generation: options.config?.generation ?? null,
    openspecPath: options.config?.openspecPath ?? null,
    analysis: options.config?.analysis ?? null,
    include: options.include ?? [],
    exclude: options.exclude ?? [],
  })).digest('hex');
}

function indexExists(index: 'function' | 'text' | 'spec', status: string, outputPath: string): boolean {
  if (status === 'skipped') return true;
  if (index === 'function') return VectorIndex.exists(outputPath);
  if (index === 'text') return TextLineIndex.exists(outputPath);
  return SpecVectorIndex.exists(outputPath);
}

/**
 * Why a receipt that passed the generation and configuration checks was still not reused.
 * Returned so the caller can SAY so: an invalidation nobody can see is how a repository
 * serves keyword results under a semantic configuration for weeks.
 */
export type IndexReuseRejection = 'configured-but-unrealized' | 'vectors-without-provider';

/** A reusable receipt, or the capability mismatch that rejected one. */
interface IndexReuseVerdict {
  receipt: IndexGenerationReceipt | null;
  rejection?: IndexReuseRejection;
}

async function readReusableIndexes(options: BuildAnalysisIndexesOptions): Promise<IndexReuseVerdict> {
  if (!options.generationId || options.force) return { receipt: null };
  try {
    const raw = await readArtifactBounded(join(options.outputPath, INDEX_GENERATION_FILE), ANALYSIS_ARTIFACT_MAX_BYTES);
    if (!raw) return { receipt: null };
    const receipt = JSON.parse(raw.text) as IndexGenerationReceipt;
    if (receipt.generationId !== options.generationId || receipt.configurationHash !== indexConfigurationHash(options)) return { receipt: null };
    if (!indexExists('function', receipt.result.functionIndex, options.outputPath)
      || !indexExists('text', receipt.result.textIndex, options.outputPath)
      || !indexExists('spec', receipt.result.specIndex, options.outputPath)) return { receipt: null };
    // A receipt is now written even for a degraded build, so that the degradation is
    // REPORTABLE. Reuse still requires a clean one — the previous behavior, when a
    // degraded build simply wrote nothing.
    if (receipt.result.degraded.length > 0 || receipt.embedFailure) return { receipt: null };
    // The configuration hash covers `config.embedding`, so a config that NAMES a provider
    // hashes identically whether or not the build realized it. Compare the realized
    // capability too, or a keyword index built while the endpoint was down is reused
    // forever (spec `analyzer` IndexReuseRequiresCapabilityAgreement).
    if (!options.keywordOnly) {
      const agreement = indexCapabilityAgreement(options.config, options.outputPath);
      if (!agreement.agrees) return { receipt: null, rejection: agreement.mismatch };
    }
    return { receipt };
  } catch {
    return { receipt: null };
  }
}

/** Human-readable reason for a capability-mismatch invalidation, for the one-line notice. */
function reuseRejectionDetail(rejection: IndexReuseRejection): string {
  return rejection === 'configured-but-unrealized'
    ? 'A semantic embedding provider is configured but the existing index carries no vectors — rebuilding it.'
    : 'The existing index carries vectors but no embedding provider is configured — rebuilding it.';
}

async function buildAnalysisIndexesUnlocked(options: BuildAnalysisIndexesOptions): Promise<AnalysisIndexResult> {
  const reusable = await readReusableIndexes(options);
  if (reusable.receipt) {
    const receipt = reusable.receipt;
    if (receipt.result.specIndex === 'skipped') {
      options.reporter?.report({
        index: 'spec',
        status: 'skip',
        detail: receipt.specSkipDetail ?? (options.freshSpecDirectory ? 'OpenSpec specs directory exists but contains no spec.md files' : 'No OpenSpec specs directory.'),
      });
    }
    return receipt.result;
  }
  const emit = (event: IndexReport): void => options.reporter?.report(event);
  // Say why a reusable-looking index was rebuilt. Exactly once, on the rebuild it caused.
  if (reusable.rejection) {
    emit({ index: 'function', status: 'skip', detail: reuseRejectionDetail(reusable.rejection) });
  }
  const result: AnalysisIndexResult = {
    functionIndex: 'skipped',
    textIndex: 'skipped',
    specIndex: 'skipped',
    degraded: [],
  };
  let specSkipDetail: string | undefined;
  let embedder: Embedder | null = null;
  if (!options.keywordOnly) {
    try {
      embedder = await resolveEmbedder(options.config);
    } catch (error) {
      const reason = `Embedding provider unavailable; keyword indexes used: ${(error as Error).message}`;
      result.degraded.push({ index: 'function', reason });
      emit({ index: 'function', status: 'warning', detail: reason });
    }
  }

  emit({ index: 'function', status: 'start' });
  try {
    const context = await loadContext(options.outputPath, options.llmContext);
    const graph = context.callGraph;
    const graphNodes = graph?.nodes ?? [];
    const signatures = context.signatures ?? [];
    const hasSignatures = signatures.some(file => file.path !== 'external' && file.entries.length > 0);
    if (graphNodes.length === 0 && !hasSignatures) {
      emit({ index: 'function', status: 'skip', detail: 'No call graph or signature data.' });
    } else {
      const paths = [...new Set(graphNodes.map(node => node.filePath))];
      const fileContents = new Map<string, string>();
      const chunkSize = 256;
      for (let offset = 0; offset < paths.length; offset += chunkSize) {
        const slice = paths.slice(offset, offset + chunkSize);
        const contents = await mapFilesBounded(slice, async filePath => {
          try { return await readSourceCapped(safeJoin(options.rootPath, filePath), SOURCE_SCAN_MAX_FILE_BYTES); }
          catch { return null; }
        });
        for (let index = 0; index < slice.length; index++) {
          if (contents[index] !== null) fileContents.set(slice[index], contents[index]!);
        }
      }
      try {
        const built = await VectorIndex.build(
          options.outputPath,
          graphNodes,
          signatures,
          new Set(graph?.hubFunctions.map(node => node.id) ?? []),
          new Set(graph?.entryPoints.map(node => node.id) ?? []),
          embedder,
          fileContents,
          !(options.force ?? false),
          options.config?.retrieval?.vocabularyExpansion !== false,
          graph?.edges,
          {
            contention: options.waitForLock ? 'wait' : 'report',
            onReclaimed: lockPath => emit({
              index: 'function',
              status: 'skip',
              detail: `Reclaimed an index lock left by a process that is no longer running: ${lockPath}`,
            }),
          },
        );
        result.functionIndex = 'built';
        const vocabulary = loadRepositoryVocabulary(options.outputPath);
        const mode = built.hasEmbeddings
          ? embedderMode(embedder)
          : vocabulary?.entries.length ? 'keyword+vocabulary' : 'keyword';
        const vocabularyDetail = vocabulary?.status === 'partial'
          ? `; vocabulary partial, ${vocabulary.omittedCandidateInputCount} candidate input(s) omitted`
          : '';
        emit({
          index: 'function',
          status: 'complete',
          detail: `[${mode}] (${describePopulation(built)})${vocabularyDetail}`,
        });
      } catch (error) {
        // Contention is NOT a provider failure. Writing a keyword index here is what let a
        // colliding build report success over a vectorless index (spec `analyzer`
        // IndexLockContentionIsNeverASilentDowngrade): the other process is mid-build, and
        // overwriting its output keyword-only is both wrong and silent.
        if (error instanceof VectorIndexLockContendedError) throw error;
        if (!embedder) throw error;
        const reason = `Semantic index failed; keyword index used: ${(error as Error).message}`;
        result.degraded.push({ index: 'function', reason });
        emit({ index: 'function', status: 'warning', detail: reason });
        await VectorIndex.build(
          options.outputPath,
          graphNodes,
          signatures,
          new Set(graph?.hubFunctions.map(node => node.id) ?? []),
          new Set(graph?.entryPoints.map(node => node.id) ?? []),
          null,
          fileContents,
          false,
          options.config?.retrieval?.vocabularyExpansion !== false,
        );
        result.functionIndex = 'degraded';
      }
      if (result.functionIndex === 'degraded') emit({ index: 'function', status: 'complete', detail: '[keyword]' });
    }
  } catch (error) {
    // The function-index catch-all degrades anything it is handed. Contention is the one
    // failure that must NOT be degraded: another process owns this index right now, so
    // "carry on with a keyword index" is both a lie and a write race.
    if (error instanceof VectorIndexLockContendedError) throw error;
    const reason = (error as Error).message;
    result.degraded.push({ index: 'function', reason });
    emit({ index: 'function', status: 'warning', detail: reason });
  }

  emit({ index: 'text', status: 'start' });
  try {
    const built = await buildTextIndex(
      options.rootPath,
      options.outputPath,
      options.config?.analysis,
      options.include ?? [],
      options.exclude ?? [],
      analysisGeneratedExcludes(options.rootPath, options.outputPath, options.config?.openspecPath),
    );
    result.textIndex = 'built';
    emit({ index: 'text', status: 'complete', detail: `${built.lines} lines across ${built.files} files` });
  } catch (error) {
    const reason = (error as Error).message;
    result.degraded.push({ index: 'text', reason });
    emit({ index: 'text', status: 'warning', detail: reason });
  }

  try {
    result.specIndex = await buildSpecIndexWithEmbedder(options, embedder);
    if (result.specIndex === 'skipped') specSkipDetail = 'No OpenSpec specs directory.';
  } catch (error) {
    const reason = (error as Error).message;
    specSkipDetail = reason;
    const expectedEmpty = reason.includes('exists but contains no spec.md files');
    if (!expectedEmpty) result.degraded.push({ index: 'spec', reason });
    emit({ index: 'spec', status: expectedEmpty ? 'skip' : 'warning', detail: reason });
  }
  if (options.generationId) {
    // Written even when the build degraded: the receipt is the record of what this index
    // IS, and a failure nobody records is one every later surface has to guess at. Reuse
    // is gated separately, on `degraded` being empty.
    await atomicWriteFile(join(options.outputPath, INDEX_GENERATION_FILE), JSON.stringify({
      generationId: options.generationId,
      configurationHash: indexConfigurationHash(options),
      result,
      ...(specSkipDetail ? { specSkipDetail } : {}),
    } satisfies IndexGenerationReceipt));
  }
  return result;
}

async function readReceipt(outputPath: string): Promise<Partial<IndexGenerationReceipt> | null> {
  try {
    const raw = await readArtifactBounded(join(outputPath, INDEX_GENERATION_FILE), ANALYSIS_ARTIFACT_MAX_BYTES);
    return raw ? JSON.parse(raw.text) as Partial<IndexGenerationReceipt> : null;
  } catch {
    return null;
  }
}

/**
 * Record a semantic-index failure that happened outside a full build, so `doctor`,
 * `status` and the freshness lease can report it. Best-effort: a failure to record a
 * failure must never take down the watcher.
 */
export async function recordIndexEmbedFailure(
  outputPath: string,
  failure: Omit<IndexEmbedFailure, 'at'> & { at?: string },
): Promise<void> {
  try {
    const receipt = (await readReceipt(outputPath)) ?? {};
    receipt.embedFailure = { at: failure.at ?? new Date().toISOString(), reason: failure.reason, ...(failure.endpoint ? { endpoint: failure.endpoint } : {}) };
    await atomicWriteFile(join(outputPath, INDEX_GENERATION_FILE), JSON.stringify(receipt));
  } catch { /* best-effort: never fail the caller over a disclosure */ }
}

/** Clear a recorded embed failure once the same path succeeds. */
export async function clearIndexEmbedFailure(outputPath: string): Promise<void> {
  try {
    const receipt = await readReceipt(outputPath);
    if (!receipt?.embedFailure) return;
    delete receipt.embedFailure;
    await atomicWriteFile(join(outputPath, INDEX_GENERATION_FILE), JSON.stringify(receipt));
  } catch { /* best-effort */ }
}

/** The index's recorded self-state: what the last build produced, and any failure since. */
export async function readIndexReceipt(outputPath: string): Promise<{
  degraded: AnalysisIndexResult['degraded'];
  embedFailure?: IndexEmbedFailure;
} | null> {
  const receipt = await readReceipt(outputPath);
  if (!receipt) return null;
  return {
    degraded: receipt.result?.degraded ?? [],
    ...(receipt.embedFailure ? { embedFailure: receipt.embedFailure } : {}),
  };
}

/** Build indexes one-at-a-time per canonical output directory for every frontend. */
export async function buildAnalysisIndexes(options: BuildAnalysisIndexesOptions): Promise<AnalysisIndexResult> {
  const key = await realpath(options.outputPath).catch(() => resolve(options.outputPath));
  const previous = indexBuilds.get(key) ?? Promise.resolve();
  const current = previous.catch(() => {}).then(() => buildAnalysisIndexesUnlocked(options));
  const tail = current.then(() => undefined, () => undefined);
  indexBuilds.set(key, tail);
  try {
    return await current;
  } finally {
    if (indexBuilds.get(key) === tail) indexBuilds.delete(key);
  }
}
