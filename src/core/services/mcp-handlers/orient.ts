/**
 * `orient` — composite orientation tool.
 *
 * Given a natural-language task description, returns in ONE call:
 *  - Relevant functions (semantic search or BM25 fallback)
 *  - Unique source files involved
 *  - Spec domains that cover those files
 *  - Depth-1 call neighbourhood for each top function
 *  - Top insertion point candidates
 *  - Matching spec sections (if spec index is available)
 *
 * Designed as the single entry point agents use at the start of any task,
 * replacing the need to chain analyze_codebase → search_code → search_specs
 * → suggest_insertion_points manually.
 */

import { join, relative } from 'node:path';
import { readFile, stat } from 'node:fs/promises';
import type { SerializedCallGraph } from '../../analyzer/call-graph.js';
import { validateDirectory, loadMappingIndex, specsForFile, functionsForDomain, readCachedContext, safeJoin, safeOpenspecDir, queryTooLongError } from './utils.js';
import { expandHandle, applyTokenBudget, collapseExactDuplicates, omissionNote } from './progressive.js';
import { readOpenLoreConfig } from '../config-manager.js';
import { isIacLanguage } from '../../analyzer/iac/types.js';
import type { RagManifest } from '../../generator/rag-manifest-generator.js';
import { ARTIFACT_RAG_MANIFEST, ARTIFACT_STYLE_FINGERPRINT } from '../../../constants.js';
import { loadArchitectureRules } from '../../architecture/rules.js';
import {
  compactIdiomSummary,
  STYLE_FINGERPRINT_LANGUAGES,
  type StyleFingerprint,
  type LanguageProfile,
} from '../../analyzer/style-fingerprint.js';
import { scanViolations } from '../../architecture/check.js';
import {
  classifyRole,
  deriveStrategy,
  compositeScore,
  buildReason,
} from './semantic.js';
import { memoryFreshness, decisionAnchors, findUnreconciled, isStaleRegionOnly, type AnchoredItem, type UnreconciledGroup } from '../../decisions/anchor.js';
import { makeFreshnessView } from '../../decisions/anchor-adapter.js';
import { loadMemoryStore } from '../../decisions/memory-store.js';
import type { MemoryFreshness } from '../../../types/index.js';

import { type Reversal, collectReversals, fileScope, supersededDecisionIds } from './reversals.js';
import { getSourceRoots, moduleFromPath } from './epistemic-lease.js';
import { readHotspotArtifact, hotspotsForModules } from './behavioral-hotspots.js';

// ============================================================================
// MANIFEST CACHE
// ============================================================================

interface CondensedEntry {
  content: string;
  mtime: number;
}

interface ManifestCache {
  manifest: RagManifest;
  /** mtimeMs of rag-manifest.json at load time */
  fileMtime: number;
  /** condensed spec content keyed by specPath, each with its own mtime */
  condensed: Map<string, CondensedEntry>;
}

/** One cache entry per project directory (MCP server is long-lived). */
const _manifestCache = new Map<string, ManifestCache>();

/** Load (or return cached) RagManifest. Returns undefined on any error. */
async function loadManifestCached(manifestPath: string, cacheKey: string): Promise<ManifestCache | undefined> {
  try {
    const mtime = (await stat(manifestPath)).mtimeMs;
    const cached = _manifestCache.get(cacheKey);
    if (cached && cached.fileMtime === mtime) return cached;
    const raw = await readFile(manifestPath, 'utf-8');
    const entry: ManifestCache = {
      manifest: JSON.parse(raw) as RagManifest,
      fileMtime: mtime,
      condensed: cached?.condensed ?? new Map(),
    };
    _manifestCache.set(cacheKey, entry);
    return entry;
  } catch {
    return undefined;
  }
}

/** Load (or return cached) condensed spec content for a single spec file. */
async function loadCondensedCached(cache: ManifestCache, absSpecPath: string, specPath: string): Promise<string | undefined> {
  try {
    const mtime = (await stat(absSpecPath)).mtimeMs;
    const cached = cache.condensed.get(specPath);
    if (cached && cached.mtime === mtime) return cached.content;
    const raw = await readFile(absSpecPath, 'utf-8');
    const content = condenseSpec(raw);
    cache.condensed.set(specPath, { content, mtime });
    return content;
  } catch {
    return undefined;
  }
}

// ============================================================================
// TYPES
// ============================================================================

interface OrientFunction {
  name: string;
  filePath: string;
  score: number;
  /** Exact expansion handle (Spec 25 P2): get_function_body(directory, filePath, name). */
  expand: string;
  signature?: string;
  docstring?: string;
  language: string;
  fanIn: number;
  fanOut: number;
  isHub: boolean;
  isEntryPoint: boolean;
  linkedSpecs: Array<{ requirement: string; domain: string; specFile: string }>;
  /** Other files holding an exact copy, when collapsed under a token budget (P3). */
  duplicateOf?: string[];
}

interface CallNeighbour {
  name: string;
  filePath: string;
  /** Present only for infrastructure neighbors (IaC resources) — spec-17 cross-domain. */
  domain?: 'infra';
}

interface OrientCallPath {
  function: string;
  filePath: string;
  callers: CallNeighbour[];
  callees: CallNeighbour[];
}

interface OrientInsertionPoint {
  rank: number;
  name: string;
  filePath: string;
  role: string;
  strategy: string;
  reason: string;
  score: number;
}

