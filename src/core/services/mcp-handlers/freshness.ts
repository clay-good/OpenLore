/**
 * Bounded read-time freshness checks for source files cited by a conclusion.
 *
 * This module intentionally depends only on Node built-ins, constants, and the
 * leaf path-confinement helper. It does not load the analyzer or EdgeStore; a
 * caller may pass the cached context's structurally-typed edge store instead.
 */

import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, stat } from 'node:fs/promises';
import { isAbsolute, join, posix, win32 } from 'node:path';
import {
  ARTIFACT_LLM_CONTEXT,
  OPENLORE_ANALYSIS_SUBDIR,
  OPENLORE_DIR,
  SOURCE_SCAN_MAX_FILE_BYTES,
} from '../../../constants.js';
import { safeJoin } from '../../../utils/path-confinement.js';
import { detectLanguage } from '../../analyzer/language-detection.js';

export interface FileHashStore {
  getFileHash(filePath: string): string | null;
  /** Explicit topology-staleness receipt from a budget-bounded watcher update. */
  isFileStale?(filePath: string): boolean;
}

export interface CitedFileFreshnessContext {
  edgeStore?: FileHashStore;
  /** Mtime of the exact cached artifact generation being served. */
  artifactMtimeMs?: number;
  /** Direct callers may override the default llm-context artifact path. */
  artifactPath?: string;
  /** The bounded payload traversal encountered a citation it could not confine. */
  unsafeCitation?: boolean;
}

export interface CitedFileFreshnessResult {
  /** Normalized repository-relative files that cannot be vouched fresh. */
  staleFiles: string[];
  /** Confined stale paths safe to hand to a repository repair host. */
  repairableStaleFiles: string[];
}

export interface StaleServingDisclosure {
  staleFiles: string[];
  note: string;
  repairScheduled?: true;
}

/** A conclusion normally cites <10 files; this caps burst I/O without serial latency. */
const FRESHNESS_IO_CONCURRENCY = 8;
const MAX_CITED_FILES = 200;
const MAX_CITED_PATH_BYTES = 64 * 1024;

function sameFile(
  a: { dev: number; ino: number },
  b: { dev: number; ino: number },
): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}

/** Deterministic seam for the same-handle post-read race check. */
export function fileChangedDuringRead(params: {
  opened: { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number };
  afterRead: { size: number; mtimeMs: number; ctimeMs: number };
  namedAfterRead: {
    dev: number;
    ino: number;
    size: number;
    mtimeMs: number;
    ctimeMs: number;
    isSymbolicLink(): boolean;
  };
  bytesRead: number;
}): boolean {
  const { opened, afterRead, namedAfterRead, bytesRead } = params;
  return bytesRead > opened.size
    || afterRead.size !== opened.size
    || afterRead.mtimeMs !== opened.mtimeMs
    || afterRead.ctimeMs !== opened.ctimeMs
    || namedAfterRead.isSymbolicLink()
    || !sameFile(opened, namedAfterRead)
    || namedAfterRead.size !== afterRead.size
    || namedAfterRead.mtimeMs !== afterRead.mtimeMs
    || namedAfterRead.ctimeMs !== afterRead.ctimeMs;
}

export interface CitedSourceFiles {
  files: string[];
  truncated: boolean;
  unsafeCitation?: true;
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
export function collectCitedSourceFiles(value: unknown, max = MAX_CITED_FILES): CitedSourceFiles {
  const limit = Number.isFinite(max) ? Math.max(0, Math.floor(max)) : 200;
  const files: string[] = [];
  const seenFiles = new Set<string>();
  const seenObjects = new Set<object>();
  const stack: unknown[] = [value];
  const maxVisited = Math.max(100, limit * 20);
  let visited = 0;
  let propertiesVisited = 0;
  let truncated = false;
  let unsafeCitation = false;

  traversal: while (stack.length > 0) {
    if (visited++ >= maxVisited) {
      truncated = true;
      break;
    }
    const current = stack.pop();
    if (current === null || typeof current !== 'object') continue;
    if (seenObjects.has(current)) continue;
    seenObjects.add(current);

    if (Array.isArray(current)) {
      const available = maxVisited - visited - stack.length;
      const accepted = Math.max(0, Math.min(current.length, available));
      if (accepted < current.length) truncated = true;
      for (let i = accepted - 1; i >= 0; i--) stack.push(current[i]);
      continue;
    }

    const children: unknown[] = [];
    for (const key in current as Record<string, unknown>) {
      if (!Object.hasOwn(current as object, key)) continue;
      if (propertiesVisited++ >= maxVisited * 2) {
        truncated = true;
        break traversal;
      }
      const child = (current as Record<string, unknown>)[key];
      if ((key === 'file' || key === 'filePath') && typeof child === 'string') {
        const normalized = normalizeCitation(child);
        if (normalized === null) unsafeCitation = true;
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
            break traversal;
          }
          seenFiles.add(normalized);
          files.push(normalized);
        }
      } else {
        if (visited + stack.length + children.length < maxVisited) children.push(child);
        else truncated = true;
      }
    }
    for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]);
  }

  return { files, truncated, ...(unsafeCitation ? { unsafeCitation: true as const } : {}) };
}

