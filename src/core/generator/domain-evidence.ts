import type { LLMContext, RepoStructure } from '../analyzer/artifact-generator.js';

export interface DomainEvidenceBundle {
  name: string;
  files: string[];
  schemaFiles: string[];
  serviceFiles: string[];
  apiFiles: string[];
  signatures: NonNullable<LLMContext['signatures']>;
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
  const bundles = repo.domains.map(domain => makeBundle(domain.name, domain.files, schemaFiles, apiFiles, repo, context));
  const assigned = new Set(bundles.flatMap(bundle => bundle.files));
  const undomained = [...new Set([...(repo.undomained ?? []), ...(context.signatures ?? []).map(s => s.path).filter(path => !assigned.has(path))])].sort();
  if (undomained.length > 0) bundles.push(makeBundle('undomained', undomained, schemaFiles, apiFiles, repo, context));
  return bundles;
}

function makeBundle(
  name: string,
  paths: string[],
  schemaFiles: Set<string>,
  apiFiles: Set<string>,
  repo: RepoStructure,
  context: LLMContext,
): DomainEvidenceBundle {
  const files = [...new Set(paths)].sort();
  const inBundle = new Set(files);
  return {
    name,
    files,
    schemaFiles: files.filter(path => schemaFiles.has(path)),
    apiFiles: files.filter(path => apiFiles.has(path)),
    serviceFiles: files.filter(path => !schemaFiles.has(path) && !apiFiles.has(path)),
    signatures: (context.signatures ?? []).filter(signature => inBundle.has(signature.path)),
    schemas: (repo.schemas ?? []).filter(schema => inBundle.has(schema.file)),
    routes: (repo.routeInventory?.routes ?? []).filter(route => inBundle.has(route.file)),
  };
}
