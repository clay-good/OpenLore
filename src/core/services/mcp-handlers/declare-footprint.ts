/**
 * `declare_footprint` — publish this agent's intended write-set and read-set to the clone's peer
 * board and learn, in the same response, which live peers it collides with
 * (change: add-peer-footprint-board).
 *
 * Seeds resolve through the same footprint machinery as `plan_parallel_work`; hazards come from the
 * same classifier (WAW / shared-append / RAW / WAR / soft-coupling), plus `duplicate-intent` when two
 * agents are about to create the same symbol name or file. Advisory: nothing is locked or blocked.
 * Peer entries are local, unreviewed data: their text is screened before it is served.
 *
 * Siblings: `plan_parallel_work` plans a caller-supplied task list; `map_in_flight_conflicts` maps
 * branches, PRs, and these live entries; `fleet_status` lists them with the verification arc.
 */

import { basename } from 'node:path';
import { validateDirectory, readCachedContext, diagnoseIndexUnservable } from './utils.js';
import { computeFootprint, classifyHazard, type Footprint, type WriteMode } from './change-footprint.js';
import type { SerializedCallGraph, FunctionNode } from '../../analyzer/call-graph.js';
import {
  readBoard, pruneEnded, writeEntry, removeEntry, worktreeIdentity, symbolHash,
  MAX_BOARD_ENTRIES, MAX_SET_SYMBOLS, type BoardEntry, type BoardSymbol,
} from '../footprint-board.js';
import { readFileConfined } from '../../../utils/path-confinement.js';
import { emittedText, WITHHELD_TEXT } from '../generated-file-guard.js';
import { classifyFindings, effectivePolicy, type GovernanceFinding } from './enforcement-policy.js';
import { readOpenLoreConfig } from '../config-manager.js';

export interface DeclareFootprintInput {
  directory: string;
  /** `declare` (default), `release`, or `list`. */
  action?: 'declare' | 'release' | 'list';
  /** Stable id of this agent; default `<branch>@<worktree folder>`. */
  actorId?: string;
  /** Short task title (≤120 characters; screened). */
  title?: string;
  /** Symbols or files this agent intends to write. Names that do not exist yet are intended creations. */
  writeSet?: string[];
  /** Symbols or files this agent's work depends on. */
  readSet?: string[];
  writeMode?: WriteMode;
}

const TITLE_MAX = 120;
const ACTOR_RE = /^[\w.@:/+-]{1,128}$/;

/**
 * The key two intended creations collide on: the bare symbol name (`src/url.ts::normalizeUrl` and
 * `normalizeUrl` are the same intent), or the file path for a file.
 */
const creationKey = (seed: string): string => {
  if (seed.includes('::')) return `name:${seed.slice(seed.lastIndexOf('::') + 2)}`;
  return seed.includes('/') || /\.[A-Za-z]{1,5}$/.test(seed) ? `file:${seed}` : `name:${seed}`;
};

function screenTitle(raw: string | undefined): { title?: string; titleWithheld?: boolean } {
  if (!raw || !raw.trim()) return {};
  const t = emittedText(raw.trim());
  if (t === WITHHELD_TEXT) return { titleWithheld: true };
  return { title: t.length > TITLE_MAX ? `${t.slice(0, TITLE_MAX - 1)}…` : t };
}

/** A footprint's members as board symbols, with the hash of their text at declaration. */
async function toBoardSymbols(root: string, cg: SerializedCallGraph, members: ReadonlyArray<{ id: string; name: string; filePath: string }>): Promise<BoardSymbol[]> {
  const byId = new Map(cg.nodes.map(n => [n.id, n as FunctionNode] as const));
  const texts = new Map<string, string | null>();
  const out: BoardSymbol[] = [];
  for (const m of members.slice(0, MAX_SET_SYMBOLS)) {
    const n = byId.get(m.id) as (FunctionNode & { startIndex?: number; endIndex?: number }) | undefined;
    const sym: BoardSymbol = { id: m.id, name: m.name, file: m.filePath };
    if (n && typeof n.startIndex === 'number' && typeof n.endIndex === 'number') {
      if (!texts.has(m.filePath)) texts.set(m.filePath, await readFileConfined(root, m.filePath, 4 * 1024 * 1024).catch(() => null));
      const text = texts.get(m.filePath);
      if (text) Object.assign(sym, { start: n.startIndex, end: n.endIndex, hash: symbolHash(text.slice(n.startIndex, n.endIndex)) });
    }
    out.push(sym);
  }
  return out;
}

