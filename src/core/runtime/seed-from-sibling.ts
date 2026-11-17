/**
 * Seed a new worktree's index from a sibling checkout
 * (change: seed-worktree-index-from-sibling-checkout).
 *
 * `.openlore/` is gitignored, so a new git worktree starts with no index, and its first call
 * could only say "a build has started". The main checkout next door usually holds a current
 * index of nearly the same code. This copies that index in, verified, so the first call
 * answers; a background rebuild then reuses the copied per-file memo in `call-graph.db`.
 *
 * What makes a copy safe to serve:
 *   - The sibling shares this checkout's git common directory, so it is the same repository.
 *   - No build owns the sibling, and its generation manifest is a published one.
 *   - Only known artifact names are copied, never a symlink or a special file, and never the
 *     sibling's runtime state (locks, stamps, progress), which lives outside the analysis dir.
 *   - The COPY is verified, not the source: its digests match the manifest and its edge store
 *     reconciles `healthy` against its attestation. The source is re-checked after the copy,
 *     so a writer that moved underneath it voids the seed.
 *   - The verified set is published by one directory rename, so a reader never sees a part.
 *
 * Any refusal leaves this checkout untouched, and the caller starts the ordinary cold build.
 */

import { constants, type Dirent } from 'node:fs';
import { copyFile, lstat, mkdir, open, readdir, realpath, rename, rm, rmdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import {
  ARTIFACT_CALL_GRAPH_DB,
  ARTIFACT_INDEX_ATTESTATION,
  ARTIFACT_LLM_CONTEXT,
  OPENLORE_ANALYSIS_REL_PATH,
} from '../../constants.js';
import { execFileGit } from '../../utils/git-exec.js';
import { readAttestation, reconcile } from '../analyzer/index-attestation.js';
import { EdgeStore } from '../services/edge-store.js';
import {
  GENERATION_MANIFEST_FILE,
  REQUIRED_ANALYSIS_ARTIFACTS,
  artifactMatchesGeneration,
  generationPublishInProgress,
  readCurrentGeneration,
  type GenerationManifest,
} from './analysis-generation.js';
import { isProcessAlive, readAnalysisOwner, runtimeDirOf } from './analysis-ownership.js';

/** Analysis files a seed carries beside the manifest's own artifact list, when present. */
const SEED_SIDE_FILES = [
  GENERATION_MANIFEST_FILE,
  ARTIFACT_INDEX_ATTESTATION,
  ARTIFACT_CALL_GRAPH_DB,
  `${ARTIFACT_CALL_GRAPH_DB}-wal`,
  'vector-index-meta.json',
  'analysis-indexes.json',
];
/** The keyword/vector search indexes, copied whole (regular files only). */
const SEED_INDEX_DIRECTORIES = ['vector-index', 'text-line-index'];
/** Files a sibling's search-index directories may hold before the seed is refused as unbounded. */
const MAX_SEED_FILES = 100_000;
/** Linked worktrees inspected before giving up. */
const MAX_CANDIDATES = 16;
const GIT_TIMEOUT_MS = 5_000;
/** Runtime marker naming the generation that was seeded; the seed is served while it is current. */
const SEEDED_GENERATION_FILE = 'seeded-generation';

export type SeedResult =
  | { state: 'seeded'; source: string; generationId: string }
  | { state: 'not-seeded'; reason: string };

/** One copied file, as it was before the copy: re-checked after it to catch a moving source. */
interface SourceEntry { rel: string; size: number; mtimeMs: number; ino: number }

class SeedRefused extends Error {}

function refuse(reason: string): never {
  throw new SeedRefused(reason);
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileGit('git', args, { cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: 1024 * 1024 });
  return stdout;
}

async function canonical(path: string): Promise<string> {
  const real = await realpath(resolve(path));
  return process.platform === 'win32' ? real.toLowerCase() : real;
}

/** True only for a real directory at `path` — a symlink to one is not. */
async function isRealDirectory(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isDirectory();
  } catch {
    return false;
  }
}

