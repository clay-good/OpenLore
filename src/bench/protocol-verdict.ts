import type { CapabilityFamily } from '../core/services/mcp-handlers/tool-contract.js';

export interface PresetBenchmarkRule {
  schemaVersion: 1;
  id: string;
  sharedSelectionRegressionMax: number;
  tierCorrectnessRegressionMax: number;
  medianCostIncreaseMax: number;
  requiredCandidateFamilies: CapabilityFamily[];
}

export interface SelectionEvidence {
  sharedAccuracy: Record<string, number>;
}

export interface CompletionTierEvidence {
  model?: string;
  tier: string;
  current: { tasks: number; correctness: number; costUsd: number; failures?: number };
  candidate: { tasks: number; correctness: number; costUsd: number; failures?: number };
}

export interface ProtocolVerdict {
  verdict: 'FLIP' | 'HOLD';
  checks: {
    sharedSelection: boolean;
    tierCorrectness: boolean;
    medianCost: boolean;
    candidateFamilies: boolean;
    completeEvidence: boolean;
  };
}

export function parsePresetBenchmarkRule(value: unknown): PresetBenchmarkRule {
  const rule = value as Partial<PresetBenchmarkRule> | null;
  if (
    rule?.schemaVersion !== 1 ||
    typeof rule.id !== 'string' || !rule.id.trim() ||
    typeof rule.sharedSelectionRegressionMax !== 'number' || rule.sharedSelectionRegressionMax < 0 ||
    typeof rule.tierCorrectnessRegressionMax !== 'number' || rule.tierCorrectnessRegressionMax < 0 ||
    typeof rule.medianCostIncreaseMax !== 'number' || rule.medianCostIncreaseMax < 0 ||
    !Array.isArray(rule.requiredCandidateFamilies) || rule.requiredCandidateFamilies.length === 0
  ) {
    throw new Error('Invalid preset benchmark decision rule.');
  }
  return rule as PresetBenchmarkRule;
}

export function evaluatePresetBenchmarkRule(
  rule: PresetBenchmarkRule,
  presetA: string,
  presetB: string,
  candidateFamilies: readonly CapabilityFamily[],
  selection: SelectionEvidence,
  completion: readonly CompletionTierEvidence[],
  requiredTiers: readonly string[],
  requiredReplicates = 1,
): ProtocolVerdict {
  const currentSelection = selection.sharedAccuracy[presetA];
  const candidateSelection = selection.sharedAccuracy[presetB];
  const sharedSelection = Number.isFinite(currentSelection) && Number.isFinite(candidateSelection)
    && candidateSelection >= currentSelection - rule.sharedSelectionRegressionMax;
  const completeEvidence = requiredTiers.every((tier) => {
    const evidence = completion.filter((entry) => entry.tier === tier);
    return evidence.length >= requiredReplicates
      && evidence.every((entry) =>
        entry.current.tasks > 0
        && entry.candidate.tasks > 0
        && (entry.current.failures ?? 0) === 0
        && (entry.candidate.failures ?? 0) === 0);
  });
  const tierCorrectness = completeEvidence && completion.every(({ current, candidate }) =>
    candidate.correctness >= current.correctness - rule.tierCorrectnessRegressionMax);
  const medianCost = completeEvidence && completion.every(({ current, candidate }) =>
    current.costUsd === 0
      ? candidate.costUsd === 0
      : candidate.costUsd <= current.costUsd * (1 + rule.medianCostIncreaseMax));
  const familySet = new Set(candidateFamilies);
  const candidateFamilyCheck = rule.requiredCandidateFamilies.every((family) => familySet.has(family));
  const checks = {
    sharedSelection,
    tierCorrectness,
    medianCost,
    candidateFamilies: candidateFamilyCheck,
    completeEvidence,
  };
  return {
    verdict: Object.values(checks).every(Boolean) ? 'FLIP' : 'HOLD',
    checks,
  };
}
