/**
 * Change significance labeling (change: add-change-significance-briefing) —
 * deterministic, label-only, no composite score.
 *
 * Given the symbols that changed since a base ref plus the structural facts the
 * analyzer already computes (the `landmark-signals` hub/orchestrator/chokepoint
 * labels) and the git churn the change-coupling miner already computes, this
 * assigns each changed symbol exactly ONE significance tier from a fixed, closed
 * set — NEVER a blended weighted number. It is the deterministic analogue of a
 * "what changed while I was away, and which of it matters" indicator, expressed
 * over labels OpenLore already produces (decision c6d1ad07: static analysis, not
 * a hidden formula).
 *
 * Tier definitions and order (highest first):
 *   - `surprising-change`  — a hub (high fan-in, the existing `hub` label) whose
 *                            file has LOW churn (the existing `volatilityLevel`
 *                            classifier's `low`), AND the repository has enough
 *                            history to say "rarely changed before". A normally-
 *                            stable, widely-depended-on symbol that suddenly moved
 *                            is the highest-signal event in a change set.
 *   - `hub-change`         — a hub that is also an orchestrator (high fan-in AND
 *                            high fan-out — a broad god-hub), not surprising.
 *   - `chokepoint-change`  — a hub that is NOT an orchestrator (a funnel many paths
 *                            cross — OpenLore's `chokepoint` label is exactly
 *                            `hub ∧ ¬orchestrator`), not surprising.
 *   - `ordinary-change`    — everything else.
 *
 * WHY hub-change splits from chokepoint-change on `orchestrator`: in OpenLore the
 * `chokepoint` label is defined as `hub ∧ ¬orchestrator`, so EVERY chokepoint is
 * also a hub. Ranking a both-labeled symbol into the higher tier would leave the
 * `chokepoint-change` tier permanently empty. Instead we partition the hubs by the
 * existing `orchestrator` classifier: a broad hub (orchestrator) ranks as
 * `hub-change`, a pure funnel (chokepoint) ranks as `chokepoint-change`. Both tiers
 * use only existing labels; no new metric, no new tuning constant.
 *
 * HONESTY — withholding the surprise: "rarely changed before" needs history. A
 * repository with fewer than two non-bulk commits of history has no "before" to be
 * rare within, so the `surprising-change` label is withheld for the whole briefing
 * and those hubs fall back to `hub-change` (exactly as the style fingerprint
 * withholds a ratio below its evidence floor). The caller passes `historyAvailable`.
 *
 * Determinism: a pure function of its inputs. Same inputs → byte-identical output,
 * including the stable secondary ordering (fan-in desc, then file, then name).
 */

import { volatilityLevel } from '../provenance/change-coupling.js';

export type SignificanceTier =
  | 'surprising-change'
  | 'hub-change'
  | 'chokepoint-change'
  | 'ordinary-change';

/** Tier order for ranking and truncation (higher = more significant). */
export const TIER_RANK: Record<SignificanceTier, number> = {
  'surprising-change': 3,
  'hub-change': 2,
  'chokepoint-change': 1,
  'ordinary-change': 0,
};

/** All tiers, most-significant first — for stable iteration / receipts. */
export const TIERS_BY_RANK: SignificanceTier[] = [
  'surprising-change',
  'hub-change',
  'chokepoint-change',
  'ordinary-change',
];

/**
 * One changed symbol, with the structural facts already computed elsewhere. The
 * labeler does no graph traversal and no git access — it only classifies.
 */
export interface ChangedSymbolFacts {
  id: string;
  name: string;
  filePath: string;
  fanIn: number;
  fanOut: number;
  /** Earned the `hub` label (fanIn ≥ hub threshold) from landmark-signals. */
  isHub: boolean;
  /** Earned the `orchestrator` label (fanOut ≥ god-function threshold). */
  isOrchestrator: boolean;
  /** Earned the `chokepoint` label (= hub ∧ ¬orchestrator). */
  isChokepoint: boolean;
  /** Commits that touched this file in the scanned history window (0 if none). */
  churn: number;
  /** Community label (the region's hub name), if the node has one. */
  community?: string;
}

