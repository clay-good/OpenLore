/**
 * Integration tests for footprint escape detection over a real temp git repo
 * (add-footprint-escape-detection, proposal 3). These exercise the full path:
 * `structural_diff` computes the actually-modified symbols (including body-only
 * changes via the line-subsequence edit-nature check) and runs the escape analysis.
 * The pure algorithm itself is unit-tested in footprint-escape.test.ts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

vi.mock('./utils.js', async (orig) => {
  const actual = await orig() as Record<string, unknown>;
  return { ...actual, validateDirectory: vi.fn(async (d: string) => d), readCachedContext: vi.fn() };
});

import { handleStructuralDiff } from './structural-diff.js';

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' } });
}
function write(cwd: string, rel: string, content: string): void {
  const p = join(cwd, rel); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, content);
}

// Base: a dispatcher with two cases + a helper. The head variants exercise the
// pure-addition (a new case) vs modifies-existing (a changed line) edit natures.
const BASE = `export function dispatch(name: string): number {
  if (name === 'a') return 1;
  if (name === 'b') return 2;
  return 0;
}
export function helper(x: number): number {
  return x + 1;
}
`;
// dispatch gains a case 'c' — every base line preserved in order → pure-addition.
const HEAD_APPEND = `export function dispatch(name: string): number {
  if (name === 'a') return 1;
  if (name === 'b') return 2;
  if (name === 'c') return 3;
  return 0;
}
export function helper(x: number): number {
  return x + 1;
}
`;
// dispatch's existing 'a' branch is rewritten → modifies-existing.
const HEAD_MODIFY = `export function dispatch(name: string): number {
  if (name === 'a') return 99;
  if (name === 'b') return 2;
  return 0;
}
export function helper(x: number): number {
  return x + 1;
}
`;

interface EscapeResult {
  escapeAnalysis?: {
    declaredTaskId: string;
    summary: Record<string, number>;
    escapes: Array<{ id: string; classification: string; editNature: string }>;
    newlyOpenedConflicts: Array<{ symbol: string; peerTaskId: string; verdict: string }>;
    registryResolutions: Array<{ symbol: string; peerTaskId: string }>;
    misDeclaredAppends: Array<{ symbol: string }>;
    findings: Array<{ code: string; enforcementClass: string }>;
    gated: boolean;
    disclosure: string;
  };
}

describe('structural_diff footprint escape detection', () => {
  let repo: string;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'escape-'));
    git(repo, ['init', '-q', '-b', 'main']);
    git(repo, ['config', 'user.name', 'T']); git(repo, ['config', 'user.email', 't@e.com']);
    git(repo, ['config', 'commit.gpgsign', 'false']);
    write(repo, 'src/core.ts', BASE);
    git(repo, ['add', '.']); git(repo, ['commit', '-q', '-m', 'base', '--no-gpg-sign']);
  });
  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  it('a diff within its declared write-set reports an empty escape set', async () => {
    write(repo, 'src/core.ts', HEAD_APPEND);
    const r = await handleStructuralDiff({
      directory: repo, baseRef: 'HEAD',
      declaredFootprint: { taskId: 't1', writeSet: [{ id: 'src/core.ts::dispatch', filePath: 'src/core.ts', writeMode: 'append' }] },
    }) as EscapeResult;
    expect(r.escapeAnalysis).toBeDefined();
    expect(r.escapeAnalysis!.escapes).toEqual([]);
    expect(r.escapeAnalysis!.summary.escapes).toBe(0);
  });

  it('an out-of-scope write is flagged out-of-scope', async () => {
    write(repo, 'src/core.ts', HEAD_APPEND);
    const r = await handleStructuralDiff({
      directory: repo, baseRef: 'HEAD',
      declaredFootprint: { taskId: 't1', writeSet: [{ id: 'src/elsewhere.ts::x', filePath: 'src/elsewhere.ts' }] },
    }) as EscapeResult;
    const esc = r.escapeAnalysis!.escapes.find(e => e.id === 'src/core.ts::dispatch');
    expect(esc).toMatchObject({ classification: 'out-of-scope-write', editNature: 'pure-addition' });
  });

  it('modifying a read-set-only symbol is a read-set intrusion', async () => {
    write(repo, 'src/core.ts', HEAD_MODIFY);
    const r = await handleStructuralDiff({
      directory: repo, baseRef: 'HEAD',
      declaredFootprint: {
        taskId: 't1',
        writeSet: [{ id: 'src/elsewhere.ts::x', filePath: 'src/elsewhere.ts' }],
        readSet: ['src/core.ts::dispatch'],
      },
    }) as EscapeResult;
    const esc = r.escapeAnalysis!.escapes.find(e => e.id === 'src/core.ts::dispatch');
    expect(esc).toMatchObject({ classification: 'read-set-intrusion', editNature: 'modifies-existing' });
  });

  it('an out-of-scope write that lands in a peer write-set opens a new WAW naming the peer', async () => {
    write(repo, 'src/core.ts', HEAD_MODIFY);
    const r = await handleStructuralDiff({
      directory: repo, baseRef: 'HEAD',
      declaredFootprint: { taskId: 't1', writeSet: [{ id: 'src/elsewhere.ts::x', filePath: 'src/elsewhere.ts' }] },
      peerFootprints: [{ taskId: 't2', writeSet: [{ id: 'src/core.ts::dispatch', filePath: 'src/core.ts', writeMode: 'modify' }] }],
    }) as EscapeResult;
    expect(r.escapeAnalysis!.newlyOpenedConflicts).toEqual([
      expect.objectContaining({ symbol: 'src/core.ts::dispatch', peerTaskId: 't2', verdict: 'WAW' }),
    ]);
    expect(r.escapeAnalysis!.findings.some(f => f.code === 'footprint-escape-new-conflict')).toBe(true);
  });

  it('two disjoint additions to the same registry symbol resolve by merge, not a conflict', async () => {
    write(repo, 'src/core.ts', HEAD_APPEND); // our side: a pure addition to dispatch
    const r = await handleStructuralDiff({
      directory: repo, baseRef: 'HEAD',
      declaredFootprint: { taskId: 't1', writeSet: [{ id: 'src/core.ts::dispatch', filePath: 'src/core.ts', writeMode: 'append' }] },
      peerFootprints: [{ taskId: 't2', writeSet: [{ id: 'src/core.ts::dispatch', filePath: 'src/core.ts', writeMode: 'append' }] }],
    }) as EscapeResult;
    expect(r.escapeAnalysis!.registryResolutions).toEqual([
      expect.objectContaining({ symbol: 'src/core.ts::dispatch', peerTaskId: 't2' }),
    ]);
    expect(r.escapeAnalysis!.newlyOpenedConflicts).toEqual([]);
  });

  it('a declared-append seed that actually modified existing code is flagged + a real WAW', async () => {
    write(repo, 'src/core.ts', HEAD_MODIFY); // declared append, but we rewrote an existing branch
    const r = await handleStructuralDiff({
      directory: repo, baseRef: 'HEAD',
      declaredFootprint: { taskId: 't1', writeSet: [{ id: 'src/core.ts::dispatch', filePath: 'src/core.ts', writeMode: 'append' }] },
      peerFootprints: [{ taskId: 't2', writeSet: [{ id: 'src/core.ts::dispatch', filePath: 'src/core.ts', writeMode: 'append' }] }],
    }) as EscapeResult;
    expect(r.escapeAnalysis!.misDeclaredAppends).toEqual([
      expect.objectContaining({ symbol: 'src/core.ts::dispatch' }),
    ]);
    // dispatch is in t1's own write-set, so it is NOT an escape; but it still collides
    // with the peer, and because we modified existing code it is a real WAW... however
    // the conflict is only "newly opened" for symbols outside our own declared set, so
    // here it is reported via the mis-declared-append signal rather than newlyOpened.
    expect(r.escapeAnalysis!.registryResolutions).toEqual([]);
    expect(r.escapeAnalysis!.findings.some(f => f.code === 'mis-declared-append')).toBe(true);
  });

  it('with no declared footprint the output is byte-identical (no escapeAnalysis key) and additive', async () => {
    write(repo, 'src/core.ts', HEAD_APPEND);
    const without = await handleStructuralDiff({ directory: repo, baseRef: 'HEAD' }) as EscapeResult & Record<string, unknown>;
    expect('escapeAnalysis' in without).toBe(false);

    const withFp = await handleStructuralDiff({
      directory: repo, baseRef: 'HEAD',
      declaredFootprint: { taskId: 't1', writeSet: [{ id: 'src/core.ts::dispatch', filePath: 'src/core.ts', writeMode: 'append' }] },
    }) as EscapeResult & Record<string, unknown>;
    // The extension is purely additive: drop escapeAnalysis and the rest is identical.
    const { escapeAnalysis, ...rest } = withFp;
    expect(escapeAnalysis).toBeDefined();
    expect(rest).toEqual(without);
  });

  it('findings are advisory by default (nothing gated without an enforcement policy)', async () => {
    write(repo, 'src/core.ts', HEAD_MODIFY);
    const r = await handleStructuralDiff({
      directory: repo, baseRef: 'HEAD',
      declaredFootprint: { taskId: 't1', writeSet: [{ id: 'src/elsewhere.ts::x', filePath: 'src/elsewhere.ts' }] },
    }) as EscapeResult;
    expect(r.escapeAnalysis!.gated).toBe(false);
    expect(r.escapeAnalysis!.findings.every(f => f.enforcementClass === 'advisory')).toBe(true);
    expect(r.escapeAnalysis!.disclosure).toMatch(/semantic/i);
  });

  it('is deterministic: the same diff + footprints yields a byte-identical escapeAnalysis', async () => {
    write(repo, 'src/core.ts', HEAD_MODIFY);
    const call = () => handleStructuralDiff({
      directory: repo, baseRef: 'HEAD',
      declaredFootprint: { taskId: 't1', writeSet: [{ id: 'src/elsewhere.ts::x', filePath: 'src/elsewhere.ts' }] },
      peerFootprints: [{ taskId: 't2', writeSet: [{ id: 'src/core.ts::dispatch', filePath: 'src/core.ts', writeMode: 'modify' }] }],
    }) as Promise<EscapeResult>;
    const a = await call(); const b = await call();
    expect(JSON.stringify(a.escapeAnalysis)).toBe(JSON.stringify(b.escapeAnalysis));
  });
});

// ── Adversarial regression set (PR #201 audit) ──────────────────────────────────
describe('structural_diff escape detection — adversarial regressions', () => {
  let repo: string;
  const init = () => {
    repo = mkdtempSync(join(tmpdir(), 'escape-adv-'));
    git(repo, ['init', '-q', '-b', 'main']);
    git(repo, ['config', 'user.name', 'T']); git(repo, ['config', 'user.email', 't@e.com']);
    git(repo, ['config', 'commit.gpgsign', 'false']);
  };
  const commit = (msg: string) => { git(repo, ['add', '.']); git(repo, ['commit', '-q', '-m', msg, '--no-gpg-sign']); };
  beforeEach(init);
  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  // CRITICAL regression: multibyte source. A `☕`/`é` before the function shifts byte
  // offsets but not code-unit offsets; a byte-sliced body would corrupt the compare
  // and could make a real modification look unchanged, silently dropping the escape.
  const MB_BASE = `// café ☕ registry — multibyte header padding ✨\nexport function dispatch(name: string): number {\n  if (name === 'α') return 1;\n  return 0;\n}\n`;
  const MB_HEAD = `// café ☕ registry — multibyte header padding ✨\nexport function dispatch(name: string): number {\n  if (name === 'α') return 99;\n  return 0;\n}\n`;

  it('detects a body modification on a MULTIBYTE source file (byte-offset regression)', async () => {
    write(repo, 'src/mb.ts', MB_BASE); commit('mb base');
    write(repo, 'src/mb.ts', MB_HEAD); // existing branch rewritten (return 1 → 99)
    const r = await handleStructuralDiff({
      directory: repo, baseRef: 'HEAD',
      declaredFootprint: { taskId: 't1', writeSet: [{ id: 'src/other.ts::x', filePath: 'src/other.ts' }] },
    }) as EscapeResult;
    const esc = r.escapeAnalysis!.escapes.find(e => e.id === 'src/mb.ts::dispatch');
    expect(esc).toBeDefined();                       // not silently dropped
    expect(esc!.editNature).toBe('modifies-existing'); // and correctly classed as a clobber, not a clean append
  });

  it('a pure addition near DUPLICATE lines stays pure-addition; a vanished line is modifies-existing', async () => {
    // duplicate `return 0;` lines; HEAD inserts a new case (addition only) → pure-addition.
    const DUP_BASE = `export function f(n: number): number {\n  if (n === 1) return 0;\n  if (n === 2) return 0;\n  return 0;\n}\n`;
    const DUP_ADD = `export function f(n: number): number {\n  if (n === 1) return 0;\n  if (n === 2) return 0;\n  if (n === 3) return 7;\n  return 0;\n}\n`;
    write(repo, 'src/d.ts', DUP_BASE); commit('dup base');
    write(repo, 'src/d.ts', DUP_ADD);
    const r = await handleStructuralDiff({
      directory: repo, baseRef: 'HEAD',
      declaredFootprint: { taskId: 't1', writeSet: [{ id: 'src/d.ts::f', filePath: 'src/d.ts', writeMode: 'append' }] },
    }) as EscapeResult;
    // declared append + actual pure addition ⇒ no mis-declared-append, no escape.
    expect(r.escapeAnalysis!.misDeclaredAppends).toEqual([]);
    expect(r.escapeAnalysis!.escapes).toEqual([]);
  });

  it('OPT-IN BLOCKING: an enforcement.policy entry flips a footprint finding to blocking and gates', async () => {
    write(repo, 'src/core2.ts', `export function dispatch(n: string): number {\n  if (n === 'a') return 1;\n  return 0;\n}\n`);
    commit('base');
    write(repo, 'src/core2.ts', `export function dispatch(n: string): number {\n  if (n === 'a') return 5;\n  return 0;\n}\n`);
    // Opt the newly-opened-conflict code into blocking for THIS repo.
    write(repo, '.openlore/config.json', JSON.stringify({ enforcement: { policy: { 'footprint-escape-new-conflict': 'blocking' } } }));
    const r = await handleStructuralDiff({
      directory: repo, baseRef: 'HEAD',
      declaredFootprint: { taskId: 't1', writeSet: [{ id: 'src/other.ts::x', filePath: 'src/other.ts' }] },
      peerFootprints: [{ taskId: 't2', writeSet: [{ id: 'src/core2.ts::dispatch', filePath: 'src/core2.ts', writeMode: 'modify' }] }],
    }) as EscapeResult;
    expect(r.escapeAnalysis!.gated).toBe(true);
    const blk = r.escapeAnalysis!.findings.find(f => f.code === 'footprint-escape-new-conflict');
    expect(blk?.enforcementClass).toBe('blocking');
  });

  it('an empty/non-code diff still emits a vacuous escapeAnalysis (opt-in check never silently skipped)', async () => {
    write(repo, 'README.md', '# hi\n'); commit('docs base');
    write(repo, 'README.md', '# hi there\n'); // non-code change only
    const r = await handleStructuralDiff({
      directory: repo, baseRef: 'HEAD',
      declaredFootprint: { taskId: 't1', writeSet: [{ id: 'src/a.ts::foo', filePath: 'src/a.ts' }] },
    }) as EscapeResult & { escapeAnalysis?: { summary: Record<string, number>; notes?: string[] } };
    expect(r.escapeAnalysis).toBeDefined();
    expect(r.escapeAnalysis!.summary.escapes).toBe(0);
    expect(r.escapeAnalysis!.notes?.some(n => /vacuously empty/i.test(n))).toBe(true);
  });

  it('a degenerate (empty) declared write-set is disclosed, not a silent escape storm', async () => {
    write(repo, 'src/x.ts', `export function a(): number { return 1; }\nexport function b(): number { return 2; }\n`);
    commit('base');
    write(repo, 'src/x.ts', `export function a(): number { return 9; }\nexport function b(): number { return 8; }\n`);
    const r = await handleStructuralDiff({
      directory: repo, baseRef: 'HEAD',
      declaredFootprint: { taskId: 't1', writeSet: [] }, // degenerate
    }) as EscapeResult & { escapeAnalysis?: { notes?: string[]; escapes: unknown[] } };
    expect(r.escapeAnalysis!.escapes.length).toBeGreaterThan(0);
    expect(r.escapeAnalysis!.notes?.some(n => /empty or every member was malformed/i.test(n))).toBe(true);
  });

  it('maxResults truncation is disclosed and never hides a blocking finding', async () => {
    // Two functions both modified; declare neither → 2 escapes. Cap at 1.
    write(repo, 'src/m.ts', `export function p(): number { return 1; }\nexport function q(): number { return 2; }\n`);
    commit('base');
    write(repo, 'src/m.ts', `export function p(): number { return 11; }\nexport function q(): number { return 22; }\n`);
    write(repo, '.openlore/config.json', JSON.stringify({ enforcement: { policy: { 'footprint-escape': 'blocking' } } }));
    const r = await handleStructuralDiff({
      directory: repo, baseRef: 'HEAD', maxResults: 1,
      declaredFootprint: { taskId: 't1', writeSet: [{ id: 'src/other.ts::z', filePath: 'src/other.ts' }] },
    }) as EscapeResult & { escapeAnalysis?: { summary: Record<string, number>; notes?: string[]; findings: Array<{ enforcementClass: string }>; escapes: unknown[]; gated: boolean } };
    expect(r.escapeAnalysis!.summary.escapes).toBe(2);       // full count authoritative
    expect(r.escapeAnalysis!.escapes.length).toBe(1);        // list capped
    expect(r.escapeAnalysis!.notes?.some(n => /truncated/i.test(n))).toBe(true);
    expect(r.escapeAnalysis!.gated).toBe(true);
    // both blocking findings retained despite maxResults: 1
    expect(r.escapeAnalysis!.findings.filter(f => f.enforcementClass === 'blocking').length).toBe(2);
  });
});
