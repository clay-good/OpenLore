/**
 * Whole-payload token-budget fitting (change: refine-orient-context-budgeting).
 *
 * A budget that trims one section over a fixed candidate cap can both overshoot a small budget (the
 * other sections still render in full) and waste a large one (the cap binds first). This fits the
 * RENDERED payload instead: list sections are trimmed from their lowest-ranked end, whole entries only,
 * in a fixed peripheral-first order, keeping the fewest removals that fit.
 * Deterministic — same payload, budget, and order give the same result — and costed with the same
 * character-based estimator every other budget in the server uses.
 */

import { estimateTokens } from '../llm-service.js';

export interface BudgetFit {
  /** The fitted payload, including whatever `decorate` added. */
  payload: Record<string, unknown>;
  /** Entries dropped per section (only sections that lost entries). */
  omitted: Record<string, number>;
  /** Estimated tokens of the fitted payload. */
  estimatedTokens: number;
  /** False when even the fullest trimming allowed by `minimum` does not fit. */
  fits: boolean;
}

/**
 * Fit `payload` to `budget` tokens by dropping whole trailing entries from the list sections named in
 * `order` (most peripheral first; each section is drained before the next is touched), keeping at least
 * `minimum[section]` entries in each. `decorate` renders the trimmed payload with its receipts, so the
 * receipts are costed too, and `measure` costs the rendering the caller actually sends (compact JSON by
 * default). Sections not named, and non-array values, are never trimmed.
 */
export function fitPayloadToBudget<T extends Record<string, unknown>>(
  payload: T,
  budget: number,
  order: readonly string[],
  minimum: Readonly<Record<string, number>>,
  decorate: (trimmed: T, omitted: Record<string, number>) => Record<string, unknown>,
  measure: (rendered: Record<string, unknown>) => number = rendered => estimateTokens(JSON.stringify(rendered)),
): BudgetFit {
  const steps: string[] = [];
  for (const section of order) {
    const value = payload[section];
    if (!Array.isArray(value)) continue;
    const removable = Math.max(0, value.length - (minimum[section] ?? 0));
    for (let i = 0; i < removable; i++) steps.push(section);
  }

  const build = (removals: number) => {
    const omitted: Record<string, number> = {};
    for (let i = 0; i < removals; i++) omitted[steps[i]] = (omitted[steps[i]] ?? 0) + 1;
    const trimmed: Record<string, unknown> = { ...payload };
    for (const [section, dropped] of Object.entries(omitted)) {
      const list = payload[section] as unknown[];
      trimmed[section] = list.slice(0, list.length - dropped);
    }
    const rendered = decorate(trimmed as T, omitted);
    return { rendered, omitted, tokens: measure(rendered) };
  };

  // Cost is not strictly monotone in the removal count (a receipt key appears the first time a section
  // loses an entry), so a binary search can skip the smallest cut that fits. The removal count is bounded
  // by the payload's own entries, so a scan from zero finds it exactly.
  let best = build(0);
  for (let removals = 1; best.tokens > budget && removals <= steps.length; removals++) best = build(removals);
  return { payload: best.rendered, omitted: best.omitted, estimatedTokens: best.tokens, fits: best.tokens <= budget };
}
