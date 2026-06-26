/**
 * MCP tool handlers: code-anchored agent memory.
 * (change: add-code-anchored-memory-staleness)
 *
 *   remember — persist a durable, code-anchored note for any agent to recall later
 *   recall   — return memories relevant to a task, each with a deterministic
 *              freshness verdict; an orphaned memory is NEVER served as
 *              authoritative context (the bullet-proof guarantee).
 *
 * Notes live in .openlore/memory/notes.json, entirely separate from the decision
 * store and commit gate. Architectural decisions are recalled too (read-only) so
 * one call surfaces all anchored memory touching a task. Freshness is static
 * analysis only — no LLM. With no `task`, recall doubles as a memory-staleness
 * scan over everything persisted.
 */

import { validateDirectory, sanitizeMcpError } from './utils.js';
import { loadDecisionStore, INACTIVE_STATUSES } from '../../decisions/store.js';
import { loadMemoryStore, updateMemoryStore, makeMemoryId } from '../../decisions/memory-store.js';
import { AnchorContext } from '../../decisions/anchor-adapter.js';
import {
  memoryFreshness,
  decisionAnchors,
  findUnreconciled,
  isStaleRegionOnly,
  type GraphFreshnessView,
  type AnchoredItem,
} from '../../decisions/anchor.js';
import { getHeadCommit, resolveCommitSha, isAncestor } from '../../decisions/git-time.js';
import { queryTerms, scoreMemory, type RankFields } from './memory-ranking.js';
import { assembleBoundary, computeStaleness } from './confidence-boundary.js';
import { resolveFederationScope } from '../../federation/resolver.js';
import { findFleetMemory } from '../../federation/fleet-memory.js';
import { collectReversals, supersededDecisionIds } from './reversals.js';
import { buildRetirementGraph, staleRefsInText, type StaleRef } from './stale-decision-reference.js';
import {
  MEMORY_TYPES,
  type AnchoredMemory,
  type MemoryType,
  type StructuralAnchor,
  type PendingDecision,
  type AnchorVerdict,
  type GroundingCertificate,
} from '../../../types/index.js';

/** Normalize a caller-supplied type to the closed set; unknown/absent ⇒ `note`. No inference. */
function normalizeMemoryType(type?: string): MemoryType {
  return (type && (MEMORY_TYPES as readonly string[]).includes(type)) ? (type as MemoryType) : 'note';
}

// ── remember ────────────────────────────────────────────────────────────────

export interface AnchorHint {
  symbol?: string;
  file?: string;
}

