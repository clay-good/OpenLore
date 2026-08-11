/**
 * Atomic analysis-generation identity.
 *
 * Analysis artifacts were written individually and daemon caches keyed primarily
 * on artifact mtime, so a multi-artifact reader could observe a MIXTURE of an old
 * and a new analysis — one file from before a rebuild, another from after. Each
 * full analysis now publishes a generation manifest binding every required
 * artifact to one identity and content digest, and readers validate that identity
 * before AND after a multi-artifact read (change `harden-spec-workflow-lifecycle`,
 * decision 64e6eb87).
 *
 * The manifest is what makes a generation CURRENT: it is written last, after
 * every required artifact is durable, so an interrupted analysis leaves the prior
 * committed generation readable rather than a half-published one.
 *
 * Renaming the whole analysis directory was rejected — databases, runtime
 * sidecars, and platform-specific rename behavior make whole-directory
 * replacement unnecessarily risky for the guarantee actually needed, which is
 * that a reader never ACCEPTS a mixture.
 */

import { createHash, randomUUID } from 'node:crypto';
import { readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Name of the manifest inside the analysis output directory. */
export const GENERATION_MANIFEST_FILE = 'generation.json';

export const GENERATION_MANIFEST_VERSION = 1;

/**
 * The artifacts a generation must contain to become current.
 *
 * Deliberately the set every multi-artifact reader consumes — not every file
 * `analyze` writes. Side artifacts (style fingerprint, parse health) are
 * fail-soft by design and must not be able to block a publication.
 */
export const REQUIRED_ANALYSIS_ARTIFACTS = [
  'repo-structure.json',
  'llm-context.json',
  'dependency-graph.json',
  'fingerprint.json',
] as const;

export interface GenerationArtifactRecord {
  /** Artifact file name, relative to the analysis directory. */
  path: string;
  sha256: string;
  bytes: number;
}

export interface GenerationManifest {
  version: typeof GENERATION_MANIFEST_VERSION;
  /** Opaque identity of this generation. Never derived from content or time. */
  generationId: string;
  publishedAt: string;
  artifacts: GenerationArtifactRecord[];
  /**
   * `manifest` for a generation this code published; `legacy` for the synthesized
   * identity of an analysis produced before manifests existed.
   */
  compatibility: 'manifest' | 'legacy';
}

export function manifestPathOf(analysisDir: string): string {
  return join(analysisDir, GENERATION_MANIFEST_FILE);
}

async function digestOf(path: string): Promise<GenerationArtifactRecord | null> {
  try {
    const contents = await readFile(path);
    return {
      path: path.slice(path.lastIndexOf('/') + 1),
      sha256: createHash('sha256').update(contents).digest('hex'),
      bytes: contents.byteLength,
    };
  } catch {
    return null;
  }
}

/**
 * Publish a new current generation.
 *
 * Call ONLY after every required artifact is durable: this is the commit point.
 * The manifest is written to a temp file and renamed, so a reader sees either the
 * previous manifest or the new one, never a partially written one.
 *
 * Returns `null` when a required artifact is missing — an analysis that did not
 * produce its full artifact set must not become current.
 */
export async function publishGeneration(
  analysisDir: string,
  requiredArtifacts: string[],
): Promise<GenerationManifest | null> {
  const records: GenerationArtifactRecord[] = [];
  for (const name of requiredArtifacts) {
    const record = await digestOf(join(analysisDir, name));
    if (!record) return null;
    records.push(record);
  }

  const manifest: GenerationManifest = {
    version: GENERATION_MANIFEST_VERSION,
    generationId: randomUUID(),
    publishedAt: new Date().toISOString(),
    artifacts: records.sort((a, b) => a.path.localeCompare(b.path)),
    compatibility: 'manifest',
  };

  const target = manifestPathOf(analysisDir);
  const tmp = `${target}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(manifest, null, 2), 'utf8');
  await rename(tmp, target);
  return manifest;
}

/**
 * Read the current generation manifest.
 *
 * An analysis with no manifest is not an error: it is a legacy generation, given
 * a disclosed synthetic identity derived from artifact mtimes so caches can still
 * key on it. It is upgraded to a real manifest on the next analyze.
 */
export async function readCurrentGeneration(
  analysisDir: string,
  legacyArtifacts: string[] = [],
): Promise<GenerationManifest | null> {
  try {
    const parsed = JSON.parse(await readFile(manifestPathOf(analysisDir), 'utf8')) as GenerationManifest;
    if (parsed?.version === GENERATION_MANIFEST_VERSION && typeof parsed.generationId === 'string') return parsed;
  } catch {
    // fall through to the legacy path
  }
  return synthesizeLegacyGeneration(analysisDir, legacyArtifacts);
}

/**
 * Identity for an analysis published before manifests existed.
 *
 * Derived from the artifact set's mtimes and sizes — weaker than a manifest, and
 * labelled `legacy` so a consumer can tell the difference rather than believing
 * it has manifest-grade coherence.
 */
export async function synthesizeLegacyGeneration(
  analysisDir: string,
  artifacts: string[],
): Promise<GenerationManifest | null> {
  const hash = createHash('sha256');
  const records: GenerationArtifactRecord[] = [];
  let found = 0;
  for (const name of [...artifacts].sort()) {
    try {
      const info = await stat(join(analysisDir, name));
      hash.update(`${name}\0${info.mtimeMs}\0${info.size}\0`);
      records.push({ path: name, sha256: '', bytes: info.size });
      found++;
    } catch {
      // A missing artifact simply does not contribute.
    }
  }
  if (found === 0) return null;
  return {
    version: GENERATION_MANIFEST_VERSION,
    generationId: `legacy-${hash.digest('hex').slice(0, 32)}`,
    publishedAt: new Date(0).toISOString(),
    artifacts: records,
    compatibility: 'legacy',
  };
}

export type GenerationSnapshot<T> =
  | { state: 'ok'; value: T; generationId: string; compatibility: GenerationManifest['compatibility'] }
  | { state: 'analysis-unavailable' }
  | { state: 'analysis-changed'; message: string };

/**
 * Do the artifacts on disk still hash to what the manifest recorded?
 *
 * The identity check alone is not sufficient. A full analyze writes each artifact
 * IN PLACE and publishes its manifest last, so between the first overwrite and
 * that publication the current manifest is still the OLD one: a reader sees the
 * same generation id before and after, while the bytes underneath it have already
 * changed. Comparing the recorded digests closes exactly that window — the one
 * where a mixture is silently labelled `ok`.
 *
 * A legacy generation records no digests (its identity is synthesized from mtime
 * and size, which already moves on any rewrite), so there is nothing to verify and
 * it passes.
 */
async function artifactsStillMatch(analysisDir: string, manifest: GenerationManifest): Promise<boolean> {
  for (const recorded of manifest.artifacts) {
    if (!recorded.sha256) continue; // legacy: no digest was ever taken
    const current = await digestOf(join(analysisDir, recorded.path));
    if (!current || current.sha256 !== recorded.sha256) return false;
  }
  return true;
}

/**
 * Run a multi-artifact read against ONE generation.
 *
 * Validates the current generation identity before and after `read`. A change
 * mid-read means the snapshot may be mixed, so it retries once against the new
 * generation and then reports `analysis-changed` rather than returning evidence
 * it cannot vouch for. Mixed-generation evidence is never labelled fresh.
 */
export async function readGenerationSnapshot<T>(
  analysisDir: string,
  legacyArtifacts: string[],
  read: (generationId: string) => Promise<T>,
): Promise<GenerationSnapshot<T>> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const before = await readCurrentGeneration(analysisDir, legacyArtifacts);
    if (!before) return { state: 'analysis-unavailable' };

    const value = await read(before.generationId);

    const after = await readCurrentGeneration(analysisDir, legacyArtifacts);
    if (after && after.generationId === before.generationId && await artifactsStillMatch(analysisDir, after)) {
      return { state: 'ok', value, generationId: before.generationId, compatibility: before.compatibility };
    }
  }
  return {
    state: 'analysis-changed',
    message: 'The analysis generation changed while this response was being composed. Retry the request.',
  };
}

/** Remove a manifest, e.g. when abandoning an interrupted publication. */
export async function discardGeneration(analysisDir: string): Promise<void> {
  await unlink(manifestPathOf(analysisDir)).catch(() => {});
}
