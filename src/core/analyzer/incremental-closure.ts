/**
 * Shared ordering and stale-region composition for incremental graph producers
 * (change: prioritize-incremental-closure-budget).
 */
import { GOD_FUNCTION_FAN_OUT_THRESHOLD, HUB_THRESHOLD } from '../../constants.js';
import { sanitizeForTerminal } from '../../utils/misc.js';
import type {
  StaleFileComposition,
  StaleRegionComposition,
  StaleRegionSymbol,
} from '../../types/index.js';
import type { FunctionNode } from './call-graph-types.js';
import { isTestFile } from './test-file.js';

export type { StaleFileComposition, StaleRegionComposition, StaleRegionSymbol } from '../../types/index.js';

export interface ClosureFileSignificance {
  path: string;
  fanIn: number;
  fanOut: number;
  hasInternalNode: boolean;
  isTest: boolean;
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Strict file order: fan-in desc, same winning node's fan-out desc, path asc. */
export function compareClosureSignificance(
  a: ClosureFileSignificance,
  b: ClosureFileSignificance,
): number {
  if (a.hasInternalNode !== b.hasInternalNode) return a.hasInternalNode ? -1 : 1;
  return b.fanIn - a.fanIn || b.fanOut - a.fanOut || compareText(a.path, b.path);
}

/**
 * Aggregate symbol facts to files. The maximum-fan-in internal non-test node
 * wins; its fan-out breaks that tie. Files without such a node rank last.
 */
export function closureFileSignificance(
  paths: readonly string[],
  nodes: readonly FunctionNode[],
): ClosureFileSignificance[] {
  const wanted = new Set(paths);
  const byFile = new Map<string, FunctionNode[]>();
  for (const node of nodes) {
    if (node.isExternal || node.isTest || !wanted.has(node.filePath)) continue;
    const group = byFile.get(node.filePath) ?? [];
    group.push(node);
    byFile.set(node.filePath, group);
  }
  return paths.map(path => {
    const winner = (byFile.get(path) ?? []).sort((a, b) =>
      b.fanIn - a.fanIn || b.fanOut - a.fanOut || compareText(a.id, b.id),
    )[0];
    return {
      path,
      fanIn: winner?.fanIn ?? 0,
      fanOut: winner?.fanOut ?? 0,
      hasInternalNode: winner !== undefined,
      isTest: isTestFile(path),
    };
  });
}

/**
 * Spend one phase's budget deterministically. Under budget the input order is
 * returned untouched. Over budget, test candidates rank within their own class
 * and receive one slot when both classes are present, preventing systematic
 * test-to-production reachability starvation without changing the work count.
 */
export function spendClosureBudget(
  candidates: readonly string[],
  budget: number,
  nodes: readonly FunctionNode[],
): { selected: string[]; dropped: string[]; usedPathFallback: boolean } {
  if (candidates.length <= budget) {
    return { selected: [...candidates], dropped: [], usedPathFallback: false };
  }

  const ranked = closureFileSignificance(candidates, nodes);
  const usedPathFallback = ranked.some(file => !file.hasInternalNode);
  if (budget <= 0) return { selected: [], dropped: ranked.sort(compareClosureSignificance).map(file => file.path), usedPathFallback };
  const production = ranked.filter(file => !file.isTest).sort(compareClosureSignificance);
  const tests = ranked.filter(file => file.isTest).sort(compareClosureSignificance);
  if (production.length === 0 || tests.length === 0) {
    const ordered = [...production, ...tests];
    return {
      selected: ordered.slice(0, budget).map(file => file.path),
      dropped: ordered.slice(budget).map(file => file.path),
      usedPathFallback,
    };
  }

  const productionSlots = Math.max(0, budget - 1);
  const selectedRecords = [...production.slice(0, productionSlots), ...tests.slice(0, 1)];
  const selectedPaths = new Set(selectedRecords.map(file => file.path));
  return {
    selected: selectedRecords.map(file => file.path),
    dropped: [...production, ...tests]
      .filter(file => !selectedPaths.has(file.path))
      .map(file => file.path),
    usedPathFallback,
  };
}

function compareSymbols(a: StaleRegionSymbol, b: StaleRegionSymbol): number {
  return b.fanIn - a.fanIn || b.fanOut - a.fanOut ||
    compareText(a.filePath, b.filePath) || compareText(a.id, b.id);
}

/** Compute per-file receipts so clearing one stale file also clears its contribution. */
export function composeStaleFiles(
  files: readonly string[],
  nodes: readonly FunctionNode[],
): Map<string, StaleFileComposition> {
  const wanted = new Set(files);
  const byFile = new Map<string, StaleRegionSymbol[]>();
  for (const node of nodes) {
    if (node.isExternal || !wanted.has(node.filePath)) continue;
    const group = byFile.get(node.filePath) ?? [];
    group.push({ id: node.id, name: node.name, filePath: node.filePath, fanIn: node.fanIn, fanOut: node.fanOut });
    byFile.set(node.filePath, group);
  }

  const out = new Map<string, StaleFileComposition>();
  for (const file of files) {
    const symbols = (byFile.get(file) ?? []).sort(compareSymbols);
    const hubs = symbols.filter(symbol => symbol.fanIn >= HUB_THRESHOLD);
    out.set(file, {
      symbolCount: symbols.length,
      hubCount: hubs.length,
      chokepointCount: hubs.filter(symbol => symbol.fanOut < GOD_FUNCTION_FAN_OUT_THRESHOLD).length,
      ...(symbols[0] ? { topSymbol: symbols[0] } : {}),
    });
  }
  return out;
}

/** Combine persisted per-file receipts into the reported stale-region composition. */
export function combineStaleFileCompositions(
  files: readonly StaleFileComposition[],
  fileCount = files.length,
): StaleRegionComposition {
  const topSymbols = files.flatMap(file => file.topSymbol ? [file.topSymbol] : []);
  topSymbols.sort(compareSymbols);
  return {
    fileCount,
    symbolCount: files.reduce((sum, file) => sum + file.symbolCount, 0),
    hubCount: files.reduce((sum, file) => sum + file.hubCount, 0),
    chokepointCount: files.reduce((sum, file) => sum + file.chokepointCount, 0),
    ...(fileCount > files.length ? { unclassifiedFileCount: fileCount - files.length } : {}),
    ...(topSymbols[0] ? { topSymbol: topSymbols[0] } : {}),
  };
}

/** Render repository-derived names through the shared terminal safety boundary. */
export function formatStaleRegionComposition(composition: StaleRegionComposition): string {
  const top = composition.topSymbol
    ? `, top ${sanitizeForTerminal(composition.topSymbol.name)} (${sanitizeForTerminal(composition.topSymbol.filePath)})`
    : '';
  const unclassified = composition.unclassifiedFileCount
    ? `, ${composition.unclassifiedFileCount} unclassified`
    : '';
  return `${composition.fileCount} file${composition.fileCount === 1 ? '' : 's'}, ` +
    `${composition.hubCount} hub${composition.hubCount === 1 ? '' : 's'}, ` +
    `${composition.chokepointCount} chokepoint${composition.chokepointCount === 1 ? '' : 's'}${unclassified}${top}`;
}
