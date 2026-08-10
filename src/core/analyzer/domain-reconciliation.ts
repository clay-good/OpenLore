import { posix } from 'node:path';
import type { ScoredFile } from '../../types/index.js';
import type { RepositoryMap } from './repository-mapper.js';
import type { DependencyGraphResult, FileCluster } from './dependency-graph.js';
import {
  classifyDomainFile,
  deriveDomainFromPath,
  deriveDomainOwnershipFromPath,
  isTechnicalDomainRole,
  type DomainFileRole,
  type DomainFileRoleReason,
} from './domain-naming.js';

export type DomainCandidateDisposition = 'promoted' | 'merged' | 'attached' | 'excluded';
export type DomainCandidateReason =
  | 'ownership-root'
  | 'filename-boundary'
  | 'exact-duplicate'
  | 'technical-child'
  | 'contained-footprint'
  | 'independent-boundary'
  | 'structural-independence'
  | 'non-defining-only'
  | 'supporting-path-owner'
  | 'supporting-import-owner'
  | 'supporting-unattached';

export interface DomainCandidateDecision {
  candidate: string;
  path: string;
  sources: DomainCandidateSignal[];
  disposition: DomainCandidateDisposition;
  reason: DomainCandidateReason;
  owner?: string;
  files: string[];
}

export type DomainCandidateSignal =
  | 'directory'
  | 'filename'
  | 'dependency-cluster'
  | 'public-entry'
  | 'route'
  | 'schema'
  | 'technical-role'
  | 'supporting-file';

export interface DomainEvidenceRole {
  path: string;
  role: DomainFileRole;
  reason: DomainFileRoleReason;
}

export interface ReconciledDomain {
  name: string;
  definingFiles: ScoredFile[];
  supportingFiles: ScoredFile[];
}

export interface DomainReconciliationResult {
  domains: ReconciledDomain[];
  decisions: DomainCandidateDecision[];
  decisionSummary: DomainDecisionSummary;
  rawCandidateCount: number;
  unattachedEvidence: DomainEvidenceRole[];
}

export interface DomainDecisionSummary {
  total: number;
  emitted: number;
  omitted: number;
  limit: number;
  filesPerDecisionLimit: number;
}

export interface DomainBoundaryEvidence {
  entryFiles?: Iterable<string>;
  routeFiles?: Iterable<string>;
  schemaFiles?: Iterable<string>;
}

const DOMAIN_DECISION_LIMIT = 500;
const DOMAIN_DECISION_FILES_LIMIT = 50;

interface Candidate {
  name: string;
  path: string;
  source: 'directory' | 'dependency-cluster' | 'boundary';
  signals: DomainCandidateSignal[];
  files: ScoredFile[];
  cluster?: FileCluster;
  ownershipRoot?: string;
}

/**
 * Reconcile directory and dependency-cluster observations into stable ownership
 * domains, then attach tests without allowing them to affect candidate truth.
 */
