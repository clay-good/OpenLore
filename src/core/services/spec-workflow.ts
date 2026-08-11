import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { isAbsolute, join, posix, relative } from 'node:path';

import {
  ARTIFACT_DEPENDENCY_GRAPH,
  ARTIFACT_LLM_CONTEXT,
  ARTIFACT_REPO_STRUCTURE,
  OPENLORE_ANALYSIS_SUBDIR,
  OPENLORE_DIR,
  OPENSPEC_DIR,
} from '../../constants.js';
import type { LLMContext, RepoStructure } from '../analyzer/artifact-generator.js';
import type { DependencyGraphResult } from '../analyzer/dependency-graph.js';
import { parseSpecHeader, parseSpecReferences } from '../drift/spec-mapper.js';
import { buildDomainEvidence, type DomainEvidenceBundle } from '../generator/domain-evidence.js';
import { loadSpecCorpus, mappingViewOf, resolveSpecLinkIndex } from '../generator/spec-link-service.js';
import {
  EVIDENCE_STREAM_PROTOCOL,
  clampResponseBytes,
  decodeEvidenceCursor,
  encodeEvidenceCursor,
  packEvidenceStream,
  trimPageToBudget,
  type EvidencePage,
  type EvidenceSection,
  type EvidenceStreamPosition,
} from './evidence-stream.js';
import {
  REQUIRED_ANALYSIS_ARTIFACTS,
  readGenerationSnapshot,
} from '../runtime/analysis-generation.js';
import { readOpenLoreConfig } from './config-manager.js';
import { computeSpecOverlapObservations, type SpecOverlapResult } from './spec-overlap.js';
import {
  GENERATION_STREAM_SECTIONS,
  REPAIR_STREAM_SECTIONS,
  buildGenerationStream,
  buildRepairStream,
  structuralChangeRecords,
  structuralChangeSummary,
} from './spec-workflow-stream.js';
import { handleAuditSpecCoverage, handleCheckSpecDrift } from './mcp-handlers/analysis.js';
import { handleGetSpec } from './mcp-handlers/semantic.js';
import { handleStructuralDiff } from './mcp-handlers/structural-diff.js';
import { validateDirectory } from './mcp-handlers/utils.js';

/**
 * The observation names each workflow can report.
 *
 * These are the stream sections plus the page-global observations that are never
 * paged (they are single scalars, not lists). Host adapters close over this list
 * in conformance tests, so adding an observation must either surface it or
 * document an exclusion.
 */
export const SPEC_WORKFLOW_SECTIONS = {
  generation: GENERATION_STREAM_SECTIONS,
  repair: [...REPAIR_STREAM_SECTIONS, 'mappingCoverage'] as const,
} as const;

export type SpecWorkflow = keyof typeof SPEC_WORKFLOW_SECTIONS;
export type SpecWorkflowReceiptState = 'complete' | 'partial' | 'unavailable';
export type SpecWorkflowErrorCode = 'analysis-unavailable' | 'analysis-changed' | 'unknown-domain' | 'spec-not-found' | 'response-too-large';

export interface SpecWorkflowFollowUp {
  tool: string;
  arguments: Record<string, unknown>;
  reason: string;
}

export interface SpecWorkflowReceipt {
  state: SpecWorkflowReceiptState;
  included: string[];
  omitted: Array<{ section: string; reason: string; omittedCount?: number }>;
  continuationCursor?: string;
  followUps: SpecWorkflowFollowUp[];
}

export interface SpecWorkflowEnvelope {
  workflow: SpecWorkflow;
  domain: { requested: string; resolved?: string };
  provenance?: {
    analysisFingerprint: string;
    artifactTimestamps: Record<string, string>;
    /** Evidence-stream protocol version this page was built under. */
    protocol?: number;
    /** Effective serialized byte budget the page was packed against. */
    responseBytes?: number;
    /** Committed analysis generation every artifact on this page was read from. */
    analysisGeneration?: string;
    /** `legacy` when the analysis predates generation manifests. */
    generationCompatibility?: 'manifest' | 'legacy';
  };
  receipt: SpecWorkflowReceipt;
  evidence?: Record<string, unknown>;
  error?: { code: SpecWorkflowErrorCode; message: string; availableDomains?: string[] };
}