export async function handleRemember(
  directory: string,
  content: string,
  anchorHints?: AnchorHint[],
  tags?: string[],
  type?: string,
  supersedes?: string,
): Promise<unknown> {
  try {
    if (!content?.trim()) return { error: 'content is required and must not be empty.' };
    const rootPath = await validateDirectory(directory);

    let anchors: StructuralAnchor[] = [];
    if (anchorHints?.length) {
      const ctx = AnchorContext.open(rootPath);
      if (ctx) {
        try {
          anchors = ctx.resolveInputAnchors(anchorHints);
        } finally {
          ctx.close();
        }
      } else {
        // No analysis yet — keep file hints as existence-only file anchors.
        anchors = anchorHints
          .filter((h) => h.file)
          .map((h) => ({ filePath: h.file! }));
      }
    }

    // Valid-time marker: the HEAD commit this memory describes (deterministic, no LLM).
    // Undefined in a non-git repo / pre-first-commit — the memory is then always-valid.
    const validFromCommit = await getHeadCommit(rootPath);

    const recordedAt = new Date().toISOString();
    // Identity is content + resolved anchors, so re-recording the same fact about the
    // same code updates in place (content-anchor dedup) instead of accumulating.
    const id = makeMemoryId(content.trim(), anchors);
    // A self-supersede (supersedes resolves to this same id — i.e. identical content+anchor)
    // is incoherent: there is nothing to retire and history would not be preserved. Drop the
    // supersede intent and treat it as the plain in-place update it actually is.
    const validSupersede = supersedes && supersedes !== id ? supersedes : undefined;

    const memory: AnchoredMemory = {
      id,
      kind: 'note',
      content: content.trim(),
      anchors,
      recordedAt,
      tags: tags?.length ? tags : undefined,
      type: normalizeMemoryType(type),
      ...(validFromCommit ? { validFromCommit } : {}),
      ...(validSupersede ? { supersedes: validSupersede } : {}),
    };

    // CAS update so concurrent remember calls never lose a write: the id-keyed
    // upsert is re-applied to the latest store on a write conflict. When `supersedes`
    // names a prior memory, mark it invalidated (it leaves the authoritative set per
    // the memory-integrity invariant, but stays queryable via `asOf` for history).
    const finalStore = await updateMemoryStore(rootPath, (store) => {
      const memories = store.memories.map((m) => {
        if (validSupersede && m.id === validSupersede && !m.invalidatedAt) {
          return {
            ...m,
            invalidatedAt: recordedAt,
            ...(validFromCommit ? { invalidatedByCommit: validFromCommit } : {}),
          };
        }
        return m;
      });
      // Dedup on content+anchor IDENTITY, not the stored id string. For new-scheme records
      // this is identical to `m.id !== memory.id` (id IS hash(content+anchors)). It additionally
      // catches a record persisted under the OLD id scheme (hash(content+recordedAt)) describing
      // the same fact+code, so re-recording it updates in place instead of leaving a silent
      // duplicate — honoring the content-anchor dedup invariant for pre-existing stores too.
      return {
        ...store,
        memories: [...memories.filter((m) => makeMemoryId(m.content, m.anchors) !== memory.id), memory],
      };
    });

    // Derive the outcome from the committed store rather than a closure side-effect, so the
    // reported result is the one that actually persisted regardless of CAS execution count.
    const supersededFound = !!validSupersede && finalStore.memories.some(
      (m) => m.id === validSupersede && m.invalidatedAt === recordedAt,
    );

    const supersedeNote = !supersedes
      ? undefined
      : supersedes === id
        ? `supersedes target "${supersedes}" is this same memory (identical content+anchor) — updated in place, nothing retired.`
        : supersededFound
          ? `Superseded prior memory ${supersedes} (now invalidated; queryable via asOf).`
          : `supersedes target "${supersedes}" was not found or already invalidated — recorded without retiring it.`;

    return {
      id: memory.id,
      type: memory.type,
      anchored: anchors.length > 0,
      validFromCommit: validFromCommit ?? null,
      anchors: anchors.map(summarizeAnchor),
      message: [
        anchors.length
          ? `Memory recorded with ${anchors.length} structural anchor(s).`
          : 'Memory recorded (unanchored — recall will not be able to verify it against code).',
        supersedeNote,
      ].filter(Boolean).join(' '),
    };
  } catch (err) {
    return { error: sanitizeMcpError(err) };
  }
}

// ── recall ────────────────────────────────────────────────────────────────────

interface RecalledMemory {
  kind: 'note' | 'decision';
  id: string;
  text: string;
  freshness: 'fresh' | 'drifted' | 'orphaned';
  anchored: boolean;
  /** Caller-supplied classification (notes only); decisions omit it. */
  type?: MemoryType;
  /** Bitemporal valid-from marker (notes only), when known. */
  validFromCommit?: string;
  /** Set on a memory returned by `asOf`/`changedSince` that has since been invalidated. */
  invalidated?: boolean;
  /**
   * Set on non-fresh memories: do not treat as authoritative without checking.
   * When `staleRegion` is also set the cause is a not-yet-recomputed topology, NOT
   * a code change (the anchored code is byte-identical).
   */
  verify?: boolean;
  /**
   * Set when the memory is non-fresh ONLY because its anchored file sits in an
   * explicitly-marked stale region (a budget-exceeded incremental update has not
   * recomputed its topology yet). The code is unchanged and this self-heals — it
   * is a "not yet reconciled" signal, not "the code changed"
   * (fix-transitive-incremental-staleness).
   */
  staleRegion?: boolean;
  anchors: ReturnType<typeof summarizeVerdict>[];
  recordedAt?: string;
  /** Why this memory ranked where it did (set only when a task was given). */
  match?: { fields: string[]; anchorBoost: boolean };
  /**
   * Set only on `fresh` facts: the span is provably unchanged since analysis, so
   * re-reading it is unnecessary. The token lever (add-trust-calibrated-context-economy).
   */
  verifiedCurrent?: boolean;
  /** Evidence behind a `fresh` verdict; absent on drifted/orphaned facts. */
  certificates?: GroundingCertificate[];
  /**
   * Set when this authoritative memory references a decision that has since been
   * superseded (the `stale-decision-reference` finding). Its stated basis is stale,
   * so it is NOT presented as cleanly fresh. (add-finding-enforcement-policy)
   */
  staleDecisionRef?: StaleRef[];
  score: number;
}

