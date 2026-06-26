/**
 * Pure presentation + gating for task-scoped context injection
 * (change: add-task-scoped-context-injection).
 *
 * Extracted from `orient-inject.ts` so it can be reused by hosts that must NOT
 * load the analyzer in-process — notably the Pi extension, which orients through
 * a warm daemon over RPC (decision abee8e3e). Everything here is pure and
 * deterministic; its only runtime dependency is `estimateTokens`. Keep it that
 * way — importing the analyzer (`handleOrient`) or config I/O here would drag the
 * analyzer back into the Pi host process the daemon split exists to keep lean.
 *
 * The block is framed as facts-not-coercion (Epistemic Lease, decision 8e95746d)
 * and capped by a token budget so it can never dominate the context it economizes.
 */

import { estimateTokens } from '../../core/services/llm-service.js';
import type { ContextInjectionConfig } from '../../types/index.js';

/** Injection settings with every documented default applied. */
export interface ResolvedInjectionConfig {
  mode: 'off' | 'task-scoped';
  tokenBudget: number;
  relevanceMinMatches: number;
  relevanceMinFanIn: number;
  relevanceMinScore: number;
}

/** Documented defaults — used when `.openlore/config.json` omits `contextInjection`. */
export const INJECTION_DEFAULTS: ResolvedInjectionConfig = {
  mode: 'task-scoped',
  tokenBudget: 600,
  relevanceMinMatches: 2,
  relevanceMinFanIn: 2,
  relevanceMinScore: 0.3,
};

/**
 * The single pointer line emitted whenever a full block is not warranted
 * (weak match, no graph, error, or empty prompt). Informational, not coercive.
 */
export const POINTER_LINE =
  '[OpenLore] Structural context is available — call `orient` with your task for a deterministic ' +
  'briefing (relevant functions, callers, insertion points). Informational; ignore if not useful.';

/** One-line framing prefix on the full block — facts, never an instruction. */
const BLOCK_HEADER =
  '[OpenLore] Task-scoped orientation (deterministic, from the local call graph). ' +
  'Informational — act on it or ignore it.';

const BLOCK_FOOTER = '(From OpenLore. Call `orient` for the full briefing, or ignore this.)';

/** Apply documented defaults over a partial config block. */
export function resolveInjectionConfig(ci: ContextInjectionConfig | undefined): ResolvedInjectionConfig {
  return {
    mode: ci?.mode ?? INJECTION_DEFAULTS.mode,
    tokenBudget:
      typeof ci?.tokenBudget === 'number' && ci.tokenBudget > 0
        ? ci.tokenBudget
        : INJECTION_DEFAULTS.tokenBudget,
    relevanceMinMatches:
      typeof ci?.relevanceMinMatches === 'number' && ci.relevanceMinMatches >= 0
        ? ci.relevanceMinMatches
        : INJECTION_DEFAULTS.relevanceMinMatches,
    relevanceMinFanIn:
      typeof ci?.relevanceMinFanIn === 'number' && ci.relevanceMinFanIn >= 0
        ? ci.relevanceMinFanIn
        : INJECTION_DEFAULTS.relevanceMinFanIn,
    relevanceMinScore:
      typeof ci?.relevanceMinScore === 'number' && ci.relevanceMinScore >= 0
        ? ci.relevanceMinScore
        : INJECTION_DEFAULTS.relevanceMinScore,
  };
}

// These shapes mirror the lean `handleOrient` result, which reaches us through
// an unchecked `as` cast (the handler — or the Pi daemon's `orient` tool —
// returns `unknown`). Fields that should be present are typed optional so the
// renderer's defensive guards against a partial/forward-incompatible payload are
// type-checked, not lint noise.
interface OrientFn {
  name?: string;
  filePath?: string;
  score?: number;
  fanIn?: number;
  fanOut?: number;
  isHub?: boolean;
}

interface CallNeighbour {
  name?: string;
  filePath?: string;
}

interface OrientCallPath {
  function?: string;
  callers?: CallNeighbour[];
  callees?: CallNeighbour[];
}

/** Compact house-style summary for the touched region (change: add-codebase-style-fingerprint). */
interface RegionStyle {
  scope?: string;
  language?: string;
  communityId?: string;
  dominantIdioms?: string[];
}

export interface LeanOrientResult {
  task?: string;
  searchMode?: string;
  error?: string;
  relevantFiles?: string[];
  relevantFunctions?: OrientFn[];
  specDomains?: string[];
  callPaths?: OrientCallPath[];
  suggestedTools?: string[];
  regionStyle?: RegionStyle;
}