export interface PrepareSpecInput {
  directory: string;
  domain: string;
  cursor?: string;
  maxItems?: number;
  /**
   * Requested serialized response budget in bytes. Clamped into the server range;
   * a caller may request less than the default, never more than the maximum.
   */
  maxResponseBytes?: number;
  baseRef?: string;
  signal?: AbortSignal;
}

const clampMaxItems = (value?: number): number => Math.max(10, Math.min(Math.floor(value ?? 80), 200));

interface LoadedAnalysis {
  root: string; repo: RepoStructure; graph: DependencyGraphResult; fingerprint: string;
  context: LLMContext; timestamps: Record<string, string>;
  /** Configured spec root, so a repo that moved `openspec/` still resolves links. */
  openspecPath: string;
  /** Committed generation identity this snapshot was read under. */
  generationId: string;
  /** `legacy` when the analysis predates generation manifests. */
  generationCompatibility: 'manifest' | 'legacy';
}

/**
 * Read the analysis artifacts as ONE coherent generation.
 *
 * Wrapped in {@link readGenerationSnapshot}: the current generation identity is
 * validated before and after the multi-artifact read, so a rebuild that lands
 * mid-read yields `analysis-changed` rather than a mixture of old and new paths.
 */
async function loadAnalysisSnapshot(directory: string): Promise<
  { state: 'ok'; loaded: LoadedAnalysis } | { state: 'unavailable' } | { state: 'changed'; message: string }
> {
  const root = await validateDirectory(directory);
  const analysisDir = join(root, OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR);
  const openspecPath = (await readOpenLoreConfig(root).catch(() => null))?.openspecPath ?? OPENSPEC_DIR;
  const snapshot = await readGenerationSnapshot(
    analysisDir,
    [...REQUIRED_ANALYSIS_ARTIFACTS],
    async () => loadAnalysisArtifacts(root, analysisDir),
  );
  if (snapshot.state === 'analysis-unavailable') return { state: 'unavailable' };
  if (snapshot.state === 'analysis-changed') return { state: 'changed', message: snapshot.message };
  if (!snapshot.value) return { state: 'unavailable' };
  return {
    state: 'ok',
    loaded: {
      ...snapshot.value,
      openspecPath,
      generationId: snapshot.generationId,
      generationCompatibility: snapshot.compatibility,
    },
  };
}

async function loadAnalysisArtifacts(root: string, analysis: string): Promise<Omit<LoadedAnalysis, 'openspecPath' | 'generationId' | 'generationCompatibility'> | null> {
  try {
    const repoPath = join(analysis, ARTIFACT_REPO_STRUCTURE);
    const graphPath = join(analysis, ARTIFACT_DEPENDENCY_GRAPH);
    const contextPath = join(analysis, ARTIFACT_LLM_CONTEXT);
    const [repoRaw, graphRaw, contextRaw, repoStat, graphStat, contextStat] = await Promise.all([
      readFile(repoPath, 'utf8'),
      readFile(graphPath, 'utf8'),
      readFile(contextPath, 'utf8'),
      stat(repoPath),
      stat(graphPath),
      stat(contextPath),
    ]);
    const repo = JSON.parse(repoRaw) as RepoStructure;
    const graph = JSON.parse(graphRaw) as DependencyGraphResult;
    const context = JSON.parse(contextRaw) as LLMContext;
    const fingerprint = createHash('sha256')
      .update(repoRaw).update('\0').update(graphRaw).update('\0')
      .update(contextRaw).digest('hex');
    return {
      root, repo, graph, fingerprint, context,
      timestamps: {
        [ARTIFACT_REPO_STRUCTURE]: repoStat.mtime.toISOString(),
        [ARTIFACT_DEPENDENCY_GRAPH]: graphStat.mtime.toISOString(),
        [ARTIFACT_LLM_CONTEXT]: contextStat.mtime.toISOString(),
      },
    };
  } catch { return null; }
}

function unavailable(workflow: SpecWorkflow, domain: string, code: SpecWorkflowErrorCode, message: string, availableDomains?: string[]): SpecWorkflowEnvelope {
  return {
    workflow, domain: { requested: domain },
    receipt: { state: 'unavailable', included: [], omitted: [{ section: 'domainEvidence', reason: code }], followUps: [] },
    error: { code, message, ...(availableDomains ? { availableDomains } : {}) },
  };
}

