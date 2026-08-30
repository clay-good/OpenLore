/**
 * MCP tool handlers for semantic search and feature insertion:
 * search_code, suggest_insertion_points, search_specs.
 */

import { join, relative } from 'node:path';
import {
  INSERTION_SEMANTIC_WEIGHT,
  INSERTION_STRUCTURAL_WEIGHT,
  INSERTION_ROLE_BONUS_ENTRY_POINT,
  INSERTION_ROLE_BONUS_ORCHESTRATOR,
  INSERTION_ROLE_BONUS_HUB,
  INSERTION_ROLE_BONUS_INTERNAL,
  INSERTION_ROLE_BONUS_UTILITY,
  INSERTION_ORCHESTRATOR_FAN_OUT_THRESHOLD,
  OPENLORE_DIR,
  OPENLORE_ANALYSIS_SUBDIR,
  OPENSPEC_DIR,
  OPENSPEC_SPECS_SUBDIR,
} from '../../../constants.js';
import { fileExists } from '../../../utils/command-helpers.js';
import { resolveOpenspecDir } from '../../../utils/openspec-dir.js';
import { validateDirectory, safeJoin, loadMappingIndex, specsForFile, functionsForDomain, queryTooLongError, notReadyResult, readCachedContext, getCachedNodeStartLine } from './utils.js';
import { expandHandle, applyTokenBudget, collapseExactDuplicates, omissionNote } from './progressive.js';
import { readOpenLoreConfig } from '../config-manager.js';
import {
  readAnalysisContentProvenance,
  indexedSpecContentProvenance,
  reviewedFileContentProvenance,
  type AnalysisContentProvenance,
} from '../served-content.js';
import { withIndexStaleness } from './index-staleness.js';
import { requireMatchEvidence } from '../../analyzer/retrieval-evidence.js';

// ============================================================================
// INSERTION POINT HELPERS
// ============================================================================

export type InsertionRole = 'entry_point' | 'orchestrator' | 'hub' | 'utility' | 'internal';
export type InsertionStrategy =
  | 'extend_entry_point'
  | 'add_orchestration_step'
  | 'cross_cutting_hook'
  | 'extract_shared_logic'
  | 'call_alongside';

export interface InsertionCandidate {
  rank: number;
  score: number;
  semanticScore: number;
  name: string;
  filePath: string;
  className?: string;
  language: string;
  signature?: string;
  docstring?: string;
  role: InsertionRole;
  insertionStrategy: InsertionStrategy;
  reason: string;
  fanIn: number;
  fanOut: number;
  isHub: boolean;
  isEntryPoint: boolean;
}

export function classifyRole(
  fanIn: number,
  fanOut: number,
  isHub: boolean,
  isEntryPoint: boolean
): InsertionRole {
  if (isEntryPoint) return 'entry_point';
  if (isHub) return 'hub';
  if (fanOut >= INSERTION_ORCHESTRATOR_FAN_OUT_THRESHOLD) return 'orchestrator';
  if (fanIn <= 1) return 'utility';
  return 'internal';
}

export function deriveStrategy(role: InsertionRole): InsertionStrategy {
  switch (role) {
    case 'entry_point':
      return 'extend_entry_point';
    case 'orchestrator':
      return 'add_orchestration_step';
    case 'hub':
      return 'cross_cutting_hook';
    case 'utility':
      return 'extract_shared_logic';
    default:
      return 'call_alongside';
  }
}

export function buildReason(
  name: string,
  role: InsertionRole,
  strategy: InsertionStrategy,
  fanIn: number,
  fanOut: number
): string {
  switch (strategy) {
    case 'extend_entry_point':
      return `${name} is an entry point (no internal callers). Add your feature here or create a sibling entry point that delegates to it.`;
    case 'add_orchestration_step':
      return `${name} orchestrates ${fanOut} downstream calls. Insert your feature as a new step in this pipeline.`;
    case 'cross_cutting_hook':
      return `${name} is called by ${fanIn} functions -- adding logic here affects the entire callsite surface.`;
    case 'extract_shared_logic':
      return `${name} is a low-traffic utility. Shared logic for your feature can live here or be extracted alongside it.`;
    default:
      return `${name} is semantically close to your feature and operates in the same domain. Extend or call alongside it.`;
  }
}

