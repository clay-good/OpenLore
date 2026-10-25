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

import { execFileGit, spawnGit } from '../../../utils/git-exec.js';
import { gitPathArgs } from '../../../utils/git-args.js';
import { CallGraphBuilder } from '../../analyzer/call-graph.js';
import type { CallEdge, FunctionNode } from '../../analyzer/call-graph-types.js';
import { classifySignatureChange, type ChangeClass } from '../../analyzer/public-surface.js';
import { detectLanguage } from '../../analyzer/language-detection.js';
import { validateDirectory } from './utils.js';

const GIT_READ_TIMEOUT_MS = 20_000;
const MAX_FILES = 20_000;
/** Total decoded blob bytes a single batch read holds before giving up (then the per-file fallback runs). */
const MAX_BLOB_BYTES_TOTAL = 512 * 1024 * 1024;

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
  // `-z` gives raw, unquoted, NUL-separated paths — robust to spaces and unicode that
  // `core.quotepath`/newline parsing would otherwise mangle.
  const { stdout } = await execFileGit('git', gitPathArgs('ls-tree', '-r', '-z', '--name-only', ref), { cwd: absDir, timeout: GIT_READ_TIMEOUT_MS });
  const selected: Array<{ path: string; language: string }> = [];
  for (const path of stdout.split('\0')) {
    if (!path) continue;
    if (path.includes('\n')) continue; // cannot be fed on cat-file's line protocol; vanishingly rare in source
    const language = detectLanguage(path);
    if (!language || language === 'Unknown' || language === 'unknown') continue;
    selected.push({ path, language });
    if (selected.length >= MAX_FILES) break;
  }
  if (selected.length === 0) return [];

  const paths = selected.map(s => s.path);
  let contents: Map<string, string>;
  try {
    contents = await readBlobsAtRef(absDir, ref, paths); // one subprocess for the whole tree (~35x faster than per-file)
  } catch {
    contents = await readBlobsPerFile(absDir, ref, paths); // robustness fallback: never regress on a quirky/old git
  }
  const out: Array<{ path: string; content: string; language: string }> = [];
  for (const s of selected) {
    const content = contents.get(s.path);
    if (content !== undefined) out.push({ path: s.path, content, language: s.language }); // a path unreadable at this ref is skipped; disclosed via the overall boundary
  }
  return out;
}

/**
 * Read many blobs at a ref in ONE `git cat-file --batch`, correlating each reply to the fed path by
 * ORDER (a `missing` reply advances the cursor with no body). Replaces one `git show` subprocess
 * per file, the dominant cost on a real repo. Rejects on a protocol or size violation, which the
 * caller turns into a per-file fallback, so this fast path is never load-bearing for correctness.
 */
function readBlobsAtRef(absDir: string, ref: string, paths: readonly string[]): Promise<Map<string, string>> {
  return new Promise((resolve, reject) => {
    const child = spawnGit('git', gitPathArgs('cat-file', '--batch'), { cwd: absDir, stdio: ['pipe', 'pipe', 'pipe'] });
    const out = new Map<string, string>();
    const decoder = new TextDecoder('utf-8');
    let pending: Buffer = Buffer.alloc(0);
    let idx = 0;
    let need: number | null = null;
    let total = 0;
    let settled = false;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.kill(); } catch { /* already exited */ }
      fn();
    };
    const fail = (e: Error): void => finish(() => reject(e));
    const timer = setTimeout(() => fail(new Error('git cat-file --batch timed out')), GIT_READ_TIMEOUT_MS);
    child.on('error', fail);
    child.stdin.on('error', fail);
    child.stdout.on('error', fail);
    child.stdout.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BLOB_BYTES_TOTAL) { fail(new Error('git cat-file --batch output exceeded the size bound')); return; }
      pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
      try {
        while (idx < paths.length) {
          if (need === null) {
            const nl = pending.indexOf(0x0a);
            if (nl === -1) return; // header incomplete; wait for more
            const header = pending.subarray(0, nl).toString('ascii').trim();
            pending = pending.subarray(nl + 1);
            const tok = header.split(/\s+/);
            if (tok[tok.length - 1] === 'missing') { idx++; continue; } // path absent at this ref
            const size = Number(tok[tok.length - 1]);
            if (!Number.isSafeInteger(size) || size < 0) throw new Error(`unexpected cat-file header: ${header}`);
            need = size;
          }
          if (pending.length < need + 1) return; // body + trailing newline not yet buffered
          if (pending[need] !== 0x0a) throw new Error('cat-file blob was not newline-terminated');
          out.set(paths[idx], decoder.decode(pending.subarray(0, need)));
          pending = pending.subarray(need + 1);
          need = null;
          idx++;
        }
        finish(() => resolve(out));
      } catch (e) {
        fail(e instanceof Error ? e : new Error(String(e)));
      }
    });
    // Git closes stdout when stdin ends; resolve with whatever was parsed (partial is fail-soft).
    child.stdout.on('end', () => finish(() => resolve(out)));
    child.stdin.end(paths.map(p => `${ref}:${p}`).join('\n') + '\n');
  });
}

/** Per-file `git show` — the correctness fallback when the batch read fails. */
async function readBlobsPerFile(absDir: string, ref: string, paths: readonly string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const path of paths) {
    try {
      const { stdout } = await execFileGit('git', gitPathArgs('show', `${ref}:${path}`), { cwd: absDir, timeout: GIT_READ_TIMEOUT_MS });
      out.set(path, stdout);
    } catch { /* unreadable at this ref — skipped, disclosed via the overall boundary */ }
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
