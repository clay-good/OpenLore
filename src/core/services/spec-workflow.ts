import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { isAbsolute, join, posix, relative } from 'node:path';

import {
  ARTIFACT_DEPENDENCY_GRAPH,
  ARTIFACT_LLM_CONTEXT,
  ARTIFACT_REPO_STRUCTURE,
  OPENLORE_ANALYSIS_SUBDIR,
  OPENLORE_DIR,
} from '../../constants.js';
import type { LLMContext, RepoStructure } from '../analyzer/artifact-generator.js';
import type { DependencyGraphResult } from '../analyzer/dependency-graph.js';
import { parseSpecHeader, parseSpecReferences } from '../drift/spec-mapper.js';
import { buildDomainEvidence, type DomainEvidenceBundle } from '../generator/domain-evidence.js';
import { handleAuditSpecCoverage, handleCheckSpecDrift, handleGetMapping } from './mcp-handlers/analysis.js';
import { handleGetSpec } from './mcp-handlers/semantic.js';
import { handleStructuralDiff } from './mcp-handlers/structural-diff.js';
import { validateDirectory } from './mcp-handlers/utils.js';

export const SPEC_WORKFLOW_SECTIONS = {
  generation: ['domainEvidence', 'inventories', 'signatures', 'relationships'] as const,
  repair: ['domainEvidence', 'existingSpec', 'coveredFunction', 'uncoveredFunction', 'staleMapping', 'orphanRequirement', 'structuralChange', 'mappingCoverage', 'drift'] as const,
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
  provenance?: { analysisFingerprint: string; artifactTimestamps: Record<string, string> };
  receipt: SpecWorkflowReceipt;
  evidence?: Record<string, unknown>;
  error?: { code: SpecWorkflowErrorCode; message: string; availableDomains?: string[] };
}

export interface PrepareSpecInput {
  directory: string;
  domain: string;
  cursor?: string;
  maxItems?: number;
  baseRef?: string;
  signal?: AbortSignal;
}

interface CursorPayload { v: 1; workflow: SpecWorkflow; domain: string; fingerprint: string; offset: number; maxItems: number }

const clampMaxItems = (value?: number): number => Math.max(10, Math.min(Math.floor(value ?? 80), 200));
const COMPOSITE_RESPONSE_MAX_BYTES = 220 * 1024;

function encodeCursor(payload: CursorPayload): string {
  return Buffer.from(JSON.stringify(payload)).toString('base64url');
}

function decodeCursor(value?: string): CursorPayload | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as CursorPayload;
    return parsed.v === 1 && Number.isInteger(parsed.offset) && parsed.offset >= 0 ? parsed : undefined;
  } catch { return undefined; }
}

