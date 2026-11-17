/**
 * Structural landmark signals (change: add-structural-landmark-salience).
 *
 * "Which functions are the structural anchors of this code, and *why*?" — answered
 * as a set of **labeled signals with raw evidence**, NOT a blended salience score.
 * A composite weighting (`hub*40 + orchestrator*20 + …`) would be deterministic but
 * arbitrary — a black box the agent must trust — which the north star (decision
 * c6d1ad07, "static analysis, not guessing") exists to keep out. So we hand the
 * agent the facts and let it rank by what its task needs.
 *
 * Every label is produced by an EXISTING deterministic classifier; no new threshold
 * or weighting constant is introduced here:
 *   - `hub`         → the precomputed `graph.hubFunctions` set (fanIn ≥ 5)
 *   - `orchestrator`→ the god-function classifier (fanOut ≥ GOD_FUNCTION_FAN_OUT_THRESHOLD)
 *   - `chokepoint`  → the parameter-free conjunction `hub ∧ ¬orchestrator`
 *   - `entrypoint`  → the precomputed `graph.entryPoints` set
 *   - `volatile`    → the change-coupling `volatilityLevel` classifier (level ≠ low)
 *   - `dead`        → the dead-code reachability classifier (`deadCodeIds`)
 *
 * `volatile` (git churn) and `dead` (reachability + dep-graph) are derived from data
 * outside the in-memory graph, so the caller injects them via `opts`; the four pure
 * structural labels need only the graph.
 */

import { GOD_FUNCTION_FAN_OUT_THRESHOLD } from '../../constants.js';
import { isProjectedLanguage } from './projected-language.js';
import type { SerializedCallGraph } from './call-graph.js';

export type LandmarkLabel =
  | 'hub'
  | 'orchestrator'
  | 'chokepoint'
  | 'volatile'
  | 'entrypoint'
  | 'dead';

/** One earned label plus the raw evidence that earned it (no derived score). */
export interface LandmarkSignal {
  label: LandmarkLabel;
  evidence: Record<string, number | string>;
}

/** A function that earned ≥ 1 structural-interest label. No `score` field by design. */
export interface Landmark {
  id: string;
  name: string;
  filePath: string;
  signals: LandmarkSignal[];
}

export interface LandmarkSignalOptions {
  /** filePath → churn evidence, from change-coupling (a file is volatile when level ≠ low). */
  volatilityByFile?: Map<string, { level: 'high' | 'medium'; churn: number; coChangedWith: number }>;
  /** Candidate dead-code node ids, from the reachability classifier (`deadCodeIds`). */
  deadIds?: Set<string>;
}

/**
 * Label each function with the structural-interest signals it earns. Returns only
 * functions with ≥ 1 label, each carrying its raw evidence — never a composite rank.
 */
export function computeLandmarkSignals(
  graph: SerializedCallGraph,
  opts: LandmarkSignalOptions = {},
): Landmark[] {
  const hubIds = new Set(graph.hubFunctions.map(n => n.id));
  const entryIds = new Set(graph.entryPoints.map(n => n.id));
  const { volatilityByFile, deadIds } = opts;

  const landmarks: Landmark[] = [];
  for (const node of graph.nodes) {
    if (node.isExternal) continue; // synthetic stdlib/HTTP leaves are not landmarks
    // A declaration is not a landmark of the code either: a YAML stanza or a declared
    // operation is not a place to navigate to (change: fix-projection-integrity).
    if (isProjectedLanguage(node.language)) continue;

    const signals: LandmarkSignal[] = [];
    const fanIn = node.fanIn ?? 0;
    const fanOut = node.fanOut ?? 0;
    const isHub = hubIds.has(node.id);
    const isOrchestrator = fanOut >= GOD_FUNCTION_FAN_OUT_THRESHOLD;

    if (isHub) signals.push({ label: 'hub', evidence: { fanIn } });
    if (isOrchestrator) signals.push({ label: 'orchestrator', evidence: { fanOut } });
    // chokepoint: a funnel many paths cross but that does not itself branch widely.
    if (isHub && !isOrchestrator) signals.push({ label: 'chokepoint', evidence: { fanIn, fanOut } });
    if (entryIds.has(node.id)) signals.push({ label: 'entrypoint', evidence: { fanOut } });

    const vol = volatilityByFile?.get(node.filePath);
    if (vol) signals.push({ label: 'volatile', evidence: { level: vol.level, commits: vol.churn, coChangedWith: vol.coChangedWith } });

    if (deadIds?.has(node.id)) signals.push({ label: 'dead', evidence: { fanIn } });

    if (signals.length > 0) {
      landmarks.push({ id: node.id, name: node.name, filePath: node.filePath, signals });
    }
  }
  return landmarks;
}
