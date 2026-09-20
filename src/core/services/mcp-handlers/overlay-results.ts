/**
 * Serving a retrieval answer over the working tree, not only over the index
 * (change: overlay-dirty-files-at-query-time).
 *
 * The handler-level half of the overlay: given a ranked result set and the stale files
 * the freshness check already identified, re-read those files and reconcile the answer
 * with what is on disk — drop rows for symbols that no longer exist, and surface symbols
 * the index has never seen.
 *
 * SCOPE, stated because it is the interesting part: symbols added in a dirty file are
 * NOT ranked against the index's corpus. Ranking them would mean re-scoring the whole
 * BM25 corpus on the query path, and a fabricated score would be worse than none. They
 * are returned after the ranked rows, labelled with their provenance and with no score,
 * so a caller can tell "the ranker put this here" from "this exists on disk and matches
 * your terms".
 */

import { buildOverlayDisclosure, buildWorkingTreeOverlay, type OverlayDisclosure } from '../../analyzer/working-tree-overlay.js';
import { detectLanguage } from '../../analyzer/language-detection.js';
import { vectorMatchEvidence, type MatchEvidence } from '../../analyzer/retrieval-evidence.js';
import { execFileGit } from '../../../utils/git-exec.js';

/** Find bounded working-tree candidates when the index has no symbol to cite. */
export async function dirtySourcePaths(rootPath: string): Promise<string[]> {
  try {
    const { stdout } = await execFileGit('git', ['--no-optional-locks', 'status', '--porcelain=v1', '-z', '--untracked-files=all'], {
      cwd: rootPath,
      maxBuffer: 64 * 1024,
      timeout: 500,
    });
    const entries = stdout.split('\0');
    const paths: string[] = [];
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      if (entry.length < 4) continue;
      const status = entry.slice(0, 2);
      const path = entry.slice(3);
      if (!path.startsWith('.openlore/') && detectLanguage(path) !== 'unknown') paths.push(path);
      if (status.includes('R') || status.includes('C')) i++; // old path follows
      if (paths.length > 25) break; // overlay reports its own file-cap skip
    }
    return paths;
  } catch {
    return []; // git unavailable or too many changes: preserve the indexed answer
  }
}

/** How many unranked working-tree additions one answer may carry. */
const MAX_OVERLAY_ADDITIONS = 5;

export interface OverlayableResult {
  name: string;
  filePath: string;
  [key: string]: unknown;
}

export interface OverlayAddition {
  name: string;
  filePath: string;
  className?: string;
  startLine?: number;
  language: string;
  signature?: string;
  /** Provenance, not decoration: read from the working tree, never ranked. */
  source: 'working-tree-overlay';
}

export interface OverlayedAnswer<T> {
  results: T[];
  additions: OverlayAddition[];
  /** Symbols dropped because the working tree no longer has them. */
  removed: string[];
  disclosure?: OverlayDisclosure;
}

/** Lowercase alphanumeric tokens, the same shape the keyword index compares. */
function queryTokens(query: string): string[] {
  return query.toLowerCase().split(/[^a-z0-9]+/i).filter(token => token.length > 2);
}

/** Does this symbol's own name or signature contain one of the caller's terms? */
function namedByQuery(symbol: { name: string; signature?: string }, tokens: readonly string[]): boolean {
  if (tokens.length === 0) return false;
  const haystack = `${symbol.name} ${symbol.signature ?? ''}`.toLowerCase();
  return tokens.some(token => haystack.includes(token));
}

/**
 * Reconcile a ranked answer with the working tree.
 *
 * Returns the answer unchanged when there is no stale set, when the overlay was skipped
 * for exceeding a bound, or when no stale file could be read — the fallback is always
 * exactly today's behavior.
 */
export async function overlayResults<T extends OverlayableResult>(
  rootPath: string,
  query: string,
  results: readonly T[],
  staleFiles: readonly string[],
): Promise<OverlayedAnswer<T>> {
  if (staleFiles.length === 0) return { results: [...results], additions: [], removed: [] };

  const overlay = await buildWorkingTreeOverlay(rootPath, staleFiles);
  const disclosure = buildOverlayDisclosure(overlay);
  if (overlay.coveredFiles.length === 0) {
    return { results: [...results], additions: [], removed: [], ...(disclosure ? { disclosure } : {}) };
  }

  const covered = new Set(overlay.coveredFiles);
  const live = new Map(overlay.nodes.map(node => [`${node.filePath}::${node.className ?? ''}::${node.name}`, node]));

  // A row for a covered file whose symbol is gone from disk is a ghost: the index still
  // remembers a function the caller has since deleted or renamed.
  const kept: T[] = [];
  const removed: string[] = [];
  for (const row of results) {
    if (covered.has(row.filePath)) {
      const key = `${row.filePath}::${String(row.className ?? '')}::${row.name}`;
      const current = live.get(key);
      if (!current) {
        removed.push(`${row.name} (${row.filePath})`);
        continue;
      }
      const evidence = row.matchEvidence as MatchEvidence | undefined;
      const currentField = evidence?.field === 'symbol' ? current.name
        : evidence?.field === 'path' ? current.filePath
          : evidence?.field === 'signature' ? current.signature
            : evidence?.field === 'doc' ? current.docstring
              : undefined;
      const evidenceStillApplies = currentField !== undefined && evidence?.terms.some(term =>
        currentField.toLowerCase().includes(term.toLowerCase()));
      kept.push({
        ...row,
        startLine: current.startLine,
        signature: current.signature,
        docstring: current.docstring,
        source: 'working-tree-overlay',
        ...(evidence && !evidenceStillApplies ? { matchEvidence: vectorMatchEvidence(3) } : {}),
      });
      continue;
    }
    kept.push(row);
  }

  const known = new Set(kept.map(row => `${row.filePath}::${String(row.className ?? '')}::${row.name}`));
  const tokens = queryTokens(query);
  const additions: OverlayAddition[] = [];
  for (const node of overlay.nodes) {
    if (additions.length >= MAX_OVERLAY_ADDITIONS) break;
    const identity = `${node.filePath}::${node.className ?? ''}::${node.name}`;
    if (known.has(identity)) continue;
    if (!namedByQuery(node, tokens)) continue;
    additions.push({
      name: node.name,
      filePath: node.filePath,
      ...(node.className ? { className: node.className } : {}),
      ...(node.startLine !== undefined ? { startLine: node.startLine } : {}),
      language: node.language,
      ...(node.signature ? { signature: node.signature } : {}),
      source: 'working-tree-overlay',
    });
  }

  return { results: kept, additions, removed, ...(disclosure ? { disclosure } : {}) };
}
