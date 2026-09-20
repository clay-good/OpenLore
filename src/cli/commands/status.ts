/**
 * `openlore status` — what this repository's index IS, right now
 * (change: make-index-self-state-honest).
 *
 * The product could already answer "can I reach the embedding endpoint" (`doctor`) and
 * "what is in the graph" (`orient`), but not the question an agent asks constantly and a
 * human asks after every upgrade: what mode am I actually being served, how old is the
 * index, and is it behind what I just edited. On 2026-09-20 answering it meant opening
 * `.openlore/analysis/vector-index-meta.json` by hand in two repositories.
 *
 * Read-only by construction: it opens no lock, writes no artifact, and starts no build.
 */

import { Command } from 'commander';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { OPENLORE_ANALYSIS_SUBDIR, OPENLORE_DIR } from '../../constants.js';
import { logger } from '../../utils/logger.js';
import { palette } from '../../utils/colors.js';
import { readOpenLoreConfig } from '../../core/services/config-manager.js';
import type { OpenLoreConfig } from '../../types/index.js';
import type { Embedder } from '../../core/analyzer/embedding-service.js';
import {
  indexCapabilityAgreement,
  resolveEmbedder,
  semanticProviderConfigured,
  servedRetrievalMode,
  type RetrievalMode,
} from '../../core/analyzer/embedder.js';
import { readIndexReceipt, type IndexEmbedFailure } from '../../core/analyzer/analysis-indexes.js';
import { VectorIndex } from '../../core/analyzer/vector-index.js';
import { safeJoin } from '../../utils/path-confinement.js';
import { sanitizeForTerminal as safe } from '../../utils/misc.js';

const execFileAsync = promisify(execFile);

/** Bound on the working-tree comparison: a status command must stay instant. */
const MAX_CHANGED_FILES_INSPECTED = 500;

/**
 * Why keyword retrieval is being served. The distinction the config spec draws: an
 * unconfigured keyword index is the first-class default, a configured-but-unrealized one
 * is a finding.
 */
export type KeywordCause = 'no-provider-configured' | 'configured-provider-unrealized' | null;

export interface IndexStatus {
  indexPresent: boolean;
  /** The mode a query would actually be served right now. */
  retrievalMode: RetrievalMode | null;
  /** Set only when the served mode is a keyword one. */
  keywordCause: KeywordCause;
  /** Provider named by configuration, if any. */
  configuredProvider: string | null;
  builtAt: string | null;
  /** Files changed in the working tree since the index was built. */
  staleFiles: string[];
  /** True when the count was capped rather than complete. */
  staleFilesTruncated: boolean;
  /** Git or the index build time was unavailable, so freshness cannot be asserted. */
  staleFilesUnknown?: true;
  /** A failure recorded outside a full build (the watcher's incremental embed). */
  embedFailure?: IndexEmbedFailure;
  /** Degradations recorded by the last build. */
  degraded: Array<{ index: string; reason: string }>;
  /** Present when the configuration could not be read at all. */
  configUnreadable?: true;
}

interface IndexMetaShape {
  hasEmbeddings?: boolean;
  dim?: number;
  model?: string | null;
  builtAt?: string;
}

function readMetaSidecar(analysisDir: string): IndexMetaShape | null {
  try {
    // The sidecar is small and repository-local; a parse failure is simply "unknown".
    return JSON.parse(readFileSync(join(analysisDir, 'vector-index-meta.json'), 'utf-8')) as IndexMetaShape;
  } catch {
    return null;
  }
}

/**
 * Files the working tree has changed since the index was built.
 *
 * Derived from git's own view plus each file's mtime, so a file the watcher already
 * re-indexed is not counted. Bounded, and never fatal: a repository without git, or a
 * git call that fails, reports no stale files rather than failing the command.
 */
