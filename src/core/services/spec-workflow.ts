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
  OPENSPEC_SPECS_SUBDIR,
  REPO_CONTENT_PROVENANCE,
} from '../../constants.js';
import { resolveOpenspecDir } from '../../utils/openspec-dir.js';
import type { LLMContext, RepoStructure } from '../analyzer/artifact-generator.js';
import type { DependencyGraphResult } from '../analyzer/dependency-graph.js';
import { isDocumentationFile } from '../analyzer/domain-naming.js';
import { parseSpecHeader, parseSpecReferences } from '../drift/spec-mapper.js';
import { detectOpenSpecPackageVersion } from '../runtime/package-versions.js';
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
import { redactSecretsWithReport } from './secret-redaction.js';

/**
 * The observation names each workflow can report.
 *
 * These are the stream sections plus the page-global observations that are never
 * paged (they are single scalars, not lists). Host adapters close over this list
 * in conformance tests, so adding an observation must either surface it or
 * document an exclusion.
 */
export const SPEC_WORKFLOW_SECTIONS = {
  generation: [...GENERATION_STREAM_SECTIONS, 'domainBehavior', 'specValidation'] as const,
  repair: [...REPAIR_STREAM_SECTIONS, 'mappingCoverage', 'specValidation', 'domainBehavior'] as const,
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
    /** `incremental` means watcher-patched evidence over the last full survey. */
    generationCoherence?: 'full' | 'incremental';
  };
  receipt: SpecWorkflowReceipt;
  evidence?: Record<string, unknown>;
  error?: { code: SpecWorkflowErrorCode; message: string; availableDomains?: string[] };
  redactions?: { count: number; kinds: string[] };
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

function compositionFingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

interface LoadedAnalysis {
  root: string; repo: RepoStructure; graph: DependencyGraphResult; fingerprint: string;
  context: LLMContext; timestamps: Record<string, string>;
  /** Configured spec root, so a repo that moved `openspec/` still resolves links. */
  openspecPath: string;
  /** Committed generation identity this snapshot was read under. */
  generationId: string;
  /** `legacy` when the analysis predates generation manifests. */
  generationCompatibility: 'manifest' | 'legacy';
  generationCoherence: 'full' | 'incremental';
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
  const configuredPath = (await readOpenLoreConfig(root).catch(() => null))?.openspecPath ?? OPENSPEC_DIR;
  const openspecPath = relative(root, resolveOpenspecDir(root, configuredPath)).replaceAll('\\', '/') || '.';
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
      generationCoherence: snapshot.coherence,
    },
  };
}

