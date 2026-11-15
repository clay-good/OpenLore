import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  HOOK_MOMENTS, LOOP_MOMENTS, deliveredPath, findingIdentity, markShown, readSession, wasShown, writeSession,
  type SessionRecord,
} from './hook-session.js';

const dirs: string[] = [];
const fresh = () => { const d = mkdtempSync(join(tmpdir(), 'olhooksession-')); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const HEAD = 'a'.repeat(40);
const rec = (keys: string[], startHead?: string): SessionRecord => ({ keys: new Set(keys), findings: {}, ...(startHead ? { startHead } : {}) });

describe('hook session record', () => {
  it('lists the prompt-submitted moment first, then every hook moment', () => {
    expect(LOOP_MOMENTS).toEqual(['prompt-submitted', ...HOOK_MOMENTS]);
  });

  it('round-trips the delivered keys and the start commit', async () => {
    const root = fresh();
    await writeSession(root, 's1', rec(['a', 'b'], HEAD));
    expect(readSession(root, 's1')).toEqual(rec(['a', 'b'], HEAD));
  });

  it('merges with what a parallel hook of the same session wrote, and keeps the first start commit', async () => {
    const root = fresh();
    await writeSession(root, 's1', rec(['a'], HEAD));
    await writeSession(root, 's1', rec(['b'], 'b'.repeat(40)));
    expect(readSession(root, 's1')).toEqual(rec(['a', 'b'], HEAD));
  });

  it('without a session id, reads nothing and writes nothing', async () => {
    const root = fresh();
    await writeSession(root, undefined, rec(['a']));
    expect(existsSync(join(root, '.openlore'))).toBe(false);
    expect(readSession(root, undefined)).toEqual(rec([]));
  });

  it('reads an older array-shaped record, and fails open on a corrupt one', () => {
    const root = fresh();
    mkdirSync(dirname(deliveredPath(root, 'old')), { recursive: true });
    writeFileSync(deliveredPath(root, 'old'), JSON.stringify(['k1', 7, 'k2']));
    expect(readSession(root, 'old')).toEqual(rec(['k1', 'k2']));
    writeFileSync(deliveredPath(root, 'bad'), '{"keys": [');
    expect(readSession(root, 'bad')).toEqual(rec([]));
    writeFileSync(deliveredPath(root, 'head'), JSON.stringify({ keys: [], startHead: 'not-a-sha' }));
    expect(readSession(root, 'head')).toEqual(rec([]));
  });

  it('reads a record written by the current release (keys and start commit, no findings)', () => {
    const root = fresh();
    mkdirSync(dirname(deliveredPath(root, 's')), { recursive: true });
    writeFileSync(deliveredPath(root, 's'), JSON.stringify({ startHead: HEAD, keys: ['generated:gen/a.go'] }));
    expect(readSession(root, 's')).toEqual(rec(['generated:gen/a.go'], HEAD));
  });

  it('removes records untouched for a week when it writes', async () => {
    const root = fresh();
    await writeSession(root, 'old', rec(['x']));
    const weekAgo = (Date.now() - 8 * 24 * 3600 * 1000) / 1000;
    utimesSync(deliveredPath(root, 'old'), weekAgo, weekAgo);
    await writeSession(root, 'new', rec(['y']));
    expect(existsSync(deliveredPath(root, 'old'))).toBe(false);
    expect(JSON.parse(readFileSync(deliveredPath(root, 'new'), 'utf8')).keys).toEqual(['y']);
  });
});

describe('finding identity (design section 3)', () => {
  const unresolved = (lineText: string) => findingIdentity('unresolved-internal-import', './missing', { path: 'src/a.ts', lineText });

  it('is code + subject + proof; its id is the first 8 hex characters', () => {
    const { identity, id } = unresolved("import { x } from './missing';");
    expect(identity).toMatch(/^[0-9a-f]{64}$/);
    expect(id).toBe(identity.slice(0, 8));
    expect(findingIdentity('other-code', './missing', { path: 'src/a.ts', lineText: "import { x } from './missing';" }).identity).not.toBe(identity);
  });

  it('a line shift keeps the identity: the line number is not part of it, and whitespace is normalized', () => {
    expect(unresolved("import { x } from './missing';").identity).toBe(unresolved("  import {  x }  from './missing';  ").identity);
  });

  it('a changed cited line is a new identity', () => {
    expect(unresolved("import { x } from './missing';").identity).not.toBe(unresolved("import { x, y } from './missing';").identity);
  });

  it('without a cited line, the discriminator is the proof', () => {
    const a = findingIdentity('test-disabled', 'src/f.test.ts', { path: 'src/f.test.ts', discriminator: 'b' });
    expect(findingIdentity('test-disabled', 'src/f.test.ts', { path: 'src/f.test.ts', discriminator: 'b' }).identity).toBe(a.identity);
    expect(findingIdentity('test-disabled', 'src/f.test.ts', { path: 'src/f.test.ts', discriminator: 'c' }).identity).not.toBe(a.identity);
  });
});

describe('shown findings in the session record', () => {
  const f = { code: 'test-disabled', subject: 'src/f.test.ts' };
  const id = findingIdentity(f.code, f.subject).identity;

  it('is shown once per audience, and the record round-trips', async () => {
    const root = fresh();
    const r = rec([]);
    expect(wasShown(r, id, 'agent')).toBe(false);
    markShown(r, id, f, 'after-tools', 'agent');
    expect(wasShown(r, id, 'agent')).toBe(true);
    expect(wasShown(r, id, 'user')).toBe(false);
    await writeSession(root, 's1', r);
    const back = readSession(root, 's1');
    expect(wasShown(back, id, 'agent')).toBe(true);
    expect(back.findings[id]).toMatchObject({ code: 'test-disabled', subject: 'src/f.test.ts', moment: 'after-tools', audiences: ['agent'] });
  });

  it('merges the audiences parallel hooks recorded', async () => {
    const root = fresh();
    const a = rec([]);
    markShown(a, id, f, 'after-tools', 'agent');
    await writeSession(root, 's1', a);
    const b = rec([]);
    markShown(b, id, f, 'before-stop', 'user');
    await writeSession(root, 's1', b);
    expect(readSession(root, 's1').findings[id].audiences.sort()).toEqual(['agent', 'user']);
  });

  it('a new session starts clean', async () => {
    const root = fresh();
    const r = rec([]);
    markShown(r, id, f, 'after-tools', 'agent');
    await writeSession(root, 's1', r);
    expect(wasShown(readSession(root, 's2'), id, 'agent')).toBe(false);
  });

  it('drops malformed finding entries instead of failing', () => {
    const root = fresh();
    mkdirSync(dirname(deliveredPath(root, 's')), { recursive: true });
    writeFileSync(deliveredPath(root, 's'), JSON.stringify({ keys: [], findings: { nothex: {}, [id]: { code: 1 }, ['b'.repeat(64)]: { code: 'c', subject: 's', audiences: ['agent', 'bot'] } } }));
    expect(Object.keys(readSession(root, 's').findings)).toEqual(['b'.repeat(64)]);
    expect(readSession(root, 's').findings['b'.repeat(64)].audiences).toEqual(['agent']);
  });
});