/**
 * Pack one page of a workflow's evidence stream and build its envelope.
 *
 * The single place that turns a stream plus a position into a transport-safe
 * response: it packs by estimate, measures the REAL serialized envelope, trims
 * to the exact budget, and only then decides the receipt state. A receipt can
 * therefore claim `complete` only after the final within-budget envelope exists
 * — the failure mode this change was written to remove.
 */
function respondWithPage(args: {
  workflow: SpecWorkflow;
  requestedDomain: string;
  resolvedDomain?: string;
  loaded: LoadedAnalysis;
  sections: EvidenceSection[];
  pageGlobal: Record<string, unknown>;
  start: EvidenceStreamPosition;
  budget: number;
  followUpsFor: (page: EvidencePage) => SpecWorkflowFollowUp[];
  /**
   * Omissions that are NOT volume-driven — evidence withheld because it could not
   * be established. These make the receipt partial but are not recoverable by a
   * cursor, so they are kept separate from the pager's own omissions.
   */
  extraOmissions?: Array<{ section: string; reason: string; omittedCount?: number }>;
}): SpecWorkflowEnvelope {
  const { workflow, requestedDomain, resolvedDomain, loaded, sections, pageGlobal, start, budget } = args;
  const extraOmissions = args.extraOmissions ?? [];

  const build = (page: EvidencePage): SpecWorkflowEnvelope => {
    const cursor = page.next
      ? encodeEvidenceCursor({
          v: EVIDENCE_STREAM_PROTOCOL, w: workflow, d: requestedDomain, g: loaded.fingerprint,
          s: page.next.sectionIndex, o: page.next.offset, b: budget,
        })
      : undefined;
    return {
      workflow,
      domain: { requested: requestedDomain, ...(resolvedDomain ? { resolved: resolvedDomain } : {}) },
      provenance: {
        analysisFingerprint: loaded.fingerprint,
        artifactTimestamps: loaded.timestamps,
        protocol: EVIDENCE_STREAM_PROTOCOL,
        responseBytes: budget,
        analysisGeneration: loaded.generationId,
        generationCompatibility: loaded.generationCompatibility,
      },
      receipt: {
        state: page.next || extraOmissions.length > 0 ? 'partial' : 'complete',
        included: page.included.filter(section => !extraOmissions.some(entry => entry.section === section)),
        omitted: [...page.omitted, ...extraOmissions],
        ...(cursor ? { continuationCursor: cursor } : {}),
        followUps: args.followUpsFor(page),
      },
      evidence: { ...pageGlobal, ...page.records },
    };
  };

  // Reserve room for the parts of the envelope that are not stream records.
  const envelopeBytes = Buffer.byteLength(JSON.stringify(build({
    included: [], omitted: [], records: {}, starts: {},
    next: { sectionIndex: sections.length, offset: 0 },
  })), 'utf8');

  const page = packEvidenceStream(sections, start, budget, envelopeBytes);
  if (page.unrepresentable) {
    return unavailable(
      workflow, requestedDomain, 'response-too-large',
      `A single ${page.unrepresentable.section} record is ${page.unrepresentable.bytes} bytes and cannot be represented within the ${budget}-byte response budget. Use the atomic MCP tools for targeted inspection.`,
    );
  }

  const fits = trimPageToBudget(page, sections, budget, candidate => Buffer.byteLength(JSON.stringify(build(candidate)), 'utf8'));
  if (!fits) {
    return unavailable(
      workflow, requestedDomain, 'response-too-large',
      `The page-global evidence alone exceeds the ${budget}-byte response budget. Use the atomic MCP tools for targeted inspection.`,
    );
  }
  return build(page);
}

/** Resolve the caller's cursor into a stream position, or an error envelope. */
function resolveStart(
  workflow: SpecWorkflow,
  input: PrepareSpecInput,
  fingerprint: string,
  sectionCount: number,
): { start: EvidenceStreamPosition; budget: number } | SpecWorkflowEnvelope {
  if (!input.cursor) {
    return { start: { sectionIndex: 0, offset: 0 }, budget: clampResponseBytes(input.maxResponseBytes) };
  }
  const cursor = decodeEvidenceCursor(input.cursor);
  if (!cursor || cursor.w !== workflow || cursor.d !== input.domain) {
    return unavailable(workflow, input.domain, 'analysis-changed', `Invalid continuation cursor; restart ${workflow} preparation.`);
  }
  if (cursor.g !== fingerprint) {
    return unavailable(workflow, input.domain, 'analysis-changed', `Analysis changed after the cursor was issued; restart ${workflow} preparation.`);
  }
  // `>=`, not `>`: a cursor AT the end of the stream is never emitted — the final
  // page carries no continuation. Accepting one returned an empty page stamped
  // `complete`, which is the one answer this protocol must never give for evidence
  // it did not deliver.
  if (cursor.s >= sectionCount) {
    return unavailable(workflow, input.domain, 'analysis-changed', `Continuation cursor is outside the current evidence stream; restart ${workflow} preparation.`);
  }
  return { start: { sectionIndex: cursor.s, offset: cursor.o }, budget: cursor.b };
}

