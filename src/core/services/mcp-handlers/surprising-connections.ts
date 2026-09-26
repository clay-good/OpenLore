import { validateDirectory, readCachedContext, diagnoseIndexUnservable } from './utils.js';
import type { SerializedCallGraph, FunctionNode } from '../../analyzer/call-graph.js';

const DEFAULT_LIMIT = 15;
const HUB_MIN_FAN_IN = 5;
const PERIPHERAL_MAX_DEGREE = 4;
// Global utilities (very high fanIn, low fanOut) are designed to be called cross-community — not surprising.
const GLOBAL_UTILITY_FAN_IN = 20;

export interface GetSurprisingConnectionsInput {
  directory: string;
  /** Max results to return (default: 15, max: 50). */
  limit?: number;
}

export async function handleGetSurprisingConnections(input: GetSurprisingConnectionsInput): Promise<unknown> {
  const absDir = await validateDirectory(input.directory);
  const ctx = await readCachedContext(absDir);
  if (!ctx) return await diagnoseIndexUnservable(absDir);
  if (!ctx.callGraph) return { error: 'Call graph not available. Re-run analyze_codebase.' };

  const limit = Math.max(1, Math.min(input.limit ?? DEFAULT_LIMIT, 50));
  const cg = ctx.callGraph as SerializedCallGraph;
  const nodeById = new Map<string, FunctionNode>(cg.nodes.map(n => [n.id, n]));

  // Score each unique (caller, callee) edge.
  type EdgeResult = { from: string; fromFile: string; to: string; toFile: string; score: number; reasons: string[] };
  const seen = new Set<string>();
  const edgeResults: EdgeResult[] = [];

  for (const e of cg.edges) {
    // Synthesized dynamic-dispatch edges are heuristic, not direct dependencies — they
    // would otherwise surface as false "cross-community surprises". They are reported
    // with their own provenance elsewhere; this tool scores the directly-resolved graph.
    if (e.confidence === 'synthesized') continue;
    const key = `${e.callerId}→${e.calleeId}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const src = nodeById.get(e.callerId);
    const tgt = nodeById.get(e.calleeId);
    if (!src || !tgt || src.isExternal || tgt.isExternal) continue;

    const reasons: string[] = [];
    let score = 0;

    // Cross-community: different non-null community IDs
    if (src.communityId && tgt.communityId && src.communityId !== tgt.communityId) {
      score += 0.3;
      reasons.push('cross-community');
    }

    // Peripheral-to-hub: low-degree source calling a domain hub.
    // Skip if target is a global utility (very high fanIn) — those are designed to be called cross-community.
    const srcDegree = (src.fanIn ?? 0) + (src.fanOut ?? 0);
    const tgtFanIn = tgt.fanIn ?? 0;
    if (srcDegree <= PERIPHERAL_MAX_DEGREE && tgtFanIn >= HUB_MIN_FAN_IN * 3 && tgtFanIn < GLOBAL_UTILITY_FAN_IN) {
      score += 0.2;
      reasons.push('peripheral-to-hub');
    }

    // Cross-test-boundary: one side is test, the other is not
    if (!!src.isTest !== !!tgt.isTest) {
      score += 0.15;
      reasons.push('cross-test-boundary');
    }

    if (score === 0) continue;
    edgeResults.push({ from: src.name, fromFile: src.filePath, to: tgt.name, toFile: tgt.filePath, score: Math.round(score * 100) / 100, reasons });
  }

  // Group by target: multiple callers reaching the same surprising target is one finding.
  type Group = { to: string; toFile: string; score: number; reasons: string[]; callers: Array<{ from: string; fromFile: string }> };
  const grouped = new Map<string, Group>();
  for (const r of edgeResults) {
    const key = `${r.toFile}::${r.to}`;
    const g = grouped.get(key);
    if (!g) {
      grouped.set(key, { to: r.to, toFile: r.toFile, score: r.score, reasons: r.reasons, callers: [{ from: r.from, fromFile: r.fromFile }] });
    } else {
      if (r.score > g.score) { g.score = r.score; g.reasons = r.reasons; }
      if (!g.callers.some(c => c.from === r.from && c.fromFile === r.fromFile)) g.callers.push({ from: r.from, fromFile: r.fromFile });
    }
  }

  const top = [...grouped.values()]
    .sort((a, b) => b.score - a.score || b.callers.length - a.callers.length)
    .slice(0, limit)
    .map(g => ({
      to: g.to,
      toFile: g.toFile,
      callerCount: g.callers.length,
      callers: g.callers.slice(0, 3),
      score: g.score,
      reasons: g.reasons,
    }));

  return {
    count: top.length,
    connections: top,
    guidance:
      'Grouped by target: callerCount shows how many distinct modules reach this surprising dependency. ' +
      'Scored by: cross-community (+0.3), peripheral-to-hub (+0.2), cross-test-boundary (+0.15). ' +
      'Verify with get_subgraph or trace_execution_path before acting.',
  };
}
