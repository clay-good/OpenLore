import { parseOpenSpecRequirements } from './openspec-compat.js';
import type { SpecLinkIndexSpecInput } from './spec-link-index.js';

export const SCENARIO_PATH_CAVEAT = 'a verification path existing means a test reaches the anchored code, never that the test asserts the scenario\'s behavior.';

export interface ScenarioShapeFinding {
  specFile: string;
  requirement: string;
  scenario: string;
  clause: string;
  reason: 'missing-when' | 'missing-then' | 'unobservable-then';
}

/** Closed, deliberately lexical token classes. This checks shape, not correctness. */
function observableThen(clause: string): boolean {
  return /[`"'][^`"']+[`"']/.test(clause)
    || /\b\d+(?:\.\d+)?\s*(?:%|ms|s|bytes?|items?|files?|rows?)?\b/.test(clause)
    || /(?:<=|>=|===|!==|==|!=|<|>)/.test(clause)
    || /\b(?:at least|at most|more than|less than|equal to|greater than|within)\b/i.test(clause)
    || /\b[A-Za-z_$][\w$]*\s+(?:field|property)\b/i.test(clause)
    || /\b(?:[A-Za-z_$][\w$]*\(\)|[A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]*|[a-z]+(?:-[a-z0-9]+)+|[A-Za-z_$]+(?:[A-Z][a-z0-9]+)+|[A-Za-z_$]+(?:_[A-Za-z0-9]+)+)\b/.test(clause);
}

export function checkScenarioShape(text: string): Pick<ScenarioShapeFinding, 'clause' | 'reason'> | null {
  const lines = text.split(/\r?\n/).map(line => line.trim());
  const when = lines.find(line => /^-?\s*\*\*WHEN\*\*\s+\S/i.test(line));
  if (!when) return { reason: 'missing-when', clause: lines.find(Boolean) ?? '(empty scenario)' };
  const then = lines.find(line => /^-?\s*\*\*THEN\*\*\s+\S/i.test(line));
  if (!then) return { reason: 'missing-then', clause: when };
  if (!observableThen(then.replace(/^-?\s*\*\*THEN\*\*\s*/i, ''))) {
    return { reason: 'unobservable-then', clause: then };
  }
  return null;
}

export function lintScenarioCorpus(specs: readonly SpecLinkIndexSpecInput[]): ScenarioShapeFinding[] {
  const findings: ScenarioShapeFinding[] = [];
  for (const spec of specs) for (const requirement of parseOpenSpecRequirements(spec.content)) {
    for (const scenario of requirement.scenarios) {
      const failure = checkScenarioShape(scenario.text);
      if (failure) findings.push({
        specFile: spec.specFile,
        requirement: requirement.name,
        scenario: scenario.name,
        ...failure,
      });
    }
  }
  return findings;
}
