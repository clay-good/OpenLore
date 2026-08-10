import type { LLMContext, RepoStructure } from '../analyzer/artifact-generator.js';

export interface DomainEvidenceBundle {
  name: string;
  files: string[];
  definingFiles: string[];
  supportingFiles: string[];
  candidateDecisions: NonNullable<RepoStructure['domainDecisions']>;
  candidateDecisionSummary?: RepoStructure['domainDecisionSummary'];
  schemaFiles: string[];
  serviceFiles: string[];
  apiFiles: string[];
  signatures: NonNullable<LLMContext['signatures']>;
  supportingSignatures: NonNullable<LLMContext['signatures']>;
  schemas: RepoStructure['schemas'];
  routes: NonNullable<RepoStructure['routeInventory']>['routes'];
}

export interface EvidenceFile {
  path: string;
  content: string;
}

/**
 * Keep a deterministic domain bundle whole whenever possible.  If it exceeds
 * the configured evidence budget, split only at file boundaries in sorted
 * path order.  This preserves stable prompts while avoiding the former
 * arbitrary AST/file chunk loop.
 */
export function partitionEvidenceFiles(files: EvidenceFile[], maxChars: number): EvidenceFile[][] {
  const partitions: EvidenceFile[][] = [];
  let current: EvidenceFile[] = [];
  let size = 0;
  for (const file of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
    // A single source file may itself exceed the domain budget. Preserve a
    // deterministic, explicitly-truncated excerpt rather than leaking an
    // unbounded prompt through the new aggregation path.
    const contentBudget = Math.max(0, maxChars - file.path.length - 8);
    const truncationMarker = '\n… [truncated deterministic evidence]';
    const bounded = file.content.length > contentBudget
      ? `${file.content.slice(0, Math.max(0, contentBudget - truncationMarker.length))}${truncationMarker}`
      : file.content;
    const boundedFile = bounded === file.content ? file : { ...file, content: bounded.slice(0, contentBudget) };
    const cost = boundedFile.path.length + boundedFile.content.length + 8;
    if (current.length > 0 && size + cost > maxChars) {
      partitions.push(current);
      current = [];
      size = 0;
    }
    current.push(boundedFile);
    size += cost;
  }
  if (current.length > 0) partitions.push(current);
  return partitions;
}

/**
 * The deterministic routing contract for stages 1–4.  A file can belong to a
 * domain without being classified as schema/API; service is the residual
 * source role so the pipeline never asks an LLM to choose downstream inputs.
 */
export function buildDomainEvidence(
  repo: RepoStructure,
  context: LLMContext,
): DomainEvidenceBundle[] {
  const schemaFiles = new Set((repo.schemas ?? []).map(s => s.file));
  const apiFiles = new Set((repo.routeInventory?.routes ?? []).map(r => r.file));
  const bundles = repo.domains.map(domain => makeBundle(
    domain.name,
    domain.files,
    domain.definingFiles ?? domain.files,
    domain.supportingFiles ?? [],
    schemaFiles,
    apiFiles,
    repo,
    context,
  ));
  const assigned = new Set(bundles.flatMap(bundle => bundle.files));
  const excluded = new Set((repo.undomainedEvidence ?? [])
    .filter(item => item.role === 'excluded')
    .map(item => item.path));
  const evidenceFiles = [
    ...(repo.undomained ?? []),
    ...(context.signatures ?? []).map(signature => signature.path),
    ...(context.phase2_deep?.files ?? []).map(file => file.path),
    ...schemaFiles,
    ...apiFiles,
  ];
  const evidenceRole = new Map((repo.undomainedEvidence ?? []).map(item => [item.path, item.role]));
  const undomained = [...new Set(evidenceFiles.filter(path => !assigned.has(path) && !excluded.has(path)))].sort();
  if (undomained.length > 0) bundles.push(makeBundle(
    'undomained',
    undomained,
    undomained.filter(path => evidenceRole.get(path) !== 'supporting'),
    undomained.filter(path => evidenceRole.get(path) === 'supporting'),
    schemaFiles, apiFiles, repo, context,
  ));
  return bundles;
}

function makeBundle(
  name: string,
  paths: string[],
  definingPaths: string[],
  supportingPaths: string[],
  schemaFiles: Set<string>,
  apiFiles: Set<string>,
  repo: RepoStructure,
  context: LLMContext,
): DomainEvidenceBundle {
  const files = [...new Set(paths)].sort();
  const defining = new Set(definingPaths);
  const supporting = new Set(supportingPaths);
  return {
    name,
    files,
    definingFiles: [...new Set(definingPaths)].sort(),
    supportingFiles: [...new Set(supportingPaths)].sort(),
    candidateDecisions: (repo.domainDecisions ?? []).filter(decision =>
      decision.owner === name || decision.candidate === name),
    candidateDecisionSummary: repo.domainDecisionSummary,
    schemaFiles: files.filter(path => defining.has(path) && schemaFiles.has(path)),
    apiFiles: files.filter(path => defining.has(path) && apiFiles.has(path)),
    serviceFiles: files.filter(path => defining.has(path) && !schemaFiles.has(path) && !apiFiles.has(path)),
    signatures: (context.signatures ?? []).filter(signature => defining.has(signature.path)),
    supportingSignatures: (context.signatures ?? []).filter(signature => supporting.has(signature.path)),
    schemas: (repo.schemas ?? []).filter(schema => defining.has(schema.file)),
    routes: (repo.routeInventory?.routes ?? []).filter(route => defining.has(route.file)),
  };
}