/** Apply the same count and serialized-path budget to caller-supplied citations. */
export function boundCitedFiles(
  citedFiles: Iterable<string>,
  max = MAX_CITED_FILES,
  maxPathBytes = MAX_CITED_PATH_BYTES,
): CitedSourceFiles {
  const files: string[] = [];
  const seen = new Set<string>();
  let pathBytes = 0;
  let truncated = false;
  let unsafeCitation = false;
  let examined = 0;
  for (const file of citedFiles) {
    if (examined++ >= max * 20) {
      truncated = true;
      break;
    }
    if (typeof file !== 'string' || seen.has(file)) continue;
    const normalized = normalizeCitation(file);
    if (normalized === null) {
      unsafeCitation = true;
      continue;
    }
    const bytes = Buffer.byteLength(normalized, 'utf8');
    if (files.length >= max || pathBytes + bytes > maxPathBytes) {
      truncated = true;
      break;
    }
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    files.push(normalized);
    pathBytes += bytes;
  }
  return { files, truncated, ...(unsafeCitation ? { unsafeCitation: true as const } : {}) };
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
  let unsafeCitation = context.unsafeCitation ?? false;

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
  const repairableStaleFiles: string[] = [];
  let artifactMtimeMs = context.artifactMtimeMs;
  const artifactPath = context.artifactPath
    ?? join(root, OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR, ARTIFACT_LLM_CONTEXT);

  type Check = { filePath: string; absPath: string; baselineFileHash: string | null };
  const checks: Check[] = [];
  for (const filePath of files) {
    let confined = false;
    try {
      const absPath = safeJoin(root, filePath);
      confined = true;
      // An unchanged file can still have stale topology when a changed hub's
      // reverse-dependency closure exceeded the watcher budget. Its content hash
      // correctly matches, but the served graph facts are not authoritative.
      // Honor that explicit receipt before hash/mtime checks so conclusions are
      // honest and can request the host's full-repair barrier.
      if (context.edgeStore?.isFileStale?.(filePath) === true) {
        staleFiles.push(filePath);
        repairableStaleFiles.push(filePath);
        continue;
      }
      const baselineFileHash = context.edgeStore?.getFileHash(filePath) ?? null;
      checks.push({ filePath, absPath, baselineFileHash });
    } catch {
      staleFiles.push(filePath);
      if (confined) repairableStaleFiles.push(filePath);
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
      let handle: Awaited<ReturnType<typeof open>> | undefined;
      try {
        // One handle binds the size check, mtime, and content hash to the same
        // file generation. The source-size cap prevents a changed generated file
        // from turning each cold read into an unbounded allocation.
        handle = await open(absPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        const sourceStats = await handle.stat();
        if (!sourceStats.isFile()) {
          staleByCheck[index] = true;
          continue;
        }

        if (baselineFileHash !== null) {
          if (sourceStats.size > SOURCE_SCAN_MAX_FILE_BYTES) {
            staleByCheck[index] = true;
            continue;
          }
          const content = Buffer.allocUnsafe(sourceStats.size + 1);
          let bytesRead = 0;
          while (bytesRead < content.byteLength) {
            const read = await handle.read(
              content,
              bytesRead,
              content.byteLength - bytesRead,
              bytesRead,
            );
            if (read.bytesRead === 0) break;
            bytesRead += read.bytesRead;
          }
          const afterRead = await handle.stat();
          safeJoin(root, checks[index].filePath);
          const namedAfterRead = await lstat(absPath);
          if (fileChangedDuringRead({
            opened: sourceStats,
            afterRead,
            namedAfterRead,
            bytesRead,
          })) {
            staleByCheck[index] = true;
            continue;
          }
          const currentFileHash = createHash('sha256')
            .update(content.subarray(0, bytesRead))
            .digest('hex');
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

        const afterStat = await handle.stat();
        safeJoin(root, checks[index].filePath);
        const namedAfterStat = await lstat(absPath);
        if (fileChangedDuringRead({
          opened: sourceStats,
          afterRead: afterStat,
          namedAfterRead: namedAfterStat,
          bytesRead: sourceStats.size,
        })) {
          staleByCheck[index] = true;
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
      } finally {
        await handle?.close().catch(() => {});
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(FRESHNESS_IO_CONCURRENCY, checks.length) }, () => worker()),
  );

  for (let i = 0; i < checks.length; i++) {
    if (staleByCheck[i]) {
      staleFiles.push(checks[i].filePath);
      repairableStaleFiles.push(checks[i].filePath);
    }
  }

  return { staleFiles, repairableStaleFiles };
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