/** A peer's footprint against this worktree's index, its declared reads joined to its read region. */
function footprintOf(cg: SerializedCallGraph, e: Pick<BoardEntry, 'actorId' | 'writeSeeds' | 'reads' | 'writeMode'>): Footprint {
  // No write seeds → an empty write region (the footprint never invents one).
  const fp = computeFootprint(cg, { id: e.actorId, seedSymbols: e.writeSeeds, ...(e.writeMode ? { writeMode: e.writeMode } : {}) });
  const reads = new Set([...fp.readSet, ...e.reads.map(r => r.id)]);
  return { ...fp, readSet: [...reads].sort() };
}

const peerView = (e: BoardEntry, moved: string[]) => ({
  actorId: emittedText(e.actorId),
  worktree: emittedText(e.worktree),
  branch: emittedText(e.branch),
  ...(e.title ? { title: emittedText(e.title) } : {}),
  ...(e.titleWithheld ? { titleWithheld: true } : {}),
  writes: e.writes.map(w => emittedText(w.name)),
  reads: e.reads.map(r => emittedText(r.name)),
  creates: e.creates.map(emittedText),
  declaredAt: e.declaredAt,
  lastSeenAt: e.lastSeenAt,
  ...(moved.length ? { movedSinceDeclared: moved.map(emittedText) } : {}),
  provenance: 'local-unreviewed' as const,
});

