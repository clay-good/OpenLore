/**
 * The logical evidence streams the Generate and Repair composites page over.
 *
 * Each workflow declares an ORDERED list of sections; a page packs records from
 * that list until the serialized envelope approaches the transport budget. The
 * order is part of the protocol: a cursor is a section index plus an offset, so
 * reordering sections would invalidate outstanding cursors (change
 * `harden-spec-workflow-lifecycle`, decision c9598b6f).
 *
 * Splitting the streams out of `spec-workflow.ts` keeps the section catalogue —
 * the thing a cursor is interpreted against — readable in one place.
 */

import type { RepoStructure } from '../analyzer/artifact-generator.js';
import type { DependencyGraphResult } from '../analyzer/dependency-graph.js';
import type { DomainEvidenceBundle } from '../generator/domain-evidence.js';
import type { EvidenceSection } from './evidence-stream.js';

/**
 * Generation stream order.
 *
 * Domain membership first: it is the smallest section and the one a host needs
 * to interpret every later record. Relationships last: they are the bulkiest and
 * the least necessary for a first draft.
 */
export const GENERATION_STREAM_SECTIONS = [
  'domainEvidence',
  'signatures',
  'schemas',
  'routes',
  'uiComponents',
  'middleware',
  'envVars',
  'candidateDecisions',
  'overlap',
  'relationships',
] as const;

/**
 * Repair stream order: the existing spec first (the host is editing it), then
 * the observations that drive the edit, then the bulk context.
 */
export const REPAIR_STREAM_SECTIONS = [
  'existingSpec',
  'coveredFunction',
  'uncoveredFunction',
  'staleMapping',
  'orphanRequirement',
  'structuralScope',
  'structuralChange',
  'drift',
  'domainEvidence',
  'candidateDecisions',
] as const;

/** Characters per `existingSpec` segment. Small enough that one segment always fits. */
export const SPEC_SEGMENT_CHARS = 4_000;

/**
 * Split spec text into ordered segments so a large existing spec pages instead
 * of being clipped. Segments are contiguous and concatenate back to the source.
 */
export function segmentSpecContent(content: string): Array<{ index: number; text: string }> {
  if (!content) return [];
  const segments: Array<{ index: number; text: string }> = [];
  for (let offset = 0, index = 0; offset < content.length; offset += SPEC_SEGMENT_CHARS, index++) {
    segments.push({ index, text: content.slice(offset, offset + SPEC_SEGMENT_CHARS) });
  }
  return segments;
}

/** Roles a file plays inside its domain, folded into one membership record. */
function fileRoles(bundle: DomainEvidenceBundle, path: string): string[] {
  const roles: string[] = [];
  if (bundle.definingFiles.includes(path)) roles.push('defining');
  if (bundle.supportingFiles.includes(path)) roles.push('supporting');
  if (bundle.schemaFiles.includes(path)) roles.push('schema');
  if (bundle.serviceFiles.includes(path)) roles.push('service');
  if (bundle.apiFiles.includes(path)) roles.push('api');
  return roles;
}

function relativePath(root: string, value: string): string {
  const normalizedRoot = root.replaceAll('\\', '/').replace(/\/$/, '');
  const normalizedValue = value.replaceAll('\\', '/');
  return normalizedValue.startsWith(`${normalizedRoot}/`)
    ? normalizedValue.slice(normalizedRoot.length + 1)
    : normalizedValue;
}

export interface GenerationStreamInput {
  root: string;
  bundle: DomainEvidenceBundle;
  repo: RepoStructure;
  graph: DependencyGraphResult;
  /** Deterministic overlap observations against existing specs (may be empty). */
  overlap: unknown[];
}

/**
 * Build the full, UNPAGED generation stream.
 *
 * Every section is materialized so the pager can measure it; paging then selects
 * a contiguous window. Sections are independent, so one oversized file's
 * signatures never make the inventories unreachable.
 */