/**
 * Composite score = semanticRelevance * INSERTION_SEMANTIC_WEIGHT + structuralBonus * INSERTION_STRUCTURAL_WEIGHT.
 *
 * `semanticRelevance` must be in the 0-1 range (higher = more relevant).
 * Callers using VectorIndex.search (hybrid/RRF or BM25) should normalise scores
 * into [0, 1] before calling this function.
 */
export function compositeScore(semanticRelevance: number, role: InsertionRole): number {
  const semantic = Math.max(0, Math.min(1, semanticRelevance));
  const structuralBonus: Record<InsertionRole, number> = {
    entry_point: INSERTION_ROLE_BONUS_ENTRY_POINT,
    orchestrator: INSERTION_ROLE_BONUS_ORCHESTRATOR,
    hub: INSERTION_ROLE_BONUS_HUB,
    internal: INSERTION_ROLE_BONUS_INTERNAL,
    utility: INSERTION_ROLE_BONUS_UTILITY,
  };
  return semantic * INSERTION_SEMANTIC_WEIGHT + structuralBonus[role] * INSERTION_STRUCTURAL_WEIGHT;
}

// ============================================================================
// HANDLERS
// ============================================================================

/**
 * MCP retrieval strategy: semantic search → graph neighborhood enrichment.
 *
 * Returns the top-k semantic results, each enriched with:
 * - callers / callees from the call graph (graph-first context)
 * - linkedSpecs from mapping.json (bidirectional code↔spec linking)
 */
/**
 * Query the literal-text line index and shape the response. Returns the result
 * object, or — in `text_fallback` mode only — `null` when the index is absent or
 * yields no matches, so the caller can fall through to its normal empty
 * response. In forced `text` mode it always returns an object.
 */
interface TextSearchPayload {
  query: string;
  searchMode: 'text' | 'text_fallback';
  count: number;
  results: Array<{
    filePath: string;
    line: number;
    text: string;
    score: number;
    kind: 'text';
    matchEvidence: import('../../analyzer/retrieval-evidence.js').MatchEvidence;
    provenance: AnalysisContentProvenance;
  }>;
  note?: string;
}

async function searchTextLines(
  outputDir: string,
  query: string,
  limit: number,
  searchMode: 'text' | 'text_fallback',
  provenance: AnalysisContentProvenance,
): Promise<TextSearchPayload | null> {
  const { TextLineIndex } = await import('../../analyzer/text-line-index.js');
  if (!TextLineIndex.exists(outputDir)) {
    return searchMode === 'text'
      ? { query, searchMode, count: 0, results: [], note: 'No text line index found. Run "openlore analyze".' }
      : null;
  }
  const hits = await TextLineIndex.searchText(outputDir, query, { limit: Math.max(1, Math.min(limit, 100)) });
  if (hits.length === 0 && searchMode === 'text_fallback') return null;
  return {
    query,
    searchMode,
    ...(searchMode === 'text_fallback'
      ? { note: 'No code symbols matched; these are literal-text matches from markup/text files.' }
      : {}),
    count: hits.length,
    results: hits.map((h) => ({
      filePath: h.filePath,
      line: h.lineNumber,
      text: h.text,
      score: h.score,
      kind: 'text' as const,
      matchEvidence: h.matchEvidence,
      provenance,
    })),
  };
}

