/**
 * MCP handler: working_set_context (change: add-working-set-context-briefing).
 *
 * Second of three in SPEC-STORE-INTEGRATION.md. Given a configured spec-store
 * binding (add-spec-store-binding) and an active change, this assembles ONE
 * deterministic, token-budgeted structural briefing spanning the change's target
 * repositories — `orient`, generalized from a single repo to the change's targets.
 *
 * It composes existing pieces only and adds NO new relevance model and NO LLM
 * (north star `c6d1ad07`):
 *   - `handleSpecStoreStatus` resolves + health-checks the binding (the single
 *     source of truth for which targets are briefable);
 *   - `handleOrient` runs task-scoped orientation against each indexed target,
 *     keyed on the change's extracted intent;
 *   - anchored-intent freshness is free: orient's `pendingDecisions` are the in-scope
 *     authoritative decisions each carrying a freshness verdict, with orphaned anchors
 *     already excluded — so the briefing flags drifted intent and withholds orphaned
 *     by construction;
 *   - the merged briefing is ranked by orient's score and bounded with the shared
 *     `applyTokenBudget` / `omissionNote` helpers (add-trust-calibrated-context-economy).
 *
 * Read-only and conclusion-shaped: it returns a briefing an agent reads in full
 * (per-target attributed items + named intent), never a raw graph. It never throws
 * for a binding/change/index problem — every problem degrades to a finding.
 */

import { existsSync, realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve, join, basename } from 'node:path';
import { validateDirectory, safeJoin } from './utils.js';
import { handleSpecStoreStatus, type SpecStoreStatusReport } from './spec-store.js';
import { handleOrient } from './orient.js';
import { applyTokenBudget, omissionNote } from './progressive.js';
import type { ServedContentProvenance } from '../served-content.js';

/** Default token budget for the whole merged briefing when none is supplied. */
const DEFAULT_WORKING_SET_BUDGET = 8_000;

/** Stable finding codes — part of the agent-facing `--json` contract. */
export type WorkingSetFindingCode =
  | 'no-binding'          // no spec-store binding is configured (info)
  | 'binding-unsound'     // the binding has blocking (error) findings; briefing may be partial
  | 'change-unspecified'  // no change id was supplied (info — nothing to brief)
  | 'change-not-found'    // the change id resolves to no proposal under the store
  | 'no-briefable-targets'// the binding has no resolved, indexed target to orient
  | 'target-not-briefable'// a declared target is unresolved/unindexed/stale → skipped
  | 'orient-unavailable'; // a target resolved + indexed but orientation returned an error

export type WorkingSetFindingSeverity = 'info' | 'warn' | 'error';

export interface WorkingSetFinding {
  code: WorkingSetFindingCode;
  severity: WorkingSetFindingSeverity;
  /** The store/target/change name the finding concerns. */
  subject: string;
  /** What is wrong (or noted), in one line. */
  message: string;
  /** A pasteable remediation. */
  remediation: string;
}

/** One briefing item: a relevant symbol, attributed to its target repository. */
export interface WorkingSetItem {
  /** The target repository this symbol lives in (per-target attribution). */
  target: string;
  provenance: ServedContentProvenance;
  name: string;
  filePath: string;
  score: number;
  /** Exact expansion handle — get_function_body(target-dir, filePath, name). */
  expand: string;
  signature?: string;
  /** Internal callers of this symbol within its target (depth-1). */
  callers: string[];
  /** Spec domains governing this symbol's file in its target. */
  specDomains: string[];
}

/** Fresh, in-scope anchored intent for a target (from orient's governingDecisions). */
export interface AnchoredIntent {
  id: string;
  title: string;
  provenance: ServedContentProvenance;
  /** The decision's status (e.g. 'verified', 'approved'). An 'approved' entry may be
   *  surfaced for sync-awareness rather than strict scope — see briefTargetFromOrient. */
  status: string;
  /** 'current' = a fresh (or, without a graph view, not-yet-verifiable) anchor;
   *  'drifted' = the anchor has moved and should be re-checked. Orphaned anchors are
   *  never surfaced (withheld upstream by orient). */
  verdict: 'current' | 'drifted';
}

