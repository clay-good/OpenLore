/**
 * New calls into deprecated code (change: add-deprecation-propagation).
 *
 * The analyzer records each declaration's standard deprecation marker (`FunctionNode.deprecation`:
 * JSDoc `@deprecated`, Go `// Deprecated:`, PEP 702 `@deprecated`). Here, each call edge a diff
 * ADDS is resolved to its target and reported when the target is marked — the SA1019 question,
 * "does my diff add calls into deprecated code?". A call that was already there is not reported.
 *
 * Resolution never guesses. In order:
 *   1. `changed-files` — the edge resolved to a symbol in the re-parsed changed files;
 *   2. `index-edge`    — the analyzed index has the same caller → name edge, to one internal symbol;
 *   3. `unique-name`   — a plain `name()` call (no receiver) and the index has exactly one internal
 *                        symbol with that name.
 * Anything else (library calls, method calls on unknown receivers, ambiguous names) is not checked,
 * and the caveat says so.
 */

import type { CallEdge, FunctionNode, SerializedCallGraph } from '../../analyzer/call-graph.js';
import type { EdgeStore } from '../edge-store.js';
import type { GovernanceFinding } from './enforcement-policy.js';

export type DeprecatedTargetResolution = 'changed-files' | 'index-edge' | 'unique-name';

export interface DeprecatedCall {
  caller: string;
  callerFile: string;
  line?: number;
  target: string;
  targetFile: string;
  /** The marker's replacement hint; empty when the marker gives none. */
  hint: string;
  resolution: DeprecatedTargetResolution;
}

export const DEPRECATED_CALLS_CAVEAT =
  'Only added calls that resolve to an indexed symbol are checked: in the changed files, through an analyzed ' +
  'call edge, or as a plain call to a name exactly one indexed symbol has. Library calls and calls OpenLore ' +
  'cannot resolve are not checked. Markers read: JSDoc @deprecated (TypeScript/JavaScript), a "Deprecated:" ' +
  'comment paragraph (Go), and a @deprecated decorator (Python).';

function resolveTarget(
  e: CallEdge,
  changed: Map<string, FunctionNode>,
  store: EdgeStore | undefined,
): { node: FunctionNode; resolution: DeprecatedTargetResolution } | undefined {
  const local = changed.get(e.calleeId);
  if (local && !local.isExternal) return { node: local, resolution: 'changed-files' };
  if (!store) return undefined;
  const viaIndex = new Map<string, FunctionNode>();
  for (const c of store.getCallees(e.callerId)) {
    if (c.calleeName !== e.calleeName || (c.kind && c.kind !== 'calls')) continue;
    const n = store.getNode(c.calleeId);
    if (n && !n.isExternal) viaIndex.set(n.id, n);
  }
  if (viaIndex.size === 1) return { node: [...viaIndex.values()][0], resolution: 'index-edge' };
  if (viaIndex.size > 1) return undefined;
  if (e.callType !== 'direct') return undefined;
  const named = store.getInternalNodesByName(e.calleeName);
  return named.length === 1 ? { node: named[0], resolution: 'unique-name' } : undefined;
}

/** The added call edges whose target is marked deprecated, sorted by caller file, line, target. */
export function findDeprecatedCalls(
  addedEdges: readonly CallEdge[],
  newGraph: SerializedCallGraph,
  store: EdgeStore | undefined,
): DeprecatedCall[] {
  const changed = new Map(newGraph.nodes.map((n) => [n.id, n]));
  const out: DeprecatedCall[] = [];
  for (const e of addedEdges) {
    const t = resolveTarget(e, changed, store);
    if (!t || typeof t.node.deprecation !== 'string') continue;
    const caller = changed.get(e.callerId);
    out.push({
      caller: caller?.name ?? e.callerId,
      callerFile: caller?.filePath ?? '',
      ...(e.line !== undefined ? { line: e.line } : {}),
      target: t.node.name,
      targetFile: t.node.filePath,
      hint: t.node.deprecation,
      resolution: t.resolution,
    });
  }
  return out.sort((a, b) =>
    a.callerFile.localeCompare(b.callerFile) || (a.line ?? 0) - (b.line ?? 0) || a.target.localeCompare(b.target));
}

/** One advisory `deprecated-symbol-use` finding per new call. */
export function deprecatedCallFindings(calls: readonly DeprecatedCall[]): GovernanceFinding[] {
  return calls.map((c) => ({
    code: 'deprecated-symbol-use',
    severity: 'warning',
    source: 'structural-diff',
    subject: `${c.targetFile}::${c.target}`,
    discriminator: `${c.callerFile}::${c.caller}:${c.line ?? ''}`,
    ...(c.callerFile ? { location: { path: c.callerFile, ...(c.line !== undefined ? { line: c.line } : {}) } } : {}),
    message: `"${c.caller}" now calls deprecated "${c.target}"${c.hint ? ` (${c.hint})` : ''}.`,
  }));
}