export async function handleSearchCode(
  directory: string,
  query: string,
  limit = 10,
  language?: string,
  minFanIn?: number,
  tokenBudget?: number,
  mode?: 'text'
): Promise<unknown> {
  const tooLong = queryTooLongError(query); if (tooLong) return tooLong;
  const absDir = await validateDirectory(directory);
  const outputDir = join(absDir, OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR);
  const analysisProvenance = await readAnalysisContentProvenance(absDir);

  const { VectorIndex } = await import('../../analyzer/vector-index.js');
  const { resolveEmbedder, servedRetrievalMode } = await import('../../analyzer/embedder.js');

  // Forced literal-text mode: query the separate line index directly, bypassing
  // symbol search. Use when hunting a literal string (UI copy, error text).
  if (mode === 'text') {
    const [result, freshnessCtx] = await Promise.all([
      searchTextLines(outputDir, query, limit, 'text', analysisProvenance),
      readCachedContext(absDir),
    ]);
    return result
      ? withIndexStaleness(absDir, result, freshnessCtx, result.results.map(hit => hit.filePath))
      : result;
  }

  if (!VectorIndex.exists(outputDir)) {
    return {
      ...notReadyResult('No search index found. Run "openlore analyze" first.', 'index-absent'),
      hint: 'Plain "openlore analyze" builds a keyword (BM25) index; add EMBED_BASE_URL/EMBED_MODEL for semantic search.',
    };
  }

  // Resolve the active embedder (env → local provider → remote config); null is
  // the first-class keyword default. retrievalMode is the honest, served mode.
  const cfg = await readOpenLoreConfig(absDir);
  const embedSvc = await resolveEmbedder(cfg);
  const retrievalMode = servedRetrievalMode(embedSvc, outputDir, 'code');
  const searchMode = retrievalMode === 'keyword' ? 'bm25_fallback' : 'hybrid';

  limit = Math.max(1, Math.min(limit, 100));
  const [results, mappingIdx, llmCtx] = await Promise.all([
    VectorIndex.search(outputDir, query, embedSvc, { limit, language, minFanIn }),
    loadMappingIndex(absDir),
    readCachedContext(absDir),
  ]);
  const indexDegraded = VectorIndex.degradationNotice?.(outputDir) ?? null;
  // Zero symbol hits: the string may live in static markup/text that extracts
  // no symbols (UI copy, error messages). Fall back to the literal-text line
  // index rather than returning a dead end. This is an optional enrichment —
  // its failure must never turn a valid empty symbol result into a tool error,
  // so a throw degrades silently to the normal empty response below.
  if (results.length === 0) {
    try {
      const textFallback = await searchTextLines(outputDir, query, limit, 'text_fallback', analysisProvenance);
      if (textFallback) {
        return withIndexStaleness(
          absDir,
          {
            ...textFallback,
            ...(indexDegraded ? { indexDegraded } : {}),
          },
          llmCtx,
          textFallback.results.map(hit => hit.filePath),
        );
      }
    } catch {
      /* text index unavailable/corrupt — fall through to the empty symbol response */
    }
  }

  type Neighbour = { name: string; filePath: string };

  // ── RIG-20: cross-graph spec traversal — seed → spec domains → peer functions ──
  // For each result that has linkedSpecs, traverse the spec domain to find
  // other functions in that domain not already in the semantic results.
  type SpecPeer = { name: string; filePath: string; domain: string; requirement: string };
  const specPeers: SpecPeer[] = [];
  if (mappingIdx) {
    const resultFileSet = new Set(results.map((r) => r.record.filePath));
    const seedDomains = new Set<string>();
    for (const r of results) {
      for (const spec of specsForFile(mappingIdx, r.record.filePath)) seedDomains.add(spec.domain);
    }
    const seen = new Set<string>();
    for (const domain of seedDomains) {
      for (const fn of functionsForDomain(mappingIdx, domain)) {
        const key = `${fn.name}::${fn.file}`;
        if (seen.has(key) || resultFileSet.has(fn.file)) continue;
        seen.add(key);
        specPeers.push({ name: fn.name, filePath: fn.file, domain, requirement: fn.requirement });
      }
    }
  }

  const allResults = results.map((r) => {
    const startLine = getCachedNodeStartLine(llmCtx, r.record.id);
    return {
      score: r.score,
      matchEvidence: requireMatchEvidence(r.matchEvidence),
      name: r.record.name,
      filePath: r.record.filePath,
      ...(startLine !== undefined ? { startLine } : {}),
      // Exact expansion handle (Spec 25 P2): get_function_body(directory, filePath, name).
      expand: expandHandle(r.record.name, r.record.filePath),
      className: r.record.className || undefined,
      language: r.record.language,
      signature: r.record.signature || undefined,
      docstring: r.record.docstring || undefined,
      fanIn: r.record.fanIn,
      fanOut: r.record.fanOut,
      isHub: r.record.isHub,
      isEntryPoint: r.record.isEntryPoint,
      provenance: analysisProvenance,
      linkedSpecs: mappingIdx ? specsForFile(mappingIdx, r.record.filePath) : undefined,
      callers: llmCtx?.edgeStore
        ? llmCtx.edgeStore.getCallers(r.record.id)
            .map(e => { const n = llmCtx!.edgeStore!.getNode(e.callerId); return n && !n.isExternal ? { name: n.name, filePath: n.filePath } : null; })
            .filter((x): x is Neighbour => x !== null)
        : undefined,
      callees: llmCtx?.edgeStore
        ? llmCtx.edgeStore.getCallees(r.record.id)
            .map(e => { const n = llmCtx!.edgeStore!.getNode(e.calleeId); return n && !n.isExternal ? { name: n.name, filePath: n.filePath } : null; })
            .filter((x): x is Neighbour => x !== null)
        : undefined,
    };
  });

  // Progressive disclosure (Spec 25 P2–P4): default returns all hits; with a
  // tokenBudget, collapse exact duplicates then greedily keep the highest-scored
  // hits that fit. Every hit carries an `expand` handle for get_function_body.
  const budgeted = tokenBudget
    ? applyTokenBudget(collapseExactDuplicates(allResults), tokenBudget)
    : { kept: allResults, omitted: 0 };

  const result = {
    query,
    searchMode,
    retrievalMode,
    ...(retrievalMode === 'keyword'
      ? {
          note: 'Keyword (BM25) search — the zero-config default. For semantic ranking, run "openlore embed --local" (on-device, no API key) or set EMBED_* for a remote endpoint.',
        }
      : {}),
    count: budgeted.kept.length,
    results: budgeted.kept,
    ...(budgeted.omitted > 0
      ? { resultsOmitted: omissionNote(budgeted.omitted, 'raise tokenBudget or narrow the query') }
      : {}),
    ...(specPeers.length > 0 ? { specLinkedFunctions: specPeers } : {}),
    ...(indexDegraded ? { indexDegraded } : {}),
  };
  return withIndexStaleness(absDir, result, llmCtx);
}

