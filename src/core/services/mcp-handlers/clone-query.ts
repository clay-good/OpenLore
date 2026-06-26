/**
 * `find_clones` MCP handler (change: add-clone-query-tool).
 *
 * `get_duplicate_report` answers the whole-repo audit question — "here is every
 * clone group" — by reading the precomputed `duplicates.json`. This answers the
 * edit-time question an agent actually has: "I am about to write (or just wrote)
 * THIS — does a near-duplicate already exist that I should reuse instead?"
 *
 * Two query forms, exactly one required:
 *   - `symbol`  : a function already in the index (name, or name::path). Its body
 *                 is extracted from the persisted byte range and compared against
 *                 every other indexed function.
 *   - `snippet` : raw code not necessarily in the index — answers the pre-write
 *                 question the whole-repo report structurally cannot.
 *
 * Computed live (no new persisted artifact) from the cached call graph plus a
 * re-read of the source it spans, then run through the one-vs-all `findClones`
 * query in `duplicate-detector.ts` — same normalization / shingling / Jaccard /
 * thresholds as the whole-repo detector. Conclusion-shaped: a ranked match list,
 * never a graph.
 */

import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { validateDirectory, readCachedContext } from './utils.js';
import {
  findClones,
  CLONE_MIN_LINES,
  CLONE_MIN_TOKENS,
  CLONE_NEAR_THRESHOLD,
  type CloneQueryNode,
} from '../../analyzer/duplicate-detector.js';
import type { SerializedCallGraph } from '../../analyzer/call-graph.js';

export interface FindClonesInput {
  directory: string;
  /** A function in the index: its name, or `name::path` to disambiguate. */
  symbol?: string;
  /** Raw code to compare (need not be in the index). */
  snippet?: string;
  /** Near-clone Jaccard floor (default CLONE_NEAR_THRESHOLD, clamped to [0.1, 1]). */
  minSimilarity?: number;
  /** Cap on returned matches (default 25, capped 200). */
  maxResults?: number;
}

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 200;
const HTML_RE = /\.html?$/i;

/** Serialized call-graph node fields this handler reads. */
interface SerNode extends CloneQueryNode {
  startLine?: number;
  endLine?: number;
}

/**
 * Find existing clones of a single symbol or snippet. Read-only, deterministic,
 * offline. Returns `unknown` (additive-by-cast), conclusion-shaped — a ranked
 * match list with the similarity floor and honesty signals, never a graph.
 */
