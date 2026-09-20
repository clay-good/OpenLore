/**
 * Spec link index — resolution and persistence.
 *
 * The I/O shell around the pure builder in `spec-link-index.ts`. It answers one
 * question for every mapping-dependent caller (audit, Repair, `mapping refresh`,
 * standalone generation finalization): *what are the current deterministic links?*
 *
 * The persisted `mapping.json` is a CACHE, never a prerequisite. When it is
 * absent, legacy, invalid, or bound to different inputs, the index is derived in
 * memory from the specs on disk plus the current graph — so Repair works on a
 * repository that has never run standalone generation (change
 * `harden-spec-workflow-lifecycle`, decision 671084e7).
 *
 * Coverage is unavailable only when an INPUT is missing (no analysis, no specs),
 * never merely because the cache was unusable.
 */

import { realpathSync, statSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';
import { ANALYSIS_ARTIFACT_MAX_BYTES, readArtifactBounded } from '../../utils/bounded-artifact-read.js';

import {
  ARTIFACT_DEPENDENCY_GRAPH,
  ARTIFACT_MAPPING,
  OPENLORE_ANALYSIS_SUBDIR,
  OPENLORE_DIR,
  OPENSPEC_DIR,
} from '../../constants.js';
import type { MappingCoverageReason } from '../../types/index.js';
import { isConfinedPath, safeJoin } from '../../utils/path-confinement.js';
import { atomicWriteFile } from '../decisions/atomic-store.js';
import type { DependencyGraphResult } from '../analyzer/dependency-graph.js';
import { extractsExports } from '../analyzer/import-parser.js';
import { mappingSourceFingerprint } from './mapping-generator.js';
import type { PipelineResult } from './spec-pipeline.js';
import {
  buildSpecLinkIndex,
  buildSymbolResolver,
  isLinkIndexCurrent,
  normalizeAnchorPath,
  readMappingArtifact,
  requirementAnchorKey,
  specCorpusDigest,
  type SpecLinkIndex,
  type SpecLinkIndexSpecInput,
  type SpecSymbolRef,
} from './spec-link-index.js';

/** Structural docs that own no source files; excluded from the link corpus. */
const NON_DOMAIN_SPECS = new Set(['overview', 'architecture']);

export interface LinkIndexResolutionAvailable {
  state: 'available';
  index: SpecLinkIndex;
  /** `cache` when the persisted artifact was current, `derived` when rebuilt in memory. */
  source: 'cache' | 'derived';
  /** Why the cache was not used, when it was not. Reported, never fatal. */
  cacheReason?: MappingCoverageReason;
  artifactPath: string;
}

export interface LinkIndexResolutionUnavailable {
  state: 'unavailable';
  reason: MappingCoverageReason;
  message: string;
  remediation: string;
  artifactPath: string;
}

export type LinkIndexResolution = LinkIndexResolutionAvailable | LinkIndexResolutionUnavailable;

export interface ResolveLinkIndexOptions {
  rootPath: string;
  /** Repo-relative openspec directory; defaults to `openspec`. */
  openspecPath?: string;
  /** Restrict the corpus to these domains. Omit for the whole corpus. */
  domains?: string[];
  /** Persist a freshly derived index. Read-only callers leave this false. */
  persist?: boolean;
  /** Pre-loaded graph, when the caller already read it. */
  graph?: DependencyGraphResult | null;
  now?: () => Date;
}

// ============================================================================
// INPUTS
// ============================================================================

export function analysisDirOf(rootPath: string): string {
  return safeJoin(rootPath, join(OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR));
}

export function mappingArtifactPath(rootPath: string): string {
  const analysisDir = analysisDirOf(rootPath);
  return safeJoin(analysisDir, ARTIFACT_MAPPING);
}

/**
 * Identity of the analysis the links are resolved against.
 *
 * Today this is the exported-symbol inventory fingerprint — the same key the
 * legacy artifact used, so provenance stays comparable. Section 5 of this change
 * replaces it with the published generation id; this is the single place to swap.
 */
export function analysisGenerationId(graph: DependencyGraphResult): string {
  return mappingSourceFingerprint(graph);
}

/**
 * Read every domain spec as link-index input.
 *
 * A spec path that escapes the repository root is dropped at the source rather
 * than parsed — anchors from it would be evidence about another tree.
 */
export async function loadSpecCorpus(
  rootPath: string,
  openspecPath = OPENSPEC_DIR,
  domains?: string[],
  includeStructuralSpecs = false,
  strict = false,
): Promise<SpecLinkIndexSpecInput[]> {
  const specsDir = join(rootPath, openspecPath, 'specs');
  const wanted = domains?.length ? new Set(domains.map(domain => domain.toLowerCase())) : null;

  let entries;
  try {
    entries = await readdir(specsDir, { withFileTypes: true });
  } catch (error) {
    if (strict) throw error;
    return [];
  }

  const specs: SpecLinkIndexSpecInput[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const domain = String(entry.name);
    if (!includeStructuralSpecs && NON_DOMAIN_SPECS.has(domain.toLowerCase())) continue;
    if (wanted && !wanted.has(domain.toLowerCase())) continue;

    const specPath = join(specsDir, domain, 'spec.md');
    if (!isConfinedPath(rootPath, specPath)) continue;
    try {
      specs.push({
        domain,
        specFile: relative(rootPath, specPath).replaceAll('\\', '/'),
        content: await readFile(specPath, 'utf-8'),
      });
    } catch (error) {
      if (strict) throw error;
      // A domain directory without a readable spec.md contributes nothing.
    }
  }
  return specs.sort((a, b) => a.specFile.localeCompare(b.specFile));
}

/**
 * The boundary that makes a cited file's export inventory unable to vouch for an absent symbol
 * (change: ground-generated-specs-in-the-graph):
 *
 *   - `language-not-extracted` — exports are never extracted for this language;
 *   - `file-not-analyzed` — the file exists but the analysis did not cover it.
 *
 * Parse health is deliberately NOT a boundary: its error regions come from the tree-sitter call-graph
 * extractors, while the export inventory comes from the import parser, which they do not affect — so
 * a tree-sitter error is no evidence the export list is incomplete.
 *
 * A boundary is named only for a file that is ANALYZED or EXISTS AS A REGULAR FILE, resolved to its
 * real spelling (symlinks, and letter case on a case-insensitive volume). A cited file that exists
 * nowhere, or is a directory, is no boundary: its absence is evidence, so the anchor stays `stale`.
 */
export async function buildFileAssessor(
  rootPath: string,
  graph: DependencyGraphResult,
): Promise<(file: string) => string | undefined> {
  return (await buildFileView(rootPath, graph)).assessFile;
}

/** How the link index sees cited files on disk: the boundary, and the real spelling. */
export interface SpecFileView {
  assessFile(file: string): string | undefined;
  canonicalFile(file: string): string | undefined;
}

/**
 * Build the file view behind {@link buildFileAssessor}. Each cited file is resolved ONCE — a corpus
 * citing one file a thousand times pays for one `stat` — to its real repository spelling, or to
 * nothing when it is not a regular file inside the repository. A graph node deleted from disk after
 * analysis resolves to nothing too, so its absent symbol is `stale`, not excused.
 */
export async function buildFileView(rootPath: string, graph: DependencyGraphResult): Promise<SpecFileView> {
  const analyzed = new Set<string>();
  for (const node of graph.nodes) {
    const file = normalizeAnchorPath(node.file.path);
    if (file) analyzed.add(file);
  }
  let realRoot: string | undefined;
  try { realRoot = realpathSync.native(rootPath); } catch { realRoot = undefined; }

  const memo = new Map<string, string | null>();
  const canonicalFile = (file: string): string | undefined => {
    const cached = memo.get(file);
    if (cached !== undefined) return cached ?? undefined;
    let resolved: string | undefined;
    const abs = join(rootPath, file);
    if (realRoot && isConfinedPath(rootPath, abs)) {
      try {
        if (statSync(abs).isFile()) {
          const rel = relative(realRoot, realpathSync.native(abs)).replaceAll('\\', '/');
          if (rel !== '..' && !rel.startsWith('../') && !isAbsolute(rel)) resolved = rel;
        }
      } catch {
        resolved = undefined;
      }
    }
    memo.set(file, resolved ?? null);
    return resolved;
  };

  return {
    canonicalFile,
    assessFile: (file) => {
      const target = canonicalFile(file);
      if (!target) return undefined;
      if (!extractsExports(target)) return 'language-not-extracted';
      if (!analyzed.has(target)) return 'file-not-analyzed';
      return undefined;
    },
  };
}

/**
 * Does a cached index still assess its absent-symbol anchors the way the current files would? The
 * cache is keyed on the analysis and the specs, but an assessment also reads the working tree — so every cited file behind a `stale` or `not-assessed` anchor is re-assessed, and any
 * difference makes the cache stale.
 */
function assessmentsCurrent(index: SpecLinkIndex, assessFile: (file: string) => string | undefined): boolean {
  for (const link of index.links) {
    for (const anchor of link.anchors) {
      if ((anchor.state !== 'stale' && anchor.state !== 'not-assessed') || !anchor.file) continue;
      const expected = anchor.state === 'not-assessed' ? (anchor.boundary ?? null) : null;
      if ((assessFile(anchor.file) ?? null) !== expected) return false;
    }
  }
  return true;
}

async function loadGraph(rootPath: string): Promise<DependencyGraphResult | null> {
  try {
    // Bounded read: repository-controlled artifact (a committed FIFO here would hang this call).
    const raw = await readArtifactBounded(join(analysisDirOf(rootPath), ARTIFACT_DEPENDENCY_GRAPH), ANALYSIS_ARTIFACT_MAX_BYTES);
    return raw ? JSON.parse(raw.text) as DependencyGraphResult : null;
  } catch {
    return null;
  }
}

// ============================================================================
// RESOLUTION
// ============================================================================

/**
 * Resolve the current deterministic link index: cache when it is current,
 * in-memory derivation otherwise.
 */
export async function resolveSpecLinkIndex(options: ResolveLinkIndexOptions): Promise<LinkIndexResolution> {
  const { rootPath } = options;
  const artifactPath = mappingArtifactPath(rootPath);

  const graph = options.graph ?? await loadGraph(rootPath);
  if (!graph) {
    return {
      state: 'unavailable',
      reason: 'analysis-unavailable',
      message: 'No dependency graph found; the current analysis is required to resolve spec anchors.',
      remediation: 'Run `openlore analyze` to build the current analysis.',
      artifactPath,
    };
  }

  const specs = await loadSpecCorpus(rootPath, options.openspecPath, options.domains);
  if (specs.length === 0) {
    return {
      state: 'unavailable',
      reason: 'specs-unavailable',
      message: 'No domain specifications were found to derive requirement links from.',
      remediation: 'Run `openlore generate` to author specifications, or check the configured openspec path.',
      artifactPath,
    };
  }

  const analysisGeneration = analysisGenerationId(graph);
  const digest = specCorpusDigest(specs);
  const fileView = await buildFileView(rootPath, graph);
  const assessFile = fileView.assessFile;

  // The cache is consulted only when the caller asked for the whole corpus: a
  // domain-scoped read must not be served from (or overwrite) a global artifact.
  const scoped = (options.domains?.length ?? 0) > 0;
  let cacheReason: MappingCoverageReason | undefined = scoped ? 'scoped-artifact' : undefined;

  if (!scoped) {
    let raw: string | null = null;
    try {
      raw = await readFile(artifactPath, 'utf-8');
    } catch {
      cacheReason = 'mapping-not-generated';
    }
    if (raw !== null) {
      const read = readMappingArtifact(raw);
      if (read.kind === 'link-index') {
        if (isLinkIndexCurrent(read.index, analysisGeneration, digest) && assessmentsCurrent(read.index, assessFile)) {
          return { state: 'available', index: read.index, source: 'cache', artifactPath };
        }
        cacheReason = 'fingerprint-mismatch';
      } else if (read.kind === 'legacy') {
        cacheReason = 'incompatible-provenance';
      } else {
        cacheReason = 'invalid-json';
      }
    }
  }

  const index = buildSpecLinkIndex({
    specs,
    graph,
    assessFile,
    canonicalFile: fileView.canonicalFile,
    analysisGeneration,
    sourceAnalysisFingerprint: analysisGeneration,
    ...(options.now ? { now: options.now } : {}),
  });

  if (options.persist && !scoped) await writeSpecLinkIndex(rootPath, index);

  return { state: 'available', index, source: 'derived', ...(cacheReason ? { cacheReason } : {}), artifactPath };
}

/** Persist the index as `mapping.json`. */
export async function writeSpecLinkIndex(rootPath: string, index: SpecLinkIndex): Promise<string> {
  const outPath = mappingArtifactPath(rootPath);
  await atomicWriteFile(outPath, JSON.stringify(index, null, 2));
  return outPath;
}

// ============================================================================
// GENERATION-SIDE ANCHOR VERIFICATION
// ============================================================================

/** One requirement's proposed implementation symbol, as produced by generation. */
export interface RequirementAnchorProposal {
  domain: string;
  requirement: string;
  /** The proposed symbol name. An empty or absent name is simply not verifiable. */
  symbol?: string;
}

/**
 * Flatten a pipeline result into one anchor proposal per requirement.
 *
 * Only the LLM's explicitly proposed symbol (`functionName`, or a sub-spec's
 * `callee`) is carried forward. Operation descriptions and names are NOT used to
 * search for a symbol — that search was the semantic/heuristic fallback this
 * change removes.
 */
export function requirementAnchorProposals(pipeline: PipelineResult): RequirementAnchorProposal[] {
  const proposals: RequirementAnchorProposal[] = [];
  for (const service of pipeline.services) {
    const domain = service.domain || 'core';
    for (const operation of service.operations) {
      proposals.push({ domain, requirement: operation.name, symbol: operation.functionName });
    }
    for (const sub of service.subSpecs ?? []) {
      for (const operation of sub.operations ?? []) {
        proposals.push({ domain, requirement: operation.name, symbol: operation.functionName || sub.callee });
      }
    }
  }
  return proposals;
}

/**
 * Keep only the proposals that resolve to exactly one exported symbol.
 *
 * This is the gate between a generator's PROPOSAL and a written spec ANCHOR: a
 * name that resolves to nothing or to several identities is dropped, so the spec
 * is written with no anchor for that requirement instead of a probabilistic one.
 * Standalone generation and agent-hosted skills therefore write anchors under the
 * same rule the link index later reads them under.
 */
export function verifyRequirementAnchors(
  proposals: RequirementAnchorProposal[],
  graph: DependencyGraphResult,
): Map<string, SpecSymbolRef> {
  const resolve = buildSymbolResolver(graph);
  // Group every proposal by key BEFORE resolving: two requirements sharing a key (an operation and a
  // sub-component operation of the same name) must agree, and a disagreement — including one side
  // proposing a name that does not resolve — writes no anchor rather than letting either side's
  // anchor land on both headings. A requirement that proposes nothing does not take part
  // (change: ground-generated-specs-in-the-graph).
  const byKey = new Map<string, Array<{ symbol: string; ref: SpecSymbolRef | null }>>();
  for (const proposal of proposals) {
    const symbol = proposal.symbol?.trim();
    if (!symbol) continue;
    const key = requirementAnchorKey(proposal.domain, proposal.requirement);
    const entries = byKey.get(key) ?? byKey.set(key, []).get(key)!;
    entries.push({ symbol, ref: resolve(symbol) });
  }
  const verified = new Map<string, SpecSymbolRef>();
  for (const [key, entries] of byKey) {
    const first = entries[0];
    if (!first.ref) continue;
    const agree = entries.every(entry => entry.ref
      ? entry.ref.name === first.ref!.name && entry.ref.file === first.ref!.file
      : false);
    if (agree) verified.set(key, first.ref);
  }
  return verified;
}

// ============================================================================
// DERIVED VIEWS
// ============================================================================

/**
 * Shape a resolution as the requirement→code view served by `get_mapping` and
 * consumed by Repair. One shaping for both callers, so a Repair that reuses an
 * already-parsed graph returns exactly what the MCP tool would.
 */
export function mappingViewOf(
  resolution: LinkIndexResolution,
  domain?: string,
  orphansOnly?: boolean,
): Record<string, unknown> {
  if (resolution.state === 'unavailable') {
    return { schemaVersion: 2, error: `${resolution.message} ${resolution.remediation}`, reason: resolution.reason };
  }

  const { index } = resolution;
  const provenance = {
    schemaVersion: 2,
    generatedAt: index.generatedAt,
    source: resolution.source,
    provenance: index.provenance,
    stats: index.stats,
  };

  if (orphansOnly) {
    return {
      ...provenance,
      orphanFunctions: domain ? index.orphanFunctions.filter(fn => fn.file.includes(domain)) : index.orphanFunctions,
    };
  }

  const links = domain ? index.links.filter(link => link.domain === domain) : index.links;
  return {
    ...provenance,
    // `mappings` keeps the historical field name so existing consumers keep reading
    // the same shape; `functions` now holds only exactly-resolved anchors.
    mappings: links.map(link => ({
      requirement: link.requirement,
      domain: link.domain,
      specFile: link.specFile,
      state: link.state,
      functions: link.functions,
      anchors: link.anchors,
      footprintFiles: link.footprintFiles,
    })),
    orphanFunctions: domain ? [] : index.orphanFunctions,
  };
}

/**
 * File-qualified keys (`file::name`) of every symbol a requirement links to.
 *
 * ONLY qualified. A bare `name` key was previously added alongside, which made
 * coverage leak across files: an anchor on `foo::src/a.ts` marked an unrelated
 * `foo` in `src/b.ts` covered too, inflating the audit. Every linked symbol is a
 * uniquely resolved reference, so its file is always known — including for a
 * bare-name anchor, which only links when exactly one symbol carries that name.
 */
export function coveredSymbolKeys(index: SpecLinkIndex): Set<string> {
  const covered = new Set<string>();
  for (const link of index.links) {
    for (const fn of link.functions) {
      covered.add(`${fn.file}::${fn.name}`);
    }
  }
  return covered;
}

/**
 * Requirements that establish no function coverage.
 *
 * `unmapped` and `stale` requirements are orphans: the first cites no exact
 * symbol, the second cites one that is gone. An `ambiguous` requirement is NOT an
 * orphan — it names a real symbol that the repository defines more than once — and
 * neither is a `not-assessed` one, whose citation the analysis simply cannot check.
 */
export function orphanRequirementsOf(
  index: SpecLinkIndex,
  domains?: Set<string>,
): Array<{ requirement: string; domain: string; specFile: string; state: SpecLinkIndex['links'][number]['state'] }> {
  return index.links
    .filter(link => link.functions.length === 0 && link.state !== 'ambiguous' && link.state !== 'not-assessed')
    .filter(link => !domains || domains.has(link.domain))
    .map(link => ({ requirement: link.requirement, domain: link.domain, specFile: link.specFile, state: link.state }));
}
