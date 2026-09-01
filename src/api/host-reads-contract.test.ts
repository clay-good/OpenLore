/**
 * The shared contract behind the four supervising-host reads
 * (change: extend-api-for-supervising-hosts, spec `SupervisingHostReadsNeedNoGenerationConfiguration`).
 *
 * These are the properties a HOST depends on and no individual read's own suite proves: that all
 * four behave alike. A read that needs an API key, prints to the host's console, ignores a
 * cancellation, or writes to the tree is unusable inside a supervisor even when its answer is
 * right — so the contract is tested across the set, not per function.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile, readFile, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { realpathSync } from 'node:fs';
import { openloreHealth } from './health.js';
import { openloreIndexState } from './index-state.js';
import { openloreAnalysisStatus } from './analysis-status.js';
import { openloreFederationList } from './federation.js';
import { addRepo } from '../core/federation/registry.js';
import { ARTIFACT_FINGERPRINT, DEFAULT_MAX_FILES, OPENLORE_ANALYSIS_REL_PATH } from '../constants.js';
import { computeProjectFingerprint } from '../core/services/mcp-handlers/utils.js';
import type { BaseOptions } from './types.js';

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

/** Every read a supervising host may call, named for the failure messages. */
const READS: { name: string; run: (options: BaseOptions) => Promise<unknown> }[] = [
  { name: 'openloreHealth', run: openloreHealth },
  { name: 'openloreIndexState', run: openloreIndexState },
  { name: 'openloreAnalysisStatus', run: openloreAnalysisStatus },
  { name: 'openloreFederationList', run: openloreFederationList },
];

/**
 * A repository with a real index fingerprint and a federation registry, so every read follows its
 * full path — including the O(repo bytes) recompute — rather than short-circuiting on absence.
 */
async function populatedWorkspace(): Promise<string> {
  const root = realpathSync(await mkdtemp(join(tmpdir(), 'openlore-host-reads-')));
  dirs.push(root);
  await writeFile(join(root, 'a.ts'), 'export const a = 1;\n');

  const configuration = {
    includePatterns: [] as string[],
    excludePatterns: [] as string[],
    maxFiles: DEFAULT_MAX_FILES,
    protectedExcludePatterns: [] as string[],
  };
  const analysisDir = join(root, OPENLORE_ANALYSIS_REL_PATH);
  await mkdir(analysisDir, { recursive: true });
  const hash = await computeProjectFingerprint(root, {
    configuration,
    protectedExcludePatterns: configuration.protectedExcludePatterns,
  });
  await writeFile(
    join(analysisDir, ARTIFACT_FINGERPRINT),
    JSON.stringify({ hash, fingerprintConfig: configuration }),
    'utf8',
  );

  const peer = realpathSync(await mkdtemp(join(tmpdir(), 'openlore-host-reads-peer-')));
  dirs.push(peer);
  addRepo(root, peer);
  return root;
}

/** Path → (size, mtime, bytes) for every file under a tree, so any write shows up. */
async function snapshot(root: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(path);
        continue;
      }
      const info = await stat(path);
      out.set(relative(root, path), `${info.size}:${info.mtimeMs}:${await readFile(path, 'utf8')}`);
    }
  };
  await walk(root);
  return out;
}

describe('the supervising-host read contract', () => {
  it('writes nothing to the console by default, like every other API function', async () => {
    const root = await populatedWorkspace();
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

    for (const read of READS) await read.run({ rootPath: root });

    expect(stdout.mock.calls.map(c => String(c[0])).join('')).toBe('');
    expect(stderr.mock.calls.map(c => String(c[0])).join('')).toBe('');
  });

  it('honours an already-aborted signal instead of doing the work', async () => {
    const root = await populatedWorkspace();
    for (const read of READS) {
      const error = await read.run({ rootPath: root, signal: AbortSignal.abort() }).catch((e: unknown) => e);
      expect(error, `${read.name} ignored an aborted signal`).toBeInstanceOf(Error);
      expect((error as Error).name, read.name).toBe('AbortError');
    }
  });

  it('needs no LLM provider credentials — each read answers with every provider key unset', async () => {
    const root = await populatedWorkspace();
    for (const key of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'OPENAI_BASE_URL']) {
      vi.stubEnv(key, '');
    }

    const results = await Promise.all(READS.map(read => read.run({ rootPath: root })));

    for (const [i, result] of results.entries()) {
      expect(result, `${READS[i].name} returned nothing`).toBeTypeOf('object');
    }
    // And each answered its own question rather than degrading to a default.
    expect(results[0]).toMatchObject({ runtime: 'available' });
    expect(results[1]).toMatchObject({ matchesWorkingTree: true });
    expect(results[2]).toEqual({ inProgress: false });
    expect((results[3] as { repos: unknown[] }).repos).toHaveLength(1);
  });

  it('writes nothing to the repository — the tree is byte-identical after all four reads', async () => {
    const root = await populatedWorkspace();
    const before = await snapshot(root);

    for (const read of READS) await read.run({ rootPath: root });

    expect(await snapshot(root)).toEqual(before);
  });
});
