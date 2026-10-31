/**
 * verify_change — the deterministic verification feedback loop (change: add-verification-feedback-loop).
 *
 * Composes the existing diff-based conclusions into ONE ordered, actionable receipt: what the
 * change breaks, who it affects, and which tests to run — each item with its subject, the check
 * that produced it, a severity, and a single next action. It performs no new analysis and invents
 * no finding codes; it projects the signals its component conclusions already compute.
 *
 * Today it composes `blast_radius` — which itself already composes `select_tests` (tests to run)
 * and the spec/memory/decision drift passes — plus `structural_diff` (removed / re-signed functions
 * and new calls into deprecated code), the generated-file guard (`generated-file-edited`: a
 * generated file or lockfile edited without its source; change: add-generated-file-guard), and the
 * phantom-reference check (imports, named exports, and packages the diff adds that resolve to
 * nothing; change: add-phantom-reference-findings). It is advisory, read-only, offline, and grader-not-author:
 * it names the tests to run and the breaks to fix; it never runs the tests or edits a file.
 *
 * NoRedundantConclusions: each component still answers its own question. verify_change only
 * assembles their answers for one diff into one next-action list.
 */

import { computeBlastRadius, type BlastRadiusBriefing } from './blast-radius.js';
import { handleStructuralDiff } from './structural-diff.js';
import { validateDirectory } from './utils.js';
import { guardDiff, type DiffGuardResult } from '../generated-file-guard.js';
import { checkPhantomReferences, type PhantomReferenceResult } from '../phantom-references.js';
import { readOpenLoreConfig } from '../config-manager.js';
import { classifyFindings, effectivePolicy, type ClassifiedFinding, type EnforcementPolicy } from './enforcement-policy.js';

type Severity = 'critical' | 'error' | 'warning' | 'info';
const SEVERITY_RANK: Record<Severity, number> = { critical: 0, error: 1, warning: 2, info: 3 };
const RISK_TO_SEVERITY: Record<string, Severity> = {
  critical: 'critical', high: 'error', medium: 'warning', low: 'info', none: 'info',
};

/** One actionable line of the receipt. */
export interface ReceiptItem {
  subject: string;
  /** The component check that produced this item. */
  check: string;
  severity: Severity;
  /** The single next action for the agent or human. */
  nextAction: string;
}

export interface VerifyChangeInput {
  directory: string;
  baseRef?: string;
}

const DEFAULT_ITEM_CAP = 25;

/** The one next action for each phantom-reference code; the finding message carries the evidence. */
const NEXT_ACTION_BY_CODE: Record<string, string> = {
  'unresolved-internal-import': 'No file is at that path; create the module or correct the import.',
  'unresolved-internal-symbol': 'The target does not export that name; export it there, or import a name it does export.',
  'undeclared-dependency': 'No manifest declares that package; add it to the manifest, or use one that is declared.',
  'unpinned-dependency': 'The lockfile does not pin it; run the package manager so the lockfile matches the manifest.',
};

interface StructuralDiffShape {
  summary?: { removedFunctions?: number; signatureChanges?: number; deprecatedCallsAdded?: number };
  removed?: Array<{ name?: string; file?: string }>;
  signatureChanged?: Array<{ name?: string; file?: string }>;
  deprecatedCalls?: { added?: Array<{ callerName?: string; calleeName?: string; file?: string }> };
  error?: string;
}

/**
 * Project a blast-radius briefing and a structural diff into the ordered, severity-ranked receipt.
 * Pure (no I/O) so the projection is tested with synthetic inputs, not only via a real diff.
 */