async function loadAnalysisArtifacts(root: string, analysis: string): Promise<Omit<LoadedAnalysis, 'openspecPath' | 'generationId' | 'generationCompatibility' | 'generationCoherence'> | null> {
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

function secureEnvelope(envelope: SpecWorkflowEnvelope): SpecWorkflowEnvelope {
  const redacted = redactSecretsWithReport(envelope);
  return redacted.redactions.count > 0
    ? { ...(redacted.value as SpecWorkflowEnvelope), redactions: redacted.redactions }
    : redacted.value;
}

function unavailable(workflow: SpecWorkflow, domain: string, code: SpecWorkflowErrorCode, message: string, availableDomains?: string[]): SpecWorkflowEnvelope {
  return secureEnvelope({
    workflow, domain: { requested: domain },
    receipt: { state: 'unavailable', included: [], omitted: [{ section: 'domainEvidence', reason: code }], followUps: [] },
    error: { code, message, ...(availableDomains ? { availableDomains } : {}) },
  });
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
  maxItems: number;
  baseRef: string;
  streamIdentity: string;
  followUpsFor: (page: EvidencePage, cursor?: string) => SpecWorkflowFollowUp[];
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
          v: EVIDENCE_STREAM_PROTOCOL, w: workflow, d: resolvedDomain ?? requestedDomain, g: loaded.generationId,
          x: args.streamIdentity, s: page.next.sectionIndex, o: page.next.offset, b: budget,
          m: args.maxItems, r: args.baseRef,
        })
      : undefined;
    const envelope: SpecWorkflowEnvelope = {
      workflow,
      domain: { requested: requestedDomain, ...(resolvedDomain ? { resolved: resolvedDomain } : {}) },
      provenance: {
        analysisFingerprint: loaded.fingerprint,
        artifactTimestamps: loaded.timestamps,
        protocol: EVIDENCE_STREAM_PROTOCOL,
        responseBytes: budget,
        analysisGeneration: loaded.generationId,
        generationCompatibility: loaded.generationCompatibility,
        generationCoherence: loaded.generationCoherence,
      },
      receipt: {
        state: page.next || extraOmissions.length > 0 ? 'partial' : 'complete',
        included: page.included.filter(section => !extraOmissions.some(entry => entry.section === section)),
        omitted: [...page.omitted, ...extraOmissions],
        ...(cursor ? { continuationCursor: cursor } : {}),
        followUps: args.followUpsFor(page, cursor),
      },
      evidence: { ...pageGlobal, ...page.records },
    };
    // Budget the exact value that leaves dispatch. Dispatch sees an already-redacted
    // result and therefore does not append a second disclosure after measurement.
    return secureEnvelope(envelope);
  };

  // Reserve room for the parts of the envelope that are not stream records.
  const envelopeBytes = Buffer.byteLength(JSON.stringify(build({
    included: [], omitted: [], records: {}, starts: {},
    next: { sectionIndex: sections.length, offset: 0 },
  })), 'utf8');

  const page = packEvidenceStream(sections, start, budget, envelopeBytes, args.maxItems);
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
  resolvedDomain: string,
  generationId: string,
  baseRef: string,
  sectionCount?: number,
  streamIdentity?: string,
): { start: EvidenceStreamPosition; budget: number; maxItems: number; cursorIdentity?: string } | SpecWorkflowEnvelope {
  const maxItems = clampMaxItems(input.maxItems);
  if (!input.cursor) {
    return { start: { sectionIndex: 0, offset: 0 }, budget: clampResponseBytes(input.maxResponseBytes), maxItems };
  }
  const cursor = decodeEvidenceCursor(input.cursor);
  if (!cursor || cursor.w !== workflow || cursor.d !== resolvedDomain) {
    return unavailable(workflow, input.domain, 'analysis-changed', `Invalid continuation cursor; restart ${workflow} preparation.`);
  }
  if (cursor.g !== generationId || cursor.m !== maxItems || cursor.r !== baseRef) {
    return unavailable(workflow, input.domain, 'analysis-changed', `Analysis changed after the cursor was issued; restart ${workflow} preparation.`);
  }
  if (streamIdentity !== undefined && cursor.x !== streamIdentity) {
    return unavailable(workflow, input.domain, 'analysis-changed', `Specification, mapping, or Git evidence changed after the cursor was issued; restart ${workflow} preparation.`);
  }
  // `>=`, not `>`: a cursor AT the end of the stream is never emitted — the final
  // page carries no continuation. Accepting one returned an empty page stamped
  // `complete`, which is the one answer this protocol must never give for evidence
  // it did not deliver.
  if (sectionCount !== undefined && cursor.s >= sectionCount) {
    return unavailable(workflow, input.domain, 'analysis-changed', `Continuation cursor is outside the current evidence stream; restart ${workflow} preparation.`);
  }
  return { start: { sectionIndex: cursor.s, offset: cursor.o }, budget: cursor.b, maxItems, cursorIdentity: cursor.x };
}