/** This checkout's root and git common directory, or undefined outside the top of a work tree. */
async function repositoryIdentity(directory: string): Promise<{ root: string; commonDir: string } | undefined> {
  try {
    const [top, common] = (await git(directory, [
      'rev-parse', '--path-format=absolute', '--show-toplevel', '--git-common-dir',
    ])).split('\n');
    if (!top || !common) return undefined;
    return { root: await canonical(top), commonDir: await canonical(common) };
  } catch {
    return undefined;
  }
}

/** The repository's checkouts in `git worktree list` order: the main worktree first. */
async function listCheckouts(directory: string): Promise<string[]> {
  const out = await git(directory, ['worktree', 'list', '--porcelain', '-z']);
  const checkouts: string[] = [];
  let current: string | undefined;
  let usable = true;
  for (const line of out.split('\0')) {
    if (line === '') {
      if (current && usable) checkouts.push(current);
      current = undefined;
      usable = true;
    } else if (line.startsWith('worktree ')) {
      current = line.slice('worktree '.length);
    } else if (line === 'bare' || line.startsWith('prunable')) {
      usable = false;
    }
  }
  if (current && usable) checkouts.push(current);
  return checkouts;
}

/** Every file a seed copies from `analysisDir`, relative to it. Refuses any non-regular entry. */
async function seedFileList(analysisDir: string, manifest: GenerationManifest): Promise<string[]> {
  const files = new Set(manifest.artifacts.map(record => record.path));
  for (const name of SEED_SIDE_FILES) {
    try {
      const entry = await lstat(join(analysisDir, name));
      if (!entry.isFile()) refuse(`${name} is not a regular file`);
      files.add(name);
    } catch (error) {
      if (error instanceof SeedRefused) throw error;
      // Absent: optional beside the manifest. The required ones are verified on the copy.
    }
  }
  for (const directory of SEED_INDEX_DIRECTORIES) {
    if (!await isRealDirectory(join(analysisDir, directory))) continue;
    const queue = [directory];
    while (queue.length > 0) {
      const rel = queue.pop()!;
      let entries: Dirent[];
      try {
        entries = await readdir(join(analysisDir, rel), { withFileTypes: true });
      } catch {
        refuse(`${rel} could not be read`);
      }
      for (const entry of entries) {
        const child = join(rel, entry.name);
        if (entry.isDirectory()) queue.push(child);
        else if (entry.isFile()) files.add(child);
        else refuse(`${child} is not a regular file`);
        if (files.size > MAX_SEED_FILES) refuse('the search index holds too many files to copy');
      }
    }
  }
  return [...files];
}

async function statEntry(analysisDir: string, rel: string): Promise<SourceEntry> {
  const entry = await lstat(join(analysisDir, rel));
  if (!entry.isFile()) refuse(`${rel} is not a regular file`);
  return { rel, size: entry.size, mtimeMs: entry.mtimeMs, ino: entry.ino };
}

/** Is the sibling's analysis idle and published, with this manifest? */
async function sourceManifest(root: string, analysisDir: string): Promise<GenerationManifest> {
  if (await readAnalysisOwner(root, analysisDir) !== null) refuse('a build owns the sibling index');
  if (await generationPublishInProgress(analysisDir)) refuse('the sibling index is being published');
  const manifest = await readCurrentGeneration(analysisDir, [...REQUIRED_ANALYSIS_ARTIFACTS]);
  if (!manifest || manifest.compatibility !== 'manifest') refuse('the sibling has no verifiable generation manifest');
  return manifest;
}

