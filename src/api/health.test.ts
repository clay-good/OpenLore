/**
 * `openloreHealth` — readiness as a value (change: extend-api-for-supervising-hosts).
 *
 * The property under test is that disk is the BASE CASE: a whole index with nothing running is
 * ready, and a live process over an unbuilt index is not.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile, readFile, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { openloreHealth } from './health.js';
import { openloreServe } from './serve.js';
import { OPENLORE_ANALYSIS_REL_PATH } from '../constants.js';
import { publishGeneration, REQUIRED_ANALYSIS_ARTIFACTS } from '../core/runtime/analysis-generation.js';
import { createServer } from 'node:http';
import type { ServeHandle } from '../cli/commands/serve.js';

const dirs: string[] = [];
const open: ServeHandle[] = [];

afterEach(async () => {
  for (const handle of open.splice(0)) await handle.close().catch(() => {});
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

async function workspace(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'openlore-health-'));
  dirs.push(dir);
  return dir;
}

/** Write a complete, parseable set of required analysis artifacts. */
async function withIndex(root: string): Promise<string> {
  const analysisDir = join(root, OPENLORE_ANALYSIS_REL_PATH);
  await mkdir(analysisDir, { recursive: true });
  for (const artifact of REQUIRED_ANALYSIS_ARTIFACTS) {
    await writeFile(join(analysisDir, artifact), JSON.stringify({ artifact }));
  }
  return analysisDir;
}

/** Every file under `root` with its content, for a no-write assertion. */
async function snapshot(root: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir)) {
      const full = join(dir, entry);
      if ((await stat(full)).isDirectory()) await walk(full);
      else out.set(relative(root, full), await readFile(full, 'utf-8').catch(() => '<binary>'));
    }
  };
  await walk(root);
  return out;
}

describe('openloreHealth', () => {
  it('reports ready from disk alone, with no daemon and no outbound request', async () => {
    const root = await workspace();
    await withIndex(root);

    const outbound = vi.spyOn(globalThis, 'fetch');
    const health = await openloreHealth({ rootPath: root });

    expect(health.runtime).toBe('available');
    expect(health.index).toBe('ready');
    expect(health.watcher).toBe('unknown'); // no daemon: unobservable, not "stopped"
    expect(health.repairInProgress).toBe(false);
    expect(health.reason).toBeUndefined();
    // No descriptor is announced, so nothing is probed at all.
    expect(outbound).not.toHaveBeenCalled();
  });

  it('reports degraded and names each artifact and why', async () => {
    const root = await workspace();
    const analysisDir = await withIndex(root);
    await rm(join(analysisDir, 'dependency-graph.json'));
    await writeFile(join(analysisDir, 'llm-context.json'), '{ this is not json');

    const health = await openloreHealth({ rootPath: root });

    expect(health.index).toBe('degraded');
    expect(health.indexDegradations).toEqual(
      expect.arrayContaining([
        { artifact: 'dependency-graph.json', reason: 'missing' },
        { artifact: 'llm-context.json', reason: 'corrupt' },
      ]),
    );
    expect(health.reason).toContain('dependency-graph.json (missing)');
    expect(health.reason).toContain('llm-context.json (corrupt)');
    // A caller switches on the code; the string is for a human.
    expect(health.reasonCode).toBe('degraded-index');
  });

  it('refuses to call a mixed generation ready', async () => {
    const root = await workspace();
    const analysisDir = await withIndex(root);
    await publishGeneration(analysisDir, [...REQUIRED_ANALYSIS_ARTIFACTS]);
    // A full analyze rewrites artifacts in place and republishes its manifest LAST, so this is the
    // state a reader sees mid-rebuild: the committed manifest no longer describes the bytes.
    await writeFile(join(analysisDir, 'llm-context.json'), JSON.stringify({ artifact: 'rewritten' }));

    const health = await openloreHealth({ rootPath: root });

    expect(health.index).toBe('building');
    expect(health.reasonCode).toBe('analysis-changed');
    expect(health.reason).toContain('Retry');
  });

  it('never follows a redirect from the announced daemon', async () => {
    const root = await workspace();
    await withIndex(root);
    let leaked = 0;
    const attacker = createServer((_req, res) => { leaked += 1; res.writeHead(204).end(); });
    await new Promise<void>((resolve) => attacker.listen(0, '127.0.0.1', resolve));
    const attackerAddress = attacker.address();
    if (!attackerAddress || typeof attackerAddress === 'string') throw new Error('attacker did not bind');
    const redirector = createServer((_req, res) => {
      res.writeHead(302, { location: `http://127.0.0.1:${attackerAddress.port}/health` }).end();
    });
    await new Promise<void>((resolve) => redirector.listen(0, '127.0.0.1', resolve));
    const redirectorAddress = redirector.address();
    if (!redirectorAddress || typeof redirectorAddress === 'string') throw new Error('redirector did not bind');

    try {
      await mkdir(join(root, '.openlore'), { recursive: true });
      await writeFile(join(root, '.openlore', 'serve.json'), JSON.stringify({
        port: redirectorAddress.port, pid: process.pid, host: '127.0.0.1',
        token: 'daemon-secret', protocolVersion: 1, startedAt: '', version: 'test',
      }));

      const health = await openloreHealth({ rootPath: root });

      // The probe failed closed, and the token was never forwarded to the redirect target.
      expect(health.watcher).toBe('unknown');
      expect(health.index).toBe('ready');
      expect(leaked).toBe(0);
    } finally {
      redirector.closeAllConnections();
      attacker.closeAllConnections();
      await new Promise<void>((resolve) => redirector.close(() => resolve()));
      await new Promise<void>((resolve) => attacker.close(() => resolve()));
    }
  });

  it('a live daemon over an unbuilt index is absent, not ready', async () => {
    const root = await workspace();
    const handle = await openloreServe({ rootPath: root, port: 0, watch: false, idleTimeoutMs: 0 });
    open.push(handle);

    const health = await openloreHealth({ rootPath: root });

    // A process answered. That is not readiness.
    expect((await fetch(`${handle.baseUrl}/health`)).status).toBe(200);
    expect(health.index).toBe('absent');
    expect(health.reasonCode).toBe('no-index');
    expect(health.runtime).toBe('available');
  });

  it('refines watcher state from a discoverable daemon', async () => {
    const root = await workspace();
    await withIndex(root);
    const handle = await openloreServe({ rootPath: root, port: 0, watch: false, idleTimeoutMs: 0 });
    open.push(handle);

    const health = await openloreHealth({ rootPath: root });
    expect(health.index).toBe('ready');
    expect(health.watcher).toBe('stopped'); // started --no-watch, and the daemon says so
  });

  it('writes nothing to the repository', async () => {
    const root = await workspace();
    await withIndex(root);
    const before = await snapshot(root);

    await openloreHealth({ rootPath: root });

    const after = await snapshot(root);
    expect([...after.keys()].sort()).toEqual([...before.keys()].sort());
    for (const [path, content] of before) expect(after.get(path)).toBe(content);
  });
});
