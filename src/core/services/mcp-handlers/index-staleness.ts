/** Shared conclusion decorator for cited-file working-tree freshness. */

import { requestRepairFromHost } from '../cold-start-bootstrap.js';
import type { CachedContext } from './utils.js';
import {
  buildStaleServingDisclosure,
  checkCitedFileFreshness,
  collectCitedSourceFiles,
  type StaleServingDisclosure,
} from './freshness.js';

export interface IndexStaleness extends StaleServingDisclosure {
  /** The structured response cited more files than the bounded collector could inspect. */
  uncheckedCitations?: true;
}

/**
 * Check the source files actually cited by a completed conclusion payload.
 * Detection never blocks serving and repair wording is authorized only by an
 * exact-root host callback (watch-auto/serve), never inferred from process type.
 */
export async function computeIndexStaleness(
  root: string,
  result: unknown,
  context?: Pick<CachedContext, 'edgeStore' | 'artifactMtimeMs'> | null,
  citedFiles?: readonly string[],
): Promise<IndexStaleness | undefined> {
  const collected = citedFiles
    ? { files: [...new Set(citedFiles)], truncated: false }
    : collectCitedSourceFiles(result);
  const checked = await checkCitedFileFreshness(root, collected.files, {
    edgeStore: context?.edgeStore,
    artifactMtimeMs: context?.artifactMtimeMs,
  });
  const repairScheduled = requestRepairFromHost(root, checked.staleFiles);
  const disclosure = buildStaleServingDisclosure(checked.staleFiles, repairScheduled);
  if (disclosure) {
    return {
      ...disclosure,
      ...(collected.truncated ? { uncheckedCitations: true as const } : {}),
    };
  }
  if (collected.truncated) {
    return {
      staleFiles: [],
      uncheckedCitations: true,
      note: 'Cited-file freshness could not be checked for the entire response; narrow the query before treating omitted regions as current.',
    };
  }
  return undefined;
}

/** Attach the additive machine-readable boundary without changing existing fields. */
export async function withIndexStaleness<T extends object>(
  root: string,
  result: T,
  context?: Pick<CachedContext, 'edgeStore' | 'artifactMtimeMs'> | null,
  citedFiles?: readonly string[],
): Promise<T & { indexStaleness?: IndexStaleness }> {
  const indexStaleness = await computeIndexStaleness(root, result, context, citedFiles);
  return indexStaleness ? { ...result, indexStaleness } : result;
}
