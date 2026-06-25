/**
 * Structural Change Analysis — graph diff (spec-21).
 *
 * Given a change (working tree vs a ref, or two refs), compute what changed
 * *structurally*: which functions/edges were added or removed, which signatures
 * changed, and which existing callers are now STALE because a callee's signature
 * moved under them. A review/refactor agent gets a precise structural changelog
 * instead of re-deriving consequences from a raw text diff.
 *
 * The difference between "these 40 lines changed" (git diff) and "this removed
 * function C, altered the signature of D, and 5 of D's callers are now stale"
 * (graph diff) — a computed consequence (Layer 3), not retrieval.
 *
 * Bounded: only the changed files are re-parsed (old content via `git show`, new
 * via the working tree / ref), so two in-memory snapshots are cheap. The canonical
 * graph is never mutated. Stale callers come from the cached graph (all callers).
 *
 * Honest limits: a moved/renamed-file symbol is matched exactly by its
 * content-addressed stable id (the same symbol, not delete+add). Identifier
 * renames and symbols with no stable id stay heuristic — both interpretations are
 * reported, never silently guessed.
 */

import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { validateDirectory, readCachedContext, safeJoin } from './utils.js';
import { isGitRepository, resolveBaseRef, validateGitRef, getChangedFiles } from '../../drift/git-diff.js';
import { CallGraphBuilder, serializeCallGraph } from '../../analyzer/call-graph.js';
import { detectLanguage } from '../../analyzer/signature-extractor.js';
import { signatureShape } from '../../scip/moniker.js';
import { readOpenLoreConfig } from '../config-manager.js';
import { effectivePolicy, classifyFindings } from './enforcement-policy.js';
import {
  analyzeEscape,
  normalizeDeclaredFootprint,
  type ModifiedSymbol,
  type EditNature,
  type DeclaredFootprintInput,
} from './footprint-escape.js';
import type { SerializedCallGraph, FunctionNode } from '../../analyzer/call-graph.js';

const execFileAsync = promisify(execFile);

export interface StructuralDiffInput {
  directory: string;
  /** Old state (default "HEAD"). */
  baseRef?: string;
  /** New state. Omit to use the working tree. */
  headRef?: string;
  /** Cap reported items per category (default 200). */
  maxResults?: number;
  /**
   * Optional declared write-footprint for the change (proposal-1 `Footprint`
   * shape, or any subset carrying `writeSet`/`readSet`). When supplied,
   * `structural_diff` additionally computes the **escape set** — symbols the diff
   * modified outside the declared write-set — and the conflicts an escape opens
   * against `peerFootprints`. Absent → behavior is byte-identical to today (the
   * extension is dormant). OpenLore holds no roster: this is a per-call input.
   */
  declaredFootprint?: DeclaredFootprintInput;
  /**
   * Optional declared footprints of *other* in-flight tasks. An out-of-scope write
   * that lands in a peer's write-set is reported as a newly-opened write-write
   * conflict naming that peer. Ignored unless `declaredFootprint` is also supplied.
   */
  peerFootprints?: DeclaredFootprintInput[];
}

interface InFile { path: string; content: string; language: string }

/** Content of a file at a git ref, or '' if it didn't exist there. */
async function fileAtRef(rootPath: string, ref: string, path: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', ['show', `${ref}:${path}`], {
      cwd: rootPath, maxBuffer: 32 * 1024 * 1024,
    });
    return stdout;
  } catch {
    return '';
  }
}

function nodeRef(n: FunctionNode) {
  return { name: n.name, file: n.filePath, className: n.className ?? null, signature: n.signature ?? n.name };
}

