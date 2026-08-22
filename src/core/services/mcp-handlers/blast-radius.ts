/**
 * Pre-flight blast-radius guard (change: add-preflight-blast-radius-guard).
 *
 * "Before I commit this diff, what does it actually touch?" The expensive
 * mistakes — changing a hub 58 callers depend on, orphaning a decision anchored
 * to a symbol you deleted, making a spec stale — are all knowable *before* the
 * edit, deterministically, from analyses OpenLore already computes. They just
 * are not surfaced at the moment they would prevent the mistake.
 *
 * This handler is PURE ORCHESTRATION: it composes existing deterministic
 * analyses — `analyze_impact` (callers / layers / hubs), `select_tests` (the
 * tests to run), and `check_spec_drift` (which already folds in anchored-memory
 * and ADR drift) over the diff returned by `getChangedFiles`. It adds no new
 * structural computation and runs no LLM (north star `c6d1ad07`). The result is
 * a single conclusion-shaped briefing — counts and named risks — never a graph.
 *
 * It is advisory by definition: the briefing informs, the agent acts. The
 * non-blocking git hook and opt-in blocking live in `cli/commands/blast-radius.ts`.
 */

import { validateDirectory, readCachedContext } from './utils.js';
import { seedsFromFiles, handleSelectTests } from './test-impact.js';
import { handleAnalyzeImpact } from './graph.js';
import { handleCheckSpecDrift } from './analysis.js';
import { assembleBoundary, computeStaleness } from './confidence-boundary.js';
import type { ConfidenceBoundary } from './confidence-boundary.js';
import type { SerializedCallGraph } from '../../analyzer/call-graph.js';
import type { DriftIssue, DriftResult } from '../../../types/index.js';
import { reviewedFileContentProvenance, type ServedContentProvenance } from '../served-content.js';
import { withIndexStaleness } from './index-staleness.js';

/** How many of the highest-fan-in changed symbols to run impact analysis on.
 * A briefing, not an audit: the riskiest symbols dominate the blast radius, and
 * bounding the work keeps a pre-commit hook fast. Truncation is reported, never
 * silent (mcp-quality: no-silent-truncation). */
const DEFAULT_MAX_SYMBOLS = 12;

export interface BlastRadiusInput {
  directory: string;
  /** Git ref to diff the working tree against. Default `HEAD` (uncommitted changes). */
  baseRef?: string;
  /** Impact-analysis traversal depth (forwarded to analyze_impact). Default 2. */
  depth?: number;
  /** Cap on the number of changed symbols analyzed for impact. Default 12. */
  maxSymbols?: number;
  /**
   * Opt into cross-repo (federation) scope: also evaluate consumer repos that reach a
   * call site of a changed published symbol. Forwarded verbatim to the composed
   * `select_tests`. (change: add-multi-repo-federation)
   */
  federation?: boolean;
  /** Restrict the federation scope to these registry repo names (default: all). */
  federationRepos?: string[];
}

type RiskLevel = 'low' | 'medium' | 'high' | 'critical';
const RISK_RANK: Record<RiskLevel, number> = { low: 1, medium: 2, high: 3, critical: 4 };

/** Per-symbol slice of the briefing (the riskiest changed symbols). */
interface SymbolRisk {
  symbol: string;
  file: string;
  riskLevel: RiskLevel;
  affectedCallers: number;
  fanIn: number;
  isHub: boolean;
}

/** The shape `analyze_impact` returns for a single resolved symbol (subset we read). */
interface ImpactResult {
  symbol: string;
  file: string;
  metrics: { fanIn: number; fanOut: number; isHub: boolean };
  blastRadius: { total: number; upstream: number; downstream: number; infrastructure?: number };
  riskLevel: RiskLevel;
  crossDomain?: { ecosystems: string[] };
  governingDecisions?: Array<{ id?: string; title: string; affectedDomains?: string[]; provenance?: ServedContentProvenance }>;
}