export async function handleDeclareFootprint(input: DeclareFootprintInput): Promise<Record<string, unknown>> {
  const root = await validateDirectory(input.directory);
  const action = input.action ?? 'declare';
  let identity: Awaited<ReturnType<typeof worktreeIdentity>>;
  try { identity = await worktreeIdentity(root); } catch { return { error: 'Not a git work tree: the board lives in the git common directory.' }; }
  const actorId = input.actorId?.trim() || `${identity.branch || 'detached'}@${basename(identity.worktree)}`;
  if (!ACTOR_RE.test(actorId)) return { error: 'actorId must be 1-128 characters: letters, digits, and . _ @ : / + -' };

  if (action === 'release') {
    const released = await removeEntry(root, actorId);
    return { tool: 'declare_footprint', action, actorId, released, ...(released ? {} : { note: 'No live entry had this actorId.' }) };
  }

  if (action === 'list') {
    const board = await readBoard(root);
    return {
      tool: 'declare_footprint', action, posture: 'advisory',
      live: board.live.map(l => peerView(l.entry, l.moved)),
      ...(board.ended.length ? { ended: board.ended.map(e => ({ actorId: emittedText(e.actorId), reason: e.reason })) } : {}),
      boundaries: board.boundaries,
    };
  }

  // ── declare ──
  const writeSeeds = [...new Set((input.writeSet ?? []).map(s => s.trim()).filter(Boolean))];
  const readSeeds = [...new Set((input.readSet ?? []).map(s => s.trim()).filter(Boolean))];
  if (!writeSeeds.length && !readSeeds.length) return { error: 'Provide writeSet or readSet: the symbols or files this agent will write or depend on.' };
  if (writeSeeds.length > MAX_SET_SYMBOLS || readSeeds.length > MAX_SET_SYMBOLS) return { error: `At most ${MAX_SET_SYMBOLS} seeds per set.` };
  const ctx = await readCachedContext(root);
  if (!ctx) return (await diagnoseIndexUnservable(root)) as unknown as Record<string, unknown>;
  if (!ctx.callGraph) return { error: 'Call graph not available. Re-run analyze_codebase.' };
  const cg = ctx.callGraph as SerializedCallGraph;

  const writeFp = writeSeeds.length ? computeFootprint(cg, { id: actorId, seedSymbols: writeSeeds, ...(input.writeMode ? { writeMode: input.writeMode } : {}) }) : null;
  const readFp = readSeeds.length ? computeFootprint(cg, { id: `${actorId}#reads`, seedSymbols: readSeeds }) : null;
  const board = await readBoard(root);
  await pruneEnded(board.ended);
  const existing = board.live.find(l => l.entry.actorId === actorId)?.entry;
  if (!existing && board.live.length >= MAX_BOARD_ENTRIES) return { error: `The board already holds ${MAX_BOARD_ENTRIES} live entries; release finished ones first.` };

  const now = new Date().toISOString();
  const entry: BoardEntry = {
    version: 1,
    actorId,
    worktree: identity.worktree,
    branch: identity.branch,
    ...screenTitle(input.title),
    writeSeeds,
    readSeeds,
    writes: writeFp ? await toBoardSymbols(root, cg, writeFp.writeSet) : [],
    reads: readFp ? await toBoardSymbols(root, cg, readFp.writeSet) : [],
    creates: writeFp ? writeFp.unresolvedSeeds : [],
    ...(identity.baseAtDeclare ? { baseAtDeclare: identity.baseAtDeclare } : {}),
    ...(input.writeMode ? { writeMode: input.writeMode } : {}),
    declaredAt: existing?.declaredAt ?? now,
    lastSeenAt: now,
  };
  try { await writeEntry(root, entry); } catch (e) { return { error: `Could not write the board entry: ${e instanceof Error ? e.message : String(e)}` }; }

  // ── Hazards against every live peer ──
  const name = new Map(cg.nodes.map(n => [n.id, `${n.name} (${n.filePath})`] as const));
  const mine = footprintOf(cg, entry);
  const myCreates = new Map(entry.creates.map(c => [creationKey(c), c] as const));
  const findings: GovernanceFinding[] = [];
  const peers = [];
  for (const { entry: p, moved } of board.live) {
    if (p.actorId === actorId) continue;
    const v = classifyHazard(mine, footprintOf(cg, p));
    const dup = p.creates.filter(c => myCreates.has(creationKey(c)));
    const peerId = emittedText(p.actorId);
    if (v.kind === 'WAW') {
      findings.push({ code: 'parallel-work-conflict', severity: 'warning', source: 'declare-footprint', subject: `${actorId} × ${peerId}`,
        message: emittedText(`Write-write conflict with ${p.actorId} (${p.branch || 'detached'} in ${p.worktree}) on ${v.witnesses.slice(0, 3).map(w => name.get(w) ?? w).join(', ')}.`) });
    }
    if (dup.length) {
      findings.push({ code: 'duplicate-intent', severity: 'warning', source: 'declare-footprint', subject: `${actorId} × ${peerId}`,
        message: emittedText(`Both ${actorId} and ${p.actorId} intend to create ${dup.slice(0, 3).join(', ')}.`) });
    }
    if (v.kind === 'none' && !dup.length) continue;
    peers.push({
      ...peerView(p, moved),
      hazard: dup.length && v.kind === 'none' ? 'duplicate-intent' : v.kind,
      ...(v.kind !== 'none' ? { witnesses: v.witnesses.slice(0, 20).map(w => emittedText(name.get(w) ?? w)) } : {}),
      ...(v.direction ? { direction: v.direction } : {}),
      ...(dup.length ? { duplicateIntent: dup.map(emittedText) } : {}),
    });
  }

  let policy;
  try { policy = effectivePolicy(await readOpenLoreConfig(root)); } catch { policy = undefined; }
  const gate = classifyFindings(findings, policy);
  const boundaries = [
    ...board.boundaries,
    'Peers\' seeds are resolved against this worktree\'s index; a symbol that exists only in a peer\'s worktree is compared by name.',
  ];
  return {
    tool: 'declare_footprint',
    action,
    posture: 'advisory',
    entry: {
      actorId, worktree: entry.worktree, branch: entry.branch,
      ...(entry.title ? { title: entry.title } : {}), ...(entry.titleWithheld ? { titleWithheld: true } : {}),
      writes: entry.writes.map(w => `${w.name} (${w.file})`),
      reads: entry.reads.map(r => `${r.name} (${r.file})`),
      creates: entry.creates,
    },
    livePeers: board.live.filter(l => l.entry.actorId !== actorId).length,
    conflicts: peers,
    findings: gate.classified.filter(f => f.enforcementClass !== 'off'),
    gated: gate.gated,
    ...(board.ended.length ? { ended: board.ended.map(e => ({ actorId: emittedText(e.actorId), reason: e.reason })) } : {}),
    boundaries,
    note: 'Advisory: nothing is locked. Release the entry when the work lands (action: release); it also ends when the branch is merged or deleted, the worktree is removed, or it is not refreshed for 30 minutes.',
  };
}