/**
 * Find the best places in the codebase to implement a new feature.
 */
export async function handleSuggestInsertionPoints(
  directory: string,
  description: string,
  limit = 5,
  language?: string
): Promise<unknown> {
  const tooLong = queryTooLongError(description, 'description'); if (tooLong) return tooLong;
  const absDir = await validateDirectory(directory);
  const outputDir = join(absDir, OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR);

  const { VectorIndex } = await import('../../analyzer/vector-index.js');
  const { resolveEmbedder } = await import('../../analyzer/embedder.js');

  if (!VectorIndex.exists(outputDir)) {
    return {
      ...notReadyResult('No search index found. Run "openlore analyze" first.', 'index-absent'),
      hint: 'Plain "openlore analyze" builds a keyword (BM25) index; add EMBED_BASE_URL/EMBED_MODEL for semantic search.',
    };
  }

  // Resolve the active embedder (env → local provider → remote config); null
  // triggers the first-class BM25 path in VectorIndex.search().
  const cfg = await readOpenLoreConfig(absDir);
  const embedSvc = await resolveEmbedder(cfg);

  limit = Math.max(1, Math.min(limit, 20));
  const { readCachedContext } = await import('./utils.js');
  const [rawResults, llmCtx] = await Promise.all([
    VectorIndex.search(outputDir, description, embedSvc, { limit: limit * 4, language }),
    readCachedContext(absDir),
  ]);
  const indexDegraded = VectorIndex.degradationNotice?.(outputDir) ?? null;

  // Normalise search scores to [0, 1] for compositeScore (scores are RRF/BM25: higher = better)
  const maxScore = rawResults.length > 0 ? Math.max(...rawResults.map((r) => r.score)) : 1;
  const normalise = (s: number) => (maxScore > 0 ? s / maxScore : 0);

  const candidates: InsertionCandidate[] = rawResults.map((r) => {
    const role = classifyRole(
      r.record.fanIn,
      r.record.fanOut,
      r.record.isHub,
      r.record.isEntryPoint
    );
    const strategy = deriveStrategy(role);
    const score = compositeScore(normalise(r.score), role);
    return {
      rank: 0,
      score,
      semanticScore: r.score,
      name: r.record.name,
      filePath: r.record.filePath,
      className: r.record.className || undefined,
      language: r.record.language,
      signature: r.record.signature || undefined,
      docstring: r.record.docstring || undefined,
      role,
      insertionStrategy: strategy,
      reason: buildReason(r.record.name, role, strategy, r.record.fanIn, r.record.fanOut),
      fanIn: r.record.fanIn,
      fanOut: r.record.fanOut,
      isHub: r.record.isHub,
      isEntryPoint: r.record.isEntryPoint,
    };
  });

  // RIG-13 — Graph expansion: add depth-1 callers of semantic seed functions.
  if (llmCtx?.edgeStore) {
    const seedIds = new Set(rawResults.map((r) => r.record.id));
    const existingIds = new Set(candidates.map((c) => `${c.filePath}::${c.name}`));

    for (const seedResult of rawResults) {
      const callerIds = llmCtx.edgeStore.getCallers(seedResult.record.id).map(e => e.callerId);
      for (const callerId of callerIds) {
        const callerNode = llmCtx.edgeStore.getNode(callerId);
        if (!callerNode) continue;
        const key = `${callerNode.filePath}::${callerNode.name}`;
        if (existingIds.has(key) || seedIds.has(callerId)) continue;
        existingIds.add(key);

        const role = classifyRole(callerNode.fanIn, callerNode.fanOut, false, false);
        const strategy = deriveStrategy(role);
        // Graph-expanded candidates score slightly lower than the semantic seed.
        // Use the NORMALISED seed score so this is on the same scale as the seed
        // candidates above (raw RRF scores top out ~0.03, which would otherwise
        // rank every expanded node below — and report a misleading semanticScore).
        const expandedSemantic = normalise(seedResult.score) + 0.15;
        const score = compositeScore(expandedSemantic, role) * 0.85;
        candidates.push({
          rank: 0,
          score,
          semanticScore: expandedSemantic,
          name: callerNode.name,
          filePath: callerNode.filePath,
          className: callerNode.className,
          language: callerNode.language,
          signature: undefined,
          docstring: undefined,
          role,
          insertionStrategy: strategy,
          reason: `${callerNode.name} calls ${seedResult.record.name} (semantically close to your feature). Adding logic here propagates to the domain.`,
          fanIn: callerNode.fanIn,
          fanOut: callerNode.fanOut,
          isHub: false,
          isEntryPoint: false,
        });
      }
    }
  }

  candidates.sort((a, b) => b.score - a.score);
  const top = candidates.slice(0, limit).map((c, i) => ({ ...c, rank: i + 1 }));

  return {
    description,
    count: top.length,
    candidates: top,
    ...(indexDegraded ? { indexDegraded } : {}),
    nextSteps:
      top.length > 0
        ? [
            `Run get_function_skeleton on "${top[0].filePath}" to see the internal structure of ${top[0].name}`,
            `Run get_subgraph on "${top[0].name}" to understand its call neighborhood`,
            `After implementing, run check_spec_drift to verify the code matches the spec`,
          ]
        : [
            'No candidates found. Try a broader description or run "openlore analyze --embed" to build the index.',
          ],
  };
}

