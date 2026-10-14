import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawnSync, type spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ONE_SHOT_BUILD_COOLDOWN_MS,
  oneShotBuildNote,
  registerOneShotRepair,
  runBackgroundIndexBuild,
  startDetachedIndexBuild,
} from './one-shot-index-build.js';
import { _resetRepairServiceForTesting, requestRepairFromHost } from './cold-start-bootstrap.js';

const STAMP = join('.openlore', 'runtime', 'auto-build-attempt');

/** A PID that is certain to be dead: a process that has already exited. */
function deadPid(): number {
  return spawnSync(process.execPath, ['-e', ''], { windowsHide: true }).pid;
}

function fakeSpawn(pid: number) {
  const calls: Array<{ args: string[]; options: Record<string, unknown> }> = [];
  const spawnProcess = ((_cmd: string, args: string[], options: Record<string, unknown>) => {
    calls.push({ args, options });
    return { pid, once: () => undefined, unref: () => undefined };
  }) as unknown as typeof spawn;
  return { calls, spawnProcess };
}

describe('one-shot index build', () => {
  let dir: string;

  beforeEach(() => {
    vi.stubEnv('OPENLORE_NO_AUTO_ANALYZE', '');
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'openlore-one-shot-')));
    mkdirSync(join(dir, '.git'));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    _resetRepairServiceForTesting();
    rmSync(dir, { recursive: true, force: true });
  });

  it('starts one detached supervisor and records its PID', () => {
    const { calls, spawnProcess } = fakeSpawn(process.pid);
    expect(startDetachedIndexBuild(dir, 'index-absent', { cliPath: '/cli.js', spawnProcess })).toEqual({ state: 'started' });
    expect(calls).toHaveLength(1);
    expect(calls[0].args).toEqual(['/cli.js', 'orient', '--background-build', '--directory', dir]);
    expect(calls[0].options).toMatchObject({ cwd: dir, detached: true, stdio: 'ignore', windowsHide: true });
    expect(readFileSync(join(dir, STAMP), 'utf8').trim()).toBe(String(process.pid));
  });

  it('asks for a repair build when the index is stale', () => {
    const { calls, spawnProcess } = fakeSpawn(process.pid);
    startDetachedIndexBuild(dir, 'stale-region', { cliPath: '/cli.js', spawnProcess });
    expect(calls[0].args).toContain('--background-repair');
  });

  it('starts no second build while the supervisor is alive, however old the stamp', () => {
    const { calls, spawnProcess } = fakeSpawn(process.pid);
    const opts = { cliPath: '/cli.js', spawnProcess };
    startDetachedIndexBuild(dir, 'index-absent', opts);
    utimesSync(join(dir, STAMP), new Date(0), new Date(0));
    expect(startDetachedIndexBuild(dir, 'index-absent', opts)).toEqual({ state: 'running' });
    expect(calls).toHaveLength(1);
  });

  it('does not restart a finished attempt inside the cooldown, and does after it', () => {
    const { calls, spawnProcess } = fakeSpawn(deadPid());
    const opts = { cliPath: '/cli.js', spawnProcess };
    startDetachedIndexBuild(dir, 'index-absent', opts);
    expect(startDetachedIndexBuild(dir, 'index-absent', opts)).toEqual({ state: 'recently-attempted' });
    expect(calls).toHaveLength(1);
    const later = () => Date.now() + ONE_SHOT_BUILD_COOLDOWN_MS + 1;
    expect(startDetachedIndexBuild(dir, 'index-absent', { ...opts, now: later })).toEqual({ state: 'started' });
    expect(calls).toHaveLength(2);
  });

  it('reports a live analysis owner as running', () => {
    mkdirSync(join(dir, '.openlore', 'runtime'), { recursive: true });
    writeFileSync(
      join(dir, '.openlore', 'runtime', '.analysis-owner.lock'),
      JSON.stringify({ repository: dir, pid: process.pid, startedAt: new Date().toISOString() }),
    );
    const { calls, spawnProcess } = fakeSpawn(process.pid);
    expect(startDetachedIndexBuild(dir, 'index-absent', { cliPath: '/cli.js', spawnProcess })).toEqual({ state: 'running' });
    expect(calls).toHaveLength(0);
  });

  it('leaves an opted-out repository untouched', () => {
    const { calls, spawnProcess } = fakeSpawn(process.pid);
    const opts = { cliPath: '/cli.js', spawnProcess };
    vi.stubEnv('OPENLORE_NO_AUTO_ANALYZE', '1');
    expect(startDetachedIndexBuild(dir, 'index-absent', opts).state).toBe('suppressed');
    expect(existsSync(join(dir, '.openlore'))).toBe(false);

    vi.stubEnv('OPENLORE_NO_AUTO_ANALYZE', '');
    mkdirSync(join(dir, '.openlore'));
    writeFileSync(join(dir, '.openlore', 'config.json'), JSON.stringify({ autoInit: false }));
    const build = startDetachedIndexBuild(dir, 'stale-region', opts);
    expect(build.state).toBe('suppressed');
    expect(oneShotBuildNote(build)).toContain('openlore analyze');
    expect(calls).toHaveLength(0);
  });

  it('first-builds only inside a git work tree, but repairs an existing index anywhere', () => {
    rmSync(join(dir, '.git'), { recursive: true });
    const { calls, spawnProcess } = fakeSpawn(process.pid);
    const opts = { cliPath: '/cli.js', spawnProcess };
    expect(startDetachedIndexBuild(dir, 'index-absent', opts).state).toBe('suppressed');
    expect(calls).toHaveLength(0);
    expect(startDetachedIndexBuild(dir, 'stale-region', opts).state).toBe('started');
  });

  it('accepts a stale-file repair request only when a build is in flight', () => {
    const { calls, spawnProcess } = fakeSpawn(deadPid());
    registerOneShotRepair(dir, { cliPath: '/cli.js', spawnProcess });
    expect(requestRepairFromHost(dir, ['src/a.ts'])).toBe(true);
    // The attempt has finished and is inside the cooldown: nothing is scheduled.
    expect(requestRepairFromHost(dir, ['src/a.ts'])).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it('supervisor runs the build and never throws', async () => {
    const build = vi.fn(async () => { throw new Error('boom'); });
    await expect(runBackgroundIndexBuild(dir, { repair: true, build })).resolves.toBeUndefined();
    expect(build).toHaveBeenCalledWith(dir, { repair: true, mode: 'full' });
  });

  it('discloses the first build with both opt-outs', () => {
    const note = oneShotBuildNote({ state: 'started' });
    expect(note).toContain('did not block');
    expect(note).toContain('autoInit');
    expect(note).toContain('OPENLORE_NO_AUTO_ANALYZE');
  });
});