export function projectVerifyReceipt(
  b: BlastRadiusBriefing,
  sd: StructuralDiffShape,
  guard?: DiffGuardResult | { error: string },
  policy?: EnforcementPolicy,
  references?: PhantomReferenceResult | { error: string },
): Record<string, unknown> {
  const items: ReceiptItem[] = [];
  const boundaries: string[] = [...b.caveats];

  // ── Affected / risk (blast_radius) ──
  if (b.impact.highestRiskLevel !== 'none' && b.impact.maxAffectedCallers > 0) {
    items.push({
      subject: `${b.changed.symbols} changed symbol(s), up to ${b.impact.maxAffectedCallers} affected caller(s)`,
      check: 'blast_radius',
      severity: RISK_TO_SEVERITY[b.impact.highestRiskLevel] ?? 'warning',
      nextAction: b.impact.layersCrossed.length
        ? `Review callers across layers: ${b.impact.layersCrossed.join(', ')}.`
        : 'Review the affected callers before landing.',
    });
  }
  for (const hub of b.impact.hubsTouched.slice(0, 5)) {
    items.push({
      subject: `hub ${hub.symbol} (fan-in ${hub.fanIn})`,
      check: 'blast_radius',
      severity: 'warning',
      nextAction: 'A high-fan-in hub changed; re-check its dependants.',
    });
  }

  // ── Structural delta (structural_diff): removed / re-signed functions, deprecated calls ──
  if (sd.error) {
    boundaries.push(`structural_diff unavailable: ${sd.error}`);
  } else {
    for (const r of sd.removed ?? []) {
      items.push({
        subject: `removed ${r.name ?? '?'}${r.file ? ` (${r.file})` : ''}`,
        check: 'structural_diff',
        severity: 'error',
        nextAction: 'A function was removed; confirm no caller still references it.',
      });
    }
    for (const s of sd.signatureChanged ?? []) {
      items.push({
        subject: `signature changed: ${s.name ?? '?'}${s.file ? ` (${s.file})` : ''}`,
        check: 'structural_diff',
        severity: 'warning',
        nextAction: 'A signature changed; re-check every call site.',
      });
    }
    for (const d of sd.deprecatedCalls?.added ?? []) {
      items.push({
        subject: `new call into deprecated ${d.calleeName ?? '?'} from ${d.callerName ?? '?'}`,
        check: 'structural_diff',
        severity: 'info',
        nextAction: 'Avoid adding calls into deprecated code; use the documented replacement.',
      });
    }
  }

  // ── Generated files edited by hand (generated-file guard) ──
  // Classified by the operator's enforcement.policy; a code set to `off` is dropped entirely.
  const guardGate = guard && !('error' in guard) && guard.findings.length ? classifyFindings(guard.findings, policy) : undefined;
  const guardFindings: ClassifiedFinding[] = guardGate ? guardGate.classified.filter(f => f.enforcementClass !== 'off') : [];
  if (guard && 'error' in guard) boundaries.push(`generated-file guard unavailable: ${guard.error}`);
  else if (guard) boundaries.push(...guard.boundaries);
  const factsByFile = new Map((guard && !('error' in guard) ? guard.facts : []).map(f => [f.file, f]));
  for (const f of guardFindings) {
    const fact = factsByFile.get(f.subject);
    const sources = fact && fact.generatedFrom !== 'unknown' ? fact.generatedFrom : [];
    const regen = fact && fact.regenerateWith !== 'unknown' ? fact.regenerateWith : null;
    items.push({
      subject: f.message,
      check: 'generated_file_guard',
      severity: f.severity,
      nextAction: fact?.kind === 'lockfile'
        ? 'A lockfile changed without its manifest; confirm the change came from the package manager.'
        : sources.length && fact?.sourceNotFound?.length !== sources.length
          ? `Edit ${sources.join(', ')}${regen ? ` and regenerate with \`${regen}\`` : ' and regenerate'}; a hand edit here is lost on the next generator run.`
          : sources.length
            ? `The header names ${sources.join(', ')}, which is not at that path; find that source, edit it, and regenerate${regen ? ` with \`${regen}\`` : ''}.`
            : regen
              ? `The source is unknown; regenerate with \`${regen}\` instead of editing by hand, or confirm the hand edit survives it.`
              : 'The source is unknown; confirm the hand edit survives the next generator run.',
    });
  }

  // ── References the diff adds that resolve to nothing (phantom-reference check) ──
  const refsOk = references && !('error' in references) ? references : undefined;
  if (references && 'error' in references) boundaries.push(`reference check unavailable: ${references.error}`);
  else if (refsOk) boundaries.push(...refsOk.boundaries);
  const refGate = refsOk && refsOk.findings.length ? classifyFindings(refsOk.findings, policy) : undefined;
  const refFindings: ClassifiedFinding[] = refGate ? refGate.classified.filter(f => f.enforcementClass !== 'off') : [];
  for (const f of refFindings) {
    items.push({
      subject: f.message,
      check: 'phantom_references',
      severity: f.severity,
      nextAction: NEXT_ACTION_BY_CODE[f.code] ?? 'The reference resolves to nothing; correct it before landing.',
    });
  }
  // A reference that could not be judged is said once, with its count — never read as resolved.
  if (refsOk && refsOk.notAssessed.length) {
    boundaries.push(`${refsOk.notAssessed.length} added reference${refsOk.notAssessed.length === 1 ? '' : 's'} could not be assessed (${[...new Set(refsOk.notAssessed.map(n => n.reason))].slice(0, 3).join('; ')}).`);
  }

  // ── Spec drift (composed inside blast_radius) ──
  for (const s of b.specs.items.slice(0, 10)) {
    items.push({
      subject: s.domain ? `${s.domain}: ${s.message}` : s.message,
      check: 'check_spec_drift',
      severity: 'warning',
      nextAction: 'A requirement may go stale; update the spec or re-check drift.',
    });
  }

  // ── Ordering + budget ──
  items.sort((a, z) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[z.severity]);
  const kept = items.slice(0, DEFAULT_ITEM_CAP);
  const omitted = items.length - kept.length;

  // ── Tests to run (select_tests, composed inside blast_radius) ──
  const testsToRun = b.tests.unavailable
    ? { unavailable: b.tests.unavailable }
    : { count: b.tests.count, toRun: b.tests.toRun };

  if (b.baseRefFallback) {
    boundaries.push(`base ref '${b.baseRefFallback.requested}' did not resolve; diffed against '${b.baseRefFallback.resolved}'.`);
  }
  if (b.confidenceBoundary) {
    boundaries.push('The index is behind the working tree; this receipt is a lower bound until re-analyze.');
  }

  const highest = kept[0]?.severity ?? 'info';
  return {
    tool: 'verify_change',
    posture: 'advisory',
    baseRef: b.baseRef,
    resolvedBaseRef: b.resolvedBaseRef,
    summary: {
      changedFiles: b.changed.files,
      changedSymbols: b.changed.symbols,
      actionItems: items.length,
      highestSeverity: highest,
      removedFunctions: sd.summary?.removedFunctions ?? 0,
      signatureChanges: sd.summary?.signatureChanges ?? 0,
      deprecatedCallsAdded: sd.summary?.deprecatedCallsAdded ?? 0,
      generatedFilesEdited: guardFindings.length,
      unresolvedReferences: refFindings.length,
    },
    items: kept,
    ...(omitted > 0 ? { truncated: { omitted, note: 'Lower-severity items omitted; raise the cap to see them.' } } : {}),
    testsToRun,
    // Registered governance findings (GovernanceFinding shape) an enforcement policy can name.
    ...(guardFindings.length || refFindings.length
      ? { findings: [...guardFindings, ...refFindings], gated: (guardGate?.gated ?? false) || (refGate?.gated ?? false) }
      : {}),
    // The guard's disclosures can also reach blast_radius's caveats: say each once.
    boundaries: [...new Set(boundaries)],
    // Grader, not author: these are actions for the caller to take — nothing was run or written.
    note: 'Advisory receipt. verify_change names the tests to run and the breaks to fix; it runs no tests and edits no files.',
  };
}

