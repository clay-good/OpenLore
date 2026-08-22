import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { GenerationLockHeldError, acquireGenerationLock, withGenerationLock } from './generation-lock.js';

describe('withGenerationLock', () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
  });

  async function root(): Promise<string> {
    const value = await mkdtemp(join(tmpdir(), 'openlore-generation-lock-'));
    roots.push(value);
    return value;
  }

  it('serializes the complete mutating callback for the same root', async () => {
    const repository = await root();
    const events: string[] = [];
    let releaseFirst!: () => void;
    const gate = new Promise<void>(resolve => { releaseFirst = resolve; });
    let firstEntered!: () => void;
    const entered = new Promise<void>(resolve => { firstEntered = resolve; });

    const first = withGenerationLock(repository, async () => {
      events.push('first:start');
      firstEntered();
      await gate;
      events.push('first:end');
    });
    await entered;
    const second = withGenerationLock(repository, async () => {
      events.push('second:start');
      events.push('second:end');
    });

    await new Promise(resolve => setTimeout(resolve, 25));
    expect(events).toEqual(['first:start']);
    releaseFirst();
    await Promise.all([first, second]);
    expect(events).toEqual(['first:start', 'first:end', 'second:start', 'second:end']);
  });

  it('allows unrelated roots to generate concurrently', async () => {
    const firstRoot = await root();
    const secondRoot = await root();
    let releaseFirst!: () => void;
    const gate = new Promise<void>(resolve => { releaseFirst = resolve; });
    let firstEntered!: () => void;
    const entered = new Promise<void>(resolve => { firstEntered = resolve; });
    let secondEntered = false;

    const first = withGenerationLock(firstRoot, async () => {
      firstEntered();
      await gate;
    });
    await entered;
    const second = withGenerationLock(secondRoot, async () => { secondEntered = true; });

    await second;
    expect(secondEntered).toBe(true);
    releaseFirst();
    await first;
  });

  it('releases ownership when generation throws', async () => {
    const repository = await root();
    const failure = new Error('pipeline failed');

    await expect(withGenerationLock(repository, async () => { throw failure; })).rejects.toBe(failure);
    await expect(withGenerationLock(repository, async () => 'recovered')).resolves.toBe('recovered');
  });

  it('fails closed with an actionable path after the finite contention bound', async () => {
    const repository = await root();
    const runtime = join(repository, '.openlore', 'runtime');
    await mkdir(runtime, { recursive: true });
    await writeFile(join(runtime, '.generation.lock'), 'malformed owner');

    await expect(acquireGenerationLock(repository, { maxWaitMs: 1 })).rejects.toMatchObject({
      name: GenerationLockHeldError.name,
      lockPath: join(await realpath(repository), '.openlore', 'runtime', '.generation.lock'),
    });
  });

  it('cancels a contended acquisition without leaking successor ownership', async () => {
    const repository = await root();
    const release = await acquireGenerationLock(repository);
    const controller = new AbortController();
    const waiting = acquireGenerationLock(repository, { signal: controller.signal });
    controller.abort(new Error('cancel generation wait'));

    await expect(waiting).rejects.toThrow('cancel generation wait');
    await release();
    const releaseAfter = await acquireGenerationLock(repository, { maxWaitMs: 25 });
    await releaseAfter();
  });

  it('treats symlink aliases as the same repository', async () => {
    const repository = await root();
    const aliasParent = await root();
    const alias = join(aliasParent, 'alias');
    await symlink(repository, alias, 'dir');
    const events: string[] = [];
    let releaseFirst!: () => void;
    const gate = new Promise<void>(resolve => { releaseFirst = resolve; });
    let firstEntered!: () => void;
    const entered = new Promise<void>(resolve => { firstEntered = resolve; });

    const first = withGenerationLock(repository, async () => {
      events.push('first');
      firstEntered();
      await gate;
    });
    await entered;
    const second = withGenerationLock(alias, async () => { events.push('alias'); });

    await new Promise(resolve => setTimeout(resolve, 25));
    expect(events).toEqual(['first']);
    releaseFirst();
    await Promise.all([first, second]);
    expect(events).toEqual(['first', 'alias']);
  });
});