export function reconcileRepositoryDomains(
  repoMap: RepositoryMap,
  depGraph: DependencyGraphResult,
  boundaries: DomainBoundaryEvidence = {},
): DomainReconciliationResult {
  const allFiles = [...repoMap.allFiles].sort(byFilePath);
  const analyzedPaths = new Set(allFiles.map(file => file.path));
  const boundaryPaths = new Set([
    ...(boundaries.entryFiles ?? []),
    ...(boundaries.routeFiles ?? []),
    ...(boundaries.schemaFiles ?? []),
  ]);
  const entryPaths = new Set(boundaries.entryFiles ?? []);
  const routePaths = new Set(boundaries.routeFiles ?? []);
  const schemaPaths = new Set(boundaries.schemaFiles ?? []);
  const candidates: Candidate[] = [];

  for (const [name, rawFiles] of Object.entries(repoMap.clusters.byDomain).sort(([a], [b]) => a.localeCompare(b))) {
    const files = uniqueFiles(rawFiles.filter(isDefining));
    candidates.push({
      name: normalizeDomainName(name),
      path: commonDirectory(files),
      source: 'directory',
      signals: candidateSignals(name, files, 'directory', entryPaths, routePaths, schemaPaths),
      files,
    });
  }

  const graphNodeById = new Map(depGraph.nodes.map(node => [node.id, node]));
  for (const cluster of [...depGraph.clusters].sort((a, b) =>
    a.name.localeCompare(b.name) || a.id.localeCompare(b.id))) {
    const files = uniqueFiles(cluster.files
      .map(id => graphNodeById.get(id)?.file)
      .filter((file): file is ScoredFile => Boolean(file))
      .filter(file => analyzedPaths.has(file.path)));
    candidates.push({
      name: normalizeDomainName(cluster.suggestedDomain),
      path: normalizePath(cluster.name),
      source: 'dependency-cluster',
      signals: candidateSignals(cluster.suggestedDomain, files, 'dependency-cluster', entryPaths, routePaths, schemaPaths),
      files,
      cluster,
    });
  }

  const boundaryCandidates = new Map<string, Candidate>();
  for (const file of allFiles.filter(isDefining)) {
    const signals: DomainCandidateSignal[] = [];
    if (entryPaths.has(file.path)) signals.push('public-entry');
    if (routePaths.has(file.path)) signals.push('route');
    if (schemaPaths.has(file.path)) signals.push('schema');
    if (signals.length === 0) continue;
    const parts = normalizePath(file.path).split('/').slice(0, -1);
    const derivedName = deriveDomainFromPath(parts);
    if (!derivedName) continue;
    const rawLeaf = normalizeDomainName(parts.at(-1) ?? '');
    const ownershipRoot = ownerForFile(file) ?? derivedName;
    const name = isTechnicalDomainRole(rawLeaf) ? ownershipRoot : derivedName;
    const key = `${ownershipRoot}::${name}`;
    const existing = boundaryCandidates.get(key);
    boundaryCandidates.set(key, {
      name,
      path: normalizePath(file.directory || posix.dirname(file.path)),
      source: 'boundary',
      signals: [...new Set([
        ...(existing?.signals ?? []), ...signals,
        ...(isTechnicalDomainRole(rawLeaf) ? ['technical-role' as const] : []),
      ])].sort(),
      files: uniqueFiles([...(existing?.files ?? []), file]),
      ownershipRoot,
    });
  }
  const repeatedBoundaryNames = new Map<string, number>();
  for (const candidate of boundaryCandidates.values()) {
    repeatedBoundaryNames.set(candidate.name, (repeatedBoundaryNames.get(candidate.name) ?? 0) + 1);
  }
  candidates.push(...[...boundaryCandidates.values()].map(candidate => ({
    ...candidate,
    name: (repeatedBoundaryNames.get(candidate.name) ?? 0) > 1 && candidate.ownershipRoot !== candidate.name
      ? `${candidate.ownershipRoot}-${candidate.name}`
      : candidate.name,
  })).sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path)));

  const rawCandidateCount = candidates.length;
  const domainMap = new Map<string, ReconciledDomain>();
  const decisions: DomainCandidateDecision[] = [];

  // Ownership roots establish the baseline before graph observations are folded in.
  // Single-root candidates go first so cross-root filename observations can
  // attach to known owners without manufacturing fallback domains.
  const directoryCandidates = candidates.filter(item => item.source === 'directory');
  for (const candidate of directoryCandidates.filter(item =>
    groupFilesByOwner(item.files, item.name).size <= 1)) {
    if (candidate.files.length === 0) {
      decisions.push(decision(candidate, 'excluded', 'non-defining-only'));
      continue;
    }
    const owner = groupFilesByOwner(candidate.files, candidate.name).keys().next().value as string;
    mergeDefiningFiles(domainMap, owner, candidate.files);
    decisions.push(decision(candidate, 'promoted', 'ownership-root', owner));
  }


  for (const candidate of candidates.filter(item => item.source === 'boundary')) {
    if (candidate.files.length === 0) {
      decisions.push(decision(candidate, 'excluded', 'non-defining-only'));
      continue;
    }
    const ownerGroups = groupFilesByOwner(candidate.files, candidate.name);
    const owner = ownerGroups.size === 1
      ? ownerGroups.keys().next().value as string
      : undefined;
    if (owner === candidate.name) {
      const existed = domainMap.has(owner);
      mergeDefiningFiles(domainMap, owner, candidate.files);
      decisions.push(decision(candidate, existed ? 'merged' : 'promoted', existed ? 'exact-duplicate' : 'ownership-root', owner));
      continue;
    }
    removeDefiningFilesFromAll(domainMap, candidate.files);
    mergeDefiningFiles(domainMap, candidate.name, candidate.files);
    decisions.push(decision(candidate, 'promoted', 'independent-boundary', candidate.name));
  }

  for (const candidate of directoryCandidates.filter(item =>
    groupFilesByOwner(item.files, item.name).size > 1)) {
    const ownerGroups = groupFilesByOwner(candidate.files, candidate.name);
    const filenameBoundary = candidate.signals.includes('filename') &&
      [...ownerGroups.keys()].every(owner => isTechnicalDomainRole(owner));
    if (filenameBoundary) {
      removeDefiningFilesFromAll(domainMap, candidate.files);
      mergeDefiningFiles(domainMap, candidate.name, candidate.files);
      decisions.push(decision(candidate, 'promoted', 'filename-boundary', candidate.name));
      continue;
    }
    for (const [owner, files] of ownerGroups) {
      if (domainMap.has(owner)) mergeDefiningFiles(domainMap, owner, files);
    }
    decisions.push(decision(candidate, 'merged', 'contained-footprint'));
  }

  for (const candidate of candidates.filter(item => item.source === 'dependency-cluster')) {
    const definingFiles = candidate.files.filter(isDefining);
    if (definingFiles.length === 0) {
      decisions.push(decision(candidate, 'excluded', 'non-defining-only'));
      continue;
    }

    const ownerGroups = groupFilesByOwner(definingFiles, candidate.name);
    if (ownerGroups.size > 1) {
      for (const [groupOwner, files] of ownerGroups) mergeDefiningFiles(domainMap, groupOwner, files);
      decisions.push(decision(candidate, 'merged', 'contained-footprint'));
      continue;
    }

    const owner = ownerGroups.keys().next().value as string;
    const existingOwner = domainMap.get(owner);
    if (candidate.name === owner) {
      mergeDefiningFiles(domainMap, owner, definingFiles);
      decisions.push(decision(
        candidate,
        existingOwner ? 'merged' : 'promoted',
        existingOwner ? 'exact-duplicate' : 'ownership-root',
        owner,
      ));
      continue;
    }

    const hasBoundary = definingFiles.some(file => boundaryPaths.has(file.path));
    const structurallyIndependent = Boolean(
      candidate.cluster?.isStructural &&
      definingFiles.length >= 3 &&
      candidate.cluster.cohesion > 0,
    );
    const technicalChild = isTechnicalDomainRole(candidate.name);
    const independentlyOwned = hasBoundary || (structurallyIndependent && !technicalChild);

    if (independentlyOwned) {
      removeDefiningFilesFromAll(domainMap, definingFiles);
      mergeDefiningFiles(domainMap, candidate.name, definingFiles);
      decisions.push(decision(
        candidate,
        'promoted',
        hasBoundary ? 'independent-boundary' : 'structural-independence',
        candidate.name,
      ));
    } else {
      mergeDefiningFiles(domainMap, owner, definingFiles);
      decisions.push(decision(
        candidate,
        'merged',
        technicalChild ? 'technical-child' : 'contained-footprint',
        owner,
      ));
    }
  }

  enforceUniqueDefiningOwnership(domainMap);
  const definingOwnerByPath = new Map<string, string>();
  for (const [domainName, domain] of domainMap) {
    domain.definingFiles = uniqueFiles(domain.definingFiles);
    for (const file of domain.definingFiles) definingOwnerByPath.set(file.path, domainName);
  }

  const nodePathById = new Map(depGraph.nodes.map(node => [node.id, node.file.path]));
  const importOwnersByPath = new Map<string, Map<string, number>>();
  for (const edge of depGraph.edges) {
    const sourcePath = nodePathById.get(edge.source);
    const targetPath = nodePathById.get(edge.target);
    if (!sourcePath || !targetPath) continue;
    addImportOwner(sourcePath, definingOwnerByPath.get(targetPath), importOwnersByPath);
    addImportOwner(targetPath, definingOwnerByPath.get(sourcePath), importOwnersByPath);
  }

  const unattachedEvidence: DomainEvidenceRole[] = [];
  for (const file of allFiles.filter(item => classifyDomainFile(item).role === 'supporting')) {
    const pathOwner = ownerForFile(file);
    const importOwner = strongestOwner(importOwnersByPath.get(file.path));
    const closestOwner = closestDirectoryOwner(file, domainMap);
    const owner = importOwner ?? closestOwner ?? ((pathOwner && domainMap.has(pathOwner)) ? pathOwner : undefined);
    if (owner && domainMap.has(owner)) {
      domainMap.get(owner)!.supportingFiles.push(file);
      decisions.push({
        candidate: file.path,
        path: file.path,
        sources: ['supporting-file'],
        disposition: 'attached',
        reason: owner === importOwner ? 'supporting-import-owner' : 'supporting-path-owner',
        owner,
        files: [file.path],
      });
    } else {
      const classification = classifyDomainFile(file);
      unattachedEvidence.push({ path: file.path, ...classification });
      decisions.push({
        candidate: file.path,
        path: file.path,
        sources: ['supporting-file'],
        disposition: 'excluded',
        reason: 'supporting-unattached',
        files: [file.path],
      });
    }
  }

  // Excluded analyzed files remain disclosed, but never enter a domain bundle.
  for (const file of allFiles) {
    const classification = classifyDomainFile(file);
    if (classification.role === 'excluded') {
      unattachedEvidence.push({ path: file.path, ...classification });
    }
  }

  const domains = [...domainMap.values()]
    .map(domain => ({
      ...domain,
      definingFiles: uniqueFiles(domain.definingFiles),
      supportingFiles: uniqueFiles(domain.supportingFiles),
    }))
    .filter(domain => domain.definingFiles.length > 0)
    .sort((a, b) => a.name.localeCompare(b.name));

  const sortedDecisions = decisions.sort(byDecision);
  const emittedDecisions = sortedDecisions.slice(0, DOMAIN_DECISION_LIMIT);
  return {
    domains,
    decisions: emittedDecisions,
    decisionSummary: {
      total: sortedDecisions.length,
      emitted: emittedDecisions.length,
      omitted: sortedDecisions.length - emittedDecisions.length,
      limit: DOMAIN_DECISION_LIMIT,
      filesPerDecisionLimit: DOMAIN_DECISION_FILES_LIMIT,
    },
    rawCandidateCount,
    unattachedEvidence: [...new Map(
      unattachedEvidence.sort((a, b) => a.path.localeCompare(b.path)).map(item => [item.path, item]),
    ).values()],
  };
}