export interface BlastRadiusBriefing {
  /** The base ref the caller requested (default `HEAD`). */
  baseRef: string;
  /** The ref git actually diffed against. Differs from `baseRef` when the
   * requested ref did not resolve and resolveBaseRef fell back (main → master →
   * HEAD~1); a caveat is emitted when they differ. */
  resolvedBaseRef: string;
  changed: { files: number; symbols: number; symbolNames: string[] };
  impact: {
    highestRiskLevel: RiskLevel | 'none';
    maxAffectedCallers: number;
    hubsTouched: Array<{ symbol: string; fanIn: number }>;
    layersCrossed: string[];
    governingDecisions: string[];
    /** Additive provenance companion for the legacy title array above. */
    governingDecisionProvenance: Array<{ title: string; provenance: ServedContentProvenance }>;
    topSymbols: SymbolRisk[];
    analyzedSymbolCount: number;
    truncated?: { omitted: number; reason: string };
  };
  tests: {
    count: number;
    toRun: Array<{ test: string; file: string; confidence: string }>;
    soundness: unknown;
    /** Unmodified reachability-cap receipt from select_tests. */
    truncatedAtDepth?: number;
    /**
     * Present when test selection THREW. `count: 0` alongside this means "not
     * computed", not "no tests are impacted" — the two are different claims and a
     * pre-commit reader acts differently on each.
     */
    unavailable?: string;
  };
  memory: {
    drifted: number;
    orphaned: number;
    willDrift: Array<{ kind: string; message: string; filePath: string; provenance: ServedContentProvenance }>;
  };
  specs: {
    willGoStale: number;
    items: Array<{ kind: string; message: string; domain: string | null; specPath: string | null; provenance: ServedContentProvenance }>;
  };
  decisions: {
    affected: number;
    /** Uncapped count of `adr-orphaned` issues. The hook's block gate reads this,
     * never `items` — `items` is display-capped and could omit a triggering issue. */
    orphaned: number;
    items: Array<{ kind: string; message: string; domain: string | null; provenance: ServedContentProvenance }>;
  };
  /**
   * Cross-repo (federation) impact. `evaluated: false` carries a truthful note about
   * why nothing ran — never a claim that the shipped federation capability does not
   * exist. `evaluated: true` carries the forwarded `select_tests` federation block
   * (cross-repo tests + repos-consulted/-skipped coverage). (change:
   * fix-git-derived-signal-honesty; BriefingCapabilityClaimsAreCurrent)
   */
  federation: { evaluated: false; note: string } | ({ evaluated: true } & Record<string, unknown>);
  /** Present only when the requested base did not resolve; names both refs (fix-cli-conclusion-honesty). */
  baseRefFallback?: { requested: string; resolved: string };
  /** Index-staleness disclosure: a risk headline computed over a graph that predates the
   * working tree must say so (fix-cli-conclusion-honesty). Absent when the index is current. */
  confidenceBoundary?: ConfidenceBoundary;
  headline: string;
  posture: 'advisory';
  caveats: string[];
}

/** Normalize analyze_impact's single-or-`{matches}` return to a flat array. */
function impactResults(raw: unknown): ImpactResult[] {
  if (raw === null || typeof raw !== 'object') return [];
  if ('error' in (raw as Record<string, unknown>)) return [];
  if ('matches' in (raw as Record<string, unknown>)) {
    const m = (raw as { matches: unknown }).matches;
    return Array.isArray(m) ? (m as ImpactResult[]) : [];
  }
  return [raw as ImpactResult];
}

const SPEC_KINDS = new Set<DriftIssue['kind']>(['stale', 'gap', 'uncovered', 'orphaned-spec']);
const MEMORY_KINDS = new Set<DriftIssue['kind']>(['memory-drifted', 'memory-orphaned']);
const DECISION_KINDS = new Set<DriftIssue['kind']>(['adr-gap', 'adr-orphaned']);

/**
 * Compute the pre-flight blast-radius briefing for a diff. Read-only,
 * deterministic, offline. Exported for reuse by the CLI hook; the MCP dispatch
 * entry is {@link handleBlastRadius}.
 */