export function buildGenerationStream(input: GenerationStreamInput): EvidenceSection[] {
  const { root, bundle, repo, graph } = input;
  const domainFiles = new Set(bundle.files.map(path => relativePath(root, path)));

  return [
    {
      section: 'domainEvidence',
      records: bundle.files.map(path => ({ path: relativePath(root, path), roles: fileRoles(bundle, path) })),
    },
    {
      section: 'signatures',
      records: [...bundle.signatures, ...bundle.supportingSignatures],
    },
    { section: 'schemas', records: bundle.schemas ?? [] },
    { section: 'routes', records: bundle.routes ?? [] },
    {
      section: 'uiComponents',
      records: (repo.uiComponents ?? []).filter(item => domainFiles.has(item.file)),
    },
    {
      section: 'middleware',
      records: (repo.middleware ?? []).filter(item => domainFiles.has(item.file)),
    },
    {
      section: 'envVars',
      records: (repo.envVars ?? []).filter(item => item.files.some(file => domainFiles.has(file))),
    },
    { section: 'candidateDecisions', records: bundle.candidateDecisions ?? [] },
    { section: 'overlap', records: input.overlap },
    {
      section: 'relationships',
      records: graph.edges
        .map(edge => ({ ...edge, source: relativePath(root, edge.source), target: relativePath(root, edge.target) }))
        .filter(edge => domainFiles.has(edge.source) || domainFiles.has(edge.target)),
    },
  ];
}

export interface RepairStreamInput {
  specContent: string;
  coveredFunction: unknown[];
  uncoveredFunction: unknown[];
  staleMapping: unknown[];
  orphanRequirement: unknown[];
  structuralScope: unknown[];
  structuralChange: unknown[];
  drift: unknown[];
  domainMembership: unknown[];
  candidateDecisions: unknown[];
}

/** Build the full, UNPAGED repair stream in protocol order. */
export function buildRepairStream(input: RepairStreamInput): EvidenceSection[] {
  return [
    { section: 'existingSpec', records: segmentSpecContent(input.specContent) },
    { section: 'coveredFunction', records: input.coveredFunction },
    { section: 'uncoveredFunction', records: input.uncoveredFunction },
    { section: 'staleMapping', records: input.staleMapping },
    { section: 'orphanRequirement', records: input.orphanRequirement },
    { section: 'structuralScope', records: input.structuralScope },
    { section: 'structuralChange', records: input.structuralChange },
    { section: 'drift', records: input.drift },
    { section: 'domainEvidence', records: input.domainMembership },
    { section: 'candidateDecisions', records: input.candidateDecisions },
  ];
}

/**
 * Flatten a `structural_diff` result into pageable records.
 *
 * The handler returns several parallel lists; tagging each entry with its `kind`
 * makes them one ordered section that can be continued mid-way, instead of an
 * indivisible object that either fits or does not.
 */
export function structuralChangeRecords(result: unknown): unknown[] {
  if (!result || typeof result !== 'object') return [];
  const value = result as Record<string, unknown>;
  const list = (key: string): unknown[] => (Array.isArray(value[key]) ? value[key] as unknown[] : []);
  const edges = (value.edges && typeof value.edges === 'object' ? value.edges : {}) as Record<string, unknown>;
  const edgeList = (key: string): unknown[] => (Array.isArray(edges[key]) ? edges[key] as unknown[] : []);

  return [
    ...list('changedFiles').map(entry => ({ kind: 'changedFile', ...(entry as object) })),
    ...list('added').map(entry => ({ kind: 'added', ...(entry as object) })),
    ...list('removed').map(entry => ({ kind: 'removed', ...(entry as object) })),
    ...list('signatureChanged').map(entry => ({ kind: 'signatureChanged', ...(entry as object) })),
    ...list('renameCandidates').map(entry => ({ kind: 'renameCandidate', ...(entry as object) })),
    ...edgeList('added').map(entry => ({ kind: 'addedEdge', ...(entry as object) })),
    ...edgeList('removed').map(entry => ({ kind: 'removedEdge', ...(entry as object) })),
  ];
}

/** The scalar part of a structural diff: page-global, never paged. */
export function structuralChangeSummary(result: unknown): Record<string, unknown> {
  if (!result || typeof result !== 'object') return { state: 'unavailable' };
  const value = result as Record<string, unknown>;
  if (typeof value.error === 'string') return { state: 'unavailable', reason: value.error };
  if (value.state === 'unavailable') {
    return { state: 'unavailable', ...(typeof value.reason === 'string' ? { reason: value.reason } : {}) };
  }
  return {
    state: 'available',
    base: value.base,
    head: value.head,
    summary: value.summary,
    ...(value.note ? { note: value.note } : {}),
    ...(value.soundness ? { soundness: value.soundness } : {}),
  };
}
