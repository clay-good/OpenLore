/**
 * Pure presentation + gating for task-scoped context injection
 * (changes: add-task-scoped-context-injection,
 * fix-inject-relevance-gate-keyword-mode).
 *
 * Extracted from `orient-inject.ts` so it can be reused by hosts that must NOT
 * load the analyzer in-process — notably the Pi extension, which orients through
 * a warm daemon over RPC (decision abee8e3e). Everything here is pure and
 * deterministic; its runtime dependencies are dependency-light pure helpers.
 * Keep it that way — importing the analyzer (`handleOrient`) or config I/O here would drag the
 * analyzer back into the Pi host process the daemon split exists to keep lean.
 *
 * The block is framed as facts-not-coercion (Epistemic Lease, decision 8e95746d)
 * and capped by a token budget so it can never dominate the context it economizes.
 */

import { estimateTokens } from '../../core/services/llm-service.js';
import { frameServedContent, type ServedContentProvenance } from '../../core/services/served-content.js';
import { tokenize } from '../../core/analyzer/bm25-tokenizer.js';
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

/** Smallest budget that can carry the framed task and a factual stale-index line. */
export const MIN_INJECTION_TOKEN_BUDGET = 68;

/**
 * The single pointer line emitted whenever a full block is not warranted
 * (weak match, no graph, error, or empty prompt). Informational, not coercive.
 */
export const POINTER_LINE =
  '[OpenLore] Structural context is available — call `orient` with your task for a deterministic ' +
  'briefing (relevant functions, callers, insertion points). Informational; ignore if not useful.';

const BLOCK_FOOTER = '(From OpenLore. Call `orient` for the full briefing, or ignore this.)';

