/**
 * Call-graph soundness calibration — the precision-order (monotone-refinement) invariant
 * (change: add-callgraph-soundness-calibration).
 *
 * Deterministic, offline (CI/dogfood), ground-truth-free. It drives the existing
 * `CallGraphBuilder` with one resolution mechanism disabled and compares the result to the full
 * build, asserting the ladder is monotone:
 *
 *   - Refining mechanisms (type inference, re-export resolution): turning the mechanism OFF may
 *     only make a call site fall through to a more conservative tier. So every call site the
 *     conservative (mechanism-off) build resolves to an internal target MUST still be resolved to
 *     an internal target by the full build — the full build must never DROP a resolution the
 *     conservative one found. A drop is a non-monotone ladder bug: the more-complete config lost a
 *     real edge.
 *   - Over-approximating mechanism (CHA): enabling it may only ADD `overrides` edges. Every
 *     non-`overrides` edge MUST be identical between the CHA-off and CHA-on builds. A disturbed
 *     non-`overrides` edge means CHA perturbed directly-resolved structure.
 *
 * Nothing here runs in a serving path. Violations are returned as the registered advisory finding
 * `callgraph-precision-order-violation`; the caller (a CI job, `openlore enforce`) decides whether
 * to gate. The comparators are pure and exported so the invariant can be tested with injected
 * edge sets, not only via a real ladder bug.
 */

import { CallGraphBuilder, type CallGraphResolutionToggles } from './call-graph.js';
import type { CallEdge } from './call-graph-types.js';
import type { GovernanceFinding } from '../services/mcp-handlers/enforcement-policy.js';

export const PRECISION_ORDER_FINDING = 'callgraph-precision-order-violation';
const FINDING_SOURCE = 'callgraph-soundness';

export interface CalibrationInput {
  files: Array<{ path: string; content: string; language: string }>;
  /** A label for the analyzed tree, named in each finding's subject (e.g. 'self', a repo name). */
  repoLabel?: string;
}

const siteKey = (e: CallEdge): string => `${e.callerId}\u0000${e.calleeName}\u0000${e.line ?? ''}`;
const isDirect = (e: CallEdge): boolean =>
  (e.kind === undefined || e.kind === 'calls') && e.confidence !== 'synthesized';
const isResolvedInternal = (e: CallEdge): boolean => e.confidence !== 'external';

const finding = (subject: string, message: string): GovernanceFinding => ({
  code: PRECISION_ORDER_FINDING,
  severity: 'warning',
  source: FINDING_SOURCE,
  subject,
  message,
});

const edgeLabel = (repoLabel: string, e: CallEdge): string =>
  `${repoLabel}: ${e.callerId} -> ${e.calleeName}@${e.line ?? '?'} [${e.confidence}]`;

/**
 * Refining invariant: every call site the conservative (mechanism-off) build resolved to an
 * internal target must still be resolved internally by the full build. A drop is a violation.
 */
export function compareRefining(
  mechanism: string,
  conservative: readonly CallEdge[],
  full: readonly CallEdge[],
  repoLabel = 'repo',
): GovernanceFinding[] {
  const fullResolved = new Set<string>();
  for (const e of full) if (isDirect(e) && isResolvedInternal(e)) fullResolved.add(siteKey(e));

  const out: GovernanceFinding[] = [];
  const seen = new Set<string>();
  for (const e of conservative) {
    if (!isDirect(e) || !isResolvedInternal(e)) continue;
    const key = siteKey(e);
    if (seen.has(key)) continue;
    seen.add(key);
    if (!fullResolved.has(key)) {
      out.push(finding(
        edgeLabel(repoLabel, e),
        `Enabling ${mechanism} dropped a call edge the conservative build resolved internally ` +
          `(resolved with ${mechanism} off, unresolved/external with it on) — the resolution ` +
          `ladder is not monotone at this site.`,
      ));
    }
  }
  return out;
}

/**
 * CHA invariant: enabling CHA may only add `overrides` edges. Every non-`overrides` edge must be
 * identical between the CHA-on and CHA-off builds; any difference is a violation.
 */
export function compareCha(
  withCha: readonly CallEdge[],
  withoutCha: readonly CallEdge[],
  repoLabel = 'repo',
): GovernanceFinding[] {
  const nonOverrides = (edges: readonly CallEdge[]): Map<string, CallEdge> => {
    const m = new Map<string, CallEdge>();
    for (const e of edges) {
      if (e.kind === 'overrides') continue;
      const k = `${e.callerId}\u0000${e.calleeId}\u0000${e.calleeName}\u0000${e.line ?? ''}\u0000${e.confidence}`;
      m.set(k, e);
    }
    return m;
  };
  const on = nonOverrides(withCha);
  const off = nonOverrides(withoutCha);
  const out: GovernanceFinding[] = [];
  for (const [k, e] of off) {
    if (!on.has(k)) {
      out.push(finding(
        edgeLabel(repoLabel, e),
        'Enabling CHA removed or changed a non-overrides edge; the over-approximating pass must ' +
          'only add `overrides` edges, never perturb directly-resolved structure.',
      ));
    }
  }
  for (const [k, e] of on) {
    if (!off.has(k)) {
      out.push(finding(
        edgeLabel(repoLabel, e),
        'Enabling CHA introduced a non-overrides edge; CHA must only add `overrides` edges.',
      ));
    }
  }
  return out;
}

/** Full-ladder build plus one build per mechanism-off variant, then the monotone comparison. */
export async function calibratePrecisionOrder(
  input: CalibrationInput,
): Promise<GovernanceFinding[]> {
  const { files, repoLabel = 'repo' } = input;
  const build = (resolution?: CallGraphResolutionToggles) =>
    new CallGraphBuilder(resolution ? { resolution } : {}).build(files);

  const [full, noTypeInference, noReExport, noCha] = await Promise.all([
    build(),
    build({ typeInference: false }),
    build({ reExport: false }),
    build({ cha: false }),
  ]);

  return [
    ...compareRefining('type_inference', noTypeInference.edges, full.edges, repoLabel),
    ...compareRefining('re_export', noReExport.edges, full.edges, repoLabel),
    ...compareCha(full.edges, noCha.edges, repoLabel),
  ];
}