export async function handleStructuralDiff(input: StructuralDiffInput): Promise<unknown> {
  const absDir = await validateDirectory(input.directory);
  if (!(await isGitRepository(absDir))) {
    return { error: 'Not a git repository. Structural diff requires git.' };
  }
  const baseRaw = input.baseRef ?? 'HEAD';
  try {
    validateGitRef(baseRaw);
    if (input.headRef) validateGitRef(input.headRef);
  } catch (err) {
    return { error: `Invalid git ref: ${err instanceof Error ? err.message : String(err)}` };
  }
  const resolvedBase = await resolveBaseRef(absDir, baseRaw);

  // ── Changed files ───────────────────────────────────────────────────────────
  let changed: Array<{ path: string; status: string; oldPath?: string }>;
  try {
    if (input.headRef) {
      const { stdout } = await execFileAsync(
        'git', ['diff', '--name-status', '--diff-filter=ACDMR', `${resolvedBase}..${input.headRef}`],
        { cwd: absDir, maxBuffer: 16 * 1024 * 1024 },
      );
      changed = stdout.split('\n').filter(Boolean).map(line => {
        const parts = line.split('\t');
        const s = parts[0].charAt(0);
        const status = s === 'A' ? 'added' : s === 'D' ? 'deleted' : s === 'R' ? 'renamed' : 'modified';
        return status === 'renamed' && parts.length >= 3
          ? { path: parts[2], status, oldPath: parts[1] }
          : { path: parts[1], status };
      });
    } else {
      const diff = await getChangedFiles({ rootPath: absDir, baseRef: resolvedBase, includeUnstaged: true });
      changed = diff.files.map(f => ({ path: f.path, status: f.status, oldPath: f.oldPath }));
      // git diff excludes untracked files; a brand-new file's functions are all
      // structural additions, so fold them in for the working-tree comparison.
      try {
        const { stdout } = await execFileAsync('git', ['ls-files', '--others', '--exclude-standard'], {
          cwd: absDir, maxBuffer: 16 * 1024 * 1024,
        });
        const seen = new Set(changed.map(c => c.path));
        for (const path of stdout.split('\n').map(s => s.trim()).filter(Boolean)) {
          if (!seen.has(path)) changed.push({ path, status: 'added' });
        }
      } catch { /* untracked enumeration is best-effort */ }
    }
  } catch (err) {
    return { error: `git diff failed: ${err instanceof Error ? err.message : String(err)}` };
  }

  // Code files only; logical path = the new path (so a file move doesn't explode
  // into all-removed + all-added at the function level).
  const codeChanged = changed.filter(c => {
    const lang = detectLanguage(c.path);
    return lang && lang !== 'Unknown' && lang !== 'unknown';
  });
  if (codeChanged.length === 0) {
    // When a declared footprint was supplied, still emit a (vacuously empty)
    // escapeAnalysis so a caller can distinguish "escape check ran, clean" from
    // "escape check never ran" — the early return otherwise silently drops the
    // opt-in safety check (Finding: empty-diff early return).
    const limit = Math.max(1, Math.min(input.maxResults ?? 200, 1000));
    const escapeBlock = input.declaredFootprint
      ? await buildEscapeBlock(absDir, input, [], limit, 'No changed code files; the escape check is vacuously empty.')
      : undefined;
    return {
      base: resolvedBase, head: input.headRef ?? 'working tree',
      message: 'No changed code files between the two states (only non-code or no changes).',
      summary: emptySummary(),
      ...(escapeBlock ? { escapeAnalysis: escapeBlock } : {}),
      soundness: diffSoundness(true),
    };
  }

  // ── Build old + new snapshots from just the changed files ───────────────────
  const oldFiles: InFile[] = [];
  const newFiles: InFile[] = [];
  for (const c of codeChanged) {
    const lang = detectLanguage(c.path);
    const oldSrcPath = c.oldPath ?? c.path;
    const oldContent = c.status === 'added' ? '' : await fileAtRef(absDir, resolvedBase, oldSrcPath);
    let newContent = '';
    if (c.status !== 'deleted') {
      newContent = input.headRef
        ? await fileAtRef(absDir, input.headRef, c.path)
        // Confine the working-tree read to the root (defense-in-depth: c.path is
        // git-derived, but safeJoin guarantees no escape — mcp-security).
        : await (async () => {
            try { return await readFile(safeJoin(absDir, c.path), 'utf-8'); }
            catch { return ''; }
          })();
    }
    if (oldContent) oldFiles.push({ path: c.path, content: oldContent, language: lang });
    if (newContent) newFiles.push({ path: c.path, content: newContent, language: lang });
  }

  const oldGraph = await safeBuild(oldFiles);
  const newGraph = await safeBuild(newFiles);

  const oldList = oldGraph.nodes.filter(isCode);
  const newList = newGraph.nodes.filter(isCode);

  // ── Node matching: stable id first, path-based id as fallback ────────────────
  // (change: add-content-addressed-stable-symbol-ids). A symbol that only moved
  // or whose modifiers shifted keeps its stableId, so it pairs across versions
  // instead of looking like remove+add. Nodes without a stableId (anonymous /
  // synthetic) fall back to the path-based id — today's exact behavior.
  const oldById = new Map<string, FunctionNode>();
  // Group by stableId on BOTH sides: because stableId is non-unique (homonyms
  // share one), a stableId is a trustworthy cross-version match ONLY when it maps
  // to exactly one node on each side. Otherwise we must NOT guess which homonym
  // moved — we fall back to the path id and the signature-shape heuristic, exactly
  // the "resolve only when unique" contract the rest of the change follows.
  const oldByStable = new Map<string, FunctionNode[]>();
  const newByStable = new Map<string, FunctionNode[]>();
  for (const n of oldList) {
    oldById.set(n.id, n);
    if (n.stableId) (oldByStable.get(n.stableId) ?? oldByStable.set(n.stableId, []).get(n.stableId)!).push(n);
  }
  for (const n of newList) {
    if (n.stableId) (newByStable.get(n.stableId) ?? newByStable.set(n.stableId, []).get(n.stableId)!).push(n);
  }
  const matchedOld = new Set<string>();
  const matchedNew = new Set<string>();
  const pairs: Array<{ old: FunctionNode; cur: FunctionNode; via: 'stableId' | 'id' }> = [];
  // Pass A — stable id, unambiguous 1:1 only (takes precedence over the path id).
  for (const n of newList) {
    if (!n.stableId || newByStable.get(n.stableId)!.length !== 1) continue;
    const olds = oldByStable.get(n.stableId);
    if (olds && olds.length === 1 && !matchedOld.has(olds[0].id)) {
      pairs.push({ old: olds[0], cur: n, via: 'stableId' });
      matchedOld.add(olds[0].id); matchedNew.add(n.id);
    }
  }
  // Pass B — remaining nodes by path-based id.
  for (const n of newList) {
    if (matchedNew.has(n.id)) continue;
    const o = oldById.get(n.id);
    if (o && !matchedOld.has(o.id)) {
      pairs.push({ old: o, cur: n, via: 'id' });
      matchedOld.add(o.id); matchedNew.add(n.id);
    }
  }

  // ── Node-level delta ────────────────────────────────────────────────────────
  const added = newList.filter(n => !matchedNew.has(n.id));
  const removed = oldList.filter(n => !matchedOld.has(n.id));
  const signatureChanged: Array<{ node: FunctionNode; before: string; after: string }> = [];
  for (const p of pairs) {
    if ((p.old.signature ?? '') !== (p.cur.signature ?? '')) {
      signatureChanged.push({ node: p.cur, before: p.old.signature ?? p.old.name, after: p.cur.signature ?? p.cur.name });
    }
  }

  // ── Rename/move candidates ───────────────────────────────────────────────────
  // stable-id: a cross-file pair with the same content-addressed id (name +
  // parameter shape). Strong signal that the symbol MOVED — but a symbol that was
  // deleted and independently replaced by a same-name/same-shape homonym is
  // indistinguishable here, so this is labeled `stable-id` (not `exact`) and the
  // note tells the agent to verify rather than asserting "the same symbol". The id
  // is unique within the CHANGED-FILE set; a same-shape symbol in an unchanged file
  // is not considered. Heuristic: leftover removed↔added paired by signature shape
  // (identifier renames, anonymous/synthetic nodes). Both interpretations surface.
  const renameCandidates: Array<{ from: ReturnType<typeof nodeRef>; to: ReturnType<typeof nodeRef>; confidence: string; note: string }> = [];
  for (const p of pairs) {
    if (p.via === 'stableId' && p.old.filePath !== p.cur.filePath) {
      renameCandidates.push({
        from: nodeRef(p.old), to: nodeRef(p.cur), confidence: 'stable-id',
        note: `"${p.old.name}" in "${p.old.filePath}" and "${p.cur.filePath}" share a content-addressed id (name + parameter shape) — most likely the same symbol moved (not remove+add), but a delete-and-replace by a same-shape homonym is indistinguishable here. Verify.`,
      });
    }
  }
  for (const r of removed) {
    for (const a of added) {
      const sameShape = signatureShape(r.signature, r.language, r.name) && signatureShape(r.signature, r.language, r.name) === signatureShape(a.signature, a.language, a.name);
      const sameFile = r.filePath === a.filePath;
      if (!sameShape) continue;
      const confidence = sameFile ? 'high' : 'medium';
      renameCandidates.push({
        from: nodeRef(r), to: nodeRef(a), confidence,
        note: `"${r.name}" may have been renamed/moved to "${a.name}" (matching signature shape${sameFile ? ', same file' : ''}). Reported as both remove+add and this rename candidate — verify.`,
      });
    }
  }

  // ── Edge delta (calls among / out of the changed files) ─────────────────────
  const edgeKey = (e: { callerId: string; calleeName: string }) => `${e.callerId}\0${e.calleeName}`;
  const oldEdges = new Map(oldGraph.edges.filter(isCallEdge).map(e => [edgeKey(e), e]));
  const newEdges = new Map(newGraph.edges.filter(isCallEdge).map(e => [edgeKey(e), e]));
  const addedEdges = [...newEdges].filter(([k]) => !oldEdges.has(k)).map(([, e]) => edgePair(e, newGraph));
  const removedEdges = [...oldEdges].filter(([k]) => !newEdges.has(k)).map(([, e]) => edgePair(e, oldGraph));

  // ── Stale callers — callers (in the canonical graph) of a node whose signature
  //    changed or that was removed, that are NOT themselves in the changed set ──
  const ctx = await readCachedContext(absDir);
  const changedPaths = new Set(codeChanged.map(c => c.path));
  const staleCallerNote = ctx?.edgeStore
    ? undefined
    : 'No cached graph — stale-caller analysis skipped. Run analyze_codebase to enable it.';
  const collectStaleCallers = (nodeId: string): Array<{ name: string; file: string }> => {
    if (!ctx?.edgeStore) return [];
    const out = new Map<string, { name: string; file: string }>();
    for (const e of ctx.edgeStore.getCallers(nodeId)) {
      if (e.kind && e.kind !== 'calls') continue;
      const caller = ctx.edgeStore.getNode(e.callerId);
      if (!caller || caller.isExternal) continue;
      if (changedPaths.has(caller.filePath)) continue; // updated in this change
      out.set(caller.id, { name: caller.name, file: caller.filePath });
    }
    return [...out.values()].sort((a, b) => a.file.localeCompare(b.file) || a.name.localeCompare(b.name));
  };

  const limit = Math.max(1, Math.min(input.maxResults ?? 200, 1000));
  const sigChangedOut = signatureChanged
    .map(s => ({ ...nodeRef(s.node), before: s.before, after: s.after, staleCallers: collectStaleCallers(s.node.id) }))
    .sort((a, b) => b.staleCallers.length - a.staleCallers.length || a.file.localeCompare(b.file));
  const removedOut = removed
    .map(n => ({ ...nodeRef(n), staleCallers: collectStaleCallers(n.id) }))
    .sort((a, b) => b.staleCallers.length - a.staleCallers.length || a.file.localeCompare(b.file));

  const totalStale = new Set(
    [...sigChangedOut, ...removedOut].flatMap(x => x.staleCallers.map(c => `${c.file}::${c.name}`)),
  ).size;

  // ── Footprint escape detection (add-footprint-escape-detection, proposal 3) ──
  // Dormant unless the caller supplies a declared write-footprint. When present,
  // compare the symbols the diff ACTUALLY modified against the declared write-set
  // and recompute the conflicts an escape opens against supplied peer footprints.
  let escapeBlock: Record<string, unknown> | undefined;
  if (input.declaredFootprint) {
    const oldContent = new Map(oldFiles.map(f => [f.path, f.content]));
    const newContent = new Map(newFiles.map(f => [f.path, f.content]));
    const modifiedSymbols = computeModifiedSymbols(pairs, added, removed, oldContent, newContent);
    escapeBlock = await buildEscapeBlock(absDir, input, modifiedSymbols, limit);
  }

  return {
    base: resolvedBase,
    head: input.headRef ?? 'working tree',
    changedFiles: codeChanged.map(c => ({ path: c.path, status: c.status, ...(c.oldPath ? { oldPath: c.oldPath } : {}) })),
    summary: {
      addedFunctions: added.length,
      removedFunctions: removed.length,
      signatureChanges: signatureChanged.length,
      addedEdges: addedEdges.length,
      removedEdges: removedEdges.length,
      staleCallers: totalStale,
      renameCandidates: renameCandidates.length,
    },
    added: added.map(nodeRef).sort(byFileName).slice(0, limit),
    removed: removedOut.slice(0, limit),
    signatureChanged: sigChangedOut.slice(0, limit),
    renameCandidates: renameCandidates.slice(0, limit),
    edges: { added: addedEdges.slice(0, limit), removed: removedEdges.slice(0, limit) },
    ...(staleCallerNote ? { note: staleCallerNote } : {}),
    ...(escapeBlock ? { escapeAnalysis: escapeBlock } : {}),
    soundness: diffSoundness(false),
  };
}