export async function prepareSpecGeneration(input: PrepareSpecInput): Promise<SpecWorkflowEnvelope> {
  input.signal?.throwIfAborted();
  const snapshot = await loadAnalysisSnapshot(input.directory);
  input.signal?.throwIfAborted();
  if (snapshot.state === 'changed') return unavailable('generation', input.domain, 'analysis-changed', snapshot.message);
  if (snapshot.state !== 'ok') return unavailable('generation', input.domain, 'analysis-unavailable', 'No compatible analysis found. Run analyze_codebase first.');
  const loaded = snapshot.loaded;

  const bundles = buildDomainEvidence(loaded.repo, loaded.context);
  const bundle = bundles.find(item => item.name === input.domain);
  if (!bundle) return unavailable('generation', input.domain, 'unknown-domain', `No analyzed domain named "${input.domain}".`, bundles.map(item => item.name));

  // Resolve the cursor BEFORE building the stream: overlap costs a full read of
  // the spec corpus plus a link-index build, and a continuation page that has
  // already streamed past the `overlap` section must not pay for it again.
  const resolved = resolveStart('generation', input, loaded.fingerprint, GENERATION_STREAM_SECTIONS.length);
  if ('receipt' in resolved) return resolved;

  const overlapIndex = GENERATION_STREAM_SECTIONS.indexOf('overlap');
  const overlap = resolved.start.sectionIndex <= overlapIndex
    ? await computeSpecOverlap(loaded, bundle)
    : { observations: [], provenance: { state: 'available' as const, comparedSpecs: 0, candidateFiles: bundle.files.length, candidateSymbols: 0, complete: true, basis: [], deliveredOnEarlierPage: true } };
  input.signal?.throwIfAborted();
  const sections = buildGenerationStream({
    root: loaded.root, bundle, repo: loaded.repo, graph: loaded.graph, overlap: overlap.observations,
  });

  return respondWithPage({
    workflow: 'generation',
    requestedDomain: input.domain,
    resolvedDomain: bundle.name,
    loaded,
    sections,
    pageGlobal: {
      domainSummary: {
        name: bundle.name,
        fileCount: bundle.files.length,
        definingFileCount: bundle.definingFiles.length,
        supportingFileCount: bundle.supportingFiles.length,
        ...(bundle.candidateDecisionSummary ? { candidateDecisionSummary: bundle.candidateDecisionSummary } : {}),
      },
      specOverlap: overlap.provenance,
      streamSections: [...GENERATION_STREAM_SECTIONS],
    },
    start: resolved.start,
    budget: resolved.budget,
    followUpsFor: page => continuationFollowUps('generation', input, page),
  });
}

/**
 * Deterministic overlap between the candidate domain and the existing specs.
 *
 * Read-only and non-fatal: a repository with no specs yields an available, empty
 * observation set, and a failure to read them is disclosed rather than thrown —
 * generation evidence remains useful without it.
 */
async function computeSpecOverlap(
  loaded: LoadedAnalysis,
  bundle: DomainEvidenceBundle,
): Promise<SpecOverlapResult> {
  try {
    const specs = await loadSpecCorpus(loaded.root, loaded.openspecPath);
    const resolution = await resolveSpecLinkIndex({
      rootPath: loaded.root, openspecPath: loaded.openspecPath, persist: false, graph: loaded.graph,
    });
    return computeSpecOverlapObservations({
      candidateDomain: bundle.name,
      candidateFiles: bundle.files,
      graph: loaded.graph,
      specs,
      linkIndex: resolution.state === 'available' ? resolution.index : null,
    });
  } catch (err) {
    return {
      observations: [],
      provenance: {
        state: 'unavailable',
        reason: err instanceof Error ? err.message : String(err),
        comparedSpecs: 0, candidateFiles: bundle.files.length, candidateSymbols: 0,
        complete: false, basis: [],
      },
    };
  }
}

