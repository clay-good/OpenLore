import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FIXTURE_FILES, FIXTURE_FUNCTIONS_PER_FILE, writeHookFixture } from './hook-fixture.js';

describe('hook latency fixture', () => {
  const dirs: string[] = [];
  const fresh = () => { const d = mkdtempSync(join(tmpdir(), 'hook-fixture-')); dirs.push(d); return d; };
  afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

  it('has 200 files and 2,000 functions', () => {
    const dir = fresh();
    const files = writeHookFixture(dir);
    expect(files).toHaveLength(FIXTURE_FILES);
    expect(readdirSync(join(dir, 'src'))).toHaveLength(200);
    const functions = files.reduce((n, f) => n + (readFileSync(join(dir, f), 'utf8').match(/^export function /gm)?.length ?? 0), 0);
    expect(functions).toBe(FIXTURE_FILES * FIXTURE_FUNCTIONS_PER_FILE);
    expect(functions).toBe(2_000);
    expect(files.filter(f => f.endsWith('.test.ts'))).toHaveLength(20);
  });

  it('is byte-identical across builds', () => {
    const a = fresh();
    const b = fresh();
    const files = writeHookFixture(a);
    writeHookFixture(b);
    for (const f of files) expect(readFileSync(join(a, f), 'utf8')).toBe(readFileSync(join(b, f), 'utf8'));
  });

  it('every import names an existing source file', () => {
    const dir = fresh();
    const files = new Set(writeHookFixture(dir));
    for (const f of files) {
      const target = /from '\.\/(mod\d+)\.js'/.exec(readFileSync(join(dir, f), 'utf8'))?.[1];
      expect(files.has(`src/${target}.ts`), `${f} imports ${target}`).toBe(true);
    }
  });
});