interface OrientSpecMatch {
  domain: string;
  section: string;
  title: string;
  score: number;
  text: string;
}

interface InlineSpec {
  domain: string;
  specPath: string;
  sourceFiles: string[];
  dependsOn: string[];
  calledBy: string[];
  /** Condensed spec content: Purpose + Dependencies section + Requirement names with file:line */
  content: string;
}

// ============================================================================
// HANDLER
// ============================================================================

export async function handleOrient(
  directory: string,
  task: string,
  limit = 5,
  tokenBudget?: number,
  lean = false,
  rankBy: 'distance' | 'pagerank' = 'distance',
): Promise<unknown> {
  const tooLong = queryTooLongError(task, 'task'); if (tooLong) return tooLong;
  const absDir = await validateDirectory(directory);
  const outputDir = join(absDir, '.openlore', 'analysis');

  const { VectorIndex } = await import('../../analyzer/vector-index.js');
  const { resolveEmbedder, servedRetrievalMode } = await import('../../analyzer/embedder.js');
  const { SpecVectorIndex } = await import('../../analyzer/spec-vector-index.js');

  const hasCodeIndex = VectorIndex.exists(outputDir);
  const hasSpecIndex = SpecVectorIndex.exists(outputDir);

  if (!hasCodeIndex) {
    return {
      error: 'No analysis found. Run "openlore analyze" first.',
      hint: 'Plain "openlore analyze" builds a keyword (BM25) index that orient can use; add EMBED_* (or --embed) for semantic search.',
    };
  }

  // Resolve the active embedder (env → local provider → remote config); null is
  // the first-class keyword default, never an error. `searchMode` stays an
  // internal score-scale token (bounded `hybrid` vs unbounded keyword) for the
  // relevance gate; `retrievalMode` is the honest, human-facing mode.
  const cfg = await readOpenLoreConfig(absDir);
  const embedSvc = await resolveEmbedder(cfg);
  const retrievalMode = servedRetrievalMode(embedSvc, outputDir, 'code');
  const searchMode = retrievalMode === 'keyword' ? 'bm25_fallback' : 'hybrid';

  const clampedLimit = Math.max(1, Math.min(limit, 20));

  // ── Parallel data loading ──────────────────────────────────────────────────
  const [rawResults, mappingIdx, llmCtx] = await Promise.all([
    VectorIndex.search(outputDir, task, embedSvc, { limit: clampedLimit * 3 }),
    loadMappingIndex(absDir),
    readCachedContext(absDir),
  ]);


  // ── Relevant functions (top-N) ────────────────────────────────────────────
  // Exclude external synthetic nodes (fetch, https.request, etc.) — they have no spec/docstring
  const topResults = rawResults
    .filter(r => r.record.filePath !== 'external' && !r.record.id?.startsWith('external::'))
    .slice(0, clampedLimit);

  const relevantFunctionsAll: OrientFunction[] = topResults.map(r => ({
    name: r.record.name,
    filePath: r.record.filePath,
    score: parseFloat(r.score.toFixed(3)),
    expand: expandHandle(r.record.name, r.record.filePath),
    signature: r.record.signature || undefined,
    docstring: r.record.docstring || undefined,
    language: r.record.language,
    fanIn: r.record.fanIn,
    fanOut: r.record.fanOut,
    isHub: r.record.isHub,
    isEntryPoint: r.record.isEntryPoint,
    linkedSpecs: mappingIdx ? specsForFile(mappingIdx, r.record.filePath) : [],
  }));

  // Progressive disclosure (Spec 25 P2–P4): when a tokenBudget is set, collapse
  // exact duplicates then greedily keep the highest-scored functions that fit.
  // Default (no budget) is unchanged. The `expand` handle on every kept item
  // means a dropped/collapsed body is one cheap get_function_body call away.
  const budgeted = tokenBudget
    ? applyTokenBudget(collapseExactDuplicates(relevantFunctionsAll), tokenBudget)
    : { kept: relevantFunctionsAll, omitted: 0 };
  const relevantFunctions = budgeted.kept;

  // ── Relevant files (deduplicated) ─────────────────────────────────────────
  const relevantFiles = [...new Set(relevantFunctions.map(f => f.filePath))];

  // ── RIG-20: cross-graph spec traversal — seed → spec domains → peer functions ──
  // Surfaces implementations linked via the spec even when the call graph
  // doesn't connect them to the seed functions.
  type SpecLinkedFunction = { name: string; filePath: string; domain: string; requirement: string };
  const specLinkedFunctions: SpecLinkedFunction[] = [];
  if (!lean && mappingIdx && relevantFunctions.length > 0) {
    const seedDomains = new Set<string>();
    for (const fn of relevantFunctions) {
      for (const spec of fn.linkedSpecs) seedDomains.add(spec.domain);
    }
    const seedFileSet = new Set(relevantFiles);
    const seen = new Set<string>();
    for (const domain of seedDomains) {
      for (const fn of functionsForDomain(mappingIdx, domain)) {
        const key = `${fn.name}::${fn.file}`;
        if (seen.has(key) || seedFileSet.has(fn.file)) continue;
        seen.add(key);
        specLinkedFunctions.push({ name: fn.name, filePath: fn.file, domain, requirement: fn.requirement });
      }
    }
  }

  // ── Spec domains covering those files ─────────────────────────────────────
  const domainScores = new Map<string, { specFile: string; matchCount: number }>();
  if (mappingIdx) {
    for (const filePath of relevantFiles) {
      const specs = specsForFile(mappingIdx, filePath);
      for (const s of specs) {
        const prev = domainScores.get(s.domain) ?? { specFile: s.specFile, matchCount: 0 };
        domainScores.set(s.domain, { ...prev, matchCount: prev.matchCount + 1 });
      }
    }
  }
  const specDomains = [...domainScores.entries()]
    .sort((a, b) => b[1].matchCount - a[1].matchCount)
    .slice(0, 5)
    .map(([domain, { specFile, matchCount }]) => ({ domain, specFile, matchCount }));

  // ── Call paths for each top function ──────────────────────────────────────
  const callPaths: OrientCallPath[] = topResults.map(r => {
    if (!llmCtx?.edgeStore) {
      return { function: r.record.name, filePath: r.record.filePath, callers: [], callees: [] };
    }
    const es = llmCtx.edgeStore;
    // Tag IaC resources so an agent can tell infrastructure neighbors from code (spec-17).
    const toNeighbour = (n: ReturnType<typeof es.getNode>): CallNeighbour | null =>
      n && !n.isExternal
        ? { name: n.name, filePath: n.filePath, ...(isIacLanguage(n.language) ? { domain: 'infra' as const } : {}) }
        : null;
    const callers = es.getCallers(r.record.id)
      .map(e => toNeighbour(es.getNode(e.callerId)))
      .filter((x): x is CallNeighbour => x !== null)
      .slice(0, 5);
    const callees = es.getCallees(r.record.id)
      .map(e => toNeighbour(es.getNode(e.calleeId)))
      .filter((x): x is CallNeighbour => x !== null)
      .slice(0, 5);
    return { function: r.record.name, filePath: r.record.filePath, callers, callees };
  });

  // ── Insertion points (lightweight: reuse rawResults with structural scoring) ──
  // Normalise search scores to [0, 1] for compositeScore (scores are RRF/BM25: higher = better)
  const maxRawScore = rawResults.length > 0 ? Math.max(...rawResults.map(r => r.score)) : 1;
  const normalise = (s: number) => maxRawScore > 0 ? s / maxRawScore : 0;

  const insertionCandidates = rawResults.map(r => {
    const role     = classifyRole(r.record.fanIn, r.record.fanOut, r.record.isHub, r.record.isEntryPoint);
    const strategy = deriveStrategy(role);
    const score    = compositeScore(normalise(r.score), role);
    return {
      name: r.record.name,
      filePath: r.record.filePath,
      role, strategy, score,
      reason: buildReason(r.record.name, role, strategy, r.record.fanIn, r.record.fanOut),
    };
  });
  insertionCandidates.sort((a, b) => b.score - a.score);
  const insertionPoints: OrientInsertionPoint[] = insertionCandidates
    .slice(0, 3)
    .map((c, i) => ({ rank: i + 1, ...c, score: parseFloat(c.score.toFixed(3)) }));

  // ── Enrichment (Spec 27, deepened) ─────────────────────────────────────────
  // Everything from here down is dropped by lean mode (it returns the navigation
  // `core` only). Spec 27 P1 trimmed the lean *payload* but still computed this
  // enrichment and threw it away — an extra embedding search (matchingSpecs),
  // manifest + spec-file reads (inlineSpecs), a decision-store load, git-derived
  // blocks, and a dependency-graph scan, all wasted on a shallow lookup. Each
  // block is now guarded by `!lean`, so lean skips the *work*, not just the
  // bytes: it makes the shallow-task path measurably faster, not only smaller.

  // ── Spec search (best-effort — skipped if spec index not available) ────────
  let matchingSpecs: OrientSpecMatch[] | undefined;
  if (!lean && hasSpecIndex) {  // embedSvc may be null — SpecVectorIndex.search falls back to BM25
    try {
      const specResults = await SpecVectorIndex.search(outputDir, task, embedSvc, { limit: 3 });
      matchingSpecs = specResults.map(r => ({
        domain: r.record.domain,
        section: r.record.section,
        title: r.record.title,
        score: parseFloat(r.score.toFixed(3)),
        text: r.record.text.slice(0, 300) + (r.record.text.length > 300 ? '…' : ''),
      }));
    } catch {
      // non-fatal — spec index may be corrupt or unavailable
    }
  }

  // ── Inline spec purpose from RAG manifest ─────────────────────────────────
  let inlineSpecs: InlineSpec[] | undefined;
  if (!lean && specDomains.length > 0) {
    try {
      const cfg = await readOpenLoreConfig(absDir);
      // Confine the configured openspec dir to the root (config is untrusted input).
      const manifestPath = join(safeOpenspecDir(absDir, cfg?.openspecPath), ARTIFACT_RAG_MANIFEST);
      const manifestCache = await loadManifestCached(manifestPath, absDir);
      if (manifestCache) {
        const { manifest } = manifestCache;
        const specs = await Promise.all(
          specDomains.slice(0, 3).map(async sd => {
            const entry = manifest.domains.find(d => d.domain.toLowerCase() === sd.domain.toLowerCase());
            if (!entry) return null;
            // entry.specPath comes from the RAG manifest (a .openlore artifact —
            // untrusted per the threat model). Confine it to the root so a poisoned
            // manifest can't redirect this read outside the project (mcp-security).
            let absSpecPath: string;
            try {
              absSpecPath = safeJoin(absDir, entry.specPath);
            } catch {
              return null;
            }
            const content = await loadCondensedCached(manifestCache, absSpecPath, entry.specPath);
            if (!content) return null;
            const MAX_SOURCE_FILES = 8;
            const relFiles = entry.sourceFiles.map(f =>
              f.startsWith(absDir) ? f.slice(absDir.length).replace(/^\//, '') : f,
            );
            const sourceFiles = relFiles.length > MAX_SOURCE_FILES
              ? [...relFiles.slice(0, MAX_SOURCE_FILES), `… and ${relFiles.length - MAX_SOURCE_FILES} more`]
              : relFiles;
            return {
              domain: sd.domain,
              specPath: entry.specPath,
              sourceFiles,
              dependsOn: entry.dependsOn,
              calledBy: entry.calledBy,
              content,
            } satisfies InlineSpec;
          }),
        );
        const filtered = specs.filter((s): s is InlineSpec => s !== null);
        if (filtered.length > 0) inlineSpecs = filtered;
      }
    } catch {
      // non-fatal — manifest may not exist yet (generate not yet run)
    }
  }

  // ── Pending decisions (best-effort) ──────────────────────────────────────
  // Active (non-synced) decisions relevant to this task's domains or files.
  // Synced decisions appear via the vector index (domain "decisions") in matchingSpecs.
  interface DecisionSummary {
    id: string;
    title: string;
    status: string;
    affectedDomains: string[];
    /** Deterministic freshness of the decision against the current graph (spec: code-anchored memory). */
    freshness?: MemoryFreshness;
    /** Set when freshness is `drifted`: do not treat as authoritative without checking. */
    verify?: boolean;
    /**
     * Set when the decision is non-fresh ONLY because its anchored file sits in an
     * explicitly-marked stale region (a budget-exceeded incremental update has not
     * recomputed its topology yet). The code is byte-identical and this self-heals —
     * a "not yet reconciled" signal, not "the code changed" (matches `recall`;
     * fix-transitive-incremental-staleness).
     */
    staleRegion?: boolean;
  }
  let pendingDecisions: DecisionSummary[] | undefined;
  // Decisions whose code anchors are gone — surfaced separately, NEVER as
  // authoritative context (the bullet-proof guarantee). The agent must re-anchor
  // or sync them rather than act on them.
  let staleDecisions: DecisionSummary[] | undefined;
  // Two authoritative memories on the same symbol — flagged, never double-served
  // (add-bitemporal-typed-memory-operations). Computed across the decisions surfaced
  // here plus the task-relevant `remember` notes.
  let unreconciledMemories: UnreconciledGroup[] | undefined;
  // Reverted/superseded intent in scope, surfaced as do-not-repeat warnings
  // (ReversalAwareness). Read from the bitemporal supersession record + decision
  // supersedes links; never re-served as authoritative current context.
  let reversals: Reversal[] | undefined;
  // Ids of decisions superseded by another (shared by every authoritative decision
  // surface below — pendingDecisions and governingDecisions — so a superseded decision
  // is never served as current intent on any of them). Populated in the block below.
  let supersededIds: ReadonlySet<string> = new Set<string>();
  if (!lean) try {
    const { loadDecisionStore, INACTIVE_STATUSES } = await import('../../decisions/store.js');
    const store = await loadDecisionStore(absDir);
    const relevantDomainSet = new Set(specDomains.map((s) => s.domain));
    const relevantFileSet = new Set(relevantFiles);
    // A decision superseded by another (and not yet flipped to `rejected` by
    // consolidation — which may never run without an LLM) must never be served as
    // authoritative current context; it surfaces only under `reversals`. Same predicate
    // collectReversals uses, so the two surfaces cannot disagree (ReversalAwareness).
    supersededIds = supersededDecisionIds(store.decisions);
    const active = store.decisions.filter((d) => {
      if (INACTIVE_STATUSES.has(d.status)) return false;
      if (supersededIds.has(d.id)) return false;
      // Surface if it touches a domain or file the orient task identified
      if (d.affectedDomains.some((dom) => relevantDomainSet.has(dom))) return true;
      if (d.affectedFiles.some((f) => relevantFileSet.has(f))) return true;
      // Always surface approved decisions — agent must sync before committing
      if (d.status === 'approved') return true;
      return false;
    });
    // Compute a freshness verdict per decision when the graph is available.
    // Without an edge store we cannot verify, so we surface decisions unannotated
    // rather than falsely flagging them stale.
    const es = llmCtx?.edgeStore;
    const view = es ? makeFreshnessView(es, absDir) : null;
    const contradictionItems: AnchoredItem[] = [];
    if (active.length > 0) {
      const authoritative: DecisionSummary[] = [];
      const stale: DecisionSummary[] = [];
      for (const d of active) {
        const base: DecisionSummary = {
          id: d.id,
          title: d.title,
          status: d.status,
          affectedDomains: d.affectedDomains,
        };
        const anchors = decisionAnchors(d);
        if (view) {
          const f = memoryFreshness(anchors, view);
          base.freshness = f.freshness;
          if (f.freshness === 'drifted') base.verify = true;
          // Label a pure stale-region downgrade honestly (not "the code changed"),
          // consistent with recall (fix-transitive-incremental-staleness).
          if (isStaleRegionOnly(f.verdicts)) base.staleRegion = true;
          if (f.freshness === 'orphaned') { stale.push(base); continue; }
          contradictionItems.push({ id: d.id, anchors, freshness: f.freshness });
        }
        authoritative.push(base);
      }
      if (authoritative.length > 0) pendingDecisions = authoritative;
      if (stale.length > 0) staleDecisions = stale;
    }
    // Fold in `remember` notes anchored to the files this task touches — or that a
    // surfaced decision governs — so a note↔note or note↔decision contradiction on a
    // relevant symbol is surfaced at the default entry tool. Gated on the graph view.
    const scopeFiles = new Set<string>(relevantFileSet);
    for (const d of active) for (const f of d.affectedFiles) scopeFiles.add(f);
    // Loaded once and reused for both the contradiction fold and the reversal scan.
    const memStore = await loadMemoryStore(absDir);
    if (view && scopeFiles.size > 0) {
      for (const m of memStore.memories) {
        if (m.invalidatedAt) continue;
        if (!m.anchors.some((a) => scopeFiles.has(a.filePath))) continue;
        const f = memoryFreshness(m.anchors, view);
        contradictionItems.push({ id: m.id, anchors: m.anchors, freshness: f.freshness, invalidated: false });
      }
    }
    const groups = findUnreconciled(contradictionItems);
    if (groups.length > 0) unreconciledMemories = groups;

    // ── ReversalAwareness (do-not-repeat) ──────────────────────────────────
    // Reversal scope is the TASK's scope ONLY: files the search surfaced, plus the
    // files of decisions relevant to the task by domain/file. Deliberately NOT
    // `scopeFiles` — that set also absorbs the files of every `approved` decision
    // (the always-surface-for-sync rule), which would leak a reverted decision/
    // memory on an unrelated approved-decision's file into this task.
    const revScopeFiles = new Set<string>(relevantFileSet);
    for (const d of store.decisions) {
      const taskRelevant =
        d.affectedDomains.some((dom) => relevantDomainSet.has(dom)) ||
        d.affectedFiles.some((f) => relevantFileSet.has(f));
      if (taskRelevant) for (const f of d.affectedFiles) revScopeFiles.add(f);
    }
    reversals = collectReversals(memStore.memories, store.decisions, fileScope(revScopeFiles, relevantDomainSet));
  } catch {
    // non-fatal — decisions feature may not be initialised
  }

  // ── Governing decisions (graph-derived, spec-16) ───────────────────────────
  // The `affects`-edge join: decisions that govern the files this task touches,
  // resolved deterministically from the projected decision graph rather than a
  // runtime set-membership scan. Additive alongside pendingDecisions — this field
  // also reports *which* files each decision governs (file-level provenance).
  let governingDecisions:
    | Array<{ id: string; title: string; status: string; governs: string[] }>
    | undefined;
  if (!lean) try {
    const es = llmCtx?.edgeStore;
    if (es && relevantFiles.length > 0) {
      // Exclude superseded decisions here too: a retired decision must not be served as
      // an authoritative governing decision either, matching the pendingDecisions filter.
      const govs = es.getDecisionsForFiles(relevantFiles).filter((d) => !supersededIds.has(d.decisionId));
      if (govs.length > 0) {
        governingDecisions = govs.map((d) => ({
          id: d.decisionId,
          title: d.title,
          status: d.status,
          governs: d.affectedFiles,
        }));
      }
    }
  } catch {
    // non-fatal — decision projection is additive
  }

  // ── Provenance (local git/gh, spec-18) ─────────────────────────────────────
  // "Last changed by X in PR #N" for the files this task touches — derived from
  // local git history (and local gh if present). Additive, local-only, no upload.
  let provenance:
    | Array<{ file: string; lastAuthor: string; lastDate?: string; lastPr?: number; lastPrTitle?: string }>
    | undefined;
  if (!lean) try {
    const es = llmCtx?.edgeStore;
    if (es && relevantFiles.length > 0) {
      const records = es.getProvenanceForFiles(relevantFiles);
      if (records.length > 0) {
        provenance = records.slice(0, 10).map((r) => {
          const topPr = r.prs[0];
          return {
            file: r.filePath,
            lastAuthor: r.lastAuthor.name || r.lastAuthor.email,
            ...(r.lastDate ? { lastDate: r.lastDate } : {}),
            ...(topPr ? { lastPr: topPr.number } : {}),
            ...(topPr?.title ? { lastPrTitle: topPr.title } : {}),
          };
        });
      }
    }
  } catch {
    // non-fatal — provenance is additive and local-only
  }

  // ── Change coupling & volatility (local git, spec-22) ──────────────────────
  // Caution signals mined from git history: "frequently changes with …" surfaces
  // invisible coupling (no import/call edge), "volatility: high" flags risky churn.
  // Additive, advisory — correlation, not a rule.
  let changeCoupling:
    | Array<{ file: string; volatility: 'high' | 'medium' | 'low'; changes: number; frequentlyChangesWith: Array<{ file: string; confidence: number }> }>
    | undefined;
  if (!lean) try {
    const es = llmCtx?.edgeStore;
    if (es && relevantFiles.length > 0) {
      const { volatilityLevel } = await import('../../provenance/change-coupling.js');
      const records = es.getChangeCouplingForFiles(relevantFiles)
        .filter((r) => r.churn > 0 && (volatilityLevel(r.churn) !== 'low' || r.coupledWith.length > 0));
      if (records.length > 0) {
        changeCoupling = records.slice(0, 10).map((r) => ({
          file: r.filePath,
          volatility: volatilityLevel(r.churn),
          changes: r.churn,
          frequentlyChangesWith: r.coupledWith.slice(0, 5).map((c) => ({ file: c.file, confidence: c.confidence })),
        }));
      }
    }
  } catch {
    // non-fatal — change coupling is additive and local-only
  }

  // ── Architecture invariants (spec-23, additive) ─────────────────────────────
  // Only when the repo declares rules AND a relevant file participates in a
  // violation. Fully omitted otherwise — inert by default.
  let architectureViolations: Array<{ from: string; to: string; kind: string; reason: string }> | undefined;
  if (!lean) try {
    const rules = await loadArchitectureRules(absDir);
    if (rules.rules.length > 0 && relevantFiles.length > 0) {
      const depRaw = await readFile(join(outputDir, 'dependency-graph.json'), 'utf-8').catch(() => null);
      if (depRaw) {
        const depGraph = JSON.parse(depRaw);
        const norm = (p: string) => p.replace(/\\/g, '/').replace(/^\.\//, '');
        const rels = relevantFiles.map(norm);
        const involvesRelevant = (vf: string) => {
          const b = norm(vf);
          return rels.some(a => a === b || a.endsWith('/' + b) || b.endsWith('/' + a));
        };
        const scoped = scanViolations(depGraph, rules).violations.filter(
          v => involvesRelevant(v.from) || involvesRelevant(v.to),
        );
        if (scoped.length > 0) {
          architectureViolations = scoped.slice(0, 10).map(v => ({
            from: v.from, to: v.to, kind: v.kind, reason: v.reason,
          }));
        }
      }
    }
  } catch {
    // non-fatal — architecture guardrail is additive and opt-in
  }

  // ── Task-scoped landmarks (change: add-structural-landmark-salience) ───────
  // The labeled structural anchors NEAREST the matched functions, ordered by
  // call-distance proximity ONLY (no blended salience). `dead` is omitted — a
  // landmark is a point to navigate toward, not dead code — and the whole block
  // runs in full mode only (lean skips the work).
  const ORIENT_LANDMARK_MAX_DISTANCE = 4;
  const ORIENT_LANDMARK_LIMIT = 6;
  let landmarks: Array<{ id: string; name: string; file: string; distance: number; hops: number; relevance?: number; signals: unknown[] }> | undefined;
  if (!lean && llmCtx?.callGraph) {
    try {
      const cg = llmCtx.callGraph as SerializedCallGraph;
      const { computeLandmarkSignals } = await import('../../analyzer/landmark-signals.js');
      const { buildWeightedAdjacency, weightedBfs } = await import('./graph.js');
      const { personalizedPageRank, mergeUndirected } = await import('../../analyzer/personalized-pagerank.js');
      const { volatilityLevel } = await import('../../provenance/change-coupling.js');

      // volatile from the persisted churn table; dead intentionally omitted.
      const volatilityByFile = new Map<string, { level: 'high' | 'medium'; churn: number; coChangedWith: number }>();
      try {
        for (const v of llmCtx.edgeStore?.getTopVolatile(1000) ?? []) {
          const level = volatilityLevel(v.churn);
          if (level !== 'low') volatilityByFile.set(v.filePath, { level, churn: v.churn, coChangedWith: v.coupledWith?.length ?? 0 });
        }
      } catch { /* no churn data */ }

      const landmarkById = new Map(computeLandmarkSignals(cg, { volatilityByFile }).map(l => [l.id, l]));

      // Seeds = the matched functions, mapped to node ids.
      const idsByNameFile = new Map<string, string[]>();
      for (const n of cg.nodes) {
        const key = `${n.filePath} ${n.name}`;
        const arr = idsByNameFile.get(key);
        if (arr) arr.push(n.id); else idsByNameFile.set(key, [n.id]);
      }
      const seedIds = relevantFunctions.flatMap(f => idsByNameFile.get(`${f.filePath} ${f.name}`) ?? []);
      const seedSet = new Set(seedIds);

      if (seedIds.length > 0 && landmarkById.size > 0) {
        // Undirected weighted adjacency: a nearby caller OR callee is "near".
        const { forward, backward } = buildWeightedAdjacency(cg);
        const undirected = mergeUndirected(forward, backward);
        // Default: order the task's nearby structural anchors by call-distance proximity.
        // Opt-in pagerank mode: order the SAME candidates by query-conditioned connectivity
        // (personalized PageRank seeded on the matched functions) over the same bounded
        // neighbourhood — multi-path relevance, not just nearest distance. Default is unchanged.
        const reach = weightedBfs(seedIds, undirected, ORIENT_LANDMARK_MAX_DISTANCE);
        const candidates = [...reach.entries()]
          .filter(([id]) => !seedSet.has(id) && landmarkById.has(id));
        const scores = rankBy === 'pagerank'
          ? personalizedPageRank(undirected, seedIds, reach.keys())
          : undefined;
        const ranked = candidates
          .map(([id, r]) => ({ lm: landmarkById.get(id)!, distance: r.distance, hops: r.hops, relevance: scores?.get(id) ?? 0 }))
          .sort((a, b) => scores
            ? (b.relevance - a.relevance || a.lm.id.localeCompare(b.lm.id))
            : (a.distance - b.distance || a.lm.id.localeCompare(b.lm.id)))
          .slice(0, ORIENT_LANDMARK_LIMIT);
        if (ranked.length > 0) {
          landmarks = ranked.map(({ lm, distance, hops, relevance }) => ({
            id: lm.id, name: lm.name, file: relative(absDir, lm.filePath), distance, hops,
            ...(scores ? { relevance: Math.round(relevance * 1e6) / 1e6 } : {}),
            signals: lm.signals,
          }));
        }
      }
    } catch { /* landmarks are additive — never fail orient over them */ }
  }

  // ── Suggested tools (portable discovery for non-Claude Code clients) ─────
  // Derived from what orient already knows — no extra I/O.
  const _suggested: string[] = ['record_decision'];
  if (architectureViolations !== undefined) _suggested.push('check_architecture');
  if (relevantFunctions.some(f => f.isHub)) _suggested.push('analyze_impact');
  if (insertionPoints.length > 0) _suggested.push('get_subgraph');
  if (specDomains.length > 0) _suggested.push('get_spec');
  // Landmarks already surface the task's structural anchors; suggest get_landmarks
  // when the matches are themselves anchors, so the agent can pull the whole set.
  if (landmarks !== undefined && landmarks.length > 0) _suggested.push('get_landmarks');
  const _taskLow = task.toLowerCase();
  if (/\b(debug|trace|flow|path|reach|call.?chain)\b/.test(_taskLow)) _suggested.push('trace_execution_path');
  // Goal-conditioned routing: "how does A get to B", by name/role/landmark.
  if (/\b(path|route|reach|get from|how does|connect|flow (in|to|from))\b/.test(_taskLow)) _suggested.push('find_path');
  // Coarse-to-fine orientation: the lay of the land and where regions connect.
  if (/\b(architect|overview|structure|lay of the land|map|navigat|regions?|modules?|organi[sz])\b/.test(_taskLow)) _suggested.push('get_map');
  if (/\b(schema|database|db|model|table|entity|migration)\b/.test(_taskLow)) _suggested.push('get_schema_inventory');
  if (/\b(route|endpoint|api|http|rest|request|handler)\b/.test(_taskLow)) _suggested.push('get_route_inventory');
  if (/\b(test|coverage|spec.?driven)\b/.test(_taskLow)) _suggested.push('get_test_coverage');
  if (/\b(duplicate|clone|similar|refactor)\b/.test(_taskLow)) _suggested.push('get_duplicate_report');
  if (/\b(cluster|community|coupled|group)\b/.test(_taskLow)) _suggested.push('get_cluster');
  _suggested.push('check_spec_drift');
  const _seen = new Set<string>();
  const suggestedTools = _suggested.filter(t => (_seen.has(t) ? false : (_seen.add(t), true)));

  // ── Next steps ────────────────────────────────────────────────────────────
  const nextSteps: string[] = [];
  nextSteps.push(
    'Before making an architectural choice, call record_decision(title, rationale, consequences, affectedFiles) to document it',
  );
  if (insertionPoints.length > 0) {
    nextSteps.push(
      `Call get_subgraph("${insertionPoints[0].name}") to trace the call neighbourhood`,
    );
  }
  if (specDomains.length > 0) {
    const hint = inlineSpecs
      ? `Domain purposes included in inlineSpecs — call get_spec("${specDomains[0].domain}") for requirements and implementation details`
      : `Call get_spec("${specDomains[0].domain}") to read the full spec before writing code`;
    nextSteps.push(hint);
  }
  nextSteps.push('After implementing, run check_spec_drift to verify the code matches the spec');

  // Signal when the graph index is unavailable (e.g. wiped by a version upgrade and
  // not yet re-analyzed): call paths, provenance, decisions, and change-coupling all
  // depend on it, so flag it rather than silently returning a thinner result.
  const graphIndexStale = relevantFunctions.length > 0 && !llmCtx?.edgeStore;

  // ── Behavioral hotspots (observe → memory) ────────────────────────────────
  // If observe-mode telemetry has identified destabilization-prone regions and the task's
  // files fall in one of them, surface it at orientation time so the agent arrives forewarned
  // — the inverse of a real-time panic nudge. Fail-open, enrichment-only (omitted in lean
  // mode), and gated on panic mode != 'off' (a pre-existing artifact must not leak when the
  // panic subsystem is disabled). Contextual: only hotspots intersecting relevantFiles.
  let behavioralHotspots:
    | Array<{ module: string; events: number; maxDepth: number; labels: string[] }>
    | undefined;
  if (!lean) {
    try {
      const cfg = await readOpenLoreConfig(absDir);
      if ((cfg?.panicResponse?.mode ?? 'off') !== 'off') {
        const report = readHotspotArtifact(outputDir);
        if (report && report.hotspots.length > 0 && relevantFiles.length > 0) {
          const roots = getSourceRoots(absDir);
          const taskModules = new Set(
            relevantFiles.map(f => moduleFromPath(f, roots)).filter((m): m is string => m !== null),
          );
          // Only surface hotspots that crossed a threshold (carry a label) — an unlabeled
          // module with a stray event is noise, not a destabilization signal worth a heads-up.
          const hits = hotspotsForModules(report, taskModules).filter(h => h.labels.length > 0).slice(0, 5);
          if (hits.length > 0) {
            behavioralHotspots = hits.map(h => ({
              module: h.module,
              events: h.events,
              maxDepth: h.max_depth,
              labels: h.labels,
            }));
          }
        }
      }
    } catch {
      // fail-open: orient must never break on the optional memory signal
    }
  }

  // ── Local house style for the touched region (change: add-codebase-style-fingerprint) ──
  // So an agent that never calls get_style_fingerprint still arrives knowing the dominant idioms
  // of the area it is about to edit. Drawn from the SAME computed fingerprint, obeying the SAME
  // evidence floor + enforcement-awareness (compactIdiomSummary omits null/enforced idioms).
  // Bounded (≤4 idioms), region-scoped where the region has strong evidence, else repo-scoped for
  // the touched language. Additive + fail-open — orient never breaks on it.
  let regionStyle:
    | { scope: 'region' | 'repository'; language: string; communityId?: string; dominantIdioms: string[] }
    | undefined;
  if (!lean && relevantFunctions.length > 0) {
    try {
      const raw = await readFile(join(outputDir, ARTIFACT_STYLE_FINGERPRINT), 'utf-8').catch(() => null);
      const fp = raw ? (JSON.parse(raw) as StyleFingerprint) : null;
      if (fp && Array.isArray(fp.byLanguage)) {
        // Dominant supported language among the matched functions.
        const langCounts = new Map<string, number>();
        for (const f of relevantFunctions) {
          if (f.language && STYLE_FINGERPRINT_LANGUAGES.has(f.language)) {
            langCounts.set(f.language, (langCounts.get(f.language) ?? 0) + 1);
          }
        }
        const lang = [...langCounts.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0]?.[0];
        if (lang) {
          // Prefer the region of the top-matched function's file; fall back to the repo profile.
          const regionId = fp.fileRegions?.[relevantFunctions[0].filePath];
          let profile: LanguageProfile | undefined;
          let scope: 'region' | 'repository' = 'repository';
          let communityId: string | undefined;
          if (regionId) {
            const region = fp.regions.find(r => r.communityId === regionId);
            const lp = region?.byLanguage.find(p => p.language === lang);
            if (lp) { profile = lp; scope = 'region'; communityId = regionId; }
          }
          if (!profile) profile = fp.byLanguage.find(p => p.language === lang);
          const dominantIdioms = profile ? compactIdiomSummary(profile) : [];
          if (dominantIdioms.length > 0) {
            regionStyle = { scope, language: lang, ...(communityId ? { communityId } : {}), dominantIdioms };
          }
        }
      }
    } catch {
      // additive enrichment — never fail orient over the style summary
    }
  }

  // Minimal-sufficient navigation core — always returned (Spec 27).
  const core = {
    task,
    searchMode,
    retrievalMode,
    ...(retrievalMode === 'keyword'
      ? { note: 'Keyword (BM25) search — the zero-config default. For semantic ranking, run "openlore embed --local" (on-device, no API key) or set EMBED_* for a remote endpoint.' }
      : {}),
    ...(graphIndexStale
      ? { graphIndexNote: 'Graph index unavailable — call paths, provenance, decisions, and change-coupling are omitted. Run analyze_codebase to (re)build it (a version upgrade resets the graph index until the next analyze).' }
      : {}),
    relevantFiles,
    relevantFunctions,
    ...(budgeted.omitted > 0
      ? { relevantFunctionsOmitted: omissionNote(budgeted.omitted, 'raise tokenBudget, increase limit, or call search_code') }
      : {}),
    specDomains,
    callPaths,
    suggestedTools,
  };

  // Lean mode (Spec 27): return the navigation core only. The enrichment blocks
  // below are pure overhead on a shallow "who calls X" lookup and each is one
  // exact `expand` handle or one dedicated tool call away — so we trim bytes per
  // turn without forcing a follow-up round-trip. The rich default is unchanged.
  if (lean) {
    return { ...core, lean: true };
  }

  return {
    ...core,
    ...(specLinkedFunctions.length > 0 ? { specLinkedFunctions } : {}),
    ...(inlineSpecs !== undefined ? { inlineSpecs } : {}),
    insertionPoints,
    ...(matchingSpecs !== undefined ? { matchingSpecs } : {}),
    ...(pendingDecisions !== undefined ? { pendingDecisions } : {}),
    ...(staleDecisions !== undefined ? { staleDecisions } : {}),
    ...(unreconciledMemories !== undefined ? { unreconciledMemories } : {}),
    ...(reversals !== undefined ? { reversals } : {}),
    ...(governingDecisions !== undefined ? { governingDecisions } : {}),
    ...(provenance !== undefined ? { provenance } : {}),
    ...(changeCoupling !== undefined ? { changeCoupling } : {}),
    ...(architectureViolations !== undefined ? { architectureViolations } : {}),
    ...(landmarks !== undefined ? { landmarks } : {}),
    ...(behavioralHotspots !== undefined ? { behavioralHotspots } : {}),
    ...(regionStyle !== undefined ? { regionStyle } : {}),
    nextSteps,
  };
}

// ============================================================================
// HELPERS
// ============================================================================

/**
 * Condense a spec to its ## Purpose paragraph only (~50-150 chars).
 * dependsOn/calledBy are already in the InlineSpec manifest fields.
 * Full requirements are available via get_spec.
 */
function condenseSpec(content: string): string {
  const lines = content.split('\n');
  const purposeStart = lines.findIndex(l => /^## Purpose\s*$/.test(l));
  if (purposeStart === -1) return '';
  let i = purposeStart + 1;
  while (i < lines.length && lines[i].trim() === '') i++;
  const out: string[] = [];
  while (i < lines.length && lines[i].trim() !== '' && !lines[i].startsWith('#')) {
    out.push(lines[i++]);
  }
  return out.join('\n').trim().replace(/^\[PARTIAL SPEC[^\]]*\]\s*/i, '');
}