export async function handleRecall(
  directory: string,
  task?: string,
  limit = 10,
  tokenBudget?: number,
  asOf?: string,
  changedSince?: string,
  typeFilter?: string,
  federation?: boolean,
  federationRepos?: string[],
): Promise<unknown> {
  try {
    const rootPath = await validateDirectory(directory);

    const [memStore, decisionStore] = await Promise.all([
      loadMemoryStore(rootPath),
      loadDecisionStore(rootPath),
    ]);

    // ── Bitemporal scoping (add-bitemporal-typed-memory-operations) ────────────
    // `asOf` / `changedSince` resolve a commit-ish to a SHA and compare each note's
    // valid-time markers via git ancestry — opt-in, so the common path shells out to
    // git zero times. Decisions are governed by the gate/sync lifecycle, not the memory
    // bitemporal model, so they are excluded whenever a temporal filter is active.
    const warnings: string[] = [];
    const asOfSha = asOf ? await resolveCommitSha(rootPath, asOf) : undefined;
    if (asOf && !asOfSha) warnings.push(`asOf "${asOf}" did not resolve to a commit — ignoring it.`);
    const sinceSha = changedSince ? await resolveCommitSha(rootPath, changedSince) : undefined;
    if (changedSince && !sinceSha) warnings.push(`changedSince "${changedSince}" did not resolve to a commit — ignoring it.`);
    const temporal = !!(asOfSha || sinceSha);

    // A combined asOf + changedSince window holds memories with sinceSha < validFrom ≤ asOfSha,
    // which can only be non-empty when changedSince is a STRICT ancestor of asOf. Otherwise the
    // intersection is empty by construction — warn so the caller can tell that apart from a
    // genuine "no matches" rather than getting a silent, indistinguishable empty result.
    if (asOfSha && sinceSha) {
      const strictAncestor = sinceSha !== asOfSha && (await isAncestor(rootPath, sinceSha, asOfSha));
      if (!strictAncestor) {
        warnings.push('changedSince must be a strict ancestor of asOf for the combined window to be non-empty — nothing can be both authoritative as of the earlier commit and changed after the later one.');
      }
    }

    const wantType = normalizeMemoryTypeFilter(typeFilter);
    if (typeFilter && !wantType) warnings.push(`type "${typeFilter}" is not a known memory type — ignoring the filter.`);

    // Decide which notes are in scope before scoring. Without a temporal filter,
    // invalidated notes are history and excluded entirely (the integrity invariant).
    const noteInScope = await selectNotesInScope(rootPath, memStore.memories, { asOfSha, sinceSha });

    const ctx = AnchorContext.open(rootPath);
    const view: GraphFreshnessView = ctx
      ? ctx.freshnessView()
      : { nodeHash: () => undefined, fileExists: () => false, fileHash: () => undefined };

    try {
      const terms = queryTerms(task ?? '');
      const hasQuery = terms.length > 0;
      const items: RecalledMemory[] = [];

      // A `fresh`, anchored fact carries a grounding certificate per anchor — the
      // evidence behind the verdict — and is marked verified-current. Computed only
      // when the graph is available (ctx) and the verdict is `fresh`; drifted/
      // orphaned facts never carry either. (add-trust-calibrated-context-economy)
      const certify = (freshness: string, anchors: StructuralAnchor[]): Pick<RecalledMemory, 'verifiedCurrent' | 'certificates'> => {
        if (freshness !== 'fresh' || !ctx) return {};
        const certificates = anchors
          .map((a) => ctx.certificateForAnchor(a))
          .filter((c): c is GroundingCertificate => !!c);
        return certificates.length ? { verifiedCurrent: true, certificates } : {};
      };

      // Track the freshness-anchor view of every authoritative memory (pre-limit) so
      // contradiction detection sees the full set, not a `limit`-truncated slice.
      const contradictionItems: AnchoredItem[] = [];

      // The retirement graph (which decisions were superseded, and by whom) drives the
      // stale-decision-reference signal: an authoritative memory whose content cites a
      // retired decision is not presented as cleanly fresh. (add-finding-enforcement-policy)
      const retirement = buildRetirementGraph(decisionStore.decisions);

      for (const m of memStore.memories) {
        if (!noteInScope.has(m.id)) continue;           // out of temporal scope / invalidated
        if (wantType && (m.type ?? 'note') !== wantType) continue; // type filter
        const f = memoryFreshness(m.anchors, view);
        const r = scoreMemory(terms, {
          anchorSymbols: m.anchors.map((a) => a.symbolName).filter((s): s is string => !!s),
          tags: m.tags ?? [],
          anchorFiles: m.anchors.map((a) => a.filePath),
          content: m.content,
        });
        const invalidated = !!m.invalidatedAt;
        // Only an authoritative (non-orphaned, non-invalidated) memory carries the signal;
        // an orphaned/invalidated one is never served as authoritative in the first place.
        const staleRefs = !invalidated && f.freshness !== 'orphaned'
          ? staleRefsInText(m.content, retirement)
          : [];
        items.push({
          kind: 'note',
          id: m.id,
          text: m.content,
          freshness: f.freshness,
          anchored: f.anchored,
          type: m.type ?? 'note',
          ...(m.validFromCommit ? { validFromCommit: m.validFromCommit } : {}),
          ...(invalidated ? { invalidated: true } : {}),
          verify: f.freshness === 'drifted' || staleRefs.length > 0 ? true : undefined,
          ...(isStaleRegionOnly(f.verdicts) ? { staleRegion: true } : {}),
          anchors: f.verdicts.map(summarizeVerdict),
          recordedAt: m.recordedAt,
          match: hasQuery ? { fields: r.matched, anchorBoost: r.anchorBoost } : undefined,
          // A stale-decision-reference suppresses the clean `verifiedCurrent` claim: the
          // anchor may be fresh, but the fact's stated basis was retired.
          ...(staleRefs.length > 0 ? { staleDecisionRef: staleRefs } : certify(f.freshness, m.anchors)),
          score: r.score,
        });
        contradictionItems.push({ id: m.id, anchors: m.anchors, freshness: f.freshness, invalidated });
      }

      // Decisions are outside the bitemporal model — skip them when a temporal filter
      // or a type filter is active (they are untyped and lifecycle-governed).
      if (!temporal && !wantType) {
        // A decision superseded by another (pre-consolidation, still draft/approved/
        // verified) must not be served as authoritative — it surfaces only under
        // `reversals`. Same predicate as collectReversals so the two never disagree.
        const supersededIds = supersededDecisionIds(decisionStore.decisions);
        for (const d of activeDecisions(decisionStore.decisions)) {
          if (supersededIds.has(d.id)) continue;
          const anchors = decisionAnchors(d);
          const f = memoryFreshness(anchors, view);
          const r = scoreMemory(terms, decisionFields(d, anchors));
          items.push({
            kind: 'decision',
            id: d.id,
            text: d.title,
            freshness: f.freshness,
            anchored: f.anchored,
            verify: f.freshness === 'drifted' ? true : undefined,
            ...(isStaleRegionOnly(f.verdicts) ? { staleRegion: true } : {}),
            anchors: f.verdicts.map(summarizeVerdict),
            recordedAt: d.recordedAt,
            match: hasQuery ? { fields: r.matched, anchorBoost: r.anchorBoost } : undefined,
            ...certify(f.freshness, anchors),
            score: r.score,
          });
          contradictionItems.push({ id: d.id, anchors, freshness: f.freshness });
        }
      }

      // Deterministic contradiction surfacing: two authoritative (fresh, non-invalidated)
      // memories on the same symbol are `unreconciled` — flagged, never double-served.
      // Computed over the score-filtered set so a task scopes it, but before `limit` so
      // truncation can never hide a contradiction.
      const inScoreScope = hasQuery
        ? new Set(items.filter((i) => i.score > 0).map((i) => i.id))
        : null;
      const unreconciled = findUnreconciled(
        inScoreScope ? contradictionItems.filter((i) => inScoreScope.has(i.id)) : contradictionItems,
      );

      const filtered = (hasQuery ? items.filter((i) => i.score > 0) : items)
        .sort((a, b) => b.score - a.score || (b.recordedAt ?? '').localeCompare(a.recordedAt ?? ''))
        .slice(0, Math.max(1, limit));

      // The bullet-proof guarantee: orphaned memories never sit in `authoritative`.
      const authoritative = filtered.filter((i) => i.freshness !== 'orphaned');
      const needsReanchoring = filtered.filter((i) => i.freshness === 'orphaned');

      // Budget-aware tiering: with a tokenBudget, return the highest grounding-
      // density facts first (verified-current core), then the tail as budget
      // allows; report what was withheld — never a silent cap. No budget = full set.
      let authoritativeOut = authoritative;
      let budget: { tokenBudget: number; returned: number; withheld: number } | undefined;
      if (typeof tokenBudget === 'number' && tokenBudget > 0 && authoritative.length) {
        const ordered = [...authoritative].sort(
          (a, b) => Number(!!b.verifiedCurrent) - Number(!!a.verifiedCurrent),
        ); // stable sort preserves the score order within each tier
        const kept: RecalledMemory[] = [];
        let used = 0;
        for (const item of ordered) {
          const cost = estimateItemTokens(item);
          if (kept.length > 0 && used + cost > tokenBudget) break;
          kept.push(item);
          used += cost;
        }
        authoritativeOut = kept;
        budget = { tokenBudget, returned: kept.length, withheld: authoritative.length - kept.length };
      }

      const budgetNote = budget && budget.withheld > 0
        ? `tokenBudget truncated the tail: ${budget.withheld} additional authoritative fact(s) withheld — raise tokenBudget or omit it to see them.`
        : undefined;
      const reanchorNote = needsReanchoring.length
        ? 'needsReanchoring entries reference code that no longer exists — do not treat them as authoritative; re-record them against current code.'
        : undefined;
      const staleRefCount = authoritativeOut.filter((i) => i.staleDecisionRef?.length).length;
      const staleRefNote = staleRefCount
        ? `${staleRefCount} authoritative memor${staleRefCount === 1 ? 'y references a' : 'ies reference a'} superseded decision (see staleDecisionRef) — verify the basis before relying on it.`
        : undefined;
      const unreconciledNote = unreconciled.length
        ? `${unreconciled.length} symbol(s) have two or more authoritative memories — reconcile or supersede one (see unreconciled).`
        : undefined;

      // Fleet-level memory (ADR-0019): opt-in cross-repo recall. Surface memories
      // recorded in producer repos and anchored to interfaces THIS (consumer) repo
      // references, each with its producer-side freshness verdict. Orphaned/retired
      // producer memories are withheld by findFleetMemory (the authoritative-recall
      // invariant across the boundary). Deterministic, lazy per-repo load, no LLM.
      let fleetMemory:
        | { memories: unknown[]; decisions: unknown[]; reposConsulted: string[]; reposSkipped: Array<{ name: string; state: string; reason?: string }>; caveats: string[]; note?: string }
        | undefined;
      const fedScope = resolveFederationScope(rootPath, { federation, federationRepos });
      if (fedScope.active) {
        const fleet = await findFleetMemory(rootPath, fedScope);
        const cov = fleet.coverage;
        if (fleet.memories.length > 0 || fleet.decisions.length > 0 || cov.reposConsulted.length > 0 || cov.reposSkipped.length > 0) {
          fleetMemory = {
            memories: fleet.memories,
            decisions: fleet.decisions,
            reposConsulted: cov.reposConsulted.map((r) => r.name),
            reposSkipped: cov.reposSkipped.map((r) => ({ name: r.name, state: r.state, reason: r.reason })),
            caveats: cov.caveats,
            ...(fleet.truncated > 0 ? { note: `${fleet.truncated} more fleet record(s) not shown — cap reached.` } : {}),
          };
        }
      }

      // Reversal-briefing (the dedicated recall surface for ReversalAwareness): reverted/
      // superseded intent relevant to this recall, surfaced as do-not-repeat warnings via
      // the same shared logic as orient. Scoped by TASK relevance (not current-memory files)
      // so a fully-reverted approach surfaces even when no current memory anchors to its file.
      // With no task, everything reverted is in scope (bounded by the omission cap).
      const scoreInScope = (fields: RankFields): boolean => !hasQuery || scoreMemory(terms, fields).score > 0;
      const reversals = collectReversals(memStore.memories, decisionStore.decisions, {
        memoryInScope: (m) => scoreInScope({
          anchorSymbols: m.anchors.map((a) => a.symbolName).filter((s): s is string => !!s),
          tags: m.tags ?? [],
          anchorFiles: m.anchors.map((a) => a.filePath),
          content: m.content,
        }),
        decisionInScope: (a) => scoreInScope(decisionFields(a, decisionAnchors(a))),
      });

      return {
        task: task ?? null,
        graphAvailable: ctx !== null,
        ...(asOfSha ? { asOf: asOfSha } : {}),
        ...(sinceSha ? { changedSince: sinceSha } : {}),
        ...(wantType ? { type: wantType } : {}),
        total: filtered.length,
        summary: {
          fresh: filtered.filter((i) => i.freshness === 'fresh').length,
          drifted: filtered.filter((i) => i.freshness === 'drifted').length,
          orphaned: needsReanchoring.length,
        },
        authoritative: authoritativeOut.map(stripScore),
        needsReanchoring: needsReanchoring.map(stripScore),
        unreconciled: unreconciled.length ? unreconciled : undefined,
        ...(reversals !== undefined ? { reversals } : {}),
        ...(fleetMemory !== undefined ? { fleetMemory } : {}),
        budget,
        note: [budgetNote, reanchorNote, staleRefNote, unreconciledNote, ...warnings].filter(Boolean).join(' ') || undefined,
        // Recall does no graph traversal — its boundary is the freshness of the
        // index the anchors were checked against (per-memory verdicts cover the
        // rest). (spec: add-confidence-boundary-disclosure)
        confidenceBoundary: assembleBoundary({ staleness: await computeStaleness(rootPath) }),
      };
    } finally {
      ctx?.close();
    }
  } catch (err) {
    return { error: sanitizeMcpError(err) };
  }
}