/**
 * Build the `escapeAnalysis` block from the diff's actually-modified symbols and
 * the caller's declared + peer footprints. Resolves each finding's enforcement
 * class against the repo policy (advisory by default — `structural_diff` never
 * blocks; it surfaces what WOULD block so the harness/gate can act). Assumes
 * `input.declaredFootprint` is set.
 *
 * Honesty fixes baked in:
 *  - blocking findings are ALWAYS retained even past `maxResults`, so a `gated:true`
 *    result never hides the finding that caused it;
 *  - truncation of any list is disclosed in `notes`, never silent;
 *  - a degenerate (empty/all-malformed) declared write-set is disclosed, since it
 *    makes every modified symbol look out-of-scope.
 */
async function buildEscapeBlock(
  absDir: string,
  input: StructuralDiffInput,
  modifiedSymbols: ModifiedSymbol[],
  limit: number,
  extraNote?: string,
): Promise<Record<string, unknown>> {
  const declared = normalizeDeclaredFootprint(input.declaredFootprint);
  const peers = (input.peerFootprints ?? []).map((p, i) => normalizeDeclaredFootprint(p, `peer-${i}`));
  const analysis = analyzeEscape(modifiedSymbols, declared, peers);

  const policy = effectivePolicy(await readOpenLoreConfig(absDir));
  const gate = classifyFindings(analysis.findings, policy);

  // Always keep every blocking finding; fill the remainder up to `limit`. A
  // gated result must show why it gated.
  const blocking = gate.classified.filter(f => f.enforcementClass === 'blocking');
  const rest = gate.classified.filter(f => f.enforcementClass !== 'blocking');
  const findings = [...blocking, ...rest].slice(0, Math.max(limit, blocking.length));

  const notes: string[] = [];
  if (extraNote) notes.push(extraNote);
  if (declared.writeModeById.size === 0 && declared.writeFiles.size === 0 && declared.readIds.size === 0 && modifiedSymbols.length > 0) {
    notes.push('The declared write-set was empty or every member was malformed; every modified symbol is reported as an out-of-scope write. Check that writeSet members carry a string `id`.');
  }
  const truncated =
    analysis.escapes.length > limit ||
    analysis.newlyOpenedConflicts.length > limit ||
    analysis.registryResolutions.length > limit ||
    analysis.misDeclaredAppends.length > limit ||
    findings.length < gate.classified.length;
  if (truncated) notes.push(`Some lists exceeded maxResults (${limit}) and were truncated; the counts in \`summary\` are authoritative. All blocking findings are retained.`);

  return {
    declaredTaskId: analysis.declaredTaskId,
    summary: analysis.summary,
    escapes: analysis.escapes.slice(0, limit),
    newlyOpenedConflicts: analysis.newlyOpenedConflicts.slice(0, limit),
    registryResolutions: analysis.registryResolutions.slice(0, limit),
    misDeclaredAppends: analysis.misDeclaredAppends.slice(0, limit),
    findings,
    gated: gate.gated,
    ...(notes.length > 0 ? { notes } : {}),
    disclosure: analysis.disclosure,
  };
}

