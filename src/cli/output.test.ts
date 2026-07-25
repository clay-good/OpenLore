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

describe('writeStdout — untrusted control sequences', () => {
  const ESC = String.fromCharCode(27);

  function capture(): { out: string[]; restore: () => void } {
    const out: string[] = [];
    const orig = process.stdout.write.bind(process.stdout);
    (process.stdout as { write: unknown }).write = ((c: string, cb?: (e?: Error) => void) => {
      out.push(String(c));
      if (typeof cb === 'function') cb();
      return true;
    }) as never;
    return { out, restore: () => { (process.stdout as { write: unknown }).write = orig as never; } };
  }

  it('strips escapes that arrived from an analyzed repository', async () => {
    const { out, restore } = capture();
    try {
      await writeStdout(`   query: symbol BEACON::src/zz${ESC}[2K${ESC}[1GFAKE${ESC}[0m.ts\n`);
    } finally { restore(); }
    const written = out.join('');
    expect(written).not.toContain(ESC);
    // The path is still reported — the fix neutralizes, it does not hide.
    expect(written).toContain('BEACON::src/zz');
    expect(written.endsWith('\n')).toBe(true);
  });

  it('preserves the newlines these reports are structured with', async () => {
    const { out, restore } = capture();
    try { await writeStdout('line one\nline two\n'); } finally { restore(); }
    expect(out.join('')).toBe('line one\nline two\n');
  });

  it('is a no-op for JSON, which already escapes control characters', async () => {
    const payload = JSON.stringify({ path: `a${ESC}[2Kb` }) + '\n';
    const { out, restore } = capture();
    try { await writeStdout(payload); } finally { restore(); }
    expect(out.join('')).toBe(payload);
  });
});