// ── helpers ─────────────────────────────────────────────────────────────────

function activeDecisions(decisions: PendingDecision[]): PendingDecision[] {
  return decisions.filter((d) => !INACTIVE_STATUSES.has(d.status));
}

/** Normalize a caller `type` filter to the closed set; unknown ⇒ undefined (no filter). */
function normalizeMemoryTypeFilter(type?: string): MemoryType | undefined {
  if (!type) return undefined;
  return (MEMORY_TYPES as readonly string[]).includes(type) ? (type as MemoryType) : undefined;
}

/**
 * The set of note ids in scope for this recall (add-bitemporal-typed-memory-operations).
 * Without a temporal filter, every non-invalidated note is in scope (invalidated notes are
 * history). With `asOf` / `changedSince`, scope is decided by git-ancestry comparison of the
 * note's valid-time markers — deterministic and reproducible for a fixed repo state.
 */
async function selectNotesInScope(
  rootPath: string,
  memories: readonly AnchoredMemory[],
  opts: { asOfSha?: string; sinceSha?: string },
): Promise<Set<string>> {
  const { asOfSha, sinceSha } = opts;
  if (!asOfSha && !sinceSha) {
    return new Set(memories.filter((m) => !m.invalidatedAt).map((m) => m.id));
  }
  const inScope = new Set<string>();
  for (const m of memories) {
    let keep = true;
    if (asOfSha) keep = keep && (await isAuthoritativeAsOf(rootPath, m, asOfSha));
    if (sinceSha) keep = keep && (await isChangedSince(rootPath, m, sinceSha));
    if (keep) inScope.add(m.id);
  }
  return inScope;
}