async function changedSinceIndex(rootPath: string, builtAtMs: number | null): Promise<{ files: string[]; truncated: boolean; unknown?: true }> {
  if (builtAtMs === null) return { files: [], truncated: false, unknown: true };
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all'], {
      cwd: rootPath,
      maxBuffer: 4 * 1024 * 1024,
    }));
  } catch {
    return { files: [], truncated: false, unknown: true };
  }
  // NUL output preserves filenames containing newlines, quotes, or backslashes. A
  // rename has a second NUL field containing its old path, which can still be in
  // the index even when the renamed file's mtime predates the build.
  const entries = stdout.split('\0');
  const candidates: Array<{ path: string; removed: boolean }> = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (entry.length < 4) continue;
    const status = entry.slice(0, 2);
    const path = entry.slice(3);
    if (!path.endsWith('/') && !path.startsWith(`${OPENLORE_DIR}/`)) {
      candidates.push({ path, removed: status.includes('D') || status.includes('R') });
    }
    if (status.includes('R') || status.includes('C')) {
      const oldPath = entries[++i];
      if (status.includes('R') && oldPath && !oldPath.startsWith(`${OPENLORE_DIR}/`)) {
        candidates.push({ path: oldPath, removed: true });
      }
    }
  }
  const truncated = candidates.length > MAX_CHANGED_FILES_INSPECTED;
  const files: string[] = [];
  for (const { path: relative, removed } of candidates.slice(0, MAX_CHANGED_FILES_INSPECTED)) {
    try {
      // Confinement: a path from `git status` is repository data, not a trusted input.
      const absolute = safeJoin(rootPath, relative);
      if (removed || statSync(absolute).mtimeMs > builtAtMs) files.push(relative);
    } catch { /* Outside the repo or unreadable. Deletions are handled above. */ }
  }
  return { files, truncated };
}

/** Collect the index's self-state without mutating anything. */
export async function collectIndexStatus(rootPath: string): Promise<IndexStatus> {
  const analysisDir = join(rootPath, OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR);
  let config: OpenLoreConfig | null = null;
  let configUnreadable = false;
  try { config = await readOpenLoreConfig(rootPath); } catch { configUnreadable = true; }

  const receipt = await readIndexReceipt(analysisDir);
  const base = {
    degraded: receipt?.degraded ?? [],
    ...(receipt?.embedFailure ? { embedFailure: receipt.embedFailure } : {}),
    ...(configUnreadable ? { configUnreadable: true as const } : {}),
  };

  if (!VectorIndex.exists(analysisDir)) {
    return {
      indexPresent: false,
      retrievalMode: null,
      keywordCause: null,
      configuredProvider: null,
      builtAt: null,
      staleFiles: [],
      staleFilesTruncated: false,
      ...base,
    };
  }

  const meta = readMetaSidecar(analysisDir);
  let embedder: Embedder | null = null;
  // A resolver failure leaves the keyword default in place; `doctor` is where a broken
  // provider is diagnosed, and `status` only reports what is being served.
  try { embedder = await resolveEmbedder(config); } catch { /* keyword default */ }
  const retrievalMode = servedRetrievalMode(embedder, analysisDir);
  const configured = !configUnreadable && semanticProviderConfigured(config);
  const agreement = indexCapabilityAgreement(config, analysisDir);
  const keywordCause: KeywordCause = retrievalMode === 'keyword' || retrievalMode === 'keyword+vocabulary'
    ? (!agreement.agrees && agreement.mismatch === 'configured-but-unrealized'
      ? 'configured-provider-unrealized'
      : 'no-provider-configured')
    : null;

  const builtAt = meta?.builtAt ?? null;
  const builtAtMs = builtAt ? Date.parse(builtAt) : null;
  const { files, truncated, unknown } = await changedSinceIndex(
    rootPath,
    builtAtMs !== null && !Number.isNaN(builtAtMs) ? builtAtMs : null,
  );

  return {
    indexPresent: true,
    retrievalMode,
    keywordCause,
    configuredProvider: configured
      ? (config?.embedding?.provider === 'local' ? 'local' : config?.embedding?.model ?? process.env.EMBED_MODEL ?? 'configured')
      : null,
    builtAt,
    staleFiles: files,
    staleFilesTruncated: truncated,
    ...(unknown ? { staleFilesUnknown: true as const } : {}),
    ...base,
  };
}