/** Does the staged copy verify: manifest digests, and an edge store that reconciles healthy? */
async function verifyCopy(stagingDir: string, generationId: string): Promise<void> {
  const manifest = await readCurrentGeneration(stagingDir, [...REQUIRED_ANALYSIS_ARTIFACTS]);
  if (!manifest || manifest.compatibility !== 'manifest' || manifest.generationId !== generationId) {
    refuse('the copied manifest does not verify');
  }
  for (const record of manifest.artifacts) {
    if (!await artifactMatchesGeneration(stagingDir, manifest, record.path)) refuse(`${record.path} does not match its digest`);
  }
  const attestation = await readAttestation(stagingDir);
  if (!attestation) refuse('the copied index has no attestation');
  const store = EdgeStore.open(EdgeStore.dbPath(stagingDir));
  try {
    if (store.notReady) refuse(`the copied edge store is not ready (${store.notReady.reason})`);
    const verdict = reconcile(attestation, {
      schemaVersion: store.getSchemaVersion(),
      files: store.countFiles(),
      functions: store.countNodes(),
      edges: store.countEdges(),
      classes: store.countClasses(),
    }).verdict;
    if (verdict !== 'healthy') refuse(`the copied edge store reconciles ${verdict}`);
  } finally {
    store.close();
  }
}

/** Copy, verify and publish one sibling's index into `targetAnalysis`. */
const STAGING_PREFIX = '.analysis-seed-';

/**
 * Remove staging copies whose writer is gone. A seed runs inside a hook or a first tool call,
 * either of which can be killed mid-copy; its `finally` then never runs, and each retry would
 * leave another full index copy behind. Only real directories named by a dead pid are removed.
 */
