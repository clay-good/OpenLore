/**
 * Memory trigger predicates: the right memory pushes itself into the briefing, deterministically.
 * (change: add-memory-trigger-predicates)
 *
 * A note recorded with `remember` may carry one trigger from a closed union — a file glob, a
 * symbol-name pattern, a spec domain, or "my anchor lies within N call hops of a touched symbol" —
 * and a `pinned` flag. The briefing tools (`orient`, `blast_radius`, and `working_set_context`
 * through orient) evaluate the triggers against the touched set they already computed and push the
 * matching notes' content into the briefing, each with a receipt naming the predicate that fired.
 *
 * Evaluation is set membership plus one bounded backward walk; no LLM interprets a trigger. A
 * trigger widens WHEN a note surfaces, never WHETHER it is trustworthy: every pushed note carries
 * its freshness verdict, and an orphaned note is never pushed as content — it is listed apart,
 * exactly as `recall` segregates it.
 */

import { Minimatch } from 'minimatch';
import { memoryFreshness, isStaleRegionOnly, type GraphFreshnessView } from '../../decisions/anchor.js';
import { MEMORY_TYPES, type AnchoredMemory, type MemoryTrigger, type MemoryType } from '../../../types/index.js';
import type { TraversalIndex } from '../../analyzer/condensation.js';
import { SUBGRAPH_MAX_DEPTH_LIMIT } from '../../../constants.js';

/** Longest accepted glob, pattern, or domain name. Triggers are repo content and caller-supplied. */
const MAX_TRIGGER_TEXT_LENGTH = 256;

/** Deepest `withinHops` accepted — the same cap `select_tests` puts on its backward walk. */
export const MAX_TRIGGER_HOPS = SUBGRAPH_MAX_DEPTH_LIMIT;

/** Most notes pushed into one briefing — `recall`'s default limit. The rest are counted, never dropped silently. */
export const MAX_INJECTED_MEMORIES = 10;

/**
 * Glob options: no brace expansion (`{a,b}{c,d}…` grows exponentially), no extglobs (their
 * backtracking is the ReDoS surface), and `!` / `#` are literal rather than negation or comment.
 */
const GLOB_OPTIONS = { dot: true, nobrace: true, noext: true, nonegate: true, nocomment: true } as const;

const TRIGGER_KINDS = ['fileGlob', 'symbolPattern', 'specDomain', 'withinHops'] as const;

/** The predicate that pushed a note, with what it matched. */
export type FiredPredicate =
  | { kind: 'pinned' }
  | { kind: 'fileGlob'; pattern: string; matched: string }
  | { kind: 'symbolPattern'; pattern: string; matched: string }
  | { kind: 'specDomain'; domain: string }
  | { kind: 'withinHops'; hops: number; matched: string; distance: number };

/** What a briefing touched: the sets each trigger kind is evaluated against. */
export interface TouchedSet {
  files: readonly string[];
  symbols: ReadonlyArray<{ id?: string; name: string; className?: string }>;
  domains: readonly string[];
}

/** A note pushed into a briefing: its content plus the receipt (id, fired predicate, verdict). */
export interface InjectedMemory {
  id: string;
  type: MemoryType;
  content: string;
  firedPredicate: FiredPredicate;
  freshness: 'fresh' | 'drifted';
  anchored: boolean;
  provenance: 'local-unreviewed';
  /** Set on a drifted note: do not treat as authoritative without checking. */
  verify?: true;
  /** Set when the drift is only a not-yet-recomputed stale region, not a code change. */
  staleRegion?: true;
}

/** A note whose trigger matched but whose anchors are gone: listed, never pushed as content. */
export interface StaleTriggeredMemory {
  id: string;
  firedPredicate: FiredPredicate;
  freshness: 'orphaned';
}

export interface MemoryInjection {
  injected: InjectedMemory[];
  stale: StaleTriggeredMemory[];
  /** Matching notes past {@link MAX_INJECTED_MEMORIES} (authoritative and stale counted separately). */
  omitted: number;
  staleOmitted: number;
}

/**
 * The view used when no graph is available: nothing can be verified, so every anchored note reads
 * as orphaned — the same judgement `recall` makes without a graph.
 */
export const UNVERIFIABLE_VIEW: GraphFreshnessView = {
  nodeHash: () => undefined,
  fileExists: () => false,
  fileHash: () => undefined,
};

// ── validation ──────────────────────────────────────────────────────────────

/**
 * Validate a caller-supplied trigger. Exactly one key from the closed union; strings non-empty and
 * bounded; `withinHops` an integer in [1, {@link MAX_TRIGGER_HOPS}]. A malformed trigger is an
 * error, never stored and silently ignored.
 */