/** A note is authoritative as of `asOfSha`: recorded at/before it and not invalidated at/before it. */
async function isAuthoritativeAsOf(rootPath: string, m: AnchoredMemory, asOfSha: string): Promise<boolean> {
  const recordedBefore = !m.validFromCommit || (await isAncestor(rootPath, m.validFromCommit, asOfSha));
  if (!recordedBefore) return false;
  if (!m.invalidatedAt) return true;
  // Invalidated but no commit anchor ⇒ cannot place on the commit axis; treat as already retired.
  if (!m.invalidatedByCommit) return false;
  return !(await isAncestor(rootPath, m.invalidatedByCommit, asOfSha));
}

/** A note changed after `sinceSha`: its record commit, or its invalidation commit, is a strict descendant. */
async function isChangedSince(rootPath: string, m: AnchoredMemory, sinceSha: string): Promise<boolean> {
  if (
    m.validFromCommit && m.validFromCommit !== sinceSha &&
    (await isAncestor(rootPath, sinceSha, m.validFromCommit))
  ) {
    return true;
  }
  return !!(
    m.invalidatedByCommit && m.invalidatedByCommit !== sinceSha &&
    (await isAncestor(rootPath, sinceSha, m.invalidatedByCommit))
  );
}

/** Map a decision onto the ranker's weighted fields. */
function decisionFields(d: PendingDecision, anchors: StructuralAnchor[]): RankFields {
  return {
    anchorSymbols: anchors.map((a) => a.symbolName).filter((s): s is string => !!s),
    tags: d.affectedDomains ?? [],
    anchorFiles: d.affectedFiles,
    content: `${d.title} ${d.rationale}`,
  };
}