export interface WorkingSetTargetBrief {
  target: string;
  /** True when orientation ran against this target's index. */
  briefed: boolean;
  /** Why the target was skipped, when `briefed` is false. */
  reason?: string;
  /** Top insertion-point candidates in this target for the change's scope. */
  insertionPoints: Array<{ name: string; filePath: string; strategy: string }>;
  /** Spec domains covering the in-scope code in this target. */
  specDomains: string[];
  /** In-scope anchored decisions/constraints with a freshness verdict. */
  anchoredIntent: AnchoredIntent[];
}

export interface WorkingSetContextReport {
  bound: boolean;
  store?: { name: string; path: string };
  change?: {
    id: string;
    /** The intent text (≤ MAX_QUERY_LENGTH) used to orient each target. */
    intent: string;
    /** Spec-delta domains the change declares it touches, if any. */
    declaredScope?: string[];
  };
  /** Per-target briefing status + insertion points + governing intent. */
  targets: WorkingSetTargetBrief[];
  /** Merged, budgeted, relevance-ranked, per-target-attributed briefing items. */
  items: WorkingSetItem[];
  /** Present when the budget dropped items — states what was omitted. */
  omissionNote?: string;
  findings: WorkingSetFinding[];
  /** True when the binding is sound and at least one target was briefed. */
  ready: boolean;
  /** Conclusion-shaped headline. */
  summary: string;
}

// ── The subset of orient's (intentionally `unknown`) result we consume. ──────
interface OrientFnView {
  name: string;
  filePath: string;
  score: number;
  expand: string;
  signature?: string;
  provenance?: ServedContentProvenance;
}
export interface OrientView {
  error?: string;
  relevantFunctions?: OrientFnView[];
  callPaths?: Array<{ function: string; filePath: string; callers?: Array<{ name: string }> }>;
  specDomains?: Array<{ domain: string; provenance?: ServedContentProvenance }>;
  insertionPoints?: Array<{ name: string; filePath: string; strategy: string }>;
  // Orient's task-relevant authoritative anchored decisions, each carrying a freshness
  // verdict. Orient EXCLUDES orphaned anchors from this set (they go to
  // `staleDecisions`, which we deliberately do not consume) and flags a moved anchor
  // with `freshness: 'drifted'` / `verify: true`. The single source of anchored intent:
  // it withholds orphaned by construction and flags drifted. (Also includes any
  // `approved`-status decisions orient surfaces for sync-awareness — see briefTargetFromOrient.)
  pendingDecisions?: Array<{ id: string; title: string; status?: string; freshness?: string; verify?: boolean; provenance?: ServedContentProvenance }>;
}

/**
 * Project ONE target's orient result into briefing items (per-target attributed)
 * plus its target brief (insertion points, spec domains, anchored intent). Pure —
 * the testable core of the per-target transformation, no I/O.
 *
 * Anchored intent comes from orient's `pendingDecisions` — the task-relevant
 * authoritative decisions, each carrying a freshness verdict: a `drifted`/`verify`
 * decision is flagged `verdict: 'drifted'`, everything else is `current`. Orphaned
 * anchors never reach this set (orient routes them to `staleDecisions`), so the
 * spec's "orphaned intent SHALL be withheld" holds by construction.
 *
 * This set is in-scope by file/domain match, plus any `approved`-status decisions
 * orient always surfaces so the agent syncs them before committing — those carry
 * `status: 'approved'`, distinguishing a sync nudge from a strictly in-scope synced
 * decision. We do NOT intersect with orient's `governingDecisions`: that field is a
 * graph-projection join built at analyze time and is empty/stale for decisions
 * recorded since the last analyze, so intersecting would drop genuinely in-scope
 * intent (verified by dogfood — governingDecisions was empty while pendingDecisions
 * correctly carried the in-scope decisions).
 */
