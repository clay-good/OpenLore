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

import { readFile, readdir, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';

import {
  ARTIFACT_DEPENDENCY_GRAPH,
  ARTIFACT_MAPPING,
  OPENLORE_ANALYSIS_SUBDIR,
  OPENLORE_DIR,
  OPENSPEC_DIR,
} from '../../constants.js';
import type { MappingCoverageReason } from '../../types/index.js';
import { isConfinedPath } from '../../utils/path-confinement.js';
import type { DependencyGraphResult } from '../analyzer/dependency-graph.js';
import { mappingSourceFingerprint } from './mapping-generator.js';
import type { PipelineResult } from './spec-pipeline.js';
import {
  buildSpecLinkIndex,
  buildSymbolResolver,
  isLinkIndexCurrent,
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
  return join(rootPath, OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR);
}

export function mappingArtifactPath(rootPath: string): string {
  return join(analysisDirOf(rootPath), ARTIFACT_MAPPING);
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
): Promise<SpecLinkIndexSpecInput[]> {
  const specsDir = join(rootPath, openspecPath, 'specs');
  const wanted = domains?.length ? new Set(domains.map(domain => domain.toLowerCase())) : null;

  let entries;
  try {
    entries = await readdir(specsDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const specs: SpecLinkIndexSpecInput[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const domain = String(entry.name);
    if (NON_DOMAIN_SPECS.has(domain.toLowerCase())) continue;
    if (wanted && !wanted.has(domain.toLowerCase())) continue;

    const specPath = join(specsDir, domain, 'spec.md');
    if (!isConfinedPath(rootPath, specPath)) continue;
    try {
      specs.push({
        domain,
        specFile: relative(rootPath, specPath).replaceAll('\\', '/'),
        content: await readFile(specPath, 'utf-8'),
      });
    } catch {
      // A domain directory without a readable spec.md contributes nothing.
    }
  }
  return specs.sort((a, b) => a.specFile.localeCompare(b.specFile));
}

async function loadGraph(rootPath: string): Promise<DependencyGraphResult | null> {
  try {
    return JSON.parse(await readFile(join(analysisDirOf(rootPath), ARTIFACT_DEPENDENCY_GRAPH), 'utf-8')) as DependencyGraphResult;
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
        if (isLinkIndexCurrent(read.index, analysisGeneration, digest)) {
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
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, JSON.stringify(index, null, 2), 'utf-8');
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
  const verified = new Map<string, SpecSymbolRef>();
  for (const proposal of proposals) {
    const symbol = proposal.symbol?.trim();
    if (!symbol) continue;
    const ref = resolve(symbol);
    if (ref) verified.set(requirementAnchorKey(proposal.domain, proposal.requirement), ref);
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
    return { error: `${resolution.message} ${resolution.remediation}`, reason: resolution.reason };
  }

  const { index } = resolution;
  const provenance = {
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

/** Keys (`file::name` and bare `name`) of every symbol a requirement links to. */
export function coveredSymbolKeys(index: SpecLinkIndex): Set<string> {
  const covered = new Set<string>();
  for (const link of index.links) {
    for (const fn of link.functions) {
      covered.add(`${fn.file}::${fn.name}`);
      covered.add(fn.name);
    }
  }
  return covered;
}

/**
 * Requirements that establish no function coverage.
 *
 * `unmapped` and `stale` requirements are orphans: the first cites no exact
 * symbol, the second cites one that is gone. An `ambiguous` requirement is NOT an
 * orphan — it names a real symbol that the repository defines more than once.
 */
export function orphanRequirementsOf(
  index: SpecLinkIndex,
  domains?: Set<string>,
): Array<{ requirement: string; domain: string; specFile: string; state: SpecLinkIndex['links'][number]['state'] }> {
  return index.links
    .filter(link => link.functions.length === 0 && link.state !== 'ambiguous')
    .filter(link => !domains || domains.has(link.domain))
    .map(link => ({ requirement: link.requirement, domain: link.domain, specFile: link.specFile, state: link.state }));
}