export async function prepareSpecGeneration(input: PrepareSpecInput): Promise<SpecWorkflowEnvelope> {
  input.signal?.throwIfAborted();
  const snapshot = await loadAnalysisSnapshot(input.directory);
  input.signal?.throwIfAborted();
  if (snapshot.state === 'changed') return unavailable('generation', input.domain, 'analysis-changed', snapshot.message);
  if (snapshot.state !== 'ok') return unavailable('generation', input.domain, 'analysis-unavailable', 'No compatible analysis found. Run analyze_codebase first.');
  const loaded = snapshot.loaded;
  if (loaded.generationCoherence !== 'full') {
    return unavailable(
      'generation', input.domain, 'analysis-changed',
      'The current analysis was incrementally patched and may not contain a current repository inventory. Run analyze_codebase for a full analysis before preparing specifications.',
    );
  }

  const bundles = buildDomainEvidence(loaded.repo, loaded.context);
  const bundle = bundles.find(item => item.name.toLowerCase() === input.domain.toLowerCase());
  if (!bundle) return unavailable('generation', input.domain, 'unknown-domain', `No analyzed domain named "${input.domain}".`, bundles.map(item => item.name));

  // Authenticate workflow/domain/generation/shaping arguments before the spec
  // corpus or link index is read. The full stream digest is checked after build.
  const preliminary = resolveStart('generation', input, bundle.name, loaded.generationId, '');
  if ('receipt' in preliminary) return preliminary;

  const overlap = await computeSpecOverlap(loaded, bundle);
  const specValidation = await specValidationDisclosure(loaded.root, loaded.openspecPath);
  input.signal?.throwIfAborted();
  const sections = buildGenerationStream({
    root: loaded.root, bundle, repo: loaded.repo, graph: loaded.graph, overlap: overlap.observations,
  });
  const pageGlobal = {
    contentSafety: REPO_CONTENT_PROVENANCE,
    domainSummary: {
      name: bundle.name,
      fileCount: bundle.files.length,
      definingFileCount: bundle.definingFiles.length,
      supportingFileCount: bundle.supportingFiles.length,
      ...(bundle.candidateDecisionSummary ? { candidateDecisionSummary: bundle.candidateDecisionSummary } : {}),
    },
    specOverlap: overlap.provenance,
    domainBehavior: domainBehaviorOf(bundle),
    specValidation,
    streamSections: [...GENERATION_STREAM_SECTIONS],
  };
  const streamIdentity = compositionFingerprint({ sections, pageGlobal });
  const resolved = resolveStart('generation', input, bundle.name, loaded.generationId, '', sections.length, streamIdentity);
  if ('receipt' in resolved) return resolved;

  return respondWithPage({
    workflow: 'generation',
    requestedDomain: input.domain,
    resolvedDomain: bundle.name,
    loaded,
    sections,
    pageGlobal,
    start: resolved.start,
    budget: resolved.budget,
    maxItems: resolved.maxItems,
    baseRef: '',
    streamIdentity,
    followUpsFor: (page, cursor) => [
      ...continuationFollowUps('generation', { ...input, domain: bundle.name }, page, cursor, resolved),
      ...(page.next && cursor
        ? []
        : [specValidationFollowUp(loaded.root, specValidation), ...behaviorFollowUp(pageGlobal.domainBehavior)]),
    ],
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
  cursor: string | undefined,
  shaping: { budget: number; maxItems: number },
): SpecWorkflowFollowUp[] {
  if (!page.next || !cursor) return [];
  return [{
    tool: workflow === 'generation' ? 'prepare_spec_generation' : 'prepare_spec_repair',
    arguments: {
      directory: input.directory,
      domain: input.domain,
      cursor,
      maxItems: shaping.maxItems,
      maxResponseBytes: shaping.budget,
      ...(workflow === 'repair' ? { baseRef: input.baseRef ?? 'auto' } : {}),
    },
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
  if (loaded.generationCoherence !== 'full') {
    return unavailable(
      'repair', input.domain, 'analysis-changed',
      'The current analysis was incrementally patched and may not contain a current repository inventory. Run analyze_codebase for a full analysis before preparing specifications.',
    );
  }
  const bundles = buildDomainEvidence(loaded.repo, loaded.context);
  const bundle = bundles.find(item => item.name.toLowerCase() === input.domain.toLowerCase());
  const specCorpus = await loadSpecCorpus(loaded.root, loaded.openspecPath);
  const canonicalSpecDomain = specCorpus.find(item => item.domain.toLowerCase() === input.domain.toLowerCase())?.domain;
  // The spec corpus owns Repair's identity. Analysis casing may differ, while the
  // link index deliberately stores the on-disk canonical domain name.
  const resolvedDomain = canonicalSpecDomain ?? bundle?.name ?? input.domain;
  const spec = objectResult(await handleGetSpec(loaded.root, canonicalSpecDomain ?? resolvedDomain));
  if (typeof spec.error === 'string') return unavailable('repair', input.domain, 'spec-not-found', spec.error);
  const baseRef = input.baseRef ?? 'auto';
  const preliminary = resolveStart('repair', input, resolvedDomain, loaded.generationId, baseRef);
  if ('receipt' in preliminary) return preliminary;

  // Resolve links against the graph this composite already parsed rather than
  // re-reading `dependency-graph.json` for the same request.
  const [mappingRaw, drift] = await Promise.all([
    resolveSpecLinkIndex({
      rootPath: loaded.root, openspecPath: loaded.openspecPath, domains: [resolvedDomain], persist: false, graph: loaded.graph,
    })
      .then(resolution => mappingViewOf(resolution, resolvedDomain)),
    handleCheckSpecDrift(loaded.root, baseRef, [], [resolvedDomain], 'warning', Number.MAX_SAFE_INTEGER),
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
  const audit = await handleAuditSpecCoverage(
    loaded.root,
    Number.MAX_SAFE_INTEGER,
    5,
    false,
    { files: scopedPaths, domains: [resolvedDomain] },
    { llmContext: loaded.context, dependencyGraph: loaded.graph },
  );
  input.signal?.throwIfAborted();
  const scopedSet = new Set(scopedPaths);
  const inScope = (path: unknown): boolean => {
    if (typeof path !== 'string') return false;
    const normalized = normalizeScopedPath(loaded.root, path.startsWith(loaded.root) ? relative(loaded.root, path) : path);
    return normalized !== null && scopedSet.has(normalized);
  };
  const structuralChange = scopedPaths.length > 0
    ? await handleStructuralDiff({ directory: loaded.root, baseRef, files: scopedPaths, unboundedResults: true })
    : { state: 'unavailable', reason: 'empty-historical-footprint', message: 'No current or historical source path could be recovered.' };
  input.signal?.throwIfAborted();
  const auditObj = objectResult(audit);
  const mappingCoverage = auditObj.mappingCoverage;
  const allOrphanRequirements = (Array.isArray(auditObj.orphanRequirements)
    ? auditObj.orphanRequirements as Array<Record<string, unknown>> : []).filter(item => item.domain === resolvedDomain);
  const scopedAudit = {
    ...auditObj,
    uncoveredFunctions: (Array.isArray(auditObj.uncoveredFunctions) ? auditObj.uncoveredFunctions as Array<Record<string, unknown>> : []).filter(item => inScope(item.file)),
    orphanRequirements: allOrphanRequirements,
    staleDomains: (Array.isArray(auditObj.staleDomains) ? auditObj.staleDomains as Array<Record<string, unknown>> : []).filter(item => item.name === resolvedDomain),
    summary: {},
  };
  const scopedNodes = (loaded.context.callGraph?.nodes ?? []).filter(node => inScope(node.filePath));
  const coverageAvailable = objectResult(mappingCoverage).state === 'available';
  // The audit already ran under exactly this file scope, so its own summary is the
  // scoped one. Recomputing counts from a transport page would report a bounded
  // page as if it were the whole gap.
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
  const mappingProvenance = {
    state: typeof mapping.error === 'string' ? 'unavailable' : 'available',
    ...(typeof mapping.error === 'string' ? { reason: mapping.reason ?? mapping.error } : {}),
    generatedAt: mapping.generatedAt,
    source: mapping.source,
    provenance: mapping.provenance,
    stats: mapping.stats,
  };
  const specValidation = await specValidationDisclosure(loaded.root, loaded.openspecPath);
  const sections = buildRepairStream({
    specContent,
    coveredFunction: mappingUnavailable ? [] : allCoveredFunctions,
    uncoveredFunction: mappingUnavailable ? [] : scopedAudit.uncoveredFunctions,
    staleMapping: mappingUnavailable ? [] : staleMapping,
    orphanRequirement: mappingUnavailable ? [] : allOrphanRequirements,
    structuralScope: scopedPaths,
    structuralChange: structuralChangeRecords(structuralChange),
    drift: driftIssues,
    domainMembership: (bundle?.files ?? []).map(path => ({ path })),
    candidateDecisions: bundle?.candidateDecisions ?? [],
  });

  const pageGlobal = {
    contentSafety: REPO_CONTENT_PROVENANCE,
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
    structuralScopeTotal: scopedPaths.length,
    specValidation,
    domainBehavior: domainBehaviorOf(bundle, scopedPaths, loaded.openspecPath),
    streamSections: [...REPAIR_STREAM_SECTIONS],
  };
  const streamIdentity = compositionFingerprint({
    sections,
    pageGlobal: { ...pageGlobal, mapping: { ...mappingProvenance, generatedAt: undefined } },
  });
  const resolved = resolveStart('repair', input, resolvedDomain, loaded.generationId, baseRef, sections.length, streamIdentity);
  if ('receipt' in resolved) return resolved;

  return respondWithPage({
    workflow: 'repair',
    requestedDomain: input.domain,
    resolvedDomain,
    loaded,
    sections,
    pageGlobal,
    start: resolved.start,
    budget: resolved.budget,
    maxItems: resolved.maxItems,
    baseRef,
    streamIdentity,
    followUpsFor: (page, cursor) => [
      ...continuationFollowUps('repair', { ...input, domain: resolvedDomain, baseRef }, page, cursor, resolved),
      ...(mappingUnavailable ? [mappingRemediation(loaded.root, objectResult(mappingCoverage))] : []),
      // Only on the terminal page: authoring — and therefore validation — happens
      // once the evidence stream is exhausted, and a mid-stream copy would spend
      // response budget the deferred sections need.
      ...(page.next && cursor
        ? []
        : [specValidationFollowUp(loaded.root, specValidation), ...behaviorFollowUp(pageGlobal.domainBehavior)]),
    ],
    extraOmissions: coverageOmissions,
  });
}

/**
 * What OpenLore can observe about the OpenSpec CLI, as fact — never as a verdict.
 *
 * OpenLore does not own the OpenSpec format and does not validate specs itself
 * (see the overview spec: the change lifecycle is delegated to the `openspec`
 * CLI rather than reimplemented). An authored or repaired spec is therefore only
 * as validated as the host's `openspec validate` run, and a host that cannot run
 * it must say so instead of implying the spec passed. Both authoring paths carry
 * this identically: a spec written by Generate is no more self-validating than
 * one edited by Repair.
 *
 * `packageResolution` is exactly what it says: whether an OpenSpec package
 * resolves from the project or from OpenLore. `unresolved` is NOT "the CLI is
 * absent" — a globally installed binary resolves from neither scope. It is a
 * disclosed unknown, which is why the follow-up is emitted either way.
 */
async function specValidationDisclosure(root: string, specRoot: string): Promise<{
  validatedByOpenLore: false;
  command: string;
  packageResolution: 'resolved' | 'unresolved';
  packageVersion?: string;
  specRoot: string;
  specRootIsDefault: boolean;
  cliValidationAvailable: boolean;
}> {
  const version = await detectOpenSpecPackageVersion(root);
  const normalized = normalizeSpecRoot(specRoot);
  return {
    validatedByOpenLore: false,
    command: OPENSPEC_VALIDATE_COMMAND,
    packageResolution: version === 'unknown' ? 'unresolved' : 'resolved',
    ...(version === 'unknown' ? {} : { packageVersion: version }),
    specRoot: normalized,
    specRootIsDefault: normalized === OPENSPEC_DIR,
    // The CLI can only validate a corpus it can find, which means the default
    // tree. Reported as fact so a host never treats a relocated corpus's silence
    // as a pass (verified: the command fails "No OpenSpec root found" both from
    // the repository root and from inside the relocated corpus).
    cliValidationAvailable: normalized === OPENSPEC_DIR,
  };
}

function normalizeSpecRoot(specRoot: string): string {
  const normalized = specRoot.replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/+$/, '');
  return normalized || '.';
}

/**
 * The OpenSpec structure check these workflows are judged by. Named, never run,
 * by OpenLore.
 *
 * `--specs`, not `--all`: both workflows write a BASELINE corpus spec, and an
 * unrelated invalid change in flight would otherwise fail the check for a spec
 * that is perfectly valid. `--strict` because the skills promise to treat a
 * warning as a failure, which the default mode does not.
 */
const OPENSPEC_VALIDATE_COMMAND = 'openspec validate --specs --strict';

/**
 * Emitted on the terminal page whether or not an OpenSpec package resolved: the
 * point is that an unvalidated spec is disclosed as unvalidated. A host that
 * cannot run the command reports that outcome; it never reports the repair as
 * validated. `evidence.specValidation` carries the same disclosure on every page
 * (page-global observations are spread into `evidence`), so a host reading only
 * one page still knows OpenLore validated nothing.
 */
function specValidationFollowUp(
  root: string,
  disclosure: { packageResolution: 'resolved' | 'unresolved'; specRoot: string; specRootIsDefault: boolean }
): SpecWorkflowFollowUp {
  // The OpenSpec CLI resolves its own root by looking for an `openspec/` tree;
  // OpenLore's `openspecPath` is an OpenLore setting it knows nothing about. With
  // a relocated corpus the command fails with "No OpenSpec root found" from the
  // repository root AND from inside the corpus, so there is no invocation to
  // advertise. Say the validation is unavailable instead of emitting advice that
  // cannot be followed — an unrunnable follow-up is worse than an honest gap.
  if (!disclosure.specRootIsDefault) {
    return {
      tool: 'disclose:validation-unavailable',
      arguments: { directory: root, specRoot: disclosure.specRoot },
      reason:
        `OpenLore does not validate OpenSpec structure, and the CLI cannot validate this corpus: it lives at ` +
        `\`${disclosure.specRoot}/\`, while the OpenSpec CLI locates its own root by looking for an \`openspec/\` tree and does not ` +
        `read OpenLore's configuration. Report the spec as NOT validated, and validate it by hand or through a registered OpenSpec store.`,
    };
  }
  const unresolved = disclosure.packageResolution === 'unresolved'
    ? ' No OpenSpec package resolves from this project (a global install would not either), so the CLI may be absent.'
    : '';
  return {
    tool: `cli:${OPENSPEC_VALIDATE_COMMAND}`,
    arguments: { directory: root, specRoot: disclosure.specRoot },
    reason:
      `OpenLore does not validate OpenSpec structure. Run \`${OPENSPEC_VALIDATE_COMMAND}\` after editing, and report the spec as ` +
      `NOT validated if it cannot run.${unresolved}`,
  };
}

/**
 * Whether the resolved domain contains anything a requirement could describe.
 *
 * A requirement states behavior, and behavior lives in symbols. A domain whose
 * files are documentation, licences, or project meta has none — prose describes
 * a system, it does not implement one — so a spec authored over it can only
 * paraphrase text back as SHALL statements, and no requirement in it can ever
 * carry a resolvable implementation anchor.
 *
 * This is an observation, never a verdict: OpenLore does not decide that such a
 * domain is illegitimate, it reports that there is no behavior in it and lets
 * the host stop and ask. `documentationFileCount` is the evidence behind the
 * observation, not a separate judgement
 * (change: stop-specifying-documentation-as-behavior).
 */
function domainBehaviorOf(
  bundle: DomainEvidenceBundle | undefined,
  scopedPaths: string[] = [],
  specRoot: string = OPENSPEC_DIR,
): {
  state: 'behavioral' | 'documentation-only' | 'unavailable';
  /** Set only when no bundle backs the request: every source the spec cites is prose. */
  proseOnlyOrphan?: boolean;
  symbolCount: number | null;
  routeCount: number | null;
  schemaCount: number | null;
  supportingSymbolCount: number | null;
  definingFileCount: number | null;
  documentationFileCount: number | null;
} {
  if (!bundle) {
    // No analyzed domain. Symbols cannot be counted, so every count stays null —
    // never a fabricated zero — and the state is `unavailable`.
    //
    // Whether that is a documentation-only orphan is decided the same way as
    // everywhere else: on POSITIVE evidence of prose, never on the absence of a
    // bundle. `overview` and `architecture` are corpus-level specs that own no
    // source by design and must stay repairable, so the spec corpus's own files
    // are excluded from the evidence — a spec that only cites other specs is
    // structural, not prose-only.
    // A cited path may carry an anchor (`README.md#Installation`); classify the
    // file it names, not the fragment, or a prose-only orphan reads as behavior.
    // `specRoot` is the CONFIGURED spec root, not the default name: a repo that
    // moved `openspec/` would otherwise keep its own corpus in the evidence, and
    // its Markdown would make every corpus-level spec read as a prose-only orphan.
    // `scopedPaths` are already normalized (no `./` prefix, no trailing slash), so
    // the configured root is normalized the same way before comparing — a common
    // `./openspec` value would otherwise match nothing and leave the corpus in.
    const normalizedRoot = normalizeSpecRoot(specRoot);
    const corpusRoot = normalizedRoot === '.'
      ? OPENSPEC_SPECS_SUBDIR
      : `${normalizedRoot}/${OPENSPEC_SPECS_SUBDIR}`;
    const sourcePaths = scopedPaths
      .filter(path => path !== corpusRoot && !path.startsWith(`${corpusRoot}/`))
      .map(path => path.split('#')[0]);
    const documentationPaths = sourcePaths.filter(isDocumentationFile).length;
    return {
      state: 'unavailable',
      proseOnlyOrphan: sourcePaths.length > 0 && documentationPaths === sourcePaths.length,
      symbolCount: null,
      routeCount: null,
      schemaCount: null,
      supportingSymbolCount: null,
      definingFileCount: null,
      documentationFileCount: sourcePaths.length > 0 ? documentationPaths : null,
    };
  }
  // `signatures` is one FileSignatureMap per FILE; the symbols are its `entries`.
  // Counting the maps would report a 25-symbol file as one symbol.
  const countEntries = (maps: DomainEvidenceBundle['signatures']): number =>
    maps.reduce((total, map) => total + (map.entries?.length ?? 0), 0);
  // Only DEFINING symbols decide the state. A requirement anchors to the
  // implementation, never to a test: a domain whose sole symbols live in an
  // attached test file has nothing a requirement could anchor to, and must still
  // raise the stop. Supporting symbols are disclosed beside it, not folded in.
  const symbolCount = countEntries(bundle.signatures);
  const definingFiles = bundle.definingFiles;
  // The stop fires on POSITIVE evidence of prose — every file that defines the
  // domain is documentation — not on the absence of extracted signatures.
  // Absence is a bad proxy: a declarative Vue/Svelte domain, or a bootstrap of
  // top-level `app.get(...)` calls, yields no signatures and is still behavior.
  // Only a domain defined entirely by prose has nothing a requirement could
  // state and nothing an anchor could resolve to.
  const documentationDefining = definingFiles.filter(isDocumentationFile).length;
  const proseOnly = definingFiles.length > 0 && documentationDefining === definingFiles.length;
  return {
    state: proseOnly ? 'documentation-only' : 'behavioral',
    proseOnlyOrphan: false,
    symbolCount,
    routeCount: bundle.routes?.length ?? 0,
    schemaCount: bundle.schemas?.length ?? 0,
    supportingSymbolCount: countEntries(bundle.supportingSignatures),
    definingFileCount: definingFiles.length,
    documentationFileCount: bundle.files.filter(isDocumentationFile).length,
  };
}

/**
 * Emitted on the terminal page only when the domain has no behavior to specify.
 * Shaped like Generate's overlap rule: deterministic evidence handed to the
 * human, never a decision taken for them.
 */
function behaviorFollowUp(behavior: {
  state: string;
  proseOnlyOrphan?: boolean;
  documentationFileCount: number | null;
}): SpecWorkflowFollowUp[] {
  // Positive evidence of prose only. A missing bundle on its own is NOT a stop:
  // `overview` and `architecture` own no source by design and stay repairable.
  if (behavior.state === 'behavioral') return [];
  if (behavior.state === 'unavailable' && !behavior.proseOnlyOrphan) return [];
  const confirmedEmpty = behavior.state === 'documentation-only';
  return [{
    tool: 'ask:human-decision',
    arguments: { state: behavior.state, documentationFileCount: behavior.documentationFileCount },
    reason:
      (confirmedEmpty
        ? 'Every file that defines this domain is documentation, so it has no behavior a requirement could state and no anchor a requirement could resolve to. '
        : 'This spec resolves to no analyzed domain, and every source file it cites is documentation — the shape a prose-only domain ' +
          'leaves behind once it stops being promoted. Nothing in it can carry a verifiable anchor. ') +
      'Stop and ask whether it should be specified at all, folded into a code domain, or left as documentation — do not paraphrase prose into SHALL statements.',
  }];
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