export function briefTargetFromOrient(
  targetName: string,
  orient: OrientView,
): { items: WorkingSetItem[]; brief: WorkingSetTargetBrief } {
  const callersByFn = new Map<string, string[]>();
  for (const cp of orient.callPaths ?? []) {
    callersByFn.set(`${cp.function}::${cp.filePath}`, (cp.callers ?? []).map(c => c.name));
  }
  const fnDomains = (orient.specDomains ?? []).map(d => d.domain);

  const items: WorkingSetItem[] = (orient.relevantFunctions ?? []).map(fn => ({
    target: targetName,
    provenance: fn.provenance ?? 'source-derived',
    name: fn.name,
    filePath: fn.filePath,
    score: fn.score,
    expand: fn.expand,
    signature: fn.signature,
    callers: callersByFn.get(`${fn.name}::${fn.filePath}`) ?? [],
    specDomains: fnDomains,
  }));

  const anchoredIntent: AnchoredIntent[] = (orient.pendingDecisions ?? []).map(d => ({
    id: d.id,
    title: d.title,
    provenance: d.provenance ?? 'local-unreviewed',
    status: d.status ?? 'unknown',
    verdict: d.freshness === 'drifted' || d.verify ? 'drifted' as const : 'current' as const,
  }));

  return {
    items,
    brief: {
      target: targetName,
      briefed: true,
      insertionPoints: (orient.insertionPoints ?? []).slice(0, 3).map(ip => ({
        name: ip.name, filePath: ip.filePath, strategy: ip.strategy,
      })),
      specDomains: fnDomains,
      anchoredIntent,
    },
  };
}

/**
 * Rank merged items by structural relevance and bound them to a token budget.
 * Pure + deterministic: sort is total-ordered on (score desc, target, name,
 * filePath) so the truncation boundary is reproducible even for two same-named
 * symbols in different files of one target (no reliance on Array.sort stability).
 * Returns the kept items and how many were dropped.
 */
export function rankAndBudget(items: WorkingSetItem[], budget: number): { kept: WorkingSetItem[]; omitted: number } {
  const sorted = [...items].sort((a, b) =>
    b.score - a.score ||
    a.target.localeCompare(b.target) ||
    a.name.localeCompare(b.name) ||
    a.filePath.localeCompare(b.filePath));
  return applyTokenBudget(sorted, budget);
}

/** Canonicalize a path for presence checks, resolved relative to the home repo. */
function canonical(p: string, base: string): string {
  const abs = resolve(base, p);
  try {
    return realpathSync(abs);
  } catch {
    return abs;
  }
}

/**
 * Extract a concise orientation task (≤ MAX_QUERY_LENGTH) from a change proposal:
 * the title (first `# ` heading) plus the first paragraph of the `## Why` section
 * when present, else the proposal's opening prose. Deterministic; no LLM.
 */