async function loadAnalysis(directory: string): Promise<{
  root: string; repo: RepoStructure; graph: DependencyGraphResult; fingerprint: string;
  context: LLMContext; timestamps: Record<string, string>;
} | null> {
  const root = await validateDirectory(directory);
  const analysis = join(root, OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR);
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

function pageBundle(bundle: DomainEvidenceBundle, paths: string[]): DomainEvidenceBundle {
  const selected = new Set(paths);
  return {
    ...bundle,
    files: paths,
    definingFiles: bundle.definingFiles.filter(path => selected.has(path)),
    supportingFiles: bundle.supportingFiles.filter(path => selected.has(path)),
    schemaFiles: bundle.schemaFiles.filter(path => selected.has(path)),
    serviceFiles: bundle.serviceFiles.filter(path => selected.has(path)),
    apiFiles: bundle.apiFiles.filter(path => selected.has(path)),
    signatures: bundle.signatures.filter(item => selected.has(item.path)),
    supportingSignatures: bundle.supportingSignatures.filter(item => selected.has(item.path)),
    schemas: bundle.schemas.filter(item => selected.has(item.file)),
    routes: bundle.routes.filter(item => selected.has(item.file)),
    candidateDecisions: bundle.candidateDecisions
      .filter(decision => decision.files.some(path => selected.has(path)))
      .map(decision => ({ ...decision, files: decision.files.filter(path => selected.has(path)).slice(0, 20) })),
  };
}

function relativeGraphPath(root: string, value: string): string {
  return value.startsWith(root) ? relative(root, value) : value;
}

function generationEvidence(
  loaded: NonNullable<Awaited<ReturnType<typeof loadAnalysis>>>,
  bundle: DomainEvidenceBundle,
  paths: string[],
): Record<string, unknown> {
  const selected = new Set(paths);
  const domainEvidence = pageBundle(bundle, paths);
  const schemas = domainEvidence.schemas;
  const routes = domainEvidence.routes;
  const signatures = [...domainEvidence.signatures, ...domainEvidence.supportingSignatures];
  domainEvidence.schemas = [];
  domainEvidence.routes = [];
  domainEvidence.signatures = [];
  domainEvidence.supportingSignatures = [];
  const relationships = loaded.graph.edges
    .map(edge => ({ ...edge, source: relativeGraphPath(loaded.root, edge.source), target: relativeGraphPath(loaded.root, edge.target) }))
    .filter(edge => selected.has(edge.source) || selected.has(edge.target));
  return {
    domainEvidence,
    inventories: {
      schemas,
      routes,
      uiComponents: (loaded.repo.uiComponents ?? []).filter(item => selected.has(item.file)),
      middleware: (loaded.repo.middleware ?? []).filter(item => selected.has(item.file)),
      envVars: (loaded.repo.envVars ?? []).filter(item => item.files.some(path => selected.has(path))),
    },
    signatures,
    relationships,
  };
}

function boundOversizedGenerationPage(response: SpecWorkflowEnvelope, root: string, paths: string[]): void {
  if (Buffer.byteLength(JSON.stringify(response)) <= COMPOSITE_RESPONSE_MAX_BYTES || !response.evidence) return;
  const omit = (section: string, omittedCount: number, followUps: SpecWorkflowFollowUp[]): void => {
    response.receipt.state = 'partial';
    response.receipt.included = response.receipt.included.filter(value => value !== section);
    response.receipt.omitted.push({ section, reason: 'response-budget', omittedCount });
    response.receipt.followUps.push(...followUps);
  };
  const relationships = Array.isArray(response.evidence.relationships) ? response.evidence.relationships : [];
  if (relationships.length > 0) {
    response.evidence.relationships = [];
    omit('relationships', relationships.length, paths.map(filePath => ({
      tool: 'get_file_dependencies',
      arguments: { directory: root, filePath, direction: 'both' },
      reason: 'Retrieve file dependency relationships omitted from an oversized single-file partition.',
    })));
    if (Buffer.byteLength(JSON.stringify(response)) <= COMPOSITE_RESPONSE_MAX_BYTES) return;
  }

  const inventories = objectResult(response.evidence.inventories);
  const inventoryCount = Object.values(inventories).reduce<number>((sum, value) => sum + (Array.isArray(value) ? value.length : 0), 0);
  if (inventoryCount > 0) {
    response.evidence.inventories = {};
    omit('inventories', inventoryCount, [
      'get_schema_inventory', 'get_route_inventory', 'get_ui_component_inventory', 'get_middleware_inventory', 'get_env_vars',
    ].map(tool => ({ tool, arguments: { directory: root, responseFormat: 'detailed' }, reason: 'Retrieve an inventory omitted from an oversized single-file partition.' })));
    if (Buffer.byteLength(JSON.stringify(response)) <= COMPOSITE_RESPONSE_MAX_BYTES) return;
  }

  const signatures = Array.isArray(response.evidence.signatures) ? response.evidence.signatures : [];
  if (signatures.length > 0) {
    response.evidence.signatures = [];
    omit('signatures', signatures.length, paths.map(filePattern => ({
      tool: 'get_signatures', arguments: { directory: root, filePattern }, reason: 'Retrieve signatures omitted from an oversized single-file partition.',
    })));
    if (Buffer.byteLength(JSON.stringify(response)) <= COMPOSITE_RESPONSE_MAX_BYTES) return;
  }

  const domainEvidence = objectResult(response.evidence.domainEvidence);
  const decisions = Array.isArray(domainEvidence.candidateDecisions) ? domainEvidence.candidateDecisions : [];
  if (decisions.length > 0) {
    domainEvidence.candidateDecisions = [];
    omit('domainEvidence', decisions.length, [{
      tool: 'get_architecture_overview', arguments: { directory: root }, reason: 'Retrieve domain-decision context omitted from an oversized single-file partition.',
    }]);
  }
}

export async function prepareSpecGeneration(input: PrepareSpecInput): Promise<SpecWorkflowEnvelope> {
  input.signal?.throwIfAborted();
  const loaded = await loadAnalysis(input.directory);
  input.signal?.throwIfAborted();
  if (!loaded) return unavailable('generation', input.domain, 'analysis-unavailable', 'No compatible analysis found. Run analyze_codebase first.');
  const bundles = buildDomainEvidence(loaded.repo, loaded.context);
  const bundle = bundles.find(item => item.name === input.domain);
  if (!bundle) return unavailable('generation', input.domain, 'unknown-domain', `No analyzed domain named "${input.domain}".`, bundles.map(item => item.name));

  const cursor = decodeCursor(input.cursor);
  if (input.cursor && (!cursor || cursor.workflow !== 'generation' || cursor.domain !== input.domain
    || !Number.isInteger(cursor.maxItems) || cursor.maxItems < 10 || cursor.maxItems > 200)) {
    return unavailable('generation', input.domain, 'analysis-changed', 'Invalid continuation cursor; restart generation preparation.');
  }
  if (cursor && cursor.fingerprint !== loaded.fingerprint) {
    return unavailable('generation', input.domain, 'analysis-changed', 'Analysis changed after the cursor was issued; restart generation preparation.');
  }
  const maxItems = cursor?.maxItems ?? clampMaxItems(input.maxItems);
  const offset = cursor?.offset ?? 0;
  if (offset > bundle.files.length) {
    return unavailable('generation', input.domain, 'analysis-changed', 'Continuation cursor is outside the current domain evidence; restart generation preparation.');
  }
  let count = Math.min(maxItems, bundle.files.length - offset);
  let response: SpecWorkflowEnvelope;
  do {
    const paths = bundle.files.slice(offset, offset + count);
    const remaining = Math.max(0, bundle.files.length - offset - paths.length);
    const next = remaining > 0 ? encodeCursor({ v: 1, workflow: 'generation', domain: input.domain, fingerprint: loaded.fingerprint, offset: offset + paths.length, maxItems }) : undefined;
    response = {
      workflow: 'generation', domain: { requested: input.domain, resolved: bundle.name },
      provenance: { analysisFingerprint: loaded.fingerprint, artifactTimestamps: loaded.timestamps },
      receipt: {
        state: remaining > 0 ? 'partial' : 'complete', included: [...SPEC_WORKFLOW_SECTIONS.generation],
        omitted: remaining > 0 ? [{ section: 'domainEvidence', reason: 'response-budget', omittedCount: remaining }] : [],
        ...(next ? { continuationCursor: next } : {}), followUps: [],
      },
      evidence: { ...generationEvidence(loaded, bundle, paths), partition: { offset, count: paths.length, total: bundle.files.length } },
    };
    if (Buffer.byteLength(JSON.stringify(response)) <= 220 * 1024 || count <= 1) break;
    count = Math.max(1, Math.floor(count / 2));
  } while (count > 0);
  boundOversizedGenerationPage(response, loaded.root, bundle.files.slice(offset, offset + count));
  return response;
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
  const loaded = await loadAnalysis(input.directory);
  input.signal?.throwIfAborted();
  if (!loaded) return unavailable('repair', input.domain, 'analysis-unavailable', 'No compatible analysis found. Run analyze_codebase first.');
  const spec = objectResult(await handleGetSpec(loaded.root, input.domain));
  if (typeof spec.error === 'string') return unavailable('repair', input.domain, 'spec-not-found', spec.error);

  const bundles = buildDomainEvidence(loaded.repo, loaded.context);
  const bundle = bundles.find(item => item.name === input.domain);
  const [mappingRaw, drift] = await Promise.all([
    handleGetMapping(loaded.root, input.domain),
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
  const uncoveredCount = scopedAudit.uncoveredFunctions.length;
  const coverageAvailable = objectResult(mappingCoverage).state === 'available';
  scopedAudit.summary = {
    totalFunctions: scopedNodes.length,
    coveredFunctions: coverageAvailable ? Math.max(0, scopedNodes.length - uncoveredCount) : 0,
    coveragePct: coverageAvailable && scopedNodes.length > 0 ? Math.round(((scopedNodes.length - uncoveredCount) / scopedNodes.length) * 100) : 0,
    uncoveredCount,
    hubGapCount: 0,
    orphanRequirementCount: allOrphanRequirements.length,
    staleDomainCount: scopedAudit.staleDomains.length,
  };
  const mappingUnavailable = objectResult(mappingCoverage).state !== 'available';
  const specContent = typeof spec.content === 'string' ? spec.content : '';
  const specLimit = 40_000;
  const specTruncated = specContent.length > specLimit;
  if (specTruncated) spec.content = specContent.slice(0, specLimit);
  const mappingDependentSections = ['coveredFunction', 'uncoveredFunction', 'orphanRequirement'] as const;
  const omitted = [
    ...(mappingUnavailable ? mappingDependentSections.map(section => ({
      section,
      reason: `mapping-${String(objectResult(mappingCoverage).reason ?? objectResult(mappingCoverage).state ?? 'unavailable')}`,
    })) : []),
    ...(specTruncated ? [{ section: 'existingSpec', reason: 'response-budget', omittedCount: specContent.length - specLimit }] : []),
    ...(!mappingUnavailable && allOrphanRequirements.length > maxItems
      ? [{ section: 'orphanRequirement', reason: 'response-budget', omittedCount: allOrphanRequirements.length - maxItems }] : []),
  ];
  const followUps: SpecWorkflowFollowUp[] = [];
  if (mappingUnavailable) followUps.push({ tool: 'audit_spec_coverage', arguments: { directory: loaded.root }, reason: 'Refresh or inspect mapping coverage availability.' });
  if (specTruncated) followUps.push({ tool: 'get_spec', arguments: { directory: loaded.root, domain: input.domain }, reason: 'Retrieve the complete existing specification.' });
  if (!mappingUnavailable && allOrphanRequirements.length > maxItems) {
    followUps.push({ tool: 'get_mapping', arguments: { directory: loaded.root, domain: input.domain }, reason: 'Retrieve remaining orphan requirement mappings.' });
  }
  const allCoveredFunctions = mappings.flatMap(entry =>
    (Array.isArray(entry.functions) ? entry.functions as Array<Record<string, unknown>> : [])
      .filter(fn => fn.name !== '*' && inScope(fn.file)),
  );
  const coveredFunction = allCoveredFunctions.slice(0, maxItems);
  if (!mappingUnavailable && allCoveredFunctions.length > maxItems) {
    omitted.push({ section: 'coveredFunction', reason: 'response-budget', omittedCount: allCoveredFunctions.length - maxItems });
    followUps.push({ tool: 'get_mapping', arguments: { directory: loaded.root, domain: input.domain }, reason: 'Retrieve the remaining covered function mappings.' });
  }
  const observations = {
    coveredFunction: mappingUnavailable ? null : coveredFunction,
    uncoveredFunction: mappingUnavailable ? null : scopedAudit.uncoveredFunctions,
    staleMapping: objectResult(mappingCoverage).state === 'stale' ? [mappingCoverage] : [],
    orphanRequirement: mappingUnavailable ? null : scopedAudit.orphanRequirements,
  };
  const auditEvidence = mappingUnavailable ? {
    ...scopedAudit,
    uncoveredFunctions: null,
    orphanRequirements: null,
    summary: {
      totalFunctions: scopedNodes.length,
      coveredFunctions: null,
      coveragePct: null,
      uncoveredCount: null,
      hubGapCount: 0,
      orphanRequirementCount: null,
      staleDomainCount: scopedAudit.staleDomains.length,
    },
  } : scopedAudit;
  const mappingProvenance = {
    state: typeof mapping.error === 'string' ? 'unavailable' : 'available',
    ...(typeof mapping.error === 'string' ? { reason: mapping.error } : {}),
    generatedAt: mapping.generatedAt,
    scope: mapping.scope,
    stats: mapping.stats,
  };
  const repairBundle = bundle ? pageBundle(bundle, bundle.files.slice(0, maxItems)) : null;
  if (repairBundle) {
    repairBundle.schemas = [];
    repairBundle.routes = [];
    repairBundle.signatures = [];
    repairBundle.supportingSignatures = [];
  }
  if (bundle && bundle.files.length > maxItems) {
    omitted.push({ section: 'domainEvidence', reason: 'response-budget', omittedCount: bundle.files.length - maxItems });
    followUps.push({ tool: 'get_architecture_overview', arguments: { directory: loaded.root }, reason: `Retrieve the complete reconciled domain evidence for "${input.domain}".` });
  }
  const response: SpecWorkflowEnvelope = {
    workflow: 'repair', domain: { requested: input.domain, ...(bundle ? { resolved: bundle.name } : {}) },
    provenance: { analysisFingerprint: loaded.fingerprint, artifactTimestamps: loaded.timestamps },
    receipt: {
      state: omitted.length > 0 ? 'partial' : 'complete',
      included: [...SPEC_WORKFLOW_SECTIONS.repair].filter(section => !omitted.some(item => item.section === section)),
      omitted,
      followUps,
    },
    evidence: {
      domainEvidence: repairBundle,
      domainEvidenceCoverage: bundle ? { state: 'available' } : { state: 'unavailable', reason: 'domain-not-analyzed', possibleOrphan: true },
      existingSpec: spec, mapping: mappingProvenance, mappingCoverage, coverageSummary: auditEvidence.summary, drift, observations, structuralChange,
      structuralScope: scopedPaths.slice(0, maxItems),
      structuralScopeTotal: scopedPaths.length,
      structuralScopeTruncated: scopedPaths.length > maxItems,
    },
  };
  if (Buffer.byteLength(JSON.stringify(response)) > COMPOSITE_RESPONSE_MAX_BYTES && response.evidence) {
    response.evidence.domainEvidence = null;
    if (!response.receipt.omitted.some(item => item.section === 'domainEvidence')) {
      response.receipt.omitted.push({ section: 'domainEvidence', reason: 'response-budget', omittedCount: bundle?.files.length ?? 0 });
      response.receipt.followUps.push({ tool: 'get_architecture_overview', arguments: { directory: loaded.root }, reason: `Retrieve current reconciled evidence for "${input.domain}" separately.` });
    }
    response.receipt.included = response.receipt.included.filter(section => section !== 'domainEvidence');
    response.receipt.state = 'partial';
  }
  if (Buffer.byteLength(JSON.stringify(response)) > COMPOSITE_RESPONSE_MAX_BYTES && response.evidence) {
    response.evidence.drift = null;
    response.receipt.omitted.push({ section: 'drift', reason: 'response-budget' });
    response.receipt.included = response.receipt.included.filter(section => section !== 'drift');
    response.receipt.followUps.push({ tool: 'check_spec_drift', arguments: { directory: loaded.root, baseRef: input.baseRef ?? 'auto', domains: [input.domain] }, reason: 'Retrieve drift observations separately.' });
  }
  if (Buffer.byteLength(JSON.stringify(response)) > COMPOSITE_RESPONSE_MAX_BYTES) {
    return {
      workflow: 'repair',
      domain: { requested: input.domain.slice(0, 512), ...(bundle ? { resolved: bundle.name.slice(0, 512) } : {}) },
      provenance: { analysisFingerprint: loaded.fingerprint, artifactTimestamps: loaded.timestamps },
      receipt: {
        state: 'unavailable',
        included: [],
        omitted: SPEC_WORKFLOW_SECTIONS.repair.map(section => ({ section, reason: 'response-too-large' })),
        followUps: [],
      },
      error: {
        code: 'response-too-large',
        message: 'The repair evidence cannot be represented safely within the composite response bound. Use the atomic MCP tools for targeted inspection.',
      },
    };
  }
  return response;
}