/**
 * The only follow-up a volume-driven omission needs is the SAME composite with
 * its cursor: it is guaranteed callable in the default substrate preset, so it
 * cannot advertise a tool the active surface does not expose.
 */
function continuationFollowUps(
  workflow: SpecWorkflow,
  input: PrepareSpecInput,
  page: EvidencePage,
): SpecWorkflowFollowUp[] {
  if (!page.next) return [];
  return [{
    tool: workflow === 'generation' ? 'prepare_spec_generation' : 'prepare_spec_repair',
    arguments: { directory: input.directory, domain: input.domain, cursor: '<continuationCursor>' },
    reason: `Retrieve the deferred ${page.omitted.map(entry => entry.section).join(', ')} evidence from the same composite.`,
  }];
}

function objectResult(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function historicalSpecPaths(content: string): string[] {
  return [...new Set([
    ...parseSpecHeader(content).sourceFiles,
    ...parseSpecReferences(content).files,
  ].map(value => posix.normalize(value.replaceAll('\\', '/').replace(/^\.\//, '')))
    .filter(value => value !== '..' && !value.startsWith('../') && !isAbsolute(value) && !/^[A-Za-z]:\//.test(value)))].sort();
}

function normalizeScopedPath(root: string, value: string): string | null {
  const slashPath = value.replaceAll('\\', '/');
  const rootSlash = root.replaceAll('\\', '/');
  const relativePath = slashPath.startsWith(`${rootSlash}/`) ? slashPath.slice(rootSlash.length + 1) : slashPath;
  const normalized = posix.normalize(relativePath.replace(/^\.\//, ''));
  return normalized !== '..' && !normalized.startsWith('../') && !isAbsolute(normalized) && !/^[A-Za-z]:\//.test(normalized)
    ? normalized : null;
}

export async function prepareSpecRepair(input: PrepareSpecInput): Promise<SpecWorkflowEnvelope> {
  input.signal?.throwIfAborted();
  const snapshot = await loadAnalysisSnapshot(input.directory);
  input.signal?.throwIfAborted();
  if (snapshot.state === 'changed') return unavailable('repair', input.domain, 'analysis-changed', snapshot.message);
  if (snapshot.state !== 'ok') return unavailable('repair', input.domain, 'analysis-unavailable', 'No compatible analysis found. Run analyze_codebase first.');
  const loaded = snapshot.loaded;
  const spec = objectResult(await handleGetSpec(loaded.root, input.domain));
  if (typeof spec.error === 'string') return unavailable('repair', input.domain, 'spec-not-found', spec.error);

  const bundles = buildDomainEvidence(loaded.repo, loaded.context);
  const bundle = bundles.find(item => item.name === input.domain);
  // Resolve links against the graph this composite already parsed rather than
  // re-reading `dependency-graph.json` for the same request.
  const [mappingRaw, drift] = await Promise.all([
    resolveSpecLinkIndex({
      rootPath: loaded.root, openspecPath: loaded.openspecPath, domains: [input.domain], persist: false, graph: loaded.graph,
    })
      .then(resolution => mappingViewOf(resolution, input.domain)),
    handleCheckSpecDrift(loaded.root, input.baseRef ?? 'auto', [], [input.domain]),
  ]);
  input.signal?.throwIfAborted();
  const mapping = objectResult(mappingRaw);
  const paths = new Set((bundle?.files ?? []).map(path => normalizeScopedPath(loaded.root, path)).filter((path): path is string => path !== null));
  if (typeof spec.content === 'string') historicalSpecPaths(spec.content).forEach(path => paths.add(path));
  const mappings = Array.isArray(mapping.mappings) ? mapping.mappings as Array<Record<string, unknown>> : [];
  for (const entry of mappings) for (const fn of Array.isArray(entry.functions) ? entry.functions as Array<Record<string, unknown>> : []) {
    if (typeof fn.file === 'string') {
      const normalized = normalizeScopedPath(loaded.root, fn.file);
      if (normalized) paths.add(normalized);
    }
  }
  const scopedPaths = [...paths].sort();
  const maxItems = clampMaxItems(input.maxItems);
  const audit = await handleAuditSpecCoverage(
    loaded.root,
    maxItems,
    5,
    false,
    { files: scopedPaths, domains: [input.domain] },
  );
  input.signal?.throwIfAborted();
  const scopedSet = new Set(scopedPaths);
  const inScope = (path: unknown): boolean => typeof path === 'string' && scopedSet.has(path.startsWith(loaded.root) ? relative(loaded.root, path) : path);
  const structuralChange = scopedPaths.length > 0
    ? await handleStructuralDiff({ directory: loaded.root, baseRef: input.baseRef ?? 'HEAD', files: scopedPaths, maxResults: Math.min(clampMaxItems(input.maxItems), 50) })
    : { state: 'unavailable', reason: 'empty-historical-footprint', message: 'No current or historical source path could be recovered.' };
  input.signal?.throwIfAborted();
  const auditObj = objectResult(audit);
  const mappingCoverage = auditObj.mappingCoverage;
  const allOrphanRequirements = (Array.isArray(auditObj.orphanRequirements)
    ? auditObj.orphanRequirements as Array<Record<string, unknown>> : []).filter(item => item.domain === input.domain);
  const scopedAudit = {
    ...auditObj,
    uncoveredFunctions: (Array.isArray(auditObj.uncoveredFunctions) ? auditObj.uncoveredFunctions as Array<Record<string, unknown>> : []).filter(item => inScope(item.file)),
    orphanRequirements: allOrphanRequirements.slice(0, maxItems),
    staleDomains: (Array.isArray(auditObj.staleDomains) ? auditObj.staleDomains as Array<Record<string, unknown>> : []).filter(item => item.name === input.domain),
    summary: {},
  };
  const scopedNodes = (loaded.context.callGraph?.nodes ?? []).filter(node => inScope(node.filePath));
  const coverageAvailable = objectResult(mappingCoverage).state === 'available';
  // The audit already ran under exactly this file scope, so its own summary is the
  // scoped one — and, unlike the returned `uncoveredFunctions` list, it is NOT
  // truncated to `maxItems`. Recomputing the counts from the truncated list would
  // report a bounded page as if it were the whole gap.
  const auditSummary = objectResult(auditObj.summary);
  const scopedCount = (key: string): number | null =>
    (coverageAvailable && typeof auditSummary[key] === 'number' ? auditSummary[key] as number : null);
  // Mapping-dependent metrics are null when coverage is unavailable; the analyzed
  // function total and the stale-domain count are observable either way.
  scopedAudit.summary = {
    totalFunctions: typeof auditSummary.totalFunctions === 'number' ? auditSummary.totalFunctions : scopedNodes.length,
    coveredFunctions: scopedCount('coveredFunctions'),
    coveragePct: scopedCount('coveragePct'),
    uncoveredCount: scopedCount('uncoveredCount'),
    hubGapCount: scopedCount('hubGapCount'),
    orphanRequirementCount: coverageAvailable ? allOrphanRequirements.length : null,
    staleDomainCount: scopedAudit.staleDomains.length,
  };
  const mappingUnavailable = !coverageAvailable;
  const specContent = typeof spec.content === 'string' ? spec.content : '';

  // Coverage-dependent evidence is WITHHELD (null), not paged, when the link
  // index could not be resolved: an unavailable observation is a different thing
  // from a deferred one, and a cursor cannot recover it.
  const mappingDependentSections = ['coveredFunction', 'uncoveredFunction', 'orphanRequirement'] as const;
  const coverageOmissions = mappingUnavailable
    ? mappingDependentSections.map(section => ({
        section,
        reason: `mapping-${String(objectResult(mappingCoverage).reason ?? 'unavailable')}`,
        omittedCount: 0,
      }))
    : [];

  const allCoveredFunctions = mappings.flatMap(entry =>
    (Array.isArray(entry.functions) ? entry.functions as Array<Record<string, unknown>> : [])
      .filter(fn => fn.name !== '*' && inScope(fn.file)),
  );
  // A stale link is a requirement whose exact anchor no longer resolves — evidence
  // about the SPEC, not about the mapping cache. It is observable whenever the
  // link index resolved at all, so it is reported independently of cache state.
  const staleMapping = mappings
    .filter(entry => entry.state === 'stale')
    .map(entry => ({
      requirement: entry.requirement,
      domain: entry.domain,
      specFile: entry.specFile,
      anchors: Array.isArray(entry.anchors)
        ? (entry.anchors as Array<Record<string, unknown>>).filter(anchor => anchor.state === 'stale')
        : [],
    }));

  const driftIssues = Array.isArray(objectResult(drift).issues) ? objectResult(drift).issues as unknown[] : [];
  const sections = buildRepairStream({
    specContent,
    coveredFunction: mappingUnavailable ? [] : allCoveredFunctions,
    uncoveredFunction: mappingUnavailable ? [] : scopedAudit.uncoveredFunctions,
    staleMapping: mappingUnavailable ? [] : staleMapping,
    orphanRequirement: mappingUnavailable ? [] : allOrphanRequirements,
    structuralChange: structuralChangeRecords(structuralChange),
    drift: driftIssues,
    domainMembership: (bundle?.files ?? []).map(path => ({ path })),
    candidateDecisions: bundle?.candidateDecisions ?? [],
  });

  const resolved = resolveStart('repair', input, loaded.fingerprint, sections.length);
  if ('receipt' in resolved) return resolved;

  const mappingProvenance = {
    state: typeof mapping.error === 'string' ? 'unavailable' : 'available',
    ...(typeof mapping.error === 'string' ? { reason: mapping.reason ?? mapping.error } : {}),
    generatedAt: mapping.generatedAt,
    // `cache` or `derived` — Repair works either way, so the host can see that a
    // missing cache did not degrade the evidence it is reading.
    source: mapping.source,
    provenance: mapping.provenance,
    stats: mapping.stats,
  };

  return respondWithPage({
    workflow: 'repair',
    requestedDomain: input.domain,
    ...(bundle ? { resolvedDomain: bundle.name } : {}),
    loaded,
    sections,
    pageGlobal: {
      existingSpecMeta: { domain: spec.domain, path: spec.path, length: specContent.length },
      domainEvidenceCoverage: bundle
        ? { state: 'available', fileCount: bundle.files.length }
        : { state: 'unavailable', reason: 'domain-not-analyzed', possibleOrphan: true },
      mapping: mappingProvenance,
      mappingCoverage,
      coverageSummary: scopedAudit.summary,
      staleDomains: scopedAudit.staleDomains,
      driftSummary: { state: typeof objectResult(drift).error === 'string' ? 'unavailable' : 'available', summary: objectResult(drift).summary },
      structuralChangeSummary: structuralChangeSummary(structuralChange),
      structuralScope: scopedPaths.slice(0, maxItems),
      structuralScopeTotal: scopedPaths.length,
      structuralScopeTruncated: scopedPaths.length > maxItems,
      streamSections: [...REPAIR_STREAM_SECTIONS],
    },
    start: resolved.start,
    budget: resolved.budget,
    followUpsFor: page => [
      ...continuationFollowUps('repair', input, page),
      ...(mappingUnavailable ? [mappingRemediation(loaded.root, objectResult(mappingCoverage))] : []),
    ],
    extraOmissions: coverageOmissions,
  });
}

/**
 * Remediation for unavailable mapping coverage.
 *
 * Never "run the audit again": repeating the observation that just came back
 * unavailable cannot change it. The actionable step is either rebuilding the
 * analysis the anchors resolve against, or writing exact anchors into the spec —
 * and both are exact local commands or explicit edits, not tool names that may
 * be absent from the active surface.
 */
function mappingRemediation(root: string, coverage: Record<string, unknown>): SpecWorkflowFollowUp {
  const reason = String(coverage.reason ?? 'unavailable');
  if (reason === 'analysis-unavailable') {
    return {
      tool: 'cli:openlore analyze',
      arguments: { directory: root },
      reason: 'Requirement anchors cannot be resolved without a current analysis. Run `openlore analyze`, then retry.',
    };
  }
  if (reason === 'specs-unavailable') {
    return {
      tool: 'edit:add-implementation-anchor',
      arguments: { directory: root },
      reason: 'No domain specification carries requirement anchors yet. Add `- **Implementation**: `symbol::path/to/file.ts`` under each requirement.',
    };
  }
  return {
    tool: 'cli:openlore mapping refresh',
    arguments: { directory: root },
    reason: 'Rebuild the deterministic spec link index with `openlore mapping refresh` (no LLM), then retry.',
  };
}