function summarizeAnchor(a: StructuralAnchor): { symbol?: string; file: string; level: 'symbol' | 'file' } {
  return { symbol: a.symbolName, file: a.filePath, level: a.nodeId ? 'symbol' : 'file' };
}

function summarizeVerdict(v: AnchorVerdict): {
  symbol?: string;
  file: string;
  level: 'symbol' | 'file';
  freshness: 'fresh' | 'drifted' | 'orphaned';
  relocatedTo?: string;
  staleRegion?: boolean;
  carriedAcross?: StructuralAnchor['carriedAcross'];
  possiblyMovedTo?: string[];
} {
  return {
    ...summarizeAnchor(v.anchor),
    freshness: v.freshness,
    relocatedTo: v.relocatedTo,
    // Distinguishes "drifted because its topology wasn't recomputed yet" from
    // "drifted because the code changed" (fix-transitive-incremental-staleness).
    ...(v.staleRegion ? { staleRegion: true } : {}),
    // This anchor was carried across a rename/move; recall surfaces the provenance
    // so the agent sees the fact survived a refactor (add-symbol-identity-continuity).
    ...(v.anchor.carriedAcross ? { carriedAcross: v.anchor.carriedAcross } : {}),
    // An orphaned anchor with ambiguous candidate destinations — disclosed, never
    // silently re-attached to a guess (add-symbol-identity-continuity). Only meaningful
    // while the anchor is still orphaned; once it resolves (carried, or the symbol came
    // back), a previously-stored hint is stale and is not surfaced.
    ...(v.freshness === 'orphaned' && v.anchor.possiblyMovedTo?.length ? { possiblyMovedTo: v.anchor.possiblyMovedTo } : {}),
  };
}

function stripScore(i: RecalledMemory): Omit<RecalledMemory, 'score'> {
  const { score: _score, ...rest } = i;
  void _score;
  return rest;
}

/**
 * Deterministic token estimate for one recalled fact, used only to apportion a
 * caller-supplied tokenBudget. Char-count/4 over the serialized payload — a fixed
 * heuristic, not a tuning constant that changes ranking.
 */
function estimateItemTokens(i: RecalledMemory): number {
  return Math.ceil(JSON.stringify(stripScore(i)).length / 4);
}
