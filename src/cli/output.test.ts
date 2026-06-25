/**
 * Regression: a CLI that writes a large payload to a PIPE and then process.exit()s
 * truncated the output at the ~64KB pipe buffer because process.stdout.write is async
 * on a pipe. writeStdout must resolve ONLY after the write has been flushed (the write
 * callback fired), so callers can await it before exiting and never truncate.
 *
 * The mechanism is also exercised end-to-end with a real child process + real pipe,
 * which would fail against the old `process.stdout.write(big); process.exit()` pattern.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { writeStdout } from './output.js';

afterEach(() => vi.restoreAllMocks());

describe('writeStdout', () => {
  it('resolves only after the write callback fires (flush), not synchronously', async () => {
    let captured: ((err?: Error) => void) | undefined;
    vi.spyOn(process.stdout, 'write').mockImplementation(
      // capture the drain callback instead of firing it immediately
      ((_chunk: unknown, cb?: (err?: Error) => void) => { captured = cb; return false; }) as typeof process.stdout.write,
    );
    let resolved = false;
    const p = writeStdout('payload').then(() => { resolved = true; });
    await Promise.resolve(); // let any synchronous resolution happen
    expect(resolved).toBe(false); // must NOT resolve before the flush callback
    captured?.(); // simulate the OS flushing the buffer
    await p;
    expect(resolved).toBe(true);
  });

  it('delivers a >64KB payload through a real pipe before exit (no truncation)', async () => {
    // A child that uses writeStdout then exits — over a pipe, the full payload must
    // arrive. With the old write-then-exit pattern this truncates at ~64KB.
    const N = 300_000;
    const script = [
      'const w=(t)=>new Promise((res,rej)=>process.stdout.write(t,(e)=>e?rej(e):res()));',
      `(async()=>{ await w('x'.repeat(${N})); process.exit(0); })();`,
    ].join('\n');
    const out = await new Promise<string>((resolve, reject) => {
      const child = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'inherit'] });
      let buf = '';
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (c) => { buf += c; });
      child.on('error', reject);
      child.on('close', () => resolve(buf));
    });
    expect(out.length).toBe(N); // full payload, not truncated at the 64KB pipe buffer
  });
});
