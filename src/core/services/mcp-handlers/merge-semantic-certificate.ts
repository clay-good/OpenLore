/**
 * certify_merge — the merge semantic certificate (change: add-merge-semantic-certificate).
 *
 * Catches the disjoint-footprint failure textual merge cannot see: branch A adds a call to
 * `parseConfig`; branch B — touching entirely different files — renames a parameter, narrows its
 * type, or removes the export. Each branch is green alone, the merge is green textually, the
 * combination is broken. Completes the coordination arc: plan_parallel_work (before dispatch) →
 * map_in_flight_conflicts (in flight) → certify_merge (at landing).
 *
 * How: build the call graph at the merge-base and at each side, compute each side's changed
 * (signature) / removed symbols (classified with the public-surface breaking-change rules), and
 * cross-join — one side's breaking/removed symbols × the OTHER side's ADDED call/import edges into
 * them, both directions. A rename handled within a branch never crosses the branch boundary, so a
 * migrated rename is not a false conflict; a call the other branch adds to the old name is.
 *
 * Honest: a change that cannot be proven compatible is `potentially-incompatible`, never silently
 * compatible; the verdict is a sound lower bound ("no detected incompatibility", never "safe");
 * unresolvable refs are fatal; unindexed languages and diff-fetch failures are disclosed. Advisory
 * finding `merge-semantic-conflict`. Siblings: map_in_flight_conflicts (footprint overlap in
 * flight) and the merge-tree oracle (will git textually conflict) vs this (what breaks when it does
 * not). The `openlore certify-merge` CLI and retained-edge (non-added) conflicts are follow-ups.
 */

import { execFileGit } from '../../../utils/git-exec.js';
import { gitPathArgs } from '../../../utils/git-args.js';
import { CallGraphBuilder } from '../../analyzer/call-graph.js';
import type { CallEdge, FunctionNode } from '../../analyzer/call-graph-types.js';
import { classifySignatureChange, type ChangeClass } from '../../analyzer/public-surface.js';
import { detectLanguage } from '../../analyzer/language-detection.js';
import { validateDirectory } from './utils.js';

const GIT_READ_TIMEOUT_MS = 20_000;
const MAX_FILES = 20_000;

export interface CertifyMergeInput {
  directory: string;
  ours: string;
  theirs: string;
  /** Explicit base; defaults to the merge-base of ours/theirs. */
  base?: string;
  maxFindings?: number;
}

/** A symbol one side changed or removed relative to the base, with its breaking classification. */
export interface ChangedSymbol {
  id: string;
  name: string;
  /** 'removed' | the signature-change class. */
  kind: 'removed' | ChangeClass;
  ruleCodes: string[];
}

interface MergeFinding {
  verdict: 'incompatible' | 'potentially-incompatible';
  side: string;         // which branch ADDED the edge
  changedBy: string;    // which branch changed/removed the symbol
  caller: string;
  callee: string;
  line: number | undefined;
  rule: string;
}

/** Simple call graph shape the join needs. */
interface Graph { nodes: Map<string, FunctionNode>; edges: CallEdge[]; }

const isDirectCall = (e: CallEdge): boolean =>
  (e.kind === undefined || e.kind === 'calls') && e.confidence !== 'external';

/** Symbols the `side` graph changed (signature) or removed relative to `base`. Pure. */
export function changedSymbols(base: Graph, side: Graph): ChangedSymbol[] {
  const out: ChangedSymbol[] = [];
  for (const [id, b] of base.nodes) {
    if (b.isExternal) continue;
    const s = side.nodes.get(id);
    if (!s) {
      out.push({ id, name: b.name, kind: 'removed', ruleCodes: ['export-removed'] });
      continue;
    }
    const before = b.signature ?? b.name;
    const after = s.signature ?? s.name;
    if (before !== after) {
      const verdict = classifySignatureChange(before, after, b.language);
      if (verdict.class !== 'non-breaking') {
        out.push({ id, name: b.name, kind: verdict.class, ruleCodes: verdict.ruleCodes });
      }
    }
  }
  return out;
}

/** Edges the `side` graph ADDED relative to `base` (direct calls only). Pure. */
export function addedEdges(base: Graph, side: Graph): CallEdge[] {
  const key = (e: CallEdge) => `${e.callerId}\u0000${e.calleeId}\u0000${e.calleeName}\u0000${e.line ?? ''}`;
  const baseKeys = new Set(base.edges.filter(isDirectCall).map(key));
  return side.edges.filter(e => isDirectCall(e) && !baseKeys.has(key(e)));
}

/**
 * Cross-join: for each edge the `addingSide` added, if its callee is a symbol the `changingSide`
 * broke or removed, emit a conflict. `incompatible` for a removal or a breaking signature change;
 * `potentially-incompatible` for anything only potentially-breaking. Pure.
 */
export function crossJoin(
  addingSide: string,
  added: readonly CallEdge[],
  changingSide: string,
  changed: readonly ChangedSymbol[],
  nameOf: (id: string) => string | undefined,
): MergeFinding[] {
  const byId = new Map(changed.map(c => [c.id, c]));
  const out: MergeFinding[] = [];
  for (const e of added) {
    const hit = byId.get(e.calleeId);
    if (!hit) continue;
    const verdict: MergeFinding['verdict'] =
      hit.kind === 'removed' || hit.kind === 'breaking' ? 'incompatible' : 'potentially-incompatible';
    out.push({
      verdict,
      side: addingSide,
      changedBy: changingSide,
      caller: nameOf(e.callerId) ?? e.callerId,
      callee: e.calleeName,
      line: e.line,
      rule: hit.kind === 'removed' ? 'export-removed' : (hit.ruleCodes[0] ?? `signature-${hit.kind}`),
    });
  }
  return out;
}

