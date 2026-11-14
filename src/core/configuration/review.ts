import { configurationDigest } from './policy.js';
import type { ConfigurationInspection } from './types.js';

/** Host-observed evidence, never a claim inferred solely from a changed manifest. */
export interface ConfigurationReviewSignal {
  kind: 'watched-output' | 'resource-pressure';
  scope: string;
  /** Stable identity of the discrepancy/action, independent of HEAD and metadata hashes. */
  action: string;
  observed: boolean;
  material: boolean;
  actionable: boolean;
  explicitChoice: boolean;
  /** Resource pressure must name an operator-measured baseline and sustained window. */
  baseline?: string;
  persistent?: boolean;
  recovered?: boolean;
}
export interface ConfigurationReviewState {
  version: 1;
  root: string;
  evidenceRevision: string;
  lastSurveyAt?: number;
  lastMetadataRevision?: string;
  evidence?: Array<{ path: string; revision: string }>;
  conditions: Record<
    string,
    {
      observations: number;
      notified: boolean;
      dismissed: boolean;
      snoozedUntil?: number;
      baseline?: string;
    }
  >;
}
export interface ConfigurationReviewResult {
  state: ConfigurationReviewState;
  notice?: {
    id: string;
    conditions: Array<{ id: string; scope: string; action: string }>;
    message: string;
  };
  diagnostics: string[];
}
/** Pure notification gate. The host persists this private state under a worktree-scoped lock. */
export function reviewConfiguration(
  inspection: ConfigurationInspection,
  signals: readonly ConfigurationReviewSignal[],
  options: {
    previous?: ConfigurationReviewState;
    mode?: 'manual' | 'notify';
    idle: boolean;
    operationActive: boolean;
    deliveryClaimed: boolean;
    now?: number;
  }
): ConfigurationReviewResult {
  const now = options.now ?? Date.now();
  const state: ConfigurationReviewState =
    options.previous?.root === inspection.root
      ? (JSON.parse(JSON.stringify(options.previous)) as ConfigurationReviewState)
      : {
          version: 1,
          root: inspection.root,
          evidenceRevision: inspection.evidenceRevision,
          conditions: {},
        };
  state.evidenceRevision = inspection.evidenceRevision;
  state.evidence = (inspection.evidence ?? [])
    .filter((item) => item.kind === 'manifest' || item.kind === 'ignore')
    .slice(0, 1000)
    .map((item) => ({ path: item.path, revision: item.revision }));
  const diagnostics: string[] = [],
    ready: Array<{ id: string; scope: string; action: string }> = [];
  if (!inspection.complete)
    return { state, diagnostics: ['Partial inspection: no notification is eligible.'] };
  const seen = new Set<string>();
  for (const signal of signals.slice(0, 100)) {
    const id = configurationDigest({
      root: inspection.root,
      kind: signal.kind,
      scope: signal.scope,
      action: signal.action,
    });
    if (seen.has(id)) continue;
    seen.add(id);
    const condition = state.conditions[id] ?? {
      observations: 0,
      notified: false,
      dismissed: false,
    };
    if (signal.recovered) {
      delete state.conditions[id];
      continue;
    }
    state.conditions[id] = condition;
    if (
      !signal.observed ||
      !signal.material ||
      !signal.actionable ||
      signal.explicitChoice ||
      options.operationActive
    ) {
      if (signal.kind === 'resource-pressure') condition.observations = 0;
      diagnostics.push('Insufficient actionable evidence for ' + signal.scope);
      continue;
    }
    if (signal.kind === 'resource-pressure') {
      if (!signal.baseline || !signal.persistent) {
        condition.observations = 0;
        continue;
      }
      if (condition.baseline !== signal.baseline) condition.observations = 0;
      condition.baseline = signal.baseline;
      condition.observations++;
      if (condition.observations < 2) continue;
    }
    if (condition.notified || condition.dismissed || (condition.snoozedUntil ?? 0) > now) continue;
    ready.push({ id, scope: signal.scope, action: signal.action });
  }
  // Absence of a signal is not evidence of resolution (missed events/restarts preserve dismissal).
  // Bound storage without discarding unresolved user choices: refuse new delivery when full.
  if (Object.keys(state.conditions).length > 1000)
    return {
      state: options.previous ?? { ...state, conditions: {} },
      diagnostics: ['Review state capacity reached; explicit reset is required.'],
    };
  if (
    options.mode !== 'notify' ||
    !options.idle ||
    options.operationActive ||
    !options.deliveryClaimed ||
    !ready.length
  )
    return { state, diagnostics };
  for (const item of ready) state.conditions[item.id].notified = true;
  return {
    state,
    diagnostics,
    notice: {
      id: configurationDigest(ready.map((r) => r.id).sort()),
      conditions: ready,
      message:
        'OpenLore observed configuration discrepancies. Review the evidence and preview a plan with openlore_configure; no settings were changed.',
    },
  };
}
export function dismissConfigurationReview(
  state: ConfigurationReviewState,
  id: string,
  snoozedUntil?: number
): ConfigurationReviewState {
  const next = JSON.parse(JSON.stringify(state)) as ConfigurationReviewState;
  const condition = next.conditions[id];
  if (!condition) return next;
  if (snoozedUntil !== undefined && Number.isFinite(snoozedUntil)) {
    condition.snoozedUntil = snoozedUntil;
    condition.notified = false;
  } else condition.dismissed = true;
  return next;
}