// ── modified-symbol extraction (footprint escape detection) ─────────────────────
/**
 * The set of symbols the diff ACTUALLY modified, each tagged with the nature of
 * the edit. The actual write-footprint of the diff:
 *   - `added`   — new symbols (in the new graph, unmatched);
 *   - `removed` — deleted symbols (in the old graph, unmatched);
 *   - paired symbols whose source slice changed: `pure-addition` (every base line
 *     preserved in order — a new switch case / registry element) or
 *     `modifies-existing` (a base line changed or removed).
 * A paired symbol whose slice is byte-identical (an untouched symbol that only
 * moved files) is NOT a modification and is omitted. Deterministic.
 */
function computeModifiedSymbols(
  pairs: Array<{ old: FunctionNode; cur: FunctionNode; via: 'stableId' | 'id' }>,
  added: FunctionNode[],
  removed: FunctionNode[],
  oldContent: Map<string, string>,
  newContent: Map<string, string>,
): ModifiedSymbol[] {
  const out: ModifiedSymbol[] = [];
  for (const n of added) out.push({ id: n.id, name: n.name, filePath: n.filePath, editNature: 'added' });
  for (const n of removed) out.push({ id: n.id, name: n.name, filePath: n.filePath, editNature: 'removed' });
  for (const p of pairs) {
    const oldSrc = sliceSource(oldContent.get(p.old.filePath), p.old.startIndex, p.old.endIndex);
    const newSrc = sliceSource(newContent.get(p.cur.filePath), p.cur.startIndex, p.cur.endIndex);
    if (oldSrc === newSrc) continue; // unchanged (possibly only moved) → not a write
    out.push({
      id: p.cur.id, name: p.cur.name, filePath: p.cur.filePath,
      editNature: editNatureOf(oldSrc, newSrc),
    });
  }
  return out;
}