export async function handleFindClones(input: FindClonesInput): Promise<unknown> {
  const absDir = await validateDirectory(input.directory);

  const hasSymbol = typeof input.symbol === 'string' && input.symbol.trim().length > 0;
  const hasSnippet = typeof input.snippet === 'string' && input.snippet.length > 0;
  if (hasSymbol === hasSnippet) {
    return {
      error:
        'Provide exactly one of `symbol` (a function name, or name::path, in the index) or ' +
        '`snippet` (raw code to compare).',
    };
  }

  const ctx = await readCachedContext(absDir);
  if (!ctx) return { error: 'No analysis found. Run analyze_codebase first.' };
  if (!ctx.callGraph) return { error: 'Call graph not available. Re-run analyze_codebase.' };

  const cg = ctx.callGraph as SerializedCallGraph;
  const allNodes = (cg.nodes ?? []) as unknown as SerNode[];

  // Comparable nodes only. Two kinds are dropped:
  //  1. HTML inline-script symbols — their persisted byte ranges were computed
  //     against transformed (blanked) HTML content, so a live re-read of the raw
  //     file would misalign the slice. This is the one we DISCLOSE (it removes
  //     real code from comparison). Honesty over a silently wrong body.
  //  2. Symbols with no extractable body (startIndex >= endIndex) — external /
  //     synthesized symbols that have no source to fingerprint. Not noteworthy:
  //     there is no body to compare, so dropping them is correct, not a gap.
  const htmlExcluded = allNodes.filter(n => HTML_RE.test(n.filePath)).length;
  const nodes = allNodes.filter(n => !HTML_RE.test(n.filePath) && n.startIndex < n.endIndex);

  // Read the source each node spans, once per file.
  const filePaths = [...new Set(nodes.map(n => n.filePath))];
  const files: Array<{ path: string; content: string }> = [];
  const fileContentMap = new Map<string, string>();
  for (const rel of filePaths) {
    try {
      const content = await readFile(join(absDir, rel), 'utf-8');
      files.push({ path: rel, content });
      fileContentMap.set(rel, content);
    } catch {
      // File unreadable or deleted since analysis — skip; it just won't be a candidate.
    }
  }

  // ── Resolve the query ──────────────────────────────────────────────────────
  let queryBody: string;
  let queryLineCount: number;
  let exclude: { filePath: string; startIndex: number; endIndex: number } | undefined;
  let queryLabel: Record<string, unknown>;

  if (hasSymbol) {
    const sym = input.symbol!.trim();
    const sep = sym.indexOf('::');
    const namePart = sep >= 0 ? sym.slice(0, sep) : sym;
    const pathPart = sep >= 0 ? sym.slice(sep + 2) : undefined;

    let candidates = nodes.filter(n => n.name === namePart);
    if (pathPart) {
      candidates = candidates.filter(n => n.filePath === pathPart || n.filePath.endsWith(pathPart));
    }

    if (candidates.length === 0) {
      // Distinguish "exists but not comparable" from "absent". A symbol present in the FULL node set
      // but absent from the comparable set was filtered out as an HTML inline-script symbol or a
      // bodyless external/synthesized symbol — saying "not found" while offering its own name as a
      // candidate would be self-contradicting. Report the real reason instead.
      const existsButNotComparable = allNodes.some(
        n => n.name === namePart && (pathPart ? (n.filePath === pathPart || n.filePath.endsWith(pathPart)) : true),
      );
      if (existsButNotComparable) {
        return {
          error:
            `"${sym}" is in the index but has no comparable body — it is an HTML inline-script symbol ` +
            'or an external/synthesized symbol with no source span. It cannot be clone-compared.',
        };
      }
      const nameLower = namePart.toLowerCase();
      const near = [...new Set(allNodes.map(n => n.name))]
        .filter(nm => nm.toLowerCase().includes(nameLower))
        .slice(0, 10);
      return {
        error: `No indexed function matching "${sym}".`,
        candidates: near,
        hint: near.length
          ? 'Did you mean one of these? Pass name::path to disambiguate.'
          : 'If the code is new, run analyze_codebase — or use `snippet` mode to compare raw code.',
      };
    }
    if (candidates.length > 1) {
      return {
        error: `"${sym}" is ambiguous — matches ${candidates.length} functions. Pass name::path.`,
        candidates: candidates.slice(0, 10).map(n => `${n.name}::${n.filePath}`),
      };
    }

    const node = candidates[0];
    const content = fileContentMap.get(node.filePath);
    if (content === undefined) {
      return {
        error:
          `Source for "${sym}" (${node.filePath}) could not be read — the file may have changed ` +
          'since analysis. Re-run analyze_codebase.',
      };
    }
    queryBody = content.slice(node.startIndex, node.endIndex);
    const startLine = node.startLine ?? 1;
    const endLine = node.endLine ?? startLine + queryBody.split('\n').length - 1;
    queryLineCount = endLine - startLine + 1;
    exclude = { filePath: node.filePath, startIndex: node.startIndex, endIndex: node.endIndex };
    queryLabel = {
      mode: 'symbol',
      symbol: `${node.name}::${node.filePath}`,
      className: node.className,
      language: node.language,
      startLine,
      endLine,
    };
  } else {
    queryBody = input.snippet!;
    queryLineCount = queryBody.split('\n').length;
    queryLabel = { mode: 'snippet', lines: queryLineCount };
  }

  // NaN-safe (a CLI `--max foo` → parseInt → NaN would otherwise pass an unlimited limit through).
  const requestedMax = Number.isFinite(input.maxResults as number) ? (input.maxResults as number) : DEFAULT_LIMIT;
  const limit = Math.max(1, Math.min(requestedMax, MAX_LIMIT));
  const result = findClones(queryBody, queryLineCount, files, nodes, {
    minSimilarity: input.minSimilarity,
    limit,
    exclude,
  });

  if (result.belowThreshold) {
    return {
      query: queryLabel,
      belowThreshold: true,
      matches: [],
      note:
        `Query is below the evidence floor (needs ≥ ${CLONE_MIN_LINES} lines and ≥ ${CLONE_MIN_TOKENS} ` +
        'normalized tokens). No comparison performed — this is "too small to compare", not "no clones".',
    };
  }

  const summary = {
    exact: result.matches.filter(m => m.type === 'exact').length,
    structural: result.matches.filter(m => m.type === 'structural').length,
    near: result.matches.filter(m => m.type === 'near').length,
    total: result.matches.length,
  };

  const note =
    'Each match is an existing function that is a clone of the query — reuse or extend the canonical ' +
    'one instead of reinventing. exact = identical after normalization, structural = same shape with ' +
    'renamed identifiers, near = high token-overlap (Jaccard ≥ similarityFloor). Bodies are sliced ' +
    'from current source by the indexed byte ranges, so re-run analyze_codebase after edits or a ' +
    'match span may be stale.' +
    (htmlExcluded > 0
      ? ` ${htmlExcluded} HTML inline-script symbol(s) were excluded from comparison.`
      : '');

  return {
    query: queryLabel,
    similarityFloor: result.similarityFloor,
    defaultSimilarityFloor: CLONE_NEAR_THRESHOLD,
    comparedAgainst: result.comparedAgainst,
    ...(htmlExcluded > 0 ? { htmlExcluded } : {}),
    summary,
    matches: result.matches,
    note,
  };
}