/** The raw evidence behind a labeled change — no derived score. */
export interface ChangeEvidence {
  fanIn: number;
  fanOut: number;
  /** Prior commits that touched this file (the churn used for the surprise test). */
  priorChurn: number;
  /** The existing volatility classifier's level for `priorChurn`. */
  volatility: 'high' | 'medium' | 'low';
}

/** A changed symbol with its single tier, the labels behind it, and raw evidence. */
export interface LabeledChange {
  id: string;
  name: string;
  file: string;
  community?: string;
  tier: SignificanceTier;
  /** The existing landmark labels this symbol earned (subset of hub/orchestrator/chokepoint). */
  labels: string[];
  evidence: ChangeEvidence;
}

export interface LabelOptions {
  /**
   * Whether the repository has enough git history to assert "rarely changed
   * before". When false, `surprising-change` is withheld for every symbol and the
   * affected hubs fall back to `hub-change`.
   */
  historyAvailable: boolean;
}

/** Assign one symbol its tier from the existing labels + churn (no score). */
function tierFor(f: ChangedSymbolFacts, historyAvailable: boolean): SignificanceTier {
  if (!f.isHub) return 'ordinary-change';
  const lowChurn = volatilityLevel(f.churn) === 'low';
  // surprising: a stable hub that moved — but only when history can support "rare".
  if (lowChurn && historyAvailable) return 'surprising-change';
  // A hub that is NOT surprising splits by the orchestrator classifier:
  //   broad god-hub (orchestrator) → hub-change; pure funnel (chokepoint) → chokepoint-change.
  if (f.isOrchestrator) return 'hub-change';
  if (f.isChokepoint) return 'chokepoint-change';
  // A hub that is neither orchestrator nor chokepoint cannot occur (chokepoint is
  // defined as hub ∧ ¬orchestrator), but classify it as hub-change defensively.
  return 'hub-change';
}

/**
 * Label and rank changed symbols by significance tier. Pure and deterministic:
 * returns the changes sorted by tier (desc), then raw fan-in (desc), then a stable
 * file+name tiebreak. No composite score, no new tuning constant.
 */
export function labelChangeSignificance(
  changes: ChangedSymbolFacts[],
  opts: LabelOptions,
): LabeledChange[] {
  const labeled: LabeledChange[] = changes.map(f => {
    const labels: string[] = [];
    if (f.isHub) labels.push('hub');
    if (f.isOrchestrator) labels.push('orchestrator');
    if (f.isChokepoint) labels.push('chokepoint');
    return {
      id: f.id,
      name: f.name,
      file: f.filePath,
      ...(f.community ? { community: f.community } : {}),
      tier: tierFor(f, opts.historyAvailable),
      labels,
      evidence: {
        fanIn: f.fanIn,
        fanOut: f.fanOut,
        priorChurn: f.churn,
        volatility: volatilityLevel(f.churn),
      },
    };
  });

  labeled.sort((a, b) => {
    const tr = TIER_RANK[b.tier] - TIER_RANK[a.tier];
    if (tr !== 0) return tr;
    if (a.evidence.fanIn !== b.evidence.fanIn) return b.evidence.fanIn - a.evidence.fanIn;
    return a.file.localeCompare(b.file) || a.name.localeCompare(b.name);
  });

  return labeled;
}

/** Count of each tier in a labeled set — for the briefing's tier rollup. */
export function tierCounts(labeled: LabeledChange[]): Record<SignificanceTier, number> {
  const counts: Record<SignificanceTier, number> = {
    'surprising-change': 0,
    'hub-change': 0,
    'chokepoint-change': 0,
    'ordinary-change': 0,
  };
  for (const c of labeled) counts[c.tier]++;
  return counts;
}