/**
 * Slice a symbol's source by its `startIndex`/`endIndex`, normalized to LF.
 *
 * Despite the "byte offset" wording on {@link FunctionNode}, the tree-sitter node
 * binding reports **UTF-16 code-unit** offsets (verified: a `☕`/`é` before a
 * function shifts a byte-indexed slice but not a `content.slice` one). Every other
 * slice site in the analyzer uses `content.slice(startIndex, endIndex)` — we match
 * it. A `Buffer.subarray` (byte) slice corrupts every multibyte file and can make a
 * real modification compare equal to its old form, silently dropping the escape.
 */
function sliceSource(content: string | undefined, startIndex: number, endIndex: number): string {
  if (content === undefined) return '';
  return content.slice(startIndex, endIndex).replace(/\r\n/g, '\n');
}

/**
 * Classify a changed symbol's edit as a `pure-addition` (every non-empty base line
 * survives, in order — only insertions) or `modifies-existing` (a base line was
 * changed or removed). Lines are trimmed and blank lines dropped so indentation and
 * spacing noise don't masquerade as a logic change. The subsequence test is the
 * deterministic equivalent of "git would 3-way-merge this as additions only".
 */
function editNatureOf(oldSrc: string, newSrc: string): EditNature {
  const oldLines = oldSrc.split('\n').map(l => l.trim()).filter(Boolean);
  const newLines = newSrc.split('\n').map(l => l.trim()).filter(Boolean);
  if (oldLines.length === 0) return 'pure-addition'; // nothing to clobber
  // oldLines ⊆ newLines as an in-order subsequence ⇒ only insertions happened.
  let i = 0;
  for (let j = 0; j < newLines.length && i < oldLines.length; j++) {
    if (newLines[j] === oldLines[i]) i++;
  }
  return i === oldLines.length ? 'pure-addition' : 'modifies-existing';
}

