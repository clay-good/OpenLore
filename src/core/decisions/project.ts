/**
 * Projection: decision store → first-class graph nodes + `affects` edges (spec-16).
 *
 * This is the decisions analogue of src/core/analyzer/iac/project.ts. The JSON
 * store (.openlore/decisions/pending.json) remains the authored source of truth;
 * this projection is derived and regenerable. Promoting a Decision to a graph node
 * with `affects` edges to the files it governs turns orient's runtime
 * set-membership filter into a deterministic graph join, and lets
 * analyze_impact / get_subgraph answer "what decisions govern this code?" with the
 * same machinery they use for code edges.
 *
 * Edge direction is decision → governed file, mirroring the IaC convention
 * (dependent/owner → dependency): a decision "affects" the files it governs.
 */

import type { DecisionStore, PendingDecision, DecisionStatus } from '../../types/index.js';
import { INACTIVE_STATUSES } from './store.js';

/** Graph node-id namespace for projected decisions (keeps them distinct from code ids). */
export const DECISION_NODE_PREFIX = 'decision::';

/** Stable graph node id for a decision's 8-char store id. */
export function decisionNodeId(decisionId: string): string {
  return `${DECISION_NODE_PREFIX}${decisionId}`;
}

/** A projected decision — a first-class, clearly-typed graph node (not a FunctionNode). */
export interface DecisionNode {
  /** Graph node id, e.g. "decision::c6d1ad07". */
  id: string;
  /** Original 8-char store id. */
  decisionId: string;
  /** Discriminator so callers never confuse this with a code node. */
  kind: 'decision';
  title: string;
  status: DecisionStatus;
  rationale: string;
  consequences: string;
  affectedDomains: string[];
  affectedFiles: string[];
  confidence: 'high' | 'medium' | 'low';
  approvedBy?: 'human' | 'autopilot';
  humanReviewedAt?: string;
  /** 8-char id of a prior decision this one reverses, if any. */
  supersedes?: string;
}

/** An `affects` edge: decision node → a governed file path. */
export interface DecisionAffectsEdge {
  /** Graph node id of the decision ("decision::<id>"). */
  decisionNodeId: string;
  /** Repo-relative, POSIX path of the governed file. */
  filePath: string;
  kind: 'affects';
}

export interface ProjectedDecisions {
  nodes: DecisionNode[];
  edges: DecisionAffectsEdge[];
}

/** True for statuses that should NOT project — already in ADRs/spec.md, or dead. */
function isInactive(status: DecisionStatus): boolean {
  return INACTIVE_STATUSES.has(status);
}

/**
 * Project the active decisions in a store onto decision nodes + `affects` edges.
 *
 * - Inactive decisions (synced / rejected / phantom) are excluded, matching
 *   orient's INACTIVE_STATUSES — their content already lives in ADRs / spec.md.
 * - An empty or legacy store projects to zero nodes/edges.
 * - Output is fully sorted for deterministic, regenerable persistence.
 */
export function projectDecisions(store: DecisionStore): ProjectedDecisions {
  const active = (store.decisions ?? [])
    .filter((d): d is PendingDecision => !!d && !isInactive(d.status))
    .sort((a, b) => a.id.localeCompare(b.id));

  const nodes: DecisionNode[] = [];
  const edges: DecisionAffectsEdge[] = [];
  const edgeSeen = new Set<string>();

  for (const d of active) {
    const id = decisionNodeId(d.id);
    nodes.push({
      id,
      decisionId: d.id,
      kind: 'decision',
      title: d.title,
      status: d.status,
      rationale: d.rationale,
      consequences: d.consequences,
      affectedDomains: [...d.affectedDomains].sort(),
      affectedFiles: [...d.affectedFiles].sort(),
      confidence: d.confidence,
      ...(d.approvedBy ? { approvedBy: d.approvedBy } : {}),
      ...(d.humanReviewedAt ? { humanReviewedAt: d.humanReviewedAt } : {}),
      ...(d.supersedes ? { supersedes: d.supersedes } : {}),
    });

    for (const file of [...d.affectedFiles].sort()) {
      if (!file) continue;
      const key = `${id}\0${file}`;
      if (edgeSeen.has(key)) continue;
      edgeSeen.add(key);
      edges.push({ decisionNodeId: id, filePath: file, kind: 'affects' });
    }
  }

  return { nodes, edges };
}
