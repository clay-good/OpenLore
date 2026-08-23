/**
 * The `stale-decision-reference` finding (change: add-finding-enforcement-policy).
 *
 * OpenLore tracks decision supersession (`supersedes`, queryable via `asOf`) and
 * anchors memory to symbols, but a *live, authoritative artifact that still points
 * at a decision that has since been superseded* is only discoverable by manually
 * walking history. That is a textbook stale reference: the artifact asserts
 * something whose stated basis was retired.
 *
 * This module makes it a first-class deterministic finding. A live, authoritative
 * artifact is:
 *   - an approved/synced architectural decision (and not itself superseded),
 *   - a non-orphaned, non-invalidated anchored memory, or
 *   - a spec requirement,
 * that names a decision id that has since been superseded by an active decision.
 *
 * The supersession edge that performed the retirement is EXEMPT: a decision whose
 * `supersedes` points at the retired one is supposed to reference it. The check is
 * a pure walk of the decision graph + anchored references — no LLM (north star
 * `c6d1ad07`). It is surfaced through existing surfaces (`recall`, the gate), never
 * a new MCP tool.
 */

import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { PendingDecision, AnchoredMemory, MemoryFreshness } from '../../../types/index.js';
import { isEffectiveSuperseder } from './reversals.js';
import { loadDecisionStore } from '../../decisions/store.js';
import { loadMemoryStore } from '../../decisions/memory-store.js';
import { memoryFreshness, type GraphFreshnessView } from '../../decisions/anchor.js';
import { AnchorContext } from '../../decisions/anchor-adapter.js';
import { readOpenLoreConfig } from '../config-manager.js';
import { validateDirectory, safeOpenspecDir } from './utils.js';

/** Decision ids are sha1(...).slice(0,8) — exactly 8 lowercase-hex chars. */
const DECISION_ID = /\b[0-9a-f]{8}\b/g;

export interface StaleDecisionReferenceFinding {
  code: 'stale-decision-reference';
  /** Intrinsic severity, owned by this source (never altered by the enforcement policy). */
  severity: 'warning';
  /** The live, authoritative artifact that references the retired decision. */
  referencingArtifact: {
    kind: 'decision' | 'memory' | 'spec';
    /** Decision/memory id, or the spec file path. */
    id: string;
    /** A short human label (decision title / memory excerpt / spec heading). */
    label: string;
  };
  /** The retired (superseded) decision id being referenced. */
  retiredDecision: string;
  /** The decision that superseded it. */
  supersededBy: string;
  message: string;
}

/** The retirement graph: which decision ids are retired, and by whom. */
export interface RetirementGraph {
  /** retiredId → the id of the active decision that superseded it. */
  supersededBy: Map<string, string>;
  /** Every target of an effective supersession edge, even when no live terminal exists. */
  retiredDecisionIds: Set<string>;
  /** Supersession cycles, with both each cycle and the outer list stably sorted. */
  cycles: string[][];
}

/**
 * Build the retirement graph from the decision set: for every active superseding
 * decision C (`C.supersedes = B`), B is retired by C. Uses the SAME predicate as
 * the reversal/authoritative surfaces ({@link isEffectiveSuperseder}) so the two
 * never disagree about what counts as superseded.
 */
export function buildRetirementGraph(decisions: readonly PendingDecision[]): RetirementGraph {
  // Immediate superseders per target. Two decisions MAY supersede the same target
  // (e.g. two reversals); pick the lexicographically smallest id as the canonical
  // immediate superseder so the result is deterministic regardless of store order.
  const immediate = new Map<string, string>();
  for (const c of decisions) {
    if (!isEffectiveSuperseder(c)) continue;
    const target = c.supersedes!;
    const existing = immediate.get(target);
    if (existing === undefined || c.id < existing) immediate.set(target, c.id);
  }
  const retiredDecisionIds = [...immediate.keys()].sort(stableCompare);

  // Find cycles in the canonical immediate-superseder graph before resolving live
  // terminals. A cycle has no authoritative terminal decision; reporting one of its
  // members as the other's live replacement (or, worse, as its own replacement) would
  // manufacture authority. Canonicalize membership so consumers can emit one stable
  // finding per cycle regardless of decision-store order or cycle entry point.
  const cycleByKey = new Map<string, string[]>();
  for (const target of retiredDecisionIds) {
    const path: string[] = [];
    const position = new Map<string, number>();
    let cur = target;
    while (immediate.has(cur)) {
      const at = position.get(cur);
      if (at !== undefined) {
        const cycle = path.slice(at).sort(stableCompare);
        cycleByKey.set(cycle.join('\x00'), cycle);
        break;
      }
      position.set(cur, path.length);
      path.push(cur);
      cur = immediate.get(cur)!;
    }
  }
  const cycles = [...cycleByKey.values()].sort((a, b) => stableCompare(a.join('\x00'), b.join('\x00')));
  const cycleMembers = new Set(cycles.flat());

  // Resolve each retired target to its LIVE terminal superseder: if the immediate
  // superseder is itself retired (a chain A←B←C), follow to the live end so the
  // remediation never points the user at a decision that is also dead. Any chain that
  // enters a cycle is omitted because it has no live terminal replacement.
  const supersededBy = new Map<string, string>();
  for (const target of retiredDecisionIds) {
    let cur = immediate.get(target)!;
    while (immediate.has(cur) && !cycleMembers.has(cur)) {
      cur = immediate.get(cur)!;
    }
    if (!cycleMembers.has(cur)) supersededBy.set(target, cur);
  }
  return { supersededBy, retiredDecisionIds: new Set(retiredDecisionIds), cycles };
}