export function extractIntent(proposalText: string, changeId: string): string {
  // Normalize CRLF/CR up front: every match/split below is `\n`-only, so a
  // Windows-authored proposal would otherwise lose its entire Why body.
  const text = proposalText.replace(/\r\n?/g, '\n');
  const titleMatch = text.match(/^#\s+(.+)$/m);
  const title = titleMatch ? titleMatch[1].trim() : changeId;

  // The first NON-HEADING paragraph of "## Why" (or "## What changes") is the
  // densest signal. Skipping `#`-led candidates stops an empty section from
  // spilling the next heading line (e.g. "## What changes") into the query.
  const isProse = (s: string): boolean => Boolean(s) && !s.startsWith('#') && !s.startsWith('>');
  let body = '';
  const sectionMatch = text.match(/^##\s+(?:Why|What changes)\b[^\n]*\n+([\s\S]*?)(?:\n##\s|$)/m);
  if (sectionMatch) {
    body = sectionMatch[1].split(/\n\s*\n/).map(s => s.trim()).find(isProse) ?? '';
  }
  if (!body) {
    // No recognizable (or no prose) section — take the first prose paragraph.
    body = text.split(/\n\s*\n/).map(s => s.trim()).find(isProse) ?? '';
  }
  // Collapse whitespace; markdown markup is harmless to BM25/embedding but noisy.
  const collapsed = `${title}. ${body}`.replace(/\s+/g, ' ').trim();
  // MAX_QUERY_LENGTH is 1000; stay clear of it so orient never rejects the task.
  if (collapsed.length <= 950) return collapsed;
  let sliced = collapsed.slice(0, 950).trimEnd();
  // Don't end on a lone high surrogate left dangling by the slice.
  if (/[\uD800-\uDBFF]$/.test(sliced)) sliced = sliced.slice(0, -1);
  return sliced;
}

/** Find the change directory under a store path; returns its proposal text + declared scope. */
async function readChange(
  storeDir: string,
  changeId: string,
): Promise<{ proposal: string; declaredScope: string[] } | null> {
  // SECURITY: `changeId` is orchestrator/agent input. Without confinement, a value
  // like "../../../secret" escapes the store and turns this read into an arbitrary
  // `proposal.md` disclosure primitive. `safeJoin` confines (symlink-aware) to the
  // store and THROWS on escape; the handler contract is no-throw, so an escape is
  // caught and degraded to "no such change under the store" (change-not-found).
  let changeDir: string;
  try {
    changeDir = safeJoin(storeDir, join('openspec', 'changes', changeId));
  } catch {
    return null;
  }
  const proposalPath = join(changeDir, 'proposal.md');
  if (!existsSync(proposalPath)) return null;
  let proposal: string;
  try {
    proposal = await readFile(proposalPath, 'utf-8');
  } catch {
    return null;
  }
  // Declared touched areas = the spec-delta domains under the change's specs/ dir.
  const declaredScope: string[] = [];
  const specsDir = join(changeDir, 'specs');
  if (existsSync(specsDir)) {
    try {
      const { readdirSync } = await import('node:fs');
      for (const e of readdirSync(specsDir, { withFileTypes: true })) {
        if (e.isDirectory()) declaredScope.push(e.name);
      }
    } catch {
      // declaredScope is additive — a read failure just omits it
    }
  }
  return { proposal, declaredScope: declaredScope.sort() };
}

/** Map a binding finding for a non-briefable target into a human reason. */
function skipReason(status: SpecStoreStatusReport, targetName: string): string {
  const f = status.findings.find(x => x.subject === targetName);
  if (f) return f.message;
  return `Target "${targetName}" is not resolvable to an indexed local checkout.`;
}

/**
 * Assemble the working-set context briefing for an active change across a bound
 * spec store's targets. Read-only; composes federation + orient only. Never throws
 * for a binding/change/index problem — every problem is a finding.
 */
export async function handleWorkingSetContext(
  directory: string,
  changeId?: string,
  tokenBudget = DEFAULT_WORKING_SET_BUDGET,
  limit = 5,
): Promise<WorkingSetContextReport> {
  const absDir = await validateDirectory(directory);
  const budget = tokenBudget > 0 ? tokenBudget : DEFAULT_WORKING_SET_BUDGET;

  // Binding health is the single source of truth for which targets are briefable.
  const status = await handleSpecStoreStatus(absDir);

  if (!status.bound) {
    return {
      bound: false,
      targets: [],
      items: [],
      findings: [{
        code: 'no-binding', severity: 'info', subject: basename(absDir),
        message: 'No spec-store binding is configured; there is no external change to brief.',
        remediation: 'Add a "specStore" block to .openlore/config.json (see add-spec-store-binding).',
      }],
      ready: false,
      summary: 'No spec-store binding configured.',
    };
  }

  const findings: WorkingSetFinding[] = [];
  const store = status.store!;

  // Surface (don't block on) an unsound binding: the briefing proceeds for whatever
  // targets ARE briefable, but the consumer is told the picture may be partial.
  if (!status.sound) {
    findings.push({
      code: 'binding-unsound', severity: 'warn', subject: store.name,
      message: `The spec-store binding has blocking issues; the briefing may be partial. ${status.summary}`,
      remediation: 'Run `openlore spec-store status` and resolve the error findings, then re-brief.',
    });
  }

  if (!changeId || !changeId.trim()) {
    findings.push({
      code: 'change-unspecified', severity: 'info', subject: store.name,
      message: 'No change was specified, so there is nothing to brief.',
      remediation: 'Pass the active change to brief, e.g. `--change <id>`.',
    });
    return {
      bound: true, store,
      targets: status.targets.map(t => ({
        target: t.name, briefed: false, reason: 'No change specified.',
        insertionPoints: [], specDomains: [], anchoredIntent: [],
      })),
      items: [], findings, ready: false,
      summary: `Binding "${store.name}" is bound; specify a change to assemble its working-set context.`,
    };
  }

  // Resolve the change against the store's working tree. Use the trimmed id
  // consistently on every surface (subject, message, echoed change.id).
  const id = changeId.trim();
  const storeDir = canonical(store.path, absDir);
  const change = await readChange(storeDir, id);
  if (!change) {
    findings.push({
      code: 'change-not-found', severity: 'error', subject: id,
      message: `No proposal found for change "${id}" under the spec store.`,
      remediation: `Expected ${join(storeDir, 'openspec', 'changes', id, 'proposal.md')}; check the change id and the store path.`,
    });
    return {
      bound: true, store, change: { id, intent: '' },
      targets: [], items: [], findings, ready: false,
      summary: `Change "${id}" not found under spec store "${store.name}".`,
    };
  }

  const intent = extractIntent(change.proposal, id);

  // Briefable = resolved AND consultable (indexed, or unbaselined — index present,
  // staleness unassessable). Everything else is reported but skipped.
  const briefable = status.targets.filter(
    t => t.resolved && (t.state === 'indexed' || t.state === 'unbaselined') && t.path,
  );
  const targets: WorkingSetTargetBrief[] = [];
  const allItems: WorkingSetItem[] = [];

  for (const t of status.targets) {
    if (!briefable.includes(t)) {
      const reason = skipReason(status, t.name);
      targets.push({ target: t.name, briefed: false, reason, insertionPoints: [], specDomains: [], anchoredIntent: [] });
      findings.push({
        code: 'target-not-briefable', severity: 'warn', subject: t.name,
        message: `Target "${t.name}" was not briefed: ${reason}`,
        remediation: `Resolve and index "${t.name}" (see \`openlore spec-store status\`), then re-brief.`,
      });
      continue;
    }

    // Orient each target at full fidelity (`limit` functions, no per-target budget):
    // the single budget truncation point is the global rank-and-budget pass below.
    // Budgeting per target would also starve orient's anchored-intent projection
    // (governingDecisions derive from the kept files), so we deliberately don't.
    let orient: OrientView;
    try {
      orient = (await handleOrient(t.path!, intent, limit)) as OrientView;
    } catch (err) {
      const reason = `Orientation failed: ${err instanceof Error ? err.message : String(err)}`;
      targets.push({ target: t.name, briefed: false, reason, insertionPoints: [], specDomains: [], anchoredIntent: [] });
      findings.push({
        code: 'orient-unavailable', severity: 'warn', subject: t.name,
        message: `Target "${t.name}" is indexed but could not be oriented: ${reason}`,
        remediation: `Re-run \`openlore analyze\` in ${t.path}, then re-brief.`,
      });
      continue;
    }

    if (orient.error) {
      targets.push({ target: t.name, briefed: false, reason: orient.error, insertionPoints: [], specDomains: [], anchoredIntent: [] });
      findings.push({
        code: 'orient-unavailable', severity: 'warn', subject: t.name,
        message: `Target "${t.name}" could not be oriented: ${orient.error}`,
        remediation: `Re-run \`openlore analyze\` in ${t.path}, then re-brief.`,
      });
      continue;
    }

    const { items, brief } = briefTargetFromOrient(t.name, orient);
    allItems.push(...items);
    targets.push(brief);
  }

  // Rank the merged briefing by structural relevance, then bound it to budget.
  const { kept, omitted } = rankAndBudget(allItems, budget);

  const briefedCount = targets.filter(t => t.briefed).length;
  if (briefedCount === 0) {
    findings.push({
      code: 'no-briefable-targets', severity: 'error', subject: store.name,
      message: 'No declared target resolved to an indexed local checkout, so no context could be assembled.',
      remediation: 'Register and `openlore analyze` at least one declared target (see `openlore spec-store status`).',
    });
  }

  const ready = status.sound && briefedCount > 0;
  const errors = findings.filter(f => f.severity === 'error').length;
  const summary = briefedCount > 0
    ? `Working set for change "${id}" on store "${store.name}": ` +
      `${kept.length} item(s) across ${briefedCount}/${status.targets.length} target(s)` +
      (omitted > 0 ? `, ${omitted} omitted to fit budget` : '') + '.'
    : `Working set for change "${id}" on store "${store.name}": no briefable targets` +
      (errors ? `, ${errors} blocking issue(s)` : '') + '.';

  return {
    bound: true,
    store,
    change: {
      id,
      intent,
      ...(change.declaredScope.length ? { declaredScope: change.declaredScope } : {}),
    },
    targets,
    items: kept,
    ...(omitted > 0 ? { omissionNote: omissionNote(omitted, 'raise --token-budget or narrow the change') } : {}),
    findings,
    ready,
    summary,
  };
}
