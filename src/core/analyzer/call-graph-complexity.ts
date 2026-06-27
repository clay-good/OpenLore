/**
 * McCabe cyclomatic-complexity estimator — extracted from `call-graph.ts`
 * (change: modularize-call-graph-builder; analyzer: StableCallGraphBarrel).
 *
 * A pure, dependency-free regex approximation (CC = 1 + decision points) used to
 * rank/triage function complexity. `computeCyclomaticComplexity` was exported from
 * `call-graph.ts`, so it is re-exported there to keep the public import surface
 * unchanged; the `CC_PATTERN_*` tables stay private to this module.
 */

const CC_PATTERN_PYTHON = /\bif\s|\belif\s|\bwhile\s|\bfor\s|\bexcept\b|\band\s|\bor\s/g;
const CC_PATTERN_DEFAULT = /\bif\s*\(|\bwhile\s*\(|\bfor\s*[(]|\bdo\s*[{]|\bcase\s+|\bcatch\s*\(|&&|\|\|/g;

/**
 * McCabe cyclomatic complexity via regex over function body.
 * CC = 1 + decision points (if, while, for, case, catch, &&, ||).
 * Approximate (regex, not AST), suitable for triage/ranking.
 */
export function computeCyclomaticComplexity(body: string, language: string): number {
  const source = language === 'Python' ? CC_PATTERN_PYTHON.source : CC_PATTERN_DEFAULT.source;
  return 1 + (body.match(new RegExp(source, 'g'))?.length ?? 0);
}