function ownerForFile(file: ScoredFile): string | null {
  const parts = normalizePath(file.path).split('/').slice(0, -1);
  return deriveDomainOwnershipFromPath(parts, file.extension);
}

function isDefining(file: ScoredFile): boolean {
  return classifyDomainFile(file).role === 'defining';
}

function mergeDefiningFiles(map: Map<string, ReconciledDomain>, name: string, files: ScoredFile[]): void {
  const normalized = normalizeDomainName(name);
  const current = map.get(normalized) ?? { name: normalized, definingFiles: [], supportingFiles: [] };
  current.definingFiles = uniqueFiles([...current.definingFiles, ...files.filter(isDefining)]);
  map.set(normalized, current);
}

function removeDefiningFiles(domain: ReconciledDomain | undefined, files: ScoredFile[]): void {
  if (!domain) return;
  const removed = new Set(files.map(file => file.path));
  domain.definingFiles = domain.definingFiles.filter(file => !removed.has(file.path));
}

function removeDefiningFilesFromAll(domains: Map<string, ReconciledDomain>, files: ScoredFile[]): void {
  for (const domain of domains.values()) removeDefiningFiles(domain, files);
}

function groupFilesByOwner(files: ScoredFile[], fallback: string): Map<string, ScoredFile[]> {
  const groups = new Map<string, ScoredFile[]>();
  for (const file of files) {
    const owner = ownerForFile(file) ?? normalizeDomainName(fallback);
    const group = groups.get(owner) ?? [];
    group.push(file);
    groups.set(owner, group);
  }
  return new Map([...groups.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

function enforceUniqueDefiningOwnership(domains: Map<string, ReconciledDomain>): void {
  const memberships = new Map<string, Array<{ name: string; file: ScoredFile }>>();
  for (const [name, domain] of domains) {
    for (const file of domain.definingFiles) {
      const items = memberships.get(file.path) ?? [];
      items.push({ name, file });
      memberships.set(file.path, items);
    }
  }
  for (const items of memberships.values()) {
    if (items.length < 2) continue;
    const preferred = ownerForFile(items[0].file);
    const winner = items.some(item => item.name === preferred)
      ? preferred!
      : [...items].sort((a, b) => a.name.localeCompare(b.name))[0].name;
    for (const item of items) {
      if (item.name !== winner) removeDefiningFiles(domains.get(item.name), [item.file]);
    }
  }
}

function closestDirectoryOwner(
  file: ScoredFile,
  domains: Map<string, ReconciledDomain>,
): string | undefined {
  const target = normalizePath(file.directory || posix.dirname(file.path)).split('/');
  const ranked = [...domains.entries()].map(([name, domain]) => {
    let score = 0;
    for (const defining of domain.definingFiles) {
      const parts = normalizePath(defining.directory || posix.dirname(defining.path)).split('/');
      let common = 0;
      while (common < target.length && common < parts.length && target[common] === parts[common]) common++;
      score = Math.max(score, common);
    }
    return { name, score };
  }).filter(item => item.score >= 2).sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  return ranked.length > 1 && ranked[0].score === ranked[1].score ? undefined : ranked[0]?.name;
}

function addImportOwner(
  path: string,
  owner: string | undefined,
  ownersByPath: Map<string, Map<string, number>>,
): void {
  if (!owner) return;
  const owners = ownersByPath.get(path) ?? new Map<string, number>();
  owners.set(owner, (owners.get(owner) ?? 0) + 1);
  ownersByPath.set(path, owners);
}

function strongestOwner(owners: Map<string, number> | undefined): string | undefined {
  if (!owners) return undefined;
  const ranked = [...owners.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  return ranked.length > 1 && ranked[0][1] === ranked[1][1] ? undefined : ranked[0]?.[0];
}

function decision(
  candidate: Candidate,
  disposition: DomainCandidateDisposition,
  reason: DomainCandidateReason,
  owner?: string,
): DomainCandidateDecision {
  return {
    candidate: candidate.name,
    path: candidate.path,
    sources: candidate.signals,
    disposition,
    reason,
    ...(owner ? { owner } : {}),
    files: candidate.files.map(file => file.path).sort().slice(0, DOMAIN_DECISION_FILES_LIMIT),
  };
}

function candidateSignals(
  name: string,
  files: ScoredFile[],
  primary: 'directory' | 'dependency-cluster',
  entryPaths: Set<string>,
  routePaths: Set<string>,
  schemaPaths: Set<string>,
): DomainCandidateSignal[] {
  const normalizedName = normalizeDomainName(name);
  const signals = new Set<DomainCandidateSignal>([primary]);
  const matchingPrefixes = files.filter(file => {
    const prefix = file.name.replace(/\.[^.]+$/, '').split(/[-_.]/)[0];
    return normalizeDomainName(prefix) === normalizedName;
  });
  if (matchingPrefixes.length >= 2) signals.add('filename');
  if (files.some(file => entryPaths.has(file.path))) signals.add('public-entry');
  if (files.some(file => routePaths.has(file.path))) signals.add('route');
  if (files.some(file => schemaPaths.has(file.path))) signals.add('schema');
  if (isTechnicalDomainRole(normalizedName)) signals.add('technical-role');
  return [...signals].sort();
}

function uniqueFiles(files: ScoredFile[]): ScoredFile[] {
  return [...new Map([...files].sort(byFilePath).map(file => [file.path, file])).values()];
}

function commonDirectory(files: ScoredFile[]): string {
  if (files.length === 0) return '';
  const split = files.map(file => normalizePath(file.directory || posix.dirname(file.path)).split('/'));
  const common: string[] = [];
  for (let index = 0; index < Math.min(...split.map(parts => parts.length)); index++) {
    const value = split[0][index];
    if (split.every(parts => parts[index] === value)) common.push(value); else break;
  }
  return common.join('/');
}

function normalizeDomainName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || 'misc';
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, '/');
}

function byFilePath(a: ScoredFile, b: ScoredFile): number {
  return a.path.localeCompare(b.path);
}

function byDecision(a: DomainCandidateDecision, b: DomainCandidateDecision): number {
  return a.candidate.localeCompare(b.candidate) || a.path.localeCompare(b.path) || a.disposition.localeCompare(b.disposition);
}