/**
 * Return the full content of a spec domain's spec.md plus its mapping entries.
 */
/**
 * The spec root this project actually uses, normalized.
 *
 * A repo that moved `openspec/` would otherwise have every spec resolved to a
 * path that does not exist — `get_spec` reporting not-found for files plainly on
 * disk, and `list_spec_domains` answering with an empty list.
 */
async function configuredSpecRoot(absDir: string): Promise<{ absolute: string; relative: string }> {
  const configured = (await readOpenLoreConfig(absDir).catch(() => null))?.openspecPath ?? OPENSPEC_DIR;
  const absolute = resolveOpenspecDir(absDir, configured);
  const relativePath = relative(absDir, absolute).replaceAll('\\', '/');
  return { absolute, relative: relativePath || '.' };
}

export async function handleGetSpec(directory: string, domain: string): Promise<unknown> {
  const { existsSync } = await import('node:fs');
  const { readFile } = await import('node:fs/promises');
  const { join: pjoin } = await import('node:path');
  const absDir = await validateDirectory(directory);

  const openspecRoot = await configuredSpecRoot(absDir);
  const specsRoot = pjoin(openspecRoot.absolute, OPENSPEC_SPECS_SUBDIR);

  // `domain` is an untrusted tool arg; confine it to the repo so e.g.
  // domain="../../../../etc" can't escape to read arbitrary spec.md files.
  let specFile: string;
  try {
    specFile = safeJoin(specsRoot, pjoin(domain, 'spec.md'));
  } catch {
    return {
      error: `No spec found for domain "${domain}". Run list_spec_domains to see available domains.`,
    };
  }
  if (!existsSync(specFile)) {
    return {
      error: `No spec found for domain "${domain}". Run list_spec_domains to see available domains.`,
    };
  }

  const [content, mappingIdx] = await Promise.all([
    readFile(specFile, 'utf-8'),
    loadMappingIndex(absDir),
  ]);
  const linkedFunctions = mappingIdx ? functionsForDomain(mappingIdx, domain) : undefined;

  // Both the reported path and the provenance must name the file actually read.
  // Querying git about `openspec/...` while serving a relocated spec would report
  // a clean, unrelated path — a modified spec could then be served as reviewed.
  const relativeSpecFile = [
    ...(openspecRoot.relative === '.' ? [] : [openspecRoot.relative]),
    OPENSPEC_SPECS_SUBDIR,
    domain,
    'spec.md',
  ].join('/');
  return {
    domain,
    specFile: relativeSpecFile,
    content,
    provenance: await reviewedFileContentProvenance(absDir, relativeSpecFile),
    linkedFunctions,
  };
}