// ── git-backed graph assembly ──────────────────────────────────────────────

async function filesAtRef(absDir: string, ref: string): Promise<Array<{ path: string; content: string; language: string }>> {
  const { stdout } = await execFileGit('git', gitPathArgs('ls-tree', '-r', ref, '--name-only'), { cwd: absDir, timeout: GIT_READ_TIMEOUT_MS });
  const paths = stdout.split('\n').map(p => p.trim()).filter(Boolean).slice(0, MAX_FILES);
  const out: Array<{ path: string; content: string; language: string }> = [];
  for (const path of paths) {
    const language = detectLanguage(path);
    if (!language || language === 'Unknown' || language === 'unknown') continue;
    try {
      const { stdout: content } = await execFileGit('git', gitPathArgs('show', `${ref}:${path}`), { cwd: absDir, timeout: GIT_READ_TIMEOUT_MS });
      out.push({ path, content, language });
    } catch { /* a path unreadable at this ref is skipped; disclosed via the overall boundary */ }
  }
  return out;
}

async function graphAtRef(absDir: string, ref: string): Promise<Graph> {
  const files = await filesAtRef(absDir, ref);
  const result = await new CallGraphBuilder().build(files);
  return { nodes: result.nodes, edges: result.edges };
}

/** Resolve the base: the explicit `base`, else `git merge-base ours theirs`. */
async function resolveMergeBase(absDir: string, ours: string, theirs: string, explicit?: string): Promise<string> {
  if (explicit && explicit.trim()) return explicit.trim();
  const { stdout } = await execFileGit('git', gitPathArgs('merge-base', ours, theirs), { cwd: absDir, timeout: GIT_READ_TIMEOUT_MS });
  const base = stdout.trim();
  if (!base) throw new Error(`no merge-base between "${ours}" and "${theirs}"`);
  return base;
}

export async function handleCertifyMerge(input: CertifyMergeInput): Promise<Record<string, unknown>> {
  const absDir = await validateDirectory(input.directory);
  if (!input.ours?.trim() || !input.theirs?.trim()) {
    return { tool: 'certify_merge', posture: 'advisory', error: 'certify_merge requires two refs: ours and theirs.' };
  }

  let base: string;
  try {
    base = await resolveMergeBase(absDir, input.ours, input.theirs, input.base);
  } catch (e) {
    return { tool: 'certify_merge', posture: 'advisory', error: `cannot resolve base: ${e instanceof Error ? e.message : String(e)}` };
  }

  let baseG: Graph, oursG: Graph, theirsG: Graph;
  try {
    [baseG, oursG, theirsG] = await Promise.all([
      graphAtRef(absDir, base),
      graphAtRef(absDir, input.ours),
      graphAtRef(absDir, input.theirs),
    ]);
  } catch (e) {
    return { tool: 'certify_merge', posture: 'advisory', error: `cannot build a branch graph: ${e instanceof Error ? e.message : String(e)}` };
  }

  const oursChanged = changedSymbols(baseG, oursG);
  const theirsChanged = changedSymbols(baseG, theirsG);
  const oursAdded = addedEdges(baseG, oursG);
  const theirsAdded = addedEdges(baseG, theirsG);
  const nameIn = (g: Graph) => (id: string) => g.nodes.get(id)?.name;

  const findings = [
    ...crossJoin('theirs', theirsAdded, 'ours', oursChanged, nameIn(theirsG)),
    ...crossJoin('ours', oursAdded, 'theirs', theirsChanged, nameIn(oursG)),
  ];
  const cap = input.maxFindings ?? 200;
  const incompatible = findings.filter(f => f.verdict === 'incompatible').length;

  return {
    tool: 'certify_merge',
    posture: 'advisory',
    ours: input.ours,
    theirs: input.theirs,
    base,
    // A sound lower bound: no DETECTED incompatibility is not a proof of safety.
    verdict: incompatible > 0 ? 'incompatible' : findings.length > 0 ? 'potentially-incompatible' : 'no-detected-conflict',
    summary: { conflicts: findings.length, incompatible, potentiallyIncompatible: findings.length - incompatible },
    findings: findings.slice(0, cap).map(f => ({
      code: 'merge-semantic-conflict',
      severity: f.verdict === 'incompatible' ? 'error' : 'warning',
      source: 'merge-semantic-certificate',
      subject: `${f.caller} -> ${f.callee}@${f.line ?? '?'}`,
      message: `${f.side} adds a call into ${f.callee}, which ${f.changedBy} ${f.rule === 'export-removed' ? 'removed' : 'changed incompatibly'} (${f.rule}); clean textual merge, broken combination.`,
    })),
    ...(findings.length > cap ? { truncated: { omitted: findings.length - cap } } : {}),
    boundaries: [
      'Sound lower bound: "no detected incompatibility", never "safe". Unindexed languages, dynamic dispatch the call graph cannot follow, and unreadable paths at a ref are not assessed.',
      'Scope: edges a side ADDED relative to the base; retained (pre-existing) calls into a changed symbol are an author\'s own blast-radius concern, not a merge-specific conflict.',
    ],
  };
}