/** Apply documented defaults over a partial config block. */
export function resolveInjectionConfig(ci: ContextInjectionConfig | undefined): ResolvedInjectionConfig {
  return {
    mode: ci?.mode ?? INJECTION_DEFAULTS.mode,
    tokenBudget:
      typeof ci?.tokenBudget === 'number' && ci.tokenBudget > 0
        ? Math.max(MIN_INJECTION_TOKEN_BUDGET, ci.tokenBudget)
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
  provenance?: ServedContentProvenance;
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
  specDomains?: Array<string | { domain?: string; provenance?: ServedContentProvenance }>;
  callPaths?: OrientCallPath[];
  suggestedTools?: string[];
  regionStyle?: RegionStyle;
  parseHealth?: string;
  indexStaleness?: {
    staleFiles?: string[];
    note?: string;
    repairScheduled?: true;
  };
  servedContentProvenance?: {
    relevantFiles?: ServedContentProvenance;
    relevantFunctions?: ServedContentProvenance;
    specDomains?: ServedContentProvenance;
    callPaths?: ServedContentProvenance;
  };
}

export interface RelevanceGateEvaluation {
  passes: boolean;
  passedCriteria: string[];
  failedCriteria: string[];
}

function containsExactIdentifier(prompt: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^A-Za-z0-9_$])${escaped}($|[^A-Za-z0-9_$])`, 'i').test(prompt);
}

/**
 * Deterministic orientation-relevance gate. Returns true when the task has a
 * substantial, structurally-connected match in the graph — the case where a
 * full briefing pays for itself. Otherwise the caller emits the pointer line,
 * keeping injection out of the small/familiar/shallow arena the scorecard shows
 * OpenLore should not tax.
 *
 * Signals are read off the lean orient result itself (no new analysis pass).
 * An exact identifier mention passes directly. Otherwise the matched-function
 * count must reach relevanceMinMatches and one of structural centrality, a
 * bounded hybrid score, or scale-free keyword rank evidence must pass.
 *
 * BM25-fallback scores live on an unbounded, corpus-relative scale, so the score
 * path is disabled there. Exact identifier and rank evidence make keyword mode
 * decidable without letting an arbitrary BM25 magnitude wave everything through.
 */
export function evaluateRelevanceGate(
  result: LeanOrientResult,
  cfg: ResolvedInjectionConfig,
): RelevanceGateEvaluation {
  if (result.error) {
    return { passes: false, passedCriteria: [], failedCriteria: ['orient-error'] };
  }
  const fns = Array.isArray(result.relevantFunctions)
    ? result.relevantFunctions.filter((f): f is OrientFn => !!f && typeof f === 'object')
    : [];
  const enoughMatches = fns.length >= cfg.relevanceMinMatches;

  const task = typeof result.task === 'string' ? result.task : '';
  const promptTokens = new Set(tokenize(task));
  const exactIdentifierMention = fns.some(f => {
    const name = typeof f.name === 'string' ? f.name.trim() : '';
    return !!name && containsExactIdentifier(task, name);
  });

  const maxFanIn = fns.reduce((m, f) => Math.max(m, f.fanIn ?? 0), 0);
  const anyHub = fns.some(f => f.isHub === true);
  const structuralCentrality = anyHub || maxFanIn >= cfg.relevanceMinFanIn;

  // Score is only comparable to a fixed threshold on the bounded hybrid scale.
  const maxScore = fns.reduce((m, f) => Math.max(m, f.score ?? 0), 0);
  const hybridScore = result.searchMode === 'hybrid' && maxScore >= cfg.relevanceMinScore;

  // Raw BM25 scores are unbounded and corpus-relative, so keyword mode uses
  // scale-free rank evidence: an identifier token from the top-ranked match.
  const topIdentifierTokens = tokenize(typeof fns[0]?.name === 'string' ? fns[0].name : '');
  const keywordMode = result.searchMode === 'bm25_fallback' || result.searchMode === 'keyword';
  const keywordRankEvidence = keywordMode
    && topIdentifierTokens.some(token => promptTokens.has(token));

  const criteria: Record<string, boolean> = {
    'minimum-matches': enoughMatches,
    'exact-identifier': exactIdentifierMention,
    'structural-centrality': structuralCentrality,
  };
  if (result.searchMode === 'hybrid') criteria['hybrid-score'] = hybridScore;
  if (keywordMode) criteria['keyword-rank-evidence'] = keywordRankEvidence;
  const passedCriteria = Object.entries(criteria).filter(([, passed]) => passed).map(([name]) => name);
  const failedCriteria = Object.entries(criteria).filter(([, passed]) => !passed).map(([name]) => name);
  return {
    passes: exactIdentifierMention || (enoughMatches && (structuralCentrality || hybridScore || keywordRankEvidence)),
    passedCriteria,
    failedCriteria,
  };
}

export function passesRelevanceGate(result: LeanOrientResult, cfg: ResolvedInjectionConfig): boolean {
  return evaluateRelevanceGate(result, cfg).passes;
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
  const task = (typeof result.task === 'string' ? result.task : '').replace(/\s+/g, ' ').trim().slice(0, 200);
  const sourceProvenance = result.servedContentProvenance?.relevantFunctions
    ?? result.relevantFunctions?.find(f => f.provenance)?.provenance
    ?? 'source-derived';
  const specProvenance = result.servedContentProvenance?.specDomains
    ?? result.specDomains?.find((s): s is { domain?: string; provenance?: ServedContentProvenance } => typeof s === 'object')?.provenance
    ?? 'local-unreviewed';
  const baseProvenances: ServedContentProvenance[] = ['local-unreviewed', sourceProvenance];
  const mandatory = [`Task: ${task}`];
  if (typeof result.indexStaleness?.note === 'string') {
    // Mandatory-line priority (change: disclose-stale-serving-on-cold-reads):
    // this factual boundary must survive before any function/caller/spec detail.
    // Collapse whitespace defensively so an artifact-controlled filename cannot
    // forge a second injected line.
    const freshnessLine = result.indexStaleness.note.replace(/\s+/g, ' ').trim();
    const staleFiles = (result.indexStaleness.staleFiles ?? [])
      .filter((file): file is string => typeof file === 'string' && file.length > 0);
    const repair = result.indexStaleness.repairScheduled === true ? ' Repair has been scheduled.' : '';
    const omitted = staleFiles.length > 1 ? `, and ${staleFiles.length - 1} more` : '';
    const compactFile = (file: string, limit: number): string => {
      const singleLine = file.replace(/[\s\u2028\u2029]+/g, ' ').trim();
      return singleLine.length > limit ? `${singleLine.slice(0, Math.max(1, limit - 1))}…` : singleLine;
    };
    const summaries = [200, 100, 50].map((limit) => {
      const first = staleFiles[0];
      const shown = first
        ? JSON.stringify(compactFile(first, limit))
        : 'cited source files';
      return `⚠ The index is behind the working tree for: ${shown}${omitted}; results may omit recent edits.${repair}`;
    });
    const terse = [24, 12, 6].map((limit) => {
      const first = staleFiles[0];
      const shown = first
        ? JSON.stringify(compactFile(first, limit))
        : 'cited files';
      const more = staleFiles.length > 1 ? ` (+${staleFiles.length - 1})` : '';
      return `⚠ Stale index: ${shown}${more}; may omit edits.${repair}`;
    });
    const namedFloor = staleFiles[0]
      ? `⚠ ${JSON.stringify(compactFile(staleFiles[0], 8))} stale; may omit edits.${
        result.indexStaleness.repairScheduled === true ? ' Repair scheduled.' : ''
      }`
      : `⚠ Stale index; may omit edits.${repair}`;
    const candidates = [
      ...(freshnessLine ? [`⚠ ${freshnessLine}`] : []),
      ...summaries,
      ...terse,
      namedFloor,
      `⚠ Stale index; may omit edits.${repair}`,
    ];
    const taskLines = [
      mandatory[0],
      `Task: ${task.length > 40 ? `${task.slice(0, 39)}…` : task}`,
      'Task: …',
    ];
    let fitted: { taskLine: string; warning: string } | undefined;
    for (const warning of candidates) {
      const taskLine = taskLines.find((line) => estimateTokens(frameServedContent(
        [line, warning].join('\n'),
        baseProvenances,
        'task-scoped orientation',
      )) <= cfg.tokenBudget);
      if (taskLine) {
        fitted = { taskLine, warning };
        break;
      }
    }
    mandatory[0] = fitted?.taskLine ?? 'Task: …';
    mandatory.push(fitted?.warning ?? namedFloor);
  }

  const optional: string[] = [];
  const clean = (xs: Array<string | undefined> | undefined, n: number): string[] =>
    (xs ?? []).filter((x): x is string => typeof x === 'string' && x.length > 0).slice(0, n);

  const fns = take(result.relevantFunctions, 8)
    .filter(f => typeof f?.name === 'string' && typeof f.filePath === 'string');
  if (fns.length > 0) {
    optional.push(`Relevant functions [${sourceProvenance}]:`);
    for (const f of fns) optional.push(`  • ${f.name} — ${f.filePath}`);
  }

  const files = clean(result.relevantFiles, 8);
  if (files.length > 0) optional.push(`Relevant files [${sourceProvenance}]: ${files.join(', ')}`);

  // Parse-health boundary — a disclosed lower-bound warning for the surfaced files, so the Pi
  // surface never lets a degraded parse read as genuine absence (change:
  // add-parse-health-boundary-disclosure).
  if (typeof result.parseHealth === 'string' && result.parseHealth.length > 0) {
    optional.push(`⚠ ${result.parseHealth}`);
  }

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
    optional.push(`Call neighbours [${sourceProvenance}]:`);
    optional.push(...pathLines);
  }

  const specs = (result.specDomains ?? [])
    .map(s => typeof s === 'string' ? s : s?.domain)
    .filter((s): s is string => typeof s === 'string' && s.length > 0)
    .slice(0, 8);
  if (specs.length > 0) {
    optional.push(`Spec domains [${specProvenance}]: ${specs.join(', ')}`);
  }

  const tools = clean(result.suggestedTools, 6);
  if (tools.length > 0) optional.push(`Suggested tools: ${tools.join(', ')}`);

  optional.push(BLOCK_FOOTER);

  // Greedily include optional lines while the whole block stays within budget.
  const lines = [...mandatory];
  for (const line of optional) {
    const candidateLines = [...lines, line];
    const candidateProvenances = candidateLines.some(l => l.startsWith('Spec domains ['))
      ? [...baseProvenances, specProvenance]
      : baseProvenances;
    const candidate = frameServedContent(candidateLines.join('\n'), candidateProvenances, 'task-scoped orientation');
    if (estimateTokens(candidate) > cfg.tokenBudget) break;
    lines.push(line);
  }
  const finalProvenances = lines.some(l => l.startsWith('Spec domains ['))
    ? [...baseProvenances, specProvenance]
    : baseProvenances;
  return frameServedContent(lines.join('\n'), finalProvenances, 'task-scoped orientation');
}
