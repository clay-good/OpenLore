import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { HOOK_MOMENTS, LOOP_MOMENTS, deliveredPath, readSession, writeSession } from './hook-session.js';

const dirs: string[] = [];
const fresh = () => { const d = mkdtempSync(join(tmpdir(), 'olhooksession-')); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const HEAD = 'a'.repeat(40);

describe('hook session record', () => {
  it('lists the prompt-submitted moment first, then every hook moment', () => {
    expect(LOOP_MOMENTS).toEqual(['prompt-submitted', ...HOOK_MOMENTS]);
  });

  it('round-trips the delivered keys and the start commit', async () => {
    const root = fresh();
    await writeSession(root, 's1', { keys: new Set(['a', 'b']), startHead: HEAD });
    expect(readSession(root, 's1')).toEqual({ keys: new Set(['a', 'b']), startHead: HEAD });
  });

  it('merges with what a parallel hook of the same session wrote, and keeps the first start commit', async () => {
    const root = fresh();
    await writeSession(root, 's1', { keys: new Set(['a']), startHead: HEAD });
    await writeSession(root, 's1', { keys: new Set(['b']), startHead: 'b'.repeat(40) });
    expect(readSession(root, 's1')).toEqual({ keys: new Set(['a', 'b']), startHead: HEAD });
  });

  it('without a session id, reads nothing and writes nothing', async () => {
    const root = fresh();
    await writeSession(root, undefined, { keys: new Set(['a']) });
    expect(existsSync(join(root, '.openlore'))).toBe(false);
    expect(readSession(root, undefined)).toEqual({ keys: new Set() });
  });

  it('reads an older array-shaped record, and fails open on a corrupt one', () => {
    const root = fresh();
    mkdirSync(dirname(deliveredPath(root, 'old')), { recursive: true });
    writeFileSync(deliveredPath(root, 'old'), JSON.stringify(['k1', 7, 'k2']));
    expect(readSession(root, 'old')).toEqual({ keys: new Set(['k1', 'k2']) });
    writeFileSync(deliveredPath(root, 'bad'), '{"keys": [');
    expect(readSession(root, 'bad')).toEqual({ keys: new Set() });
    writeFileSync(deliveredPath(root, 'head'), JSON.stringify({ keys: [], startHead: 'not-a-sha' }));
    expect(readSession(root, 'head')).toEqual({ keys: new Set() });
  });

  it('removes records untouched for a week when it writes', async () => {
    const root = fresh();
    await writeSession(root, 'old', { keys: new Set(['x']) });
    const weekAgo = (Date.now() - 8 * 24 * 3600 * 1000) / 1000;
    utimesSync(deliveredPath(root, 'old'), weekAgo, weekAgo);
    await writeSession(root, 'new', { keys: new Set(['y']) });
    expect(existsSync(deliveredPath(root, 'old'))).toBe(false);
    expect(JSON.parse(readFileSync(deliveredPath(root, 'new'), 'utf8')).keys).toEqual(['y']);
  });
});