function describeKeywordCause(cause: KeywordCause): string {
  if (cause === 'configured-provider-unrealized') {
    return 'a semantic provider is configured, but this index carries no vectors';
  }
  if (cause === 'no-provider-configured') {
    return 'no embedding provider configured — the first-class default';
  }
  return '';
}

export const statusCommand = new Command('status')
  .description("Report the search index's own state: retrieval mode served, when it was built, and whether it is behind the working tree")
  .option('--json', 'Output the status as JSON', false)
  .addHelpText(
    'after',
    `
Examples:
  $ openlore status          What mode am I being served, and is the index current?
  $ openlore status --json   Machine-readable (for agents and scripts)

Read-only: this never builds, rebuilds, or locks the index.
`,
  )
  .action(async (options: { json?: boolean }) => {
    const rootPath = process.cwd();
    const status = await collectIndexStatus(rootPath);

    if (options.json) {
      console.log(JSON.stringify(status, null, 2));
      return;
    }

    const c = palette(Boolean(process.stdout.isTTY));
    logger.section('openlore status');
    console.log('');

    // Everything printed below that came from the repository — its config, its index
    // sidecar, its receipt, its file names — is sanitized: a repository must not be able
    // to forge OpenLore's own output with terminal control sequences.
    if (!status.indexPresent) {
      console.log(`  ${c.yellow('No search index')} in ${OPENLORE_DIR}/${OPENLORE_ANALYSIS_SUBDIR}`);
      console.log(`  ${c.dim('→ Run "openlore analyze" to build one')}`);
      console.log('');
      return;
    }

    const cause = describeKeywordCause(status.keywordCause);
    const label = (text: string): string => text.padEnd(20);
    console.log(`  ${label('Retrieval mode')} ${c.bold(safe(status.retrievalMode ?? 'unknown'))}${cause ? c.dim(` — ${cause}`) : ''}`);
    if (status.configuredProvider) {
      console.log(`  ${label('Configured provider')} ${safe(status.configuredProvider)}`);
    }
    if (status.configUnreadable) {
      console.log(`  ${label('Configuration')} ${c.yellow('unreadable — run "openlore doctor"')}`);
    }
    console.log(`  ${label('Index built')} ${status.builtAt ? safe(status.builtAt) : c.dim('unknown')}`);

    const staleCount = status.staleFiles.length;
    const staleText = status.staleFilesUnknown
      ? c.yellow('unknown — Git status or index build time is unavailable')
      : staleCount === 0
        ? c.green('up to date with the working tree')
        : c.yellow(`${staleCount}${status.staleFilesTruncated ? '+' : ''} file(s) changed since the index was built`);
    console.log(`  ${label('Working tree')} ${staleText}`);
    if (staleCount > 0) {
      for (const file of status.staleFiles.slice(0, 5)) console.log(`  ${' '.repeat(20)} ${c.dim(safe(file))}`);
      if (staleCount > 5) console.log(`  ${' '.repeat(20)} ${c.dim(`… and ${staleCount - 5} more`)}`);
    }

    if (status.embedFailure) {
      const { reason, endpoint, at } = status.embedFailure;
      const where = endpoint ? c.dim(` (${safe(endpoint)})`) : '';
      console.log(`  ${label('Last embed failure')} ${c.yellow(safe(reason))}${where} ${c.dim(`at ${safe(at)}`)}`);
    }
    for (const entry of status.degraded) {
      console.log(`  ${label('Degraded')} ${c.yellow(`${safe(entry.index)}: ${safe(entry.reason)}`)}`);
    }

    if (status.keywordCause === 'configured-provider-unrealized') {
      console.log('');
      console.log(`  ${c.dim('→ Run "openlore analyze --force" to rebuild with the configured provider')}`);
    }
    console.log('');
  });
