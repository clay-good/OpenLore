import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildProgressPath, formatBuildProgress, openBuildProgress, readBuildProgress, reportBuildPhase, reportFileDone,
} from './build-progress.js';

const dirs: string[] = [];
const fresh = () => { const d = mkdtempSync(join(tmpdir(), 'olbuildprogress-')); mkdirSync(join(d, '.openlore')); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe('build progress', () => {
  it('records the phase and the files parsed, and removes the record when the build ends', () => {
    const root = fresh();
    const close = openBuildProgress(root);
    expect(readBuildProgress(root)).toMatchObject({ phase: 'scanning', pid: process.pid });
    reportBuildPhase('parsing', 2_900);
    for (let i = 0; i < 1_310; i++) reportFileDone();
    reportBuildPhase('parsing', 2_900); // a phase write is immediate; reset, then count again
    for (let i = 0; i < 1_310; i++) reportFileDone();
    // File ticks are throttled to one write a second; a phase change writes at once.
    reportBuildPhase('linking');
    expect(readBuildProgress(root)).toMatchObject({ phase: 'linking', filesDone: 1_310, filesTotal: 2_900 });
    close();
    expect(existsSync(buildProgressPath(root))).toBe(false);
    expect(readBuildProgress(root)).toBeUndefined();
  });

  it('is a no-op with no sink open, and never throws', () => {
    expect(() => { reportBuildPhase('parsing', 3); reportFileDone(); }).not.toThrow();
  });

  it('formats the scenario numbers exactly, with thousands separators, then the phase name', () => {
    const base = { startedAt: '', updatedAt: '', pid: 1 };
    expect(formatBuildProgress({ ...base, phase: 'parsing', filesDone: 1_310, filesTotal: 2_900 })).toBe('indexing 45% (1,310/2,900 files)');
    expect(formatBuildProgress({ ...base, phase: 'writing the index', filesDone: 2_900, filesTotal: 2_900 })).toBe('indexing: writing the index');
  });

  it('reads a record whose pid is gone, or that is 2 minutes old, as not building', () => {
    const root = fresh();
    const dead = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
    const deadPid = Number(dead.stdout);
    const now = Date.now();
    const write = (pid: number, updatedAt: number) => writeFileSync(buildProgressPath(root), JSON.stringify({ phase: 'parsing', filesDone: 1, filesTotal: 2, startedAt: new Date(now).toISOString(), updatedAt: new Date(updatedAt).toISOString(), pid }));
    write(deadPid, now);
    expect(readBuildProgress(root, now)).toBeUndefined();
    write(process.pid, now - 3 * 60 * 1000);
    expect(readBuildProgress(root, now)).toBeUndefined();
    write(process.pid, now - 10_000);
    expect(readBuildProgress(root, now)).toMatchObject({ phase: 'parsing', filesDone: 1, filesTotal: 2 });
    writeFileSync(buildProgressPath(root), '{"phase": ');
    expect(readBuildProgress(root, now)).toBeUndefined();
  });

  it('writes nothing into a repository without .openlore/', () => {
    const root = mkdtempSync(join(tmpdir(), 'olbuildprogress-none-'));
    dirs.push(root);
    const close = openBuildProgress(root);
    reportBuildPhase('parsing', 1);
    close();
    expect(existsSync(join(root, '.openlore'))).toBe(false);
  });

  it('a real record is one JSON object (no partial write is ever visible)', () => {
    const root = fresh();
    const close = openBuildProgress(root);
    reportBuildPhase('parsing', 5);
    const text = readFileSync(buildProgressPath(root), 'utf8');
    expect(() => JSON.parse(text)).not.toThrow();
    close();
  });
});

describe('the Pass-1 progress listener (only openlore analyze sets one)', () => {
  it('hears start, one tick per file, and end; with none set, extraction reports nothing', async () => {
    const { extractFilesForPass1, setPass1ProgressListener } = await import('../analyzer/extraction-pool.js');
    const files = ['a.ts', 'b.ts', 'c.ts'].map(path => ({ path, content: '', language: 'TypeScript' })) as never[];
    const heard: string[] = [];
    setPass1ProgressListener({ start: n => heard.push(`start ${n}`), fileDone: () => heard.push('done'), end: () => heard.push('end') });
    try {
      await extractFilesForPass1(files, async () => 'x', () => false, { poolSize: 0 });
    } finally {
      setPass1ProgressListener(undefined);
    }
    expect(heard).toEqual(['start 3', 'start 3', 'done', 'done', 'done', 'end']);
    heard.length = 0;
    await extractFilesForPass1(files, async () => 'x', () => false, { poolSize: 0 });
    expect(heard).toEqual([]);
  });
});
