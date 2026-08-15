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
 * every required artifact is durable. Writers serialize the complete required
 * write set and this commit point under the analysis lock. Readers that do not
 * participate in that lock still verify content digests and refuse a mixture.
 *
 * Renaming the whole analysis directory was rejected — databases, runtime
 * sidecars, and platform-specific rename behavior make whole-directory
 * replacement unnecessarily risky for the guarantee actually needed, which is
 * that a reader never ACCEPTS a mixture.
 */

import { createHash, randomUUID } from 'node:crypto';
import { readFile, stat, unlink } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { atomicWriteFile } from '../decisions/atomic-store.js';

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
  /** Full rebuild, or an honest watcher patch over a potentially stale repo survey. */
  coherence: 'full' | 'incremental';
}

export function manifestPathOf(analysisDir: string): string {
  return join(analysisDir, GENERATION_MANIFEST_FILE);
}

/**
 * Digest one artifact, recorded under the NAME it was asked for.
 *
 * The name is never derived back out of the joined path. Doing that with a POSIX
 * separator stored the whole absolute path on Windows, where `join` produces
 * backslashes — and since the recorded name is what the digest re-check joins
 * against, every snapshot read on Windows would resolve to a nonexistent file and
 * report `analysis-changed` forever. Passing the name through keeps the record
 * platform-independent by construction.
 */
async function digestOf(analysisDir: string, name: string): Promise<GenerationArtifactRecord | null> {
  try {
    const contents = await readFile(join(analysisDir, name));
    return {
      path: name,
      sha256: createHash('sha256').update(contents).digest('hex'),
      bytes: contents.byteLength,
    };
  } catch {
    return null;
  }
}

/** Verify one artifact against a manifest record without trusting mtime granularity. */
export async function artifactMatchesGeneration(
  analysisDir: string,
  manifest: GenerationManifest,
  name: string,
): Promise<boolean> {
  if (manifest.compatibility === 'legacy') return true;
  const expected = manifest.artifacts.find(record => record.path === name);
  if (!expected) return false;
  const current = await digestOf(analysisDir, name);
  return current !== null
    && current.sha256 === expected.sha256
    && current.bytes === expected.bytes;
}

/**
 * Publish a new current generation.
 *
 * Call ONLY after every required artifact is durable: this is the commit point.
 * The manifest uses the durable atomic-write primitive, so a reader sees either
 * the previous manifest or the new one, never a partially written one.
 *
 * Returns `null` when a required artifact is missing — an analysis that did not
 * produce its full artifact set must not become current.
 */
export async function publishGeneration(
  analysisDir: string,
  requiredArtifacts: string[],
  options: { coherence?: GenerationManifest['coherence'] } = {},
): Promise<GenerationManifest | null> {
  const records: GenerationArtifactRecord[] = [];
  for (const name of requiredArtifacts) {
    const record = await digestOf(analysisDir, name);
    if (!record) return null;
    records.push(record);
  }

  const manifest: GenerationManifest = {
    version: GENERATION_MANIFEST_VERSION,
    generationId: randomUUID(),
    publishedAt: new Date().toISOString(),
    artifacts: records.sort((a, b) => a.path.localeCompare(b.path)),
    compatibility: 'manifest',
    coherence: options.coherence ?? 'full',
  };

  await atomicWriteFile(manifestPathOf(analysisDir), JSON.stringify(manifest, null, 2));
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
  let raw: string;
  try {
    raw = await readFile(manifestPathOf(analysisDir), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return synthesizeLegacyGeneration(analysisDir, legacyArtifacts);
    }
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as GenerationManifest;
    const paths = Array.isArray(parsed?.artifacts)
      ? parsed.artifacts.map(record => record?.path)
      : [];
    const uniquePaths = new Set(paths);
    if (
      parsed?.version === GENERATION_MANIFEST_VERSION
      && typeof parsed.generationId === 'string'
      && parsed.generationId.length > 0
      && typeof parsed.publishedAt === 'string'
      && parsed.compatibility === 'manifest'
      && (parsed.coherence === 'full' || parsed.coherence === 'incremental' || parsed.coherence === undefined)
      && Array.isArray(parsed.artifacts)
      && uniquePaths.size === parsed.artifacts.length
      && legacyArtifacts.every(name => uniquePaths.has(name))
      && parsed.artifacts.every(record =>
        record
        && typeof record.path === 'string'
        && record.path === basename(record.path)
        && record.path !== '.'
        && typeof record.sha256 === 'string'
        && /^[a-f0-9]{64}$/.test(record.sha256)
        && Number.isSafeInteger(record.bytes)
        && record.bytes >= 0)
    ) return parsed;
  } catch {
    // A present but malformed manifest is an invalid committed generation, not a
    // legacy analysis. Falling back here would silently downgrade integrity.
  }
  return null;
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
    coherence: 'full',
  };
}

export type GenerationSnapshot<T> =
  | { state: 'ok'; value: T; generationId: string; compatibility: GenerationManifest['compatibility']; coherence: GenerationManifest['coherence'] }
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
    const current = await digestOf(analysisDir, recorded.path);
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
      return { state: 'ok', value, generationId: before.generationId, compatibility: before.compatibility, coherence: before.coherence ?? 'full' };
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