async function sweepAbandonedStaging(openloreDir: string): Promise<void> {
  let entries: Dirent[];
  try { entries = await readdir(openloreDir, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    const pid = entry.name.startsWith(STAGING_PREFIX) ? Number.parseInt(entry.name.slice(STAGING_PREFIX.length), 10) : NaN;
    if (!entry.isDirectory() || Number.isNaN(pid) || isProcessAlive(pid)) continue;
    await rm(join(openloreDir, entry.name), { recursive: true, force: true }).catch(() => {});
  }
}

async function seedFrom(sourceRoot: string, targetRoot: string): Promise<string> {
  const sourceAnalysis = join(sourceRoot, OPENLORE_ANALYSIS_REL_PATH);
  if (!await isRealDirectory(dirname(sourceAnalysis)) || !await isRealDirectory(sourceAnalysis)) {
    refuse('the sibling has no index directory');
  }
  const manifest = await sourceManifest(sourceRoot, sourceAnalysis);
  const files = await seedFileList(sourceAnalysis, manifest);
  const before = await Promise.all(files.map(rel => statEntry(sourceAnalysis, rel)));

  const openloreDir = dirname(join(targetRoot, OPENLORE_ANALYSIS_REL_PATH));
  const targetAnalysis = join(targetRoot, OPENLORE_ANALYSIS_REL_PATH);
  await mkdir(openloreDir).catch(error => {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  });
  if (!await isRealDirectory(openloreDir)) refuse('.openlore is not a directory');
  await sweepAbandonedStaging(openloreDir);
  // A fresh, uniquely named directory: nothing in it can be a planted link, and every copy is
  // exclusive, so a file that appears there anyway fails the copy instead of being followed.
  // The writer's pid is in the name, so a copy killed before its cleanup can be swept.
  const stagingDir = join(openloreDir, `${STAGING_PREFIX}${process.pid}-${randomUUID()}`);
  await mkdir(stagingDir);
  try {
    for (const entry of before) {
      const destination = join(stagingDir, entry.rel);
      await mkdir(dirname(destination), { recursive: true });
      // Copy-on-write where the file system supports it (APFS, Btrfs, XFS, ReFS); a plain
      // copy elsewhere.
      await copyFile(join(sourceAnalysis, entry.rel), destination, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE);
    }
    // A source that changed during the copy may have been copied as a mixture: refuse it.
    for (const entry of before) {
      const after = await statEntry(sourceAnalysis, entry.rel);
      if (after.size !== entry.size || after.mtimeMs !== entry.mtimeMs || after.ino !== entry.ino) {
        refuse(`${entry.rel} changed during the copy`);
      }
    }
    if ((await sourceManifest(sourceRoot, sourceAnalysis)).generationId !== manifest.generationId) {
      refuse('the sibling index was republished during the copy');
    }
    await verifyCopy(stagingDir, manifest.generationId);

    // Publish. Only an absent or empty analysis directory is replaced; anything else means
    // another writer got here first.
    try {
      await rmdir(targetAnalysis);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') refuse('this checkout already has analysis files');
    }
    try {
      await rename(stagingDir, targetAnalysis);
    } catch {
      refuse('another writer created the index first');
    }
  } finally {
    await rm(stagingDir, { recursive: true, force: true }).catch(() => {});
  }
  await writeSeededMarker(targetAnalysis, manifest.generationId);
  return manifest.generationId;
}

/** Record which generation was seeded. Best-effort: without it only this process discloses the seed. */
async function writeSeededMarker(analysisDir: string, generationId: string): Promise<void> {
  const runtimeDir = runtimeDirOf(analysisDir);
  try {
    await mkdir(runtimeDir, { recursive: true });
    if (!await isRealDirectory(runtimeDir)) return;
    const handle = await open(
      join(runtimeDir, SEEDED_GENERATION_FILE),
      constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | (constants.O_NOFOLLOW ?? 0),
    );
    try {
      await handle.writeFile(`${generationId}\n`);
    } finally {
      await handle.close();
    }
  } catch {
    // Best-effort.
  }
}

/**
 * Seed `directory`'s index from a sibling checkout of the same repository, when it has none.
 *
 * The caller applies the auto-init opt-outs first. Never throws: every refusal is a
 * `not-seeded` result, and the caller then starts the ordinary cold build.
 */
export async function seedFromSiblingCheckout(directory: string): Promise<SeedResult> {
  try {
    const target = await repositoryIdentity(directory);
    if (!target || target.root !== await canonical(directory)) return { state: 'not-seeded', reason: 'not the top of a git work tree' };
    const targetAnalysis = join(directory, OPENLORE_ANALYSIS_REL_PATH);
    try {
      await lstat(join(targetAnalysis, ARTIFACT_LLM_CONTEXT));
      return { state: 'not-seeded', reason: 'this checkout already has an index' };
    } catch {
      // Absent, as expected.
    }
    if (await readAnalysisOwner(target.root, targetAnalysis) !== null) {
      return { state: 'not-seeded', reason: 'a build is already running here' };
    }

    let reason = 'no sibling checkout holds an index';
    let inspected = 0;
    for (const checkout of await listCheckouts(directory)) {
      if (inspected >= MAX_CANDIDATES) break;
      let root: string;
      try {
        root = await canonical(checkout);
        await lstat(join(root, OPENLORE_ANALYSIS_REL_PATH, ARTIFACT_LLM_CONTEXT));
      } catch {
        continue;
      }
      if (root === target.root) continue;
      inspected++;
      const sibling = await repositoryIdentity(root);
      if (!sibling || sibling.commonDir !== target.commonDir) continue;
      try {
        const generationId = await seedFrom(root, directory);
        return { state: 'seeded', source: root, generationId };
      } catch (error) {
        reason = error instanceof SeedRefused ? error.message : `the copy failed: ${(error as Error).message}`;
      }
    }
    return { state: 'not-seeded', reason };
  } catch (error) {
    return { state: 'not-seeded', reason: (error as Error).message };
  }
}

/**
 * Is `directory` still serving the generation it was seeded with? True from the seed until
 * the rebuild publishes its own generation.
 */
export async function servingSeededIndex(directory: string): Promise<boolean> {
  const analysisDir = join(directory, OPENLORE_ANALYSIS_REL_PATH);
  let seeded: string;
  try {
    const handle = await open(
      join(runtimeDirOf(analysisDir), SEEDED_GENERATION_FILE),
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    try {
      const buffer = Buffer.alloc(128);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      seeded = buffer.subarray(0, bytesRead).toString('utf8').trim();
    } finally {
      await handle.close();
    }
  } catch {
    return false;
  }
  const current = await readCurrentGeneration(analysisDir, [...REQUIRED_ANALYSIS_ARTIFACTS]).catch(() => null);
  return seeded.length > 0 && current?.generationId === seeded;
}