/**
 * List all spec domains available in the project (reads the configured specs directory).
 * Useful for the agent to discover what domains exist before doing a targeted search.
 *
 * Honors the configured spec root for the same reason `handleGetSpec` does, and
 * because that handler's not-found error sends the agent here: a relocated corpus
 * would otherwise answer with an empty list of domains `get_spec` opens happily.
 */
export async function handleListSpecDomains(directory: string): Promise<unknown> {
  const { readdir } = await import('node:fs/promises');
  const { join: pjoin } = await import('node:path');
  const absDir = await validateDirectory(directory);

  const openspecRoot = await configuredSpecRoot(absDir);
  const specsDir = pjoin(openspecRoot.absolute, OPENSPEC_SPECS_SUBDIR);
  const relativeSpecsDir = [
    ...(openspecRoot.relative === '.' ? [] : [openspecRoot.relative]),
    OPENSPEC_SPECS_SUBDIR,
  ].join('/');
  if (!(await fileExists(specsDir))) {
    return {
      domains: [],
      note: `No ${relativeSpecsDir}/ directory found. Run "openlore generate" first.`,
    };
  }

  let entries: string[];
  try {
    entries = await readdir(specsDir);
  } catch {
    return { domains: [] };
  }

  const domainChecks = await Promise.all(
    entries.map((e) => fileExists(pjoin(specsDir, e, 'spec.md')))
  );
  const domains = entries.filter((_, i) => domainChecks[i]);
  return {
    domains,
    count: domains.length,
    provenance: await reviewedFileContentProvenance(absDir, relativeSpecsDir),
  };
}

/**
 * Semantic search over the spec index built by "openlore analyze --embed"
 * or "openlore analyze --reindex-specs".
 */