/**
 * Build the ordered verification receipt for a diff. Returns a conclusion-shaped object; a failed
 * blast-radius computation (e.g. an unresolvable base) is returned as an error, not a partial pass.
 */
export async function handleVerifyChange(
  input: VerifyChangeInput,
): Promise<Record<string, unknown>> {
  // The guard runs inside blast_radius on the same diff read; its result is reused, not recomputed.
  let shared: DiffGuardResult | undefined;
  let sharedRefs: PhantomReferenceResult | undefined;
  const briefing = await computeBlastRadius(
    { directory: input.directory, baseRef: input.baseRef },
    { guard: g => { shared = g; }, references: r => { sharedRefs = r; } },
  );
  if ('error' in briefing) {
    return { tool: 'verify_change', posture: 'advisory', error: briefing.error };
  }
  const b = briefing as BlastRadiusBriefing;
  let references: PhantomReferenceResult | { error: string };
  try {
    references = sharedRefs ?? await checkPhantomReferences(await validateDirectory(input.directory), b.resolvedBaseRef);
  } catch (err) {
    references = { error: err instanceof Error ? err.message : String(err) };
  }
  const sd = (await handleStructuralDiff({ directory: input.directory, baseRef: input.baseRef })) as StructuralDiffShape;
  // Best-effort like the other components: a failed guard is a boundary, never a failed receipt.
  let guard: DiffGuardResult | { error: string };
  try {
    guard = shared ?? await guardDiff(await validateDirectory(input.directory), b.resolvedBaseRef);
  } catch (err) {
    guard = { error: err instanceof Error ? err.message : String(err) };
  }
  let policy: EnforcementPolicy | undefined;
  try {
    policy = effectivePolicy(await readOpenLoreConfig(await validateDirectory(input.directory)));
  } catch {
    policy = undefined; // an unreadable config is "no policy declared": source defaults apply
  }
  return projectVerifyReceipt(b, sd, guard, policy, references);
}