// ── helpers ────────────────────────────────────────────────────────────────────
function isCode(n: FunctionNode): boolean { return !n.isExternal; }
function isCallEdge(e: { kind?: string; calleeId?: string }): boolean {
  return (!e.kind || e.kind === 'calls') && !!e.calleeId;
}
function byFileName(a: { file: string; name: string }, b: { file: string; name: string }) {
  return a.file.localeCompare(b.file) || a.name.localeCompare(b.name);
}
function edgePair(e: { callerId: string; calleeId: string; calleeName: string }, g: SerializedCallGraph) {
  const caller = g.nodes.find(n => n.id === e.callerId);
  return { caller: caller?.name ?? e.callerId, callee: e.calleeName, file: caller?.filePath ?? '' };
}
async function safeBuild(files: InFile[]): Promise<SerializedCallGraph> {
  if (files.length === 0) return emptyGraph();
  try {
    return serializeCallGraph(await new CallGraphBuilder().build(files));
  } catch {
    return emptyGraph();
  }
}
function emptyGraph(): SerializedCallGraph {
  return { nodes: [], edges: [], classes: [], inheritanceEdges: [], hubFunctions: [], entryPoints: [], layerViolations: [],
    stats: { totalNodes: 0, totalEdges: 0, avgFanIn: 0, avgFanOut: 0 } };
}
function emptySummary() {
  return { addedFunctions: 0, removedFunctions: 0, signatureChanges: 0, addedEdges: 0, removedEdges: 0, staleCallers: 0, renameCandidates: 0 };
}
function diffSoundness(empty: boolean): { posture: string; caveats: string[] } {
  const caveats = [
'A cross-file pair sharing a content-addressed stable id (name + parameter shape) is reported as a move with confidence "stable-id" — a strong signal, but NOT proof: a symbol that was deleted and independently replaced by a same-name/same-shape homonym is indistinguishable, so verify rather than assume "same symbol". The stable id is matched only when unique within the changed-file set (a same-shape symbol in an unchanged file is not considered). Identifier renames and symbols without a stable id (anonymous/synthetic) stay heuristic — paired by signature shape and reported separately.',
    'Signature-change detection is limited to what the analyzer extracts per language; cross-language signature notions differ.',
    'Edge deltas cover calls among/out of the changed files; calls into unchanged files resolve against the canonical graph for stale callers only.',
  ];
  if (empty) caveats.push('No code files changed — the structural delta is empty.');
  return { posture: 'structural-complement-to-git-diff', caveats };
}
