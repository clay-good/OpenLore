/**
 * Query-time overlay of the files the index is behind on
 * (change: overlay-dirty-files-at-query-time).
 *
 * OpenLore already knows, per query, exactly which files the index has not caught up
 * with — it computes the stale set and discloses it — and then answers from the stale
 * index anyway. The disclosure is honest and inert: the symbols most likely to matter
 * are the ones the caller just edited.
 *
 * Re-extracting those files is bounded, cacheable work rather than a re-analysis: Pass-1
 * extraction is a pure function of `(language, content)`, which is what makes the fact
 * cache sound and this overlay affordable.
 *
 * SCOPE, and the limit that comes with it: the overlay is SYMBOL-level. Re-reading a
 * file gives its own symbols, signatures and spans soundly. It does NOT re-resolve call
 * edges INTO those symbols from files outside the stale set — that is a whole-graph
 * operation and belongs to the watcher's incremental update. Callers of an overlaid
 * symbol therefore remain as the index recorded them, and every consumer discloses that
 * rather than implying otherwise.
 */

import { createHash } from 'node:crypto';
import { statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import type { FunctionNode } from './call-graph.js';
import { detectLanguage } from './language-support.js';
import { safeJoin } from '../../utils/path-confinement.js';

/**
 * Bounds. Exceeding any of them means "do exactly what we do today": answer from the
 * index and disclose the staleness. Keeping the worst case equal to the status quo is
 * what makes the overlay safe to run by default.
 */
export const OVERLAY_MAX_FILES = 25;
export const OVERLAY_MAX_BYTES = 2_000_000;
export const OVERLAY_TIME_BUDGET_MS = 750;

/** Why an overlay produced nothing, or less than the whole stale set. */
export type OverlaySkipReason =
  | 'no-stale-files'
  | 'too-many-files'
  | 'byte-budget-exceeded'
  | 'time-budget-exceeded';

export interface OverlayFileOutcome {
  filePath: string;
  status: 'overlaid' | 'unparsable' | 'unreadable' | 'unsupported-language';
}

export interface WorkingTreeOverlay {
  /** Symbols read from the working tree, replacing the indexed rows for these files. */
  nodes: FunctionNode[];
  /** Files whose current contents were read and extracted. */
  coveredFiles: string[];
  /** Stale files still served from the index, with the reason each was not overlaid. */
  uncoveredFiles: OverlayFileOutcome[];
  /** Set when the overlay was skipped or truncated, naming why. */
  skipped?: OverlaySkipReason;
  /**
   * Always true when any file was overlaid: incoming call edges are the index's, and a
   * consumer must say so rather than imply the answer is fully current.
   */
  edgesFromIndex: boolean;
}

/**
 * Attach 1-based line numbers to a freshly extracted node, the way the builder does after
 * Pass 1. A consumer that reports positions needs them, and computing them from the exact
 * bytes just read is what makes an overlaid span address the file on disk.
 */
function deriveLines(node: FunctionNode, content: string): FunctionNode {
  const lineOf = (index: number): number => {
    let line = 1;
    const bound = Math.min(Math.max(index, 0), content.length);
    for (let i = 0; i < bound; i++) if (content.charCodeAt(i) === 10) line++;
    return line;
  };
  return { ...node, startLine: lineOf(node.startIndex), endLine: lineOf(node.endIndex) };
}

/**
 * Process-lifetime memo of overlaid extractions, keyed by the same identity the
 * persistent Pass-1 fact cache uses: `sha256(language + '\0' + content)`. Pass 1 is a pure
 * function of `(language, content)`, so an identical key can only reproduce an identical
 * answer — that purity is what makes the build-time memo sound, and it holds here.
 *
 * Deliberately in-process rather than the EdgeStore-backed cache: the overlay runs on the
 * QUERY path, where opening the graph store to memoize a handful of files would cost more
 * than the parse it saves. The property the design asked for — a file already extracted in
 * this session is not re-parsed — is what this delivers.
 */
const _overlayMemo = new Map<string, FunctionNode[]>();

/** Bound: an editing session touches few files, and a memo must not grow without limit. */
const OVERLAY_MEMO_MAX_ENTRIES = 200;

function memoKey(language: string, content: string): string {
  return createHash('sha256').update(`${language}\0${content}`).digest('hex');
}

/** Test-only: clear the overlay memo so a test can observe a cold extraction. */
export function _resetOverlayMemoForTesting(): void {
  _overlayMemo.clear();
}

/** Test-only: how many distinct extractions the memo currently holds. */
export function _overlayMemoSizeForTesting(): number {
  return _overlayMemo.size;
}

const EMPTY_OVERLAY: WorkingTreeOverlay = {
  nodes: [],
  coveredFiles: [],
  uncoveredFiles: [],
  edgesFromIndex: false,
};

/**
 * Re-extract the stale set from the working tree.
 *
 * Fails soft everywhere: an unreadable file, a file whose current contents do not parse,
 * and a language with no extractor are each reported as not overlaid, never raised. A
 * query must always be answerable.
 */
export async function buildWorkingTreeOverlay(
  rootPath: string,
  staleFiles: readonly string[],
  options: { now?: () => number } = {},
): Promise<WorkingTreeOverlay> {
  const files = [...new Set(staleFiles)].filter(path => path.length > 0);
  if (files.length === 0) return { ...EMPTY_OVERLAY, skipped: 'no-stale-files' };
  if (files.length > OVERLAY_MAX_FILES) {
    return {
      ...EMPTY_OVERLAY,
      uncoveredFiles: files.map(filePath => ({ filePath, status: 'unreadable' as const })),
      skipped: 'too-many-files',
    };
  }

  const now = options.now ?? (() => Date.now());
  const startedAt = now();
  const { dispatchFileExtract } = await import('./call-graph.js');

  const nodes: FunctionNode[] = [];
  const coveredFiles: string[] = [];
  const uncoveredFiles: OverlayFileOutcome[] = [];
  let bytes = 0;
  let skipped: OverlaySkipReason | undefined;

  for (const filePath of files) {
    if (now() - startedAt > OVERLAY_TIME_BUDGET_MS) {
      skipped = 'time-budget-exceeded';
      uncoveredFiles.push({ filePath, status: 'unreadable' });
      continue;
    }

    let absolute: string;
    try {
      // A stale path comes from git or from the index — repository data, not a trusted input.
      absolute = safeJoin(rootPath, filePath);
    } catch {
      uncoveredFiles.push({ filePath, status: 'unreadable' });
      continue;
    }

    let size: number;
    try {
      size = statSync(absolute).size;
    } catch {
      // Deleted in the working tree: nothing to overlay, and the indexed rows for it are
      // suppressed by the caller, which is the correct answer for a removed file.
      uncoveredFiles.push({ filePath, status: 'unreadable' });
      continue;
    }
    if (bytes + size > OVERLAY_MAX_BYTES) {
      skipped = 'byte-budget-exceeded';
      uncoveredFiles.push({ filePath, status: 'unreadable' });
      continue;
    }

    const language = detectLanguage(filePath);
    if (!language) {
      uncoveredFiles.push({ filePath, status: 'unsupported-language' });
      continue;
    }

    let content: string;
    try {
      content = await readFile(absolute, 'utf-8');
    } catch {
      uncoveredFiles.push({ filePath, status: 'unreadable' });
      continue;
    }
    bytes += size;

    const key = memoKey(language, content);
    const memoized = _overlayMemo.get(key);
    if (memoized) {
      nodes.push(...memoized);
      coveredFiles.push(filePath);
      continue;
    }

    try {
      const extracted = await dispatchFileExtract({ path: filePath, content, language });
      if (!extracted) {
        uncoveredFiles.push({ filePath, status: 'unsupported-language' });
        continue;
      }
      // Pass 1 emits a node per matched construct, so an exported declaration yields two
      // rows with the same id (the export statement's span and the declaration's). The
      // builder keys them by id, last wins — the overlay must do the same, or it serves
      // every exported symbol twice. Line numbers are derived here for the same reason:
      // the builder attaches them after extraction, and a consumer reading a span needs
      // them (see `deriveLines`).
      const byId = new Map<string, FunctionNode>();
      for (const node of extracted.nodes) {
        if (node.isExternal) continue;
        byId.set(node.id, deriveLines(node, content));
      }
      const fileNodes = [...byId.values()];
      if (_overlayMemo.size >= OVERLAY_MEMO_MAX_ENTRIES) _overlayMemo.clear();
      _overlayMemo.set(key, fileNodes);
      nodes.push(...fileNodes);
      coveredFiles.push(filePath);
    } catch {
      // A file mid-save, or one whose current contents do not parse. The query still answers.
      uncoveredFiles.push({ filePath, status: 'unparsable' });
    }
  }

  return {
    nodes,
    coveredFiles,
    uncoveredFiles,
    ...(skipped ? { skipped } : {}),
    edgesFromIndex: coveredFiles.length > 0,
  };
}

/** The disclosure a consumer attaches when it served an overlay. */
export interface OverlayDisclosure {
  overlaidFiles: string[];
  /** Stale files still answered from the index. */
  indexedFiles: string[];
  skipped?: OverlaySkipReason;
  note: string;
}

export function buildOverlayDisclosure(overlay: WorkingTreeOverlay): OverlayDisclosure | undefined {
  if (overlay.coveredFiles.length === 0 && overlay.uncoveredFiles.length === 0) return undefined;
  const indexedFiles = overlay.uncoveredFiles.map(entry => entry.filePath);
  const covered = overlay.coveredFiles.length;
  const note = covered === 0
    ? `The index is behind for ${indexedFiles.length} file(s) and none could be read from the working tree${overlay.skipped ? ` (${overlay.skipped})` : ''}; results come from the index.`
    : `${covered} edited file(s) were read from the working tree for this answer${indexedFiles.length > 0 ? `, ${indexedFiles.length} still served from the index` : ''}. Callers of the re-read symbols come from the index and may predate the edit.`;
  return {
    overlaidFiles: [...overlay.coveredFiles],
    indexedFiles,
    ...(overlay.skipped ? { skipped: overlay.skipped } : {}),
    note,
  };
}