export function validateMemoryTrigger(raw: unknown): { trigger: MemoryTrigger } | { error: string } {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { error: `trigger must be an object with exactly one of: ${TRIGGER_KINDS.join(', ')}.` };
  }
  const keys = Object.keys(raw);
  if (keys.length !== 1 || !(TRIGGER_KINDS as readonly string[]).includes(keys[0])) {
    return { error: `trigger must have exactly one of: ${TRIGGER_KINDS.join(', ')} (got ${keys.length ? keys.join(', ') : 'none'}).` };
  }
  const kind = keys[0] as (typeof TRIGGER_KINDS)[number];
  const value = (raw as Record<string, unknown>)[kind];
  if (kind === 'withinHops') {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > MAX_TRIGGER_HOPS) {
      return { error: `trigger.withinHops must be an integer from 1 to ${MAX_TRIGGER_HOPS}.` };
    }
    return { trigger: { withinHops: value } };
  }
  if (typeof value !== 'string' || value.trim().length === 0) {
    return { error: `trigger.${kind} must be a non-empty string.` };
  }
  if (value.length > MAX_TRIGGER_TEXT_LENGTH) {
    return { error: `trigger.${kind} is too long: ${value.length} characters (max ${MAX_TRIGGER_TEXT_LENGTH}).` };
  }
  if (/[\r\n]/.test(value)) return { error: `trigger.${kind} must be a single line.` };
  const text = value.trim();
  if (kind === 'fileGlob') return { trigger: { fileGlob: text.replace(/^\.\//, '') } };
  if (kind === 'symbolPattern') return { trigger: { symbolPattern: text } };
  return { trigger: { specDomain: text } };
}

/**
 * Re-validate a trigger read from `notes.json`. The store is committed repo content, so a
 * hand-edited trigger outside the closed union is ignored here rather than evaluated.
 */
export function storedTrigger(m: AnchoredMemory): MemoryTrigger | undefined {
  if (m.trigger === undefined) return undefined;
  const v = validateMemoryTrigger(m.trigger);
  return 'trigger' in v ? v.trigger : undefined;
}

// ── evaluation ──────────────────────────────────────────────────────────────

/**
 * Answers "does a touched symbol reach one of these anchor nodes within `hops` call hops?" with
 * the nearest touched symbol and its distance. Built once per briefing over a traversal index.
 */
export type HopProbe = (anchorNodeIds: readonly string[], hops: number) => { matched: string; distance: number } | undefined;

/**
 * A {@link HopProbe} over `traversal`: one backward walk from the anchor nodes, depth-bounded by
 * `hops`, intersected with the touched symbol ids. Deterministic: the nearest touched symbol wins,
 * ties broken by name.
 */
export function makeHopProbe(
  traversal: TraversalIndex,
  touched: TouchedSet['symbols'],
): HopProbe {
  const touchedById = new Map<string, string>();
  for (const s of touched) if (s.id) touchedById.set(s.id, s.className ? `${s.className}.${s.name}` : s.name);
  return (anchorNodeIds, hops) => {
    if (touchedById.size === 0) return undefined;
    const seeds = anchorNodeIds.filter(id => traversal.hasNode(id));
    if (seeds.length === 0) return undefined;
    const depth = traversal.bfsDepths(seeds, 'backward', Math.min(hops, MAX_TRIGGER_HOPS), undefined, { sortNeighbors: true });
    let best: { matched: string; distance: number } | undefined;
    for (const [id, d] of depth) {
      const name = touchedById.get(id);
      if (name === undefined) continue;
      if (!best || d < best.distance || (d === best.distance && name < best.matched)) best = { matched: name, distance: d };
    }
    return best;
  };
}

/** True when some note in `memories` could fire a `withinHops` trigger — so the walk is only paid when needed. */
export function needsHopProbe(memories: readonly AnchoredMemory[]): boolean {
  return memories.some(m => {
    if (m.invalidatedAt) return false;
    const trigger = storedTrigger(m);
    return trigger !== undefined && 'withinHops' in trigger;
  });
}

/** The node ids a note's symbol anchors resolve to now: the recorded id, else its stable-id relocation. */
function anchorNodeIds(m: AnchoredMemory, view: GraphFreshnessView): string[] {
  const ids: string[] = [];
  for (const a of m.anchors) {
    if (a.nodeId) ids.push(a.nodeId);
    if (a.stableId) {
      const relocated = view.resolveStableId?.(a.stableId);
      if (relocated && relocated.nodeId !== a.nodeId) ids.push(relocated.nodeId);
    }
  }
  return ids;
}

function firstMatch(patternText: string, candidates: readonly string[]): string | undefined {
  const mm = new Minimatch(patternText, GLOB_OPTIONS);
  return [...candidates].sort().find(c => mm.match(c));
}

/** The predicate that fires for `m` against `touched`, or undefined. A trigger is reported over `pinned`. */
function firedPredicate(
  m: AnchoredMemory,
  touched: TouchedSet,
  view: GraphFreshnessView,
  probe: HopProbe | undefined,
): FiredPredicate | undefined {
  const trigger = storedTrigger(m);
  if (trigger) {
    if ('fileGlob' in trigger) {
      const matched = firstMatch(trigger.fileGlob, touched.files);
      if (matched !== undefined) return { kind: 'fileGlob', pattern: trigger.fileGlob, matched };
    } else if ('symbolPattern' in trigger) {
      const names = touched.symbols.flatMap(s => (s.className ? [s.name, `${s.className}.${s.name}`] : [s.name]));
      const matched = firstMatch(trigger.symbolPattern, names);
      if (matched !== undefined) return { kind: 'symbolPattern', pattern: trigger.symbolPattern, matched };
    } else if ('specDomain' in trigger) {
      if (touched.domains.includes(trigger.specDomain)) return { kind: 'specDomain', domain: trigger.specDomain };
    } else if (probe) {
      const hit = probe(anchorNodeIds(m, view), trigger.withinHops);
      if (hit) return { kind: 'withinHops', hops: trigger.withinHops, matched: hit.matched, distance: hit.distance };
    }
  }
  return m.pinned === true ? { kind: 'pinned' } : undefined;
}

/**
 * Select the notes a briefing pushes: every live note whose trigger matches `touched`, plus every
 * pinned note when `includePinned`. Each carries its freshness verdict; an orphaned note goes to
 * `stale` (receipt only, no content). The order is deterministic — trigger matches before pinned,
 * then newest first, then id — and both lists are bounded by {@link MAX_INJECTED_MEMORIES} with the
 * remainder counted.
 */
export function selectInjectedMemories(
  memories: readonly AnchoredMemory[],
  touched: TouchedSet,
  view: GraphFreshnessView,
  opts: { includePinned: boolean; probe?: HopProbe },
): MemoryInjection {
  const fired: Array<{ m: AnchoredMemory; p: FiredPredicate }> = [];
  for (const m of memories) {
    if (m.invalidatedAt) continue;
    if (!opts.includePinned && storedTrigger(m) === undefined) continue;
    const p = firedPredicate(m, touched, view, opts.probe);
    if (!p || (p.kind === 'pinned' && !opts.includePinned)) continue;
    fired.push({ m, p });
  }
  fired.sort((a, b) =>
    Number(a.p.kind === 'pinned') - Number(b.p.kind === 'pinned') ||
    (b.m.recordedAt ?? '').localeCompare(a.m.recordedAt ?? '') ||
    a.m.id.localeCompare(b.m.id));

  const injected: InjectedMemory[] = [];
  const stale: StaleTriggeredMemory[] = [];
  let omitted = 0;
  let staleOmitted = 0;
  for (const { m, p } of fired) {
    const f = memoryFreshness(m.anchors, view);
    if (f.freshness === 'orphaned') {
      if (stale.length < MAX_INJECTED_MEMORIES) stale.push({ id: m.id, firedPredicate: p, freshness: 'orphaned' });
      else staleOmitted++;
      continue;
    }
    if (injected.length >= MAX_INJECTED_MEMORIES) { omitted++; continue; }
    injected.push({
      id: m.id,
      // The stored type is repo content: outside the closed set it reads as `note`, as in recall.
      type: m.type && (MEMORY_TYPES as readonly string[]).includes(m.type) ? m.type : 'note',
      content: m.content,
      firedPredicate: p,
      freshness: f.freshness,
      anchored: f.anchored,
      provenance: 'local-unreviewed',
      ...(f.freshness === 'drifted' ? { verify: true as const } : {}),
      ...(isStaleRegionOnly(f.verdicts) ? { staleRegion: true as const } : {}),
    });
  }
  return { injected, stale, omitted, staleOmitted };
}

/**
 * The briefing fields for an injection: `injectedMemories` (content + receipt), `staleTriggeredMemories`
 * (receipt only), and a note when either list was bounded. Empty object when nothing fired.
 */
export function injectionFields(inj: MemoryInjection): {
  injectedMemories?: InjectedMemory[];
  staleTriggeredMemories?: StaleTriggeredMemory[];
  injectedMemoriesNote?: string;
} {
  const notes: string[] = [];
  if (inj.omitted > 0) notes.push(`${inj.omitted} more triggered or pinned memor${inj.omitted === 1 ? 'y' : 'ies'} matched but ${inj.omitted === 1 ? 'was' : 'were'} not pushed (cap ${MAX_INJECTED_MEMORIES}) — call recall to see them.`);
  if (inj.staleOmitted > 0) notes.push(`${inj.staleOmitted} more orphaned triggered memor${inj.staleOmitted === 1 ? 'y' : 'ies'} not listed (cap ${MAX_INJECTED_MEMORIES}).`);
  if (inj.stale.length > 0) notes.push('staleTriggeredMemories reference code that no longer exists — not served as authoritative; re-record them against current code.');
  return {
    ...(inj.injected.length > 0 ? { injectedMemories: inj.injected } : {}),
    ...(inj.stale.length > 0 ? { staleTriggeredMemories: inj.stale } : {}),
    ...(notes.length > 0 ? { injectedMemoriesNote: notes.join(' ') } : {}),
  };
}