export async function computeBlastRadius(
  input: BlastRadiusInput,
): Promise<BlastRadiusBriefing | { error: string }> {
  const absDir = await validateDirectory(input.directory);
  const ctx = await readCachedContext(absDir);
  if (!ctx) return { error: 'No analysis found. Run analyze_codebase first.' };
  if (!ctx.callGraph) return { error: 'Call graph not available. Re-run analyze_codebase.' };

  const cg = ctx.callGraph as SerializedCallGraph;
  const baseRef = input.baseRef && input.baseRef.length > 0 ? input.baseRef : 'HEAD';
  const depth = Math.max(1, Math.min(input.depth ?? 2, 6));
  const maxSymbols = Math.max(1, Math.min(input.maxSymbols ?? DEFAULT_MAX_SYMBOLS, 50));

  // ── 1. Resolve the diff → changed files → seed production symbols ───────────
  let changedFiles: string[];
  // Resolve-or-disclose through the one shared helper (fix-cli-conclusion-honesty):
  // an explicit ref that git can't resolve falls back (main → master → HEAD~1) and is
  // disclosed, so the advisory briefing never misrepresents the base it diffed against.
  let resolvedBaseRef: string;
  let baseFellBack: boolean;
  try {
    const { getChangedFiles, resolveBaseRefDisclosed } = await import('../../drift/git-diff.js');
    const base = await resolveBaseRefDisclosed(absDir, baseRef);
    resolvedBaseRef = base.resolved;
    baseFellBack = base.fellBack;
    const diff = await getChangedFiles({ rootPath: absDir, baseRef: resolvedBaseRef, includeUnstaged: true });
    changedFiles = diff.files.map(f => f.path);
  } catch (err) {
    return { error: `git diff failed (base ${baseRef}): ${err instanceof Error ? err.message : String(err)}` };
  }

  // Rank by fan-in: the highest-fan-in changed symbols dominate the blast radius.
  const seeds = seedsFromFiles(cg, changedFiles).sort((a, b) => (b.fanIn ?? 0) - (a.fanIn ?? 0));
  const analyzed = seeds.slice(0, maxSymbols);

  // ── 2. Impact per top symbol (reuse analyze_impact) ─────────────────────────
  const topSymbols: SymbolRisk[] = [];
  const hubsTouched: Array<{ symbol: string; fanIn: number }> = [];
  const layers = new Set<string>();
  const governing = new Map<string, ServedContentProvenance>();
  let highestRank = 0;
  let maxAffectedCallers = 0;
  // Symbols whose impact analysis threw. `analyzedSymbolCount` is documented below as
  // authoritative, so it must count symbols actually ANALYZED, not merely attempted.
  let impactFailures = 0;

  for (const seed of analyzed) {
    // Per-symbol best-effort: one symbol whose impact analysis throws must not
    // abort the whole briefing (advisory — never block; mcp-handlers/AdvisoryByDefault).
    let raw: unknown;
    try {
      raw = await handleAnalyzeImpact(absDir, seed.name, depth);
    } catch { impactFailures++; continue; }
    const candidates = impactResults(raw);
    // Prefer the resolution whose file matches the changed seed (names can collide).
    const r = candidates.find(c => c.file === seed.filePath) ?? candidates[0];
    if (!r) continue;

    const risk = (r.riskLevel ?? 'low') as RiskLevel;
    const callers = r.blastRadius?.upstream ?? 0;
    const isHub = r.metrics?.isHub ?? false;
    topSymbols.push({ symbol: r.symbol, file: r.file, riskLevel: risk, affectedCallers: callers, fanIn: r.metrics?.fanIn ?? 0, isHub });
    if (isHub) hubsTouched.push({ symbol: r.symbol, fanIn: r.metrics?.fanIn ?? 0 });
    for (const e of r.crossDomain?.ecosystems ?? []) layers.add(e);
    for (const d of r.governingDecisions ?? []) {
      governing.set(d.title, d.provenance ?? 'local-unreviewed');
      for (const dom of d.affectedDomains ?? []) layers.add(dom);
    }
    highestRank = Math.max(highestRank, RISK_RANK[risk] ?? 0);
    maxAffectedCallers = Math.max(maxAffectedCallers, callers);
  }

  topSymbols.sort((a, b) => RISK_RANK[b.riskLevel] - RISK_RANK[a.riskLevel] || b.affectedCallers - a.affectedCallers);
  const highestRiskLevel: RiskLevel | 'none' =
    highestRank === 0 ? 'none' : (['', 'low', 'medium', 'high', 'critical'][highestRank] as RiskLevel);

  // ── 3. Tests to run (reuse select_tests over the same diff) ─────────────────
  let testCount = 0;
  let testToRun: Array<{ test: string; file: string; confidence: string }> = [];
  let testSoundness: unknown;
  let testsTruncatedAtDepth: number | undefined;
  let testsUnavailable: string | null = null;
  // Cross-repo (federation) block returned by the composed select_tests, present only
  // when federation was opted in AND a federation scope resolved.
  let federationResult: Record<string, unknown> | undefined;
  try {
    const sel = await handleSelectTests({
      directory: absDir,
      diffRef: resolvedBaseRef,
      ...(input.federation ? { federation: true } : {}),
      ...(input.federationRepos ? { federationRepos: input.federationRepos } : {}),
    }) as {
      selectedTests?: Array<{ test: string; file: string; confidence: string }>;
      soundness?: unknown;
      truncatedAtDepth?: number;
      federation?: Record<string, unknown>;
    };
    const tests = sel.selectedTests ?? [];
    testCount = tests.length;
    testToRun = tests.slice(0, 15);
    testSoundness = sel.soundness;
    testsTruncatedAtDepth = sel.truncatedAtDepth;
    federationResult = sel.federation;
  } catch (err) {
    // Tests are best-effort, but "0 tests" and "tests could not be computed" are
    // different claims and a reader acts differently on each: an unrecorded throw
    // renders as "no tests are impacted" on a hub change. Degrade to a caveat, the
    // same way the drift path below does.
    testsUnavailable = err instanceof Error ? err.message : String(err);
  }

  // ── 4. Spec / memory / decision drift (reuse check_spec_drift, one pass) ─────
  // check_spec_drift already computes anchored-memory freshness (memory-drifted /
  // memory-orphaned) and ADR drift in addition to spec staleness. We extract the
  // named issues by kind rather than re-implementing freshness — pure reuse.
  const memWillDrift: Array<{ kind: string; message: string; filePath: string; provenance: ServedContentProvenance }> = [];
  const specItems: Array<{ kind: string; message: string; domain: string | null; specPath: string | null; provenance: ServedContentProvenance }> = [];
  const decisionItems: Array<{ kind: string; message: string; domain: string | null; provenance: ServedContentProvenance }> = [];
  const specProvenance = await reviewedFileContentProvenance(absDir, 'openspec');
  let driftUnavailable: string | null = null;
  let driftFilesOmitted = 0;
  let driftRaw: unknown;
  try {
    driftRaw = await handleCheckSpecDrift(absDir, resolvedBaseRef, changedFiles, [], 'warning');
  } catch (err) {
    // Drift is best-effort: a throw degrades to "unavailable" (reported as a
    // caveat), it never aborts the briefing (advisory — never block).
    driftRaw = { error: err instanceof Error ? err.message : String(err) };
  }
  if (driftRaw && typeof driftRaw === 'object' && 'error' in driftRaw) {
    driftUnavailable = (driftRaw as { error: string }).error;
  } else {
    const drift = driftRaw as DriftResult;
    driftFilesOmitted = drift.filesOmitted;
    for (const issue of drift.issues ?? []) {
      if (MEMORY_KINDS.has(issue.kind)) memWillDrift.push({ kind: issue.kind, message: issue.message, filePath: issue.filePath, provenance: 'local-unreviewed' });
      else if (SPEC_KINDS.has(issue.kind)) specItems.push({ kind: issue.kind, message: issue.message, domain: issue.domain, specPath: issue.specPath, provenance: specProvenance });
      else if (DECISION_KINDS.has(issue.kind)) decisionItems.push({ kind: issue.kind, message: issue.message, domain: issue.domain, provenance: specProvenance });
    }
  }
  const memOrphaned = memWillDrift.filter(m => m.kind === 'memory-orphaned').length;
  const memDrifted = memWillDrift.filter(m => m.kind === 'memory-drifted').length;
  const decisionsOrphaned = decisionItems.filter(d => d.kind === 'adr-orphaned').length;

  // ── 5. Compose the conclusion-shaped briefing ───────────────────────────────
  const caveats: string[] = [
    'Blast radius is an over-approximate structural prioritizer, not a behavioral test outcome.',
    'Impact and test selection can under-select through dynamic dispatch, reflection, and DI.',
  ];
  if (baseFellBack) {
    caveats.push(`Requested base ref "${baseRef}" did not resolve; diffed against "${resolvedBaseRef}" instead (main → master → HEAD~1 fallback).`);
  }
  if (seeds.length > analyzed.length) {
    caveats.push(`Impact analyzed the ${analyzed.length} highest-fan-in changed symbols; ${seeds.length - analyzed.length} lower-risk symbols were not individually analyzed.`);
  }
  if (seeds.length > 30) {
    caveats.push(`changed.symbolNames lists the first 30 of ${seeds.length} changed symbols (count is in changed.symbols).`);
  }
  if (driftUnavailable) {
    caveats.push(`Spec/memory drift could not be evaluated: ${driftUnavailable}`);
  }
  if (driftFilesOmitted > 0) {
    caveats.push(`Spec/memory drift omitted ${driftFilesOmitted} changed file${driftFilesOmitted === 1 ? '' : 's'} after reaching its analysis limit; absence of a finding does not cover those files.`);
  }
  if (testsUnavailable) {
    caveats.push(`Tests to run could not be computed: ${testsUnavailable} — tests.count 0 means "not computed", not "none impacted".`);
  }
  if (impactFailures > 0) {
    caveats.push(`Impact analysis failed for ${impactFailures} of the ${analyzed.length} selected symbols; the risk figures below cover the ${analyzed.length - impactFailures} that succeeded.`);
  }
  // Detail lists are display-capped; report any that drop items so a reader never
  // mistakes a short list for a complete one (mcp-quality: no-silent-truncation).
  // The counts (tests.count / memory.* / specs.willGoStale / decisions.affected+orphaned /
  // impact.analyzedSymbolCount) remain authoritative and uncapped.
  const capped: string[] = [];
  if (testToRun.length < testCount) capped.push(`tests.toRun (${testToRun.length}/${testCount})`);
  if (memWillDrift.length > 20) capped.push(`memory.willDrift (20/${memWillDrift.length})`);
  if (specItems.length > 20) capped.push(`specs.items (20/${specItems.length})`);
  if (decisionItems.length > 20) capped.push(`decisions.items (20/${decisionItems.length})`);
  if (topSymbols.length > 15) capped.push(`impact.topSymbols (15/${topSymbols.length})`);
  if (capped.length > 0) {
    caveats.push(`Detail lists truncated for brevity: ${capped.join(', ')} — see the counts for totals.`);
  }

  // Index-staleness disclosure: a risk headline computed from a graph that predates
  // the working tree must say so (fix-cli-conclusion-honesty). Same shared shape the
  // certification commands emit; absent when the index is current.
  const staleness = await computeStaleness(absDir);
  const confidenceBoundary = assembleBoundary({ staleness, integrity: ctx.integrity });

  // Federation block: forward the composed select_tests result when it ran, otherwise
  // a truthful note. Never claim the shipped federation capability is unshipped
  // (BriefingCapabilityClaimsAreCurrent).
  const federationRequested = input.federation === true || (input.federationRepos?.length ?? 0) > 0;
  const federation: BlastRadiusBriefing['federation'] = federationResult
    ? { ...federationResult, evaluated: true } // evaluated wins even if the block ever carries the key
    : {
        evaluated: false,
        note: federationRequested
          ? 'Federation was requested but no cross-repo selection ran (no federation registry resolved, or no changed published symbol propagated to consumers). Use select_tests with federation:true for the detailed cross-repo diagnosis.'
          : 'Cross-repo consumers of changed published interfaces are not evaluated by this tool unless federation is opted in. Pass federation:true (optionally federationRepos), or call select_tests with federation:true.',
      };

  const briefing: BlastRadiusBriefing = {
    baseRef,
    resolvedBaseRef,
    ...(baseFellBack ? { baseRefFallback: { requested: baseRef, resolved: resolvedBaseRef } } : {}),
    ...(confidenceBoundary.complete ? {} : { confidenceBoundary }),
    changed: {
      files: changedFiles.length,
      symbols: seeds.length,
      symbolNames: seeds.slice(0, 30).map(s => s.name),
    },
    impact: {
      highestRiskLevel,
      maxAffectedCallers,
      hubsTouched: hubsTouched.sort((a, b) => b.fanIn - a.fanIn),
      layersCrossed: [...layers].sort(),
      governingDecisions: [...governing.keys()].sort(),
      governingDecisionProvenance: [...governing.entries()]
        .map(([title, provenance]) => ({ title, provenance }))
        .sort((a, b) => a.title.localeCompare(b.title)),
      topSymbols: topSymbols.slice(0, 15),
      analyzedSymbolCount: analyzed.length - impactFailures,
      ...(seeds.length > analyzed.length
        ? { truncated: { omitted: seeds.length - analyzed.length, reason: `only the ${analyzed.length} highest-fan-in symbols were analyzed` } }
        : {}),
    },
    tests: {
      count: testCount,
      toRun: testToRun,
      soundness: testSoundness,
      ...(testsTruncatedAtDepth !== undefined ? { truncatedAtDepth: testsTruncatedAtDepth } : {}),
      ...(testsUnavailable ? { unavailable: testsUnavailable } : {}),
    },
    memory: { drifted: memDrifted, orphaned: memOrphaned, willDrift: memWillDrift.slice(0, 20) },
    specs: { willGoStale: specItems.length, items: specItems.slice(0, 20) },
    decisions: { affected: decisionItems.length, orphaned: decisionsOrphaned, items: decisionItems.slice(0, 20) },
    federation,
    headline: '',
    posture: 'advisory',
    caveats,
  };
  briefing.headline = renderHeadline(briefing);
  return withIndexStaleness(absDir, briefing, ctx);
}

