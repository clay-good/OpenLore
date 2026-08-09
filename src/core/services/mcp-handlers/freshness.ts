/**
 * Bounded read-time freshness checks for source files cited by a conclusion.
 *
 * This module intentionally depends only on Node built-ins, constants, and the
 * leaf path-confinement helper. It does not load the analyzer or EdgeStore; a
 * caller may pass the cached context's structurally-typed edge store instead.
 */

import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { isAbsolute, join, posix, win32 } from 'node:path';
import {
  ARTIFACT_LLM_CONTEXT,
  OPENLORE_ANALYSIS_SUBDIR,
  OPENLORE_DIR,
} from '../../../constants.js';
import { safeJoin } from '../../../utils/path-confinement.js';
import { detectLanguage } from '../../analyzer/language-detection.js';

export interface FileHashStore {
  getFileHash(filePath: string): string | null;
}

export interface CitedFileFreshnessContext {
  edgeStore?: FileHashStore;
  /** Mtime of the exact cached artifact generation being served. */
  artifactMtimeMs?: number;
  /** Direct callers may override the default llm-context artifact path. */
  artifactPath?: string;
}

export interface CitedFileFreshnessResult {
  /** Normalized repository-relative files that cannot be vouched fresh. */
  staleFiles: string[];
}

export interface StaleServingDisclosure extends CitedFileFreshnessResult {
  note: string;
  repairScheduled?: true;
}

/** A conclusion normally cites <10 files; this caps burst I/O without serial latency. */
const FRESHNESS_IO_CONCURRENCY = 8;

export interface CitedSourceFiles {
  files: string[];
  truncated: boolean;
}

/**
 * Resolve one file's dual-baseline verdict. A recorded content hash is
 * authoritative. Full analysis does not populate file_hashes on every path, so
 * an absent hash falls back to source-vs-artifact mtime. Unknown inputs fail safe.
 */
export function resolveFileFreshness(params: {
  baselineFileHash: string | null;
  currentFileHash: string;
  sourceMtimeMs: number;
  artifactMtimeMs: number;
}): 'fresh' | 'stale' {
  const { baselineFileHash, currentFileHash, sourceMtimeMs, artifactMtimeMs } = params;
  if (baselineFileHash !== null) {
    return baselineFileHash === currentFileHash ? 'fresh' : 'stale';
  }
  return sourceMtimeMs <= artifactMtimeMs ? 'fresh' : 'stale';
}

/** Normalize an analyzer-provided citation without allowing it to become a path. */
function normalizeCitation(filePath: string): string | null {
  const hasControlCharacter = [...filePath].some((char) => {
    const code = char.charCodeAt(0);
    return code <= 0x1f || code === 0x7f;
  });
  if (hasControlCharacter || isAbsolute(filePath) || win32.isAbsolute(filePath)) return null;
  const normalized = posix.normalize(filePath.replaceAll('\\', '/'));
  if (normalized === '.' || normalized === '..' || normalized.startsWith('../')) return null;
  return normalized;
}

/** Code plus graph-projected markup/IaC formats not covered by detectLanguage. */
function isSourceCitation(filePath: string): boolean {
  if (detectLanguage(filePath) !== 'unknown') return true;
  const lower = filePath.toLowerCase();
  const name = lower.slice(lower.lastIndexOf('/') + 1);
  return /\.(?:html?|vue|svelte|ya?ml|json)$/.test(lower)
    || name === 'dockerfile'
    || name.startsWith('dockerfile.');
}

/**
 * Collect source-file citations from a final structured payload. Calling this
 * after token budgeting makes the I/O bound follow what was actually emitted,
 * not candidates the user never sees. Traversal is iterative and capped too, so
 * a malformed cyclic or enormous value cannot turn freshness into a repo scan.
 */
export function collectCitedSourceFiles(value: unknown, max = 200): CitedSourceFiles {
  const limit = Number.isFinite(max) ? Math.max(0, Math.floor(max)) : 200;
  const files: string[] = [];
  const seenFiles = new Set<string>();
  const seenObjects = new Set<object>();
  const stack: unknown[] = [value];
  const maxVisited = Math.max(100, limit * 20);
  let visited = 0;
  let truncated = false;

  while (stack.length > 0) {
    if (visited++ >= maxVisited) {
      truncated = true;
      break;
    }
    const current = stack.pop();
    if (current === null || typeof current !== 'object') continue;
    if (seenObjects.has(current)) continue;
    seenObjects.add(current);

    if (Array.isArray(current)) {
      for (let i = current.length - 1; i >= 0; i--) stack.push(current[i]);
      continue;
    }

    const entries = Object.entries(current as Record<string, unknown>);
    for (let i = entries.length - 1; i >= 0; i--) {
      const [key, child] = entries[i];
      if ((key === 'file' || key === 'filePath') && typeof child === 'string') {
        const normalized = normalizeCitation(child);
        if (
          normalized !== null
          && normalized !== 'external'
          && !normalized.startsWith('[external]')
          && !normalized.startsWith('<')
          && isSourceCitation(normalized)
          && !seenFiles.has(normalized)
        ) {
          if (files.length >= limit) {
            truncated = true;
            continue;
          }
          seenFiles.add(normalized);
          files.push(normalized);
        }
      } else {
        stack.push(child);
      }
    }
  }

  return { files, truncated };
}