/**
 * Deterministic orientation-relevance gate. Returns true when the task has a
 * substantial, structurally-connected match in the graph — the case where a
 * full briefing pays for itself. Otherwise the caller emits the pointer line,
 * keeping injection out of the small/familiar/shallow arena the scorecard shows
 * OpenLore should not tax.
 *
 * Signals are read off the lean orient result itself (no new analysis pass):
 *   1. matched-function count >= relevanceMinMatches, AND
 *   2. structural centrality — a match with fan-in >= relevanceMinFanIn, or a
 *      hub — OR, only on the bounded semantic/hybrid score scale, a top match
 *      score >= relevanceMinScore.
 *
 * BM25-fallback scores live on an unbounded, corpus-relative scale, so the score
 * path is disabled there and the gate relies on count + structural centrality —
 * which keeps a strong structural match from being gated out when embeddings are
 * unavailable, without letting an arbitrary BM25 magnitude wave everything through.
 */
export function passesRelevanceGate(result: LeanOrientResult, cfg: ResolvedInjectionConfig): boolean {
  if (result.error) return false;
  const fns = result.relevantFunctions ?? [];
  if (fns.length < cfg.relevanceMinMatches) return false;

  const maxFanIn = fns.reduce((m, f) => Math.max(m, f.fanIn ?? 0), 0);
  const anyHub = fns.some(f => f.isHub === true);
  if (anyHub || maxFanIn >= cfg.relevanceMinFanIn) return true;

  // Score is only comparable to a fixed threshold on the bounded hybrid scale.
  if (result.searchMode === 'hybrid') {
    const maxScore = fns.reduce((m, f) => Math.max(m, f.score ?? 0), 0);
    return maxScore >= cfg.relevanceMinScore;
  }
  return false;
}

/** Take the first `n` graph-clean entries; tolerate undefined. */
function take<T>(arr: T[] | undefined, n: number): T[] {
  return (arr ?? []).slice(0, n);
}

/**
 * Render the full injection block from a lean orient result, hard-capped to the
 * token budget. The header, framing, and task line are mandatory (a small fixed
 * floor that is always present so an injected block is unambiguously attributed
 * and ignorable); detail lines are added in priority order (functions → files →
 * call neighbours → specs → tools) only while they fit, so the data — regardless
 * of match size — never pushes the block over budget.
 *
 * Every interpolated field is defensively filtered: although `handleOrient`
 * declares its name/file fields as required strings, a partial/forward-incompat
 * result must never leak a literal `undefined`, `[object Object]`, or a stray
 * leading comma into the agent's context.
 */
export function renderInjectionBlock(result: LeanOrientResult, cfg: ResolvedInjectionConfig): string {
  const task = (result.task ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
  const mandatory = [BLOCK_HEADER, `Task: ${task}`];

  const optional: string[] = [];
  const clean = (xs: Array<string | undefined> | undefined, n: number): string[] =>
    (xs ?? []).filter((x): x is string => typeof x === 'string' && x.length > 0).slice(0, n);

  const fns = take(result.relevantFunctions, 8).filter(f => f.name && f.filePath);
  if (fns.length > 0) {
    optional.push('Relevant functions:');
    for (const f of fns) optional.push(`  • ${f.name} — ${f.filePath}`);
  }

  const files = clean(result.relevantFiles, 8);
  if (files.length > 0) optional.push(`Relevant files: ${files.join(', ')}`);

  // House style for the area in scope — the payoff of the style fingerprint on the Pi surface, so
  // an agent matches the local idioms without a second tool call. One bounded, budget-gated line;
  // defensively filtered against a partial payload (change: add-codebase-style-fingerprint).
  const rs = result.regionStyle;
  const idioms = clean(rs?.dominantIdioms, 4);
  if (rs && idioms.length > 0) {
    const lang = typeof rs.language === 'string' ? rs.language : 'code';
    const scope = rs.scope === 'repository' ? 'repo' : 'region';
    optional.push(`House style (${lang}, ${scope}): ${idioms.join(', ')}`);
  }

  const names = (ns: CallNeighbour[] | undefined): string =>
    [...new Set((ns ?? []).map(n => n?.name).filter((x): x is string => typeof x === 'string' && x.length > 0))]
      .slice(0, 3)
      .join(', ');
  const paths = take(result.callPaths, 5).filter(p => p.function);
  const pathLines: string[] = [];
  for (const p of paths) {
    const callers = names(p.callers);
    const callees = names(p.callees);
    const parts: string[] = [];
    if (callers) parts.push(`← ${callers}`);
    if (callees) parts.push(`→ ${callees}`);
    if (parts.length > 0) pathLines.push(`  ${p.function}: ${parts.join('  ')}`);
  }
  if (pathLines.length > 0) {
    optional.push('Call neighbours:');
    optional.push(...pathLines);
  }

  const specs = clean(result.specDomains, 8);
  if (specs.length > 0) optional.push(`Spec domains: ${specs.join(', ')}`);

  const tools = clean(result.suggestedTools, 6);
  if (tools.length > 0) optional.push(`Suggested tools: ${tools.join(', ')}`);

  optional.push(BLOCK_FOOTER);

  // Greedily include optional lines while the whole block stays within budget.
  const lines = [...mandatory];
  for (const line of optional) {
    if (estimateTokens([...lines, line].join('\n')) > cfg.tokenBudget) break;
    lines.push(line);
  }
  return lines.join('\n');
}