/** Map of retired target → the set of its immediate superseders (a target may have >1). */
function immediateSupersedersByTarget(decisions: readonly PendingDecision[]): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const c of decisions) {
    if (!isEffectiveSuperseder(c)) continue;
    const set = out.get(c.supersedes!) ?? new Set<string>();
    set.add(c.id);
    out.set(c.supersedes!, set);
  }
  return out;
}

/** All 8-hex decision-id tokens present in a piece of text. */
function hexTokensIn(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.matchAll(DECISION_ID)) out.add(m[0]);
  return out;
}

/** Locale-independent, byte-stable string compare for reproducible output across environments. */
function stableCompare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Split a markdown spec into heading-delimited blocks. Each block carries its nearest
 * heading and the full text from that heading up to (excluding) the next one, so the
 * retirement-record exemption can ask "does THIS block also contain the superseder id?"
 * — keeping a superseder's own ADR from flagging the id it documents retiring, while a
 * separate requirement that cites a retired decision still flags.
 */
function splitIntoBlocks(text: string): Array<{ heading: string; text: string }> {
  const blocks: Array<{ heading: string; lines: string[] }> = [{ heading: '', lines: [] }];
  for (const line of text.split('\n')) {
    if (/^#{1,6}\s/.test(line)) blocks.push({ heading: line.replace(/^#+\s*/, '').trim(), lines: [line] });
    else blocks[blocks.length - 1].lines.push(line);
  }
  return blocks.map((b) => ({ heading: b.heading, text: b.lines.join('\n') }));
}

/** A single stale reference: the retired decision a text cites and its active superseder. */
export interface StaleRef {
  retired: string;
  supersededBy: string;
}

/**
 * The stale references in a piece of text against a retirement graph — the reusable
 * core behind `recall`'s freshness signal. Returns one entry per distinct retired
 * decision the text cites (excluding the `exempt` supersedes edge). Empty when the
 * graph is empty or nothing is cited. Pure, no I/O.
 */
export function staleRefsInText(text: string, graph: RetirementGraph, exempt?: string): StaleRef[] {
  if (graph.supersededBy.size === 0) return [];
  const retired = new Set(graph.supersededBy.keys());
  return retiredIdsIn(text, retired, exempt).map((id) => ({ retired: id, supersededBy: graph.supersededBy.get(id)! }));
}

/** The retired-decision ids a text references, excluding `exempt` (the supersedes edge). */
function retiredIdsIn(text: string, retired: ReadonlySet<string>, exempt?: string): string[] {
  const found = new Set<string>();
  for (const m of text.matchAll(DECISION_ID)) {
    const id = m[0];
    if (id !== exempt && retired.has(id)) found.add(id);
  }
  return [...found];
}

function excerpt(s: string, max = 80): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

export interface StaleReferenceInputs {
  decisions: readonly PendingDecision[];
  memories: readonly AnchoredMemory[];
  /** Spec documents to scan, each as a file path + its full text. */
  specs: readonly { file: string; text: string }[];
  /** Freshness of a memory's anchors against the current graph (orphaned ⇒ not authoritative). */
  freshnessOf: (m: AnchoredMemory) => MemoryFreshness;
}

/**
 * Pure detector: walk the live, authoritative artifacts and emit one finding per
 * (artifact, retired decision) reference. Deterministic and order-independent —
 * findings are sorted by a stable key. No I/O, no LLM.
 */
export function findStaleDecisionReferences(input: StaleReferenceInputs): StaleDecisionReferenceFinding[] {
  const { supersededBy } = buildRetirementGraph(input.decisions);
  const retired = new Set(supersededBy.keys());
  if (retired.size === 0) return [];

  // Immediate superseders per target — used to exempt a spec block that is itself the
  // retirement record (a superseder's synced ADR legitimately names the id it retired).
  const immediateSuperseders = immediateSupersedersByTarget(input.decisions);
  const findings: StaleDecisionReferenceFinding[] = [];
  const emit = (
    kind: StaleDecisionReferenceFinding['referencingArtifact']['kind'],
    id: string,
    label: string,
    retiredId: string,
  ) => {
    findings.push({
      code: 'stale-decision-reference',
      severity: 'warning',
      referencingArtifact: { kind, id, label },
      retiredDecision: retiredId,
      supersededBy: supersededBy.get(retiredId)!,
      message:
        `${kind} ${kind === 'spec' ? label : id} references decision ${retiredId}, which was superseded by ` +
        `${supersededBy.get(retiredId)!}. Re-point it at the superseding decision or remove the stale basis.`,
    });
  };

  // (a) Approved/synced decisions that are not themselves retired. The supersedes
  // edge that performed a retirement is exempt; a self-reference is ignored.
  for (const d of input.decisions) {
    if (d.status !== 'approved' && d.status !== 'synced') continue;
    if (retired.has(d.id)) continue; // a retired decision is not current authoritative context
    const text = [d.title, d.rationale, d.consequences, d.proposedRequirement ?? ''].join('\n');
    for (const retiredId of retiredIdsIn(text, retired, d.supersedes)) {
      if (retiredId === d.id) continue;
      emit('decision', d.id, excerpt(d.title), retiredId);
    }
  }

  // (b) Non-orphaned, non-invalidated anchored memories.
  for (const m of input.memories) {
    if (m.invalidatedAt) continue;
    if (input.freshnessOf(m) === 'orphaned') continue; // never authoritative
    for (const retiredId of retiredIdsIn(m.content, retired)) {
      emit('memory', m.id, excerpt(m.content), retiredId);
    }
  }

  // (c) Spec requirements, scanned per heading-delimited block so a block can be
  // attributed to its requirement/decision heading AND so the retirement record itself
  // is exempt: a block that *documents* the supersession (it contains an immediate
  // superseder of the retired id — e.g. a superseder's own synced ADR) legitimately
  // names the id it retired and SHALL NOT be flagged. A block citing a retired decision
  // that is NOT its own superseder is a genuine stale reference and is flagged.
  for (const spec of input.specs) {
    for (const block of splitIntoBlocks(spec.text)) {
      const idsInBlock = hexTokensIn(block.text);
      for (const retiredId of retiredIdsIn(block.text, retired)) {
        const supers = immediateSuperseders.get(retiredId);
        const documentsRetirement = !!supers && [...idsInBlock].some((id) => supers.has(id));
        if (documentsRetirement) continue; // this block IS the retirement record — exempt
        const label = block.heading ? `${spec.file} › ${excerpt(block.heading, 60)}` : spec.file;
        emit('spec', spec.file, label, retiredId);
      }
    }
  }

  // Dedup by (kind, id, retired) and sort by a stable, locale-independent key so output
  // is reproducible across environments.
  const seen = new Set<string>();
  const deduped = findings.filter((f) => {
    const k = `${f.referencingArtifact.kind}\x00${f.referencingArtifact.id}\x00${f.retiredDecision}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  deduped.sort((a, b) =>
    stableCompare(
      `${a.referencingArtifact.kind} ${a.referencingArtifact.id} ${a.retiredDecision}`,
      `${b.referencingArtifact.kind} ${b.referencingArtifact.id} ${b.retiredDecision}`,
    ),
  );
  return deduped;
}

/** Recursively collect `*.md` spec files under `<openspecPath>/specs`, bounded. */
async function collectSpecFiles(specsRoot: string, max = 500): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    if (out.length >= max) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return; // missing dir is fine — no specs to scan
    }
    for (const e of entries) {
      if (out.length >= max) return;
      const full = join(dir, e.name);
      if (e.isDirectory()) await walk(full);
      else if (e.isFile() && e.name.endsWith('.md')) out.push(full);
    }
  }
  await walk(specsRoot);
  return out;
}

/**
 * Filesystem entry point: load the decision store, memory store, and synced specs,
 * resolve memory freshness against the current call graph, and run the pure
 * detector. Never throws for an infrastructure problem — a missing store/graph
 * degrades to "no findings" (advisory-safe), consistent with the other guards.
 */
export async function detectStaleDecisionReferences(directory: string): Promise<StaleDecisionReferenceFinding[]> {
  const rootPath = await validateDirectory(directory);
  const [decisionStore, memStore, config] = await Promise.all([
    loadDecisionStore(rootPath),
    loadMemoryStore(rootPath),
    readOpenLoreConfig(rootPath),
  ]);

  const ctx = AnchorContext.open(rootPath);
  // No graph ⇒ cannot prove orphaned; treat anchors as fresh (advisory finding only).
  const view: GraphFreshnessView = ctx
    ? ctx.freshnessView()
    : { nodeHash: () => undefined, fileExists: () => true, fileHash: () => undefined };
  const freshnessOf = (m: AnchoredMemory): MemoryFreshness => memoryFreshness(m.anchors, view).freshness;

  try {
    // `openspecPath` comes from the repo's own `.openlore/config.json`, and this
    // check runs from the pre-commit hook — so an unconfined join reads out-of-repo
    // `.md` files on the victim's first commit in a hostile clone.
    const specsRoot = join(safeOpenspecDir(rootPath, config?.openspecPath), 'specs');
    const specFiles = await collectSpecFiles(specsRoot);
    const specs = await Promise.all(
      specFiles.map(async (f) => ({
        file: f.slice(rootPath.length + 1),
        text: await readFile(f, 'utf-8').catch(() => ''),
      })),
    );
    return findStaleDecisionReferences({
      decisions: decisionStore.decisions,
      memories: memStore.memories,
      specs,
      freshnessOf,
    });
  } finally {
    ctx?.close();
  }
}