export async function handleSearchSpecs(
  directory: string,
  query: string,
  limit = 10,
  domain?: string,
  section?: string
): Promise<unknown> {
  const tooLong = queryTooLongError(query); if (tooLong) return tooLong;
  const absDir = await validateDirectory(directory);
  const outputDir = join(absDir, OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR);

  const { SpecVectorIndex } = await import('../../analyzer/spec-vector-index.js');
  const { resolveEmbedder, servedRetrievalMode } = await import('../../analyzer/embedder.js');

  if (!SpecVectorIndex.exists(outputDir)) {
    return {
      error: 'No spec index found. Run "openlore analyze" first.',
      hint: 'Plain "openlore analyze" builds a keyword (BM25) spec index; configure EMBED_* for semantic spec search.',
    };
  }

  // Resolve the active embedder (env → local provider → remote config); null is
  // the first-class keyword default for spec search.
  const cfg = await readOpenLoreConfig(absDir);
  const embedSvc = await resolveEmbedder(cfg);
  const retrievalMode = servedRetrievalMode(embedSvc, outputDir, 'spec');
  const searchMode = retrievalMode === 'keyword' ? 'bm25_fallback' : 'hybrid';

  limit = Math.max(1, Math.min(limit, 50));
  const [results, mappingIdx] = await Promise.all([
    SpecVectorIndex.search(outputDir, query, embedSvc, { limit, domain, section }),
    loadMappingIndex(absDir),
  ]);
  const servedResults = await Promise.all(results.map(async (r) => ({
    score: r.score,
    matchEvidence: requireMatchEvidence(r.matchEvidence),
    id: r.record.id,
    domain: r.record.domain,
    section: r.record.section,
    title: r.record.title,
    text: r.record.text,
    provenance: await indexedSpecContentProvenance(
      absDir,
      `openspec/specs/${r.record.domain}/spec.md`,
      [r.record.title, r.record.text, ...r.record.linkedFiles],
    ),
    linkedFiles: r.record.linkedFiles,
    linkedFunctions: mappingIdx ? functionsForDomain(mappingIdx, r.record.domain) : undefined,
  })));

  return {
    query,
    searchMode,
    retrievalMode,
    ...(retrievalMode === 'keyword'
      ? {
          note: 'Keyword (BM25) spec search — the zero-config default. For semantic ranking, run "openlore embed --local" (on-device, no API key) or set EMBED_* for a remote endpoint.',
        }
      : {}),
    count: servedResults.length,
    results: servedResults,
  };
}

/**
 * Unified search that combines code and spec indexes with cross-scoring
 */
export async function handleUnifiedSearch(
  directory: string,
  query: string,
  limit = 10,
  language?: string,
  domain?: string,
  section?: string
): Promise<unknown> {
  const tooLong = queryTooLongError(query); if (tooLong) return tooLong;
  const absDir = await validateDirectory(directory);
  const outputDir = join(absDir, OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR);

  const { UnifiedSearch, unifiedSearchAvailable } =
    await import('../../analyzer/unified-search.js');
  const { resolveEmbedder } = await import('../../analyzer/embedder.js');

  if (!(await unifiedSearchAvailable(outputDir))) {
    return {
      error:
        'No unified search available. Run "openlore analyze --embed" first, ' +
        'then configure EMBED_BASE_URL and EMBED_MODEL.',
    };
  }

  // Resolve the active embedder (env → local provider → remote config).
  const cfg = await readOpenLoreConfig(absDir);
  const embedSvc = await resolveEmbedder(cfg);

  limit = Math.max(1, Math.min(limit, 50));
  const results = await UnifiedSearch.unifiedSearch(outputDir, query, embedSvc, {
    limit,
    language,
    domain,
    section,
  });
  const analysisProvenance = await readAnalysisContentProvenance(absDir);
  const servedResults = await Promise.all(results.map(async result => ({
    ...result,
    provenance: result.source.domain
      ? await indexedSpecContentProvenance(
          absDir,
          `openspec/specs/${result.source.domain}/spec.md`,
          [result.source.section, result.source.title].filter((value): value is string => Boolean(value)),
        )
      : analysisProvenance,
  })));

  return {
    query,
    count: servedResults.length,
    results: servedResults,
  };
}