/** One-line conclusion summarizing the briefing. */
function renderHeadline(b: BlastRadiusBriefing): string {
  if (b.changed.files === 0) return 'No changes vs ' + b.resolvedBaseRef + ' — nothing to brief.';
  const parts: string[] = [
    `${b.changed.files} file${b.changed.files === 1 ? '' : 's'} / ${b.changed.symbols} symbol${b.changed.symbols === 1 ? '' : 's'} changed`,
  ];
  if (b.impact.highestRiskLevel !== 'none') parts.push(`highest risk: ${b.impact.highestRiskLevel}`);
  if (b.impact.hubsTouched.length > 0) parts.push(`${b.impact.hubsTouched.length} hub${b.impact.hubsTouched.length === 1 ? '' : 's'} affected`);
  // The headline is the line a reader acts on, so an uncomputed test set must appear
  // there rather than silently dropping out and reading as "no tests impacted".
  if (b.tests.unavailable) parts.push('tests to run could not be computed');
  else if (b.tests.count > 0) parts.push(`${b.tests.count} test${b.tests.count === 1 ? '' : 's'} to run`);
  const willDrift = b.memory.drifted + b.memory.orphaned;
  if (willDrift > 0) parts.push(`${willDrift} anchored memor${willDrift === 1 ? 'y' : 'ies'} will drift/orphan`);
  if (b.decisions.affected > 0) parts.push(`${b.decisions.affected} decision${b.decisions.affected === 1 ? '' : 's'} affected`);
  if (b.specs.willGoStale > 0) parts.push(`${b.specs.willGoStale} spec${b.specs.willGoStale === 1 ? '' : 's'} may go stale`);
  return parts.join('; ') + '.';
}

/** MCP dispatch entry. Returns the briefing object directly (additive-by-cast). */
export async function handleBlastRadius(input: BlastRadiusInput): Promise<unknown> {
  return computeBlastRadius(input);
}
