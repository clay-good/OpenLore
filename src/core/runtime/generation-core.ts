import { writeFile } from 'node:fs/promises';
import { relative } from 'node:path';
import { ARTIFACT_RAG_MANIFEST } from '../../constants.js';
import type { DependencyGraphResult } from '../analyzer/dependency-graph.js';
import { SpecSnapshotGenerator } from '../analyzer/spec-snapshot-generator.js';
import type { GeneratedSpec } from '../generator/openspec-format-generator.js';
import { RagManifestGenerator } from '../generator/rag-manifest-generator.js';
import { resolveSpecLinkIndex } from '../generator/spec-link-service.js';
import { safeJoin } from '../../utils/path-confinement.js';
export { resolveGenerationProvider } from './llm-provider-resolution.js';
export type { ProviderName } from './llm-provider-resolution.js';
export { detectOpenSpecPackageVersion, OPENLORE_PACKAGE_VERSION } from './package-versions.js';

type FinalizationStep = 'mapping' | 'rag-manifest' | 'spec-snapshot';

export interface GenerationFinalizationOptions {
  rootPath: string;
  openspecRoot: string;
  openspecPath: string;
  mappingRootPath?: string;
  mappingOpenspecPath?: string;
  snapshotRootPath?: string;
  snapshotOpenspecPath?: string;
  metadataSpecs: GeneratedSpec[];
  depGraph?: DependencyGraphResult;
  mapping?: boolean;
  scoped?: boolean;
  onProgress?: (step: FinalizationStep, status: 'complete' | 'skip', detail: string) => void;
}

/**
 * Rebuild the deterministic artifacts derived after specs are written.
 * Each artifact is rebuildable and therefore intentionally best-effort.
 */
export async function finalizeGeneration(options: GenerationFinalizationOptions): Promise<void> {
  const { rootPath, openspecRoot, openspecPath, metadataSpecs, depGraph, onProgress } = options;

  if (options.mapping ?? true) {
    try {
      const resolution = await resolveSpecLinkIndex({
        rootPath: options.mappingRootPath ?? rootPath,
        openspecPath: options.mappingOpenspecPath ?? openspecPath,
        persist: true,
        graph: depGraph,
      });
      if (resolution.state === 'available') {
        onProgress?.('mapping', 'complete', `${resolution.index.stats.linked}/${resolution.index.stats.totalRequirements} linked`);
      } else {
        onProgress?.('mapping', 'skip', resolution.reason);
      }
    } catch (error) {
      onProgress?.('mapping', 'skip', (error as Error).message);
    }
  }

  if (options.scoped) {
    onProgress?.('rag-manifest', 'skip', 'Scoped generation leaves the global manifest unchanged');
  } else {
    try {
      const manifest = new RagManifestGenerator().generate(metadataSpecs, depGraph);
      await writeFile(
        safeJoin(openspecRoot, ARTIFACT_RAG_MANIFEST),
        JSON.stringify(manifest, null, 2),
        'utf-8',
      );
      onProgress?.('rag-manifest', 'complete', `${manifest.domains.length} domains`);
    } catch (error) {
      onProgress?.('rag-manifest', 'skip', (error as Error).message);
    }
  }

  try {
    const snapshotRoot = options.snapshotRootPath ?? rootPath;
    const snapshotOpenspecPath = options.snapshotOpenspecPath
      ?? (relative(snapshotRoot, openspecRoot) || '.');
    await new SpecSnapshotGenerator(snapshotRoot, snapshotOpenspecPath).generate();
    onProgress?.('spec-snapshot', 'complete', 'updated');
  } catch (error) {
    onProgress?.('spec-snapshot', 'skip', (error as Error).message);
  }
}