/**
 * Check only the files the caller is about to cite. Inputs are deduplicated
 * before I/O. Unsafe paths are represented by one conservative sentinel and are
 * never read, so an untrusted analysis artifact cannot escape the repository.
 */
export async function checkCitedFileFreshness(
  root: string,
  citedFiles: Iterable<string>,
  context: CitedFileFreshnessContext = {},
): Promise<CitedFileFreshnessResult> {
  const files: string[] = [];
  const seen = new Set<string>();
  let unsafeCitation = false;

  for (const cited of citedFiles) {
    if (typeof cited !== 'string' || cited.length === 0) continue;
    const normalized = normalizeCitation(cited);
    if (normalized === null) {
      unsafeCitation = true;
      continue;
    }
    if (!seen.has(normalized)) {
      seen.add(normalized);
      files.push(normalized);
    }
  }

  const staleFiles: string[] = unsafeCitation ? ['[unsafe cited path]'] : [];
  let artifactMtimeMs = context.artifactMtimeMs;
  const artifactPath = context.artifactPath
    ?? join(root, OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR, ARTIFACT_LLM_CONTEXT);

  type Check = { filePath: string; absPath: string; baselineFileHash: string | null };
  const checks: Check[] = [];
  for (const filePath of files) {
    try {
      const absPath = safeJoin(root, filePath);
      const baselineFileHash = context.edgeStore?.getFileHash(filePath) ?? null;
      checks.push({ filePath, absPath, baselineFileHash });
    } catch {
      staleFiles.push(filePath);
    }
  }

  // Read the artifact timestamp once for every hashless citation. A supplied
  // generation mtime binds the check to the exact cached payload and avoids I/O.
  if (artifactMtimeMs === undefined && checks.some(c => c.baselineFileHash === null)) {
    try {
      artifactMtimeMs = (await stat(artifactPath)).mtimeMs;
    } catch {
      artifactMtimeMs = 0;
    }
  }

  const staleByCheck = new Array<boolean>(checks.length).fill(false);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < checks.length) {
      const index = next++;
      const { absPath, baselineFileHash } = checks[index];
      try {
        const sourceStats = await stat(absPath);
        if (!sourceStats.isFile()) {
          staleByCheck[index] = true;
          continue;
        }

        if (baselineFileHash !== null) {
          const content = await readFile(absPath);
          const currentFileHash = createHash('sha256').update(content).digest('hex');
          if (resolveFileFreshness({
            baselineFileHash,
            currentFileHash,
            sourceMtimeMs: sourceStats.mtimeMs,
            artifactMtimeMs: artifactMtimeMs ?? 0,
          }) === 'stale') {
            staleByCheck[index] = true;
          }
          continue;
        }

        if (resolveFileFreshness({
          baselineFileHash: null,
          currentFileHash: '',
          sourceMtimeMs: sourceStats.mtimeMs,
          artifactMtimeMs: artifactMtimeMs ?? 0,
        }) === 'stale') {
          staleByCheck[index] = true;
        }
      } catch {
        staleByCheck[index] = true;
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(FRESHNESS_IO_CONCURRENCY, checks.length) }, () => worker()),
  );

  for (let i = 0; i < checks.length; i++) {
    if (staleByCheck[i]) staleFiles.push(checks[i].filePath);
  }

  return { staleFiles };
}

/** Build the additive payload block shared by MCP and one-shot CLI surfaces. */
export function buildStaleServingDisclosure(
  staleFiles: readonly string[],
  repairScheduled = false,
): StaleServingDisclosure | undefined {
  if (staleFiles.length === 0) return undefined;
  const unique = [...new Set(staleFiles)];
  const sorted = [...unique].sort((a, b) => a.localeCompare(b));
  const shown = sorted.slice(0, 10).map(file => JSON.stringify(file));
  const omitted = sorted.length - shown.length;
  const namedFiles = omitted > 0
    ? `${shown.join(', ')}, and ${omitted} more`
    : shown.join(', ');
  const repair = repairScheduled ? ' Repair has been scheduled.' : '';
  return {
    staleFiles: unique,
    note:
      `The index is behind the working tree for: ${namedFiles} — ` +
      `results may omit recent edits; re-run analyze or let the watcher converge.${repair}`,
    ...(repairScheduled ? { repairScheduled: true as const } : {}),
  };
}
