/**
 * Spec-21 — Structural Change Analysis (graph diff) over a real temp git repo.
 * A v1→v2 change exercises added/removed/signature-changed functions, the
 * stale-caller set (via a mocked canonical graph), and rename-candidate flagging.
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
import { readCachedContext } from './utils.js';

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' } });
}
function write(cwd: string, rel: string, content: string): void {
  const p = join(cwd, rel); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, content);
}

const V1 = `export function alpha(a: string): number { return a.length; }
export function beta(): void { alpha("x"); }
export function gamma(): void {}
export function oldName(x: number): boolean { return x > 0; }
`;
const V2 = `export function alpha(a: string, b: number): number { return a.length + b; }
export function beta(): void { alpha("x", 1); }
export function delta(z: string): void {}
export function newName(x: number): boolean { return x > 0; }
`;

describe('handleStructuralDiff', () => {
  let repo: string;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'struct-diff-'));
    git(repo, ['init', '-q', '-b', 'main']);
    git(repo, ['config', 'user.name', 'T']); git(repo, ['config', 'user.email', 't@e.com']);
    git(repo, ['config', 'commit.gpgsign', 'false']);
    write(repo, 'src/mod.ts', V1);
    git(repo, ['add', '.']); git(repo, ['commit', '-q', '-m', 'v1', '--no-gpg-sign']);
    write(repo, 'src/mod.ts', V2); // working-tree change = v2
    // Canonical graph: alpha has an external caller in an UNCHANGED file.
    vi.mocked(readCachedContext).mockResolvedValue({
      edgeStore: {
        getCallers: (id: string) => id === 'src/mod.ts::alpha'
          ? [{ callerId: 'src/other.ts::consumer', calleeId: id, calleeName: 'alpha', confidence: 'import', kind: 'calls' }]
          : [],
        getNode: (id: string) => id === 'src/other.ts::consumer'
          ? { id, name: 'consumer', filePath: 'src/other.ts', isExternal: false, isAsync: false, language: 'TypeScript', startIndex: 0, endIndex: 9, fanIn: 0, fanOut: 1 }
          : null,
      },
    } as never);
  });

  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  it('reports added, removed, and signature-changed functions', async () => {
    const r = await handleStructuralDiff({ directory: repo, baseRef: 'HEAD' }) as {
      summary: Record<string, number>;
      added: Array<{ name: string }>; removed: Array<{ name: string }>;
      signatureChanged: Array<{ name: string; before: string; after: string }>;
    };
    expect(r.added.map(n => n.name).sort()).toEqual(['delta', 'newName']);
    expect(r.removed.map(n => n.name).sort()).toEqual(['gamma', 'oldName']);
    expect(r.signatureChanged.map(n => n.name)).toEqual(['alpha']);
    const alpha = r.signatureChanged[0];
    expect(alpha.before).toContain('a: string): number');
    expect(alpha.after).toContain('b: number');
    expect(r.summary.signatureChanges).toBe(1);
  });

  it('lists stale callers of a signature-changed function from the canonical graph', async () => {
    const r = await handleStructuralDiff({ directory: repo, baseRef: 'HEAD' }) as {
      signatureChanged: Array<{ name: string; staleCallers: Array<{ name: string; file: string }> }>;
      summary: { staleCallers: number };
    };
    const alpha = r.signatureChanged.find(s => s.name === 'alpha')!;
    // beta (same file, updated) is excluded; consumer (other file) is stale.
    expect(alpha.staleCallers.map(c => c.name)).toEqual(['consumer']);
    expect(r.summary.staleCallers).toBe(1);
  });

  it('flags a rename/move candidate without dropping the remove+add', async () => {
    const r = await handleStructuralDiff({ directory: repo, baseRef: 'HEAD' }) as {
      renameCandidates: Array<{ from: { name: string }; to: { name: string }; confidence: string; note: string }>;
      removed: Array<{ name: string }>; added: Array<{ name: string }>;
    };
    const rename = r.renameCandidates.find(c => c.from.name === 'oldName' && c.to.name === 'newName');
    expect(rename).toBeDefined();
    expect(rename!.confidence).toBe('high'); // same signature shape, same file
    // Both interpretations remain present.
    expect(r.removed.map(n => n.name)).toContain('oldName');
    expect(r.added.map(n => n.name)).toContain('newName');
  });

  it('notes when no cached graph is available (stale callers skipped)', async () => {
    vi.mocked(readCachedContext).mockResolvedValueOnce(null as never);
    const r = await handleStructuralDiff({ directory: repo, baseRef: 'HEAD' }) as { note?: string; signatureChanged: Array<{ staleCallers: unknown[] }> };
    expect(r.note).toMatch(/analyze_codebase/);
    expect(r.signatureChanged[0].staleCallers).toEqual([]);
  });

  it('includes untracked new files (their functions are all additions)', async () => {
    write(repo, 'src/brand-new.ts', 'export function freshFn(): void {}\n'); // untracked
    const r = await handleStructuralDiff({ directory: repo, baseRef: 'HEAD' }) as {
      added: Array<{ name: string }>; changedFiles: Array<{ path: string; status: string }>;
    };
    expect(r.added.map(n => n.name)).toContain('freshFn');
    expect(r.changedFiles.find(f => f.path === 'src/brand-new.ts')?.status).toBe('added');
  });

  it('errors on a non-git directory', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'struct-nogit-'));
    try {
      const r = await handleStructuralDiff({ directory: dir }) as { error: string };
      expect(r.error).toMatch(/git repository/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns an empty delta when nothing changed', async () => {
    git(repo, ['checkout', '--', 'src/mod.ts']); // revert working tree to v1
    const r = await handleStructuralDiff({ directory: repo, baseRef: 'HEAD' }) as { summary: Record<string, number>; message?: string };
    expect(r.summary.addedFunctions).toBe(0);
    expect(r.summary.removedFunctions).toBe(0);
  });

  // fix-git-derived-signal-honesty: a below-root directory is inside a real repo, so
  // structural_diff must NOT refuse it as "Not a git repository"; instead it discloses
  // the below-root boundary rather than returning a confident empty delta.
  it('discloses the below-root boundary instead of refusing a real repository', async () => {
    const pkg = join(repo, 'packages', 'foo');
    write(pkg, 'lib.ts', 'export function q(): number { return 1; }\n');
    git(repo, ['add', '.']); git(repo, ['commit', '-q', '-m', 'add pkg', '--no-gpg-sign']);
    const r = await handleStructuralDiff({ directory: pkg, baseRef: 'HEAD' }) as {
      error?: string; boundary?: { belowRepoRoot: boolean; prefix: string };
    };
    expect(r.error).not.toMatch(/Not a git repository/i);
    expect(r.error).toMatch(/below the repository root/i);
    expect(r.boundary).toMatchObject({ belowRepoRoot: true });
    expect(r.boundary?.prefix).toBe('packages/foo/');
  });
});

// ── Rename-stable matching via content-addressed stable id ─────────────────────
// (change: add-content-addressed-stable-symbol-ids)
describe('handleStructuralDiff — stable-id matching', () => {
  let repo: string;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'struct-diff-sid-'));
    git(repo, ['init', '-q', '-b', 'main']);
    git(repo, ['config', 'user.name', 'T']); git(repo, ['config', 'user.email', 't@e.com']);
    git(repo, ['config', 'commit.gpgsign', 'false']);
    // v1: `mover` and `shifter` live in a.ts; `stay` in b.ts.
    write(repo, 'src/a.ts',
      `export function mover(p: string): number { return p.length; }\n` +
      `export function shifter(n: number): number { return n; }\n`);
    write(repo, 'src/b.ts', `export function stay(): void {}\n`);
    git(repo, ['add', '.']); git(repo, ['commit', '-q', '-m', 'v1', '--no-gpg-sign']);
    // v2 (working tree): `mover` moved to b.ts unchanged; `shifter` moved to b.ts
    // with an added modifier (signature differs, param shape identical).
    write(repo, 'src/a.ts', `// emptied\n`);
    write(repo, 'src/b.ts',
      `export function stay(): void {}\n` +
      `export function mover(p: string): number { return p.length; }\n` +
      `export async function shifter(n: number): number { return n; }\n`);
    vi.mocked(readCachedContext).mockResolvedValue(null as never);
  });

  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  it('reports a pure cross-file move as the same symbol, not remove+add', async () => {
    const r = await handleStructuralDiff({ directory: repo, baseRef: 'HEAD' }) as {
      added: Array<{ name: string }>; removed: Array<{ name: string }>;
      renameCandidates: Array<{ from: { name: string; file: string }; to: { name: string; file: string }; confidence: string; note: string }>;
    };
    expect(r.added.map(n => n.name)).not.toContain('mover');
    expect(r.removed.map(n => n.name)).not.toContain('mover');
    const move = r.renameCandidates.find(c => c.from.name === 'mover');
    expect(move).toBeDefined();
    expect(move!.confidence).toBe('stable-id'); // honest label — strong signal, not "exact"/proof
    expect(move!.note).toMatch(/verify/i);       // conveys uncertainty to the agent
    expect(move!.from.file).toBe('src/a.ts');
    expect(move!.to.file).toBe('src/b.ts');
  });

  it('labels a stable-id cross-file match as "stable-id" with a verify note, never overclaiming "exact"', async () => {
    // A delete-and-replace by a same-name/same-shape homonym is indistinguishable
    // from a move here. The match is still surfaced (useful) but must be honestly
    // labeled and tell the agent to verify — never asserted as proof of identity.
    write(repo, 'src/a.ts', `// mover deleted from here\nexport const A = 1;\n`);
    write(repo, 'src/b.ts',
      `export function stay(): void {}\n` +
      `export function shifter(n: number): number { return n; }\n` +
      `export function mover(p: string): number { return p.length * 99; }\n`); // same name+shape, different body
    const r = await handleStructuralDiff({ directory: repo, baseRef: 'HEAD' }) as {
      renameCandidates: Array<{ from: { name: string }; to: { name: string }; confidence: string; note: string }>;
    };
    const m = r.renameCandidates.find(c => c.from.name === 'mover' && c.to.name === 'mover');
    expect(m).toBeDefined();
    expect(m!.confidence).toBe('stable-id');
    expect(m!.confidence).not.toBe('exact');
    expect(m!.note).toMatch(/verify/i);
    expect(m!.note).toMatch(/indistinguishable|delete-and-replace|homonym/i);
  });

  it('reports a moved symbol with a modifier-only signature change as modified', async () => {
    const r = await handleStructuralDiff({ directory: repo, baseRef: 'HEAD' }) as {
      added: Array<{ name: string }>; removed: Array<{ name: string }>;
      signatureChanged: Array<{ name: string; before: string; after: string }>;
    };
    expect(r.added.map(n => n.name)).not.toContain('shifter');
    expect(r.removed.map(n => n.name)).not.toContain('shifter');
    const sig = r.signatureChanged.find(s => s.name === 'shifter');
    expect(sig).toBeDefined();
    expect(sig!.after).toContain('async');
  });

  it('still pairs an anonymous-style identifier rename via the heuristic fallback', async () => {
    // Rename a free function in place (same file, same shape, different name) —
    // stable id differs (name is in it), so the heuristic shape-pairing applies.
    write(repo, 'src/a.ts', `export function renamedInPlace(p: string): number { return p.length; }\n`);
    write(repo, 'src/b.ts', `export function stay(): void {}\nexport function shifter(n: number): number { return n; }\n`);
    const r = await handleStructuralDiff({ directory: repo, baseRef: 'HEAD' }) as {
      renameCandidates: Array<{ from: { name: string }; to: { name: string }; confidence: string }>;
    };
    const heuristic = r.renameCandidates.find(c => c.from.name === 'mover' && c.to.name === 'renamedInPlace');
    expect(heuristic).toBeDefined();
    expect(heuristic!.confidence).toBe('high'); // same file, same shape
  });

  it('does NOT falsely merge ambiguous homonyms: in-place edit + sibling deletion', async () => {
    // Two `dup`s share a stable id (homonyms). One is genuinely DELETED while the
    // other is edited IN PLACE (never moved). The matcher must not "exact"-merge
    // them across files (the first-wins bug) nor report the surviving in-place one
    // as removed. Ambiguous stable ids resolve only when unique — here they don't,
    // so it falls back to the path id (correct, honest result).
    const repo2 = mkdtempSync(join(tmpdir(), 'struct-diff-homonym-'));
    try {
      const g = (args: string[]) => execFileSync('git', args, { cwd: repo2, stdio: 'ignore', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' } });
      g(['init', '-q', '-b', 'main']); g(['config', 'user.name', 'T']); g(['config', 'user.email', 't@e.com']); g(['config', 'commit.gpgsign', 'false']);
      const dup = `export function dup(n: number): number { return n; }\n`;
      write(repo2, 'src/keep.ts', dup);
      write(repo2, 'src/gone.ts', dup);
      g(['add', '.']); g(['commit', '-q', '-m', 'v1', '--no-gpg-sign']);
      write(repo2, 'src/keep.ts', `export function dup(n: number): number { return n + 1; }\n`); // edited in place, still in keep.ts
      write(repo2, 'src/gone.ts', `export function other(): void {}\n`);                          // dup genuinely deleted here
      vi.mocked(readCachedContext).mockResolvedValue(null as never);
      const r = await handleStructuralDiff({ directory: repo2, baseRef: 'HEAD' }) as {
        added: Array<{ name: string; file: string }>; removed: Array<{ name: string; file: string }>;
        renameCandidates: Array<{ from: { name: string; file: string }; to: { name: string; file: string }; confidence: string }>;
      };
      // No cross-file stable-id merge for the ambiguous homonyms (id not unique).
      expect(r.renameCandidates.some(c => c.confidence === 'stable-id')).toBe(false);
      expect(r.renameCandidates.some(c => c.confidence === 'exact')).toBe(false);
      // keep.ts's dup survived in place → must NOT be reported removed.
      expect(r.removed.some(n => n.name === 'dup' && n.file === 'src/keep.ts')).toBe(false);
      // gone.ts's dup was genuinely deleted → reported removed.
      expect(r.removed.some(n => n.name === 'dup' && n.file === 'src/gone.ts')).toBe(true);
    } finally {
      rmSync(repo2, { recursive: true, force: true });
    }
  });
});
