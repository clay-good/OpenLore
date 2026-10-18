/**
 * New calls into deprecated code (change: add-deprecation-propagation), end to end over a real
 * git repository: `structural_diff` reports only calls the diff ADDS, resolves targets without
 * guessing, and emits an advisory `deprecated-symbol-use` finding. Plain .test.ts so CI runs it.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

vi.mock('./utils.js', async (orig) => {
  const actual = await orig() as Record<string, unknown>;
  return { ...actual, validateDirectory: vi.fn(async (d: string) => d), readCachedContext: vi.fn(async () => null) };
});

import { handleStructuralDiff } from './structural-diff.js';
import { readCachedContext } from './utils.js';
import { EdgeStore } from '../edge-store.js';
import type { FunctionNode } from '../../analyzer/call-graph.js';

const ENV = {
  ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@e.com', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@e.com',
};
const git = (cwd: string, args: string[]) => execFileSync('git', args, { cwd, stdio: 'ignore', env: ENV });
const write = (cwd: string, rel: string, content: string) => {
  const p = join(cwd, rel); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, content);
};

const LIB = '/** @deprecated use newApi */\nexport function oldApi(): number { return 1; }\nexport function newApi(): number { return 2; }\n';

let dirs: string[] = [];
let stores: EdgeStore[] = [];
afterEach(() => {
  for (const s of stores) s.close();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = []; stores = [];
  vi.mocked(readCachedContext).mockResolvedValue(null as never);
});

/** A repo with `files` committed, then `edits` applied to the working tree. */
function repo(files: Record<string, string>, edits: Record<string, string>): string {
  const d = mkdtempSync(join(tmpdir(), 'openlore-deprecated-'));
  dirs.push(d);
  git(d, ['init', '-q', '-b', 'main']);
  for (const [f, c] of Object.entries(files)) write(d, f, c);
  git(d, ['add', '-A']);
  git(d, ['commit', '-q', '-m', 'base']);
  for (const [f, c] of Object.entries(edits)) write(d, f, c);
  return d;
}

type Dep = { caller: string; callerFile: string; target: string; targetFile: string; hint: string; resolution: string };
type Diff = {
  summary: { deprecatedCallsAdded: number };
  deprecatedCalls?: { added: Dep[]; findings: Array<{ code: string; enforcementClass: string; subject: string; location?: { path: string } }>; gated: boolean };
  soundness: { caveats: string[] };
};

describe('structural_diff — new calls into deprecated code', () => {
  it('reports a new call into a deprecated symbol in a changed file, with an advisory finding', async () => {
    const d = repo(
      { 'src/lib.ts': 'export function newApi(): number { return 2; }\n', 'src/app.ts': 'export function main() { return 0; }\n' },
      { 'src/lib.ts': LIB, 'src/app.ts': 'import { oldApi } from "./lib";\nexport function main() { return oldApi(); }\n' },
    );
    const r = await handleStructuralDiff({ directory: d, baseRef: 'HEAD' }) as Diff;
    expect(r.summary.deprecatedCallsAdded).toBe(1);
    expect(r.deprecatedCalls!.added[0]).toMatchObject({
      caller: 'main', callerFile: 'src/app.ts', target: 'oldApi', targetFile: 'src/lib.ts', hint: 'use newApi', resolution: 'changed-files',
    });
    expect(r.deprecatedCalls!.findings[0]).toMatchObject({
      code: 'deprecated-symbol-use', enforcementClass: 'advisory', subject: 'src/lib.ts::oldApi', location: { path: 'src/app.ts' },
    });
    expect(r.deprecatedCalls!.gated).toBe(false);
    expect(r.soundness.caveats.some(c => c.includes('@deprecated'))).toBe(true);
  });

  it('does not report a call that was already there', async () => {
    const before = 'import { oldApi } from "./lib";\nexport function main() { return oldApi(); }\n';
    const d = repo(
      { 'src/lib.ts': LIB, 'src/app.ts': before },
      { 'src/lib.ts': `${LIB}// touched\n`, 'src/app.ts': `${before}export function other() { return 3; }\n` },
    );
    const r = await handleStructuralDiff({ directory: d, baseRef: 'HEAD' }) as Diff;
    expect(r.summary.deprecatedCallsAdded).toBe(0);
    expect(r.deprecatedCalls).toBeUndefined();
  });

  it('does not report a call into a symbol that is not marked', async () => {
    const d = repo(
      { 'src/lib.ts': LIB, 'src/app.ts': 'export function main() { return 0; }\n' },
      { 'src/lib.ts': `${LIB}// touched\n`, 'src/app.ts': 'import { newApi } from "./lib";\nexport function main() { return newApi(); }\n' },
    );
    const r = await handleStructuralDiff({ directory: d, baseRef: 'HEAD' }) as Diff;
    expect(r.summary.deprecatedCallsAdded).toBe(0);
  });

  it('resolves a target in an unchanged file through the index, and only by a unique name', async () => {
    const d = repo(
      { 'src/lib.ts': LIB, 'src/app.ts': 'export function main() { return 0; }\n' },
      { 'src/app.ts': 'import { oldApi } from "./lib";\nexport function main() { return oldApi(); }\n' },
    );
    const store = EdgeStore.open(join(d, 'graph.db'));
    stores.push(store);
    const node = (id: string, over: Partial<FunctionNode> = {}): FunctionNode => ({
      id, name: id.split('::')[1], filePath: id.split('::')[0], isAsync: false, language: 'TypeScript',
      startIndex: 0, endIndex: 1, fanIn: 0, fanOut: 0, ...over,
    });
    store.insertNodes([node('src/lib.ts::oldApi', { deprecation: 'use newApi' }), node('src/lib.ts::newApi'), node('src/app.ts::main')]);
    vi.mocked(readCachedContext).mockResolvedValue({ edgeStore: store } as never);

    const r = await handleStructuralDiff({ directory: d, baseRef: 'HEAD' }) as Diff;
    expect(r.deprecatedCalls!.added[0]).toMatchObject({ target: 'oldApi', targetFile: 'src/lib.ts', resolution: 'unique-name' });

    // A second symbol with the same name makes the name ambiguous: nothing is guessed.
    store.insertNodes([node('src/other.ts::oldApi')]);
    const again = await handleStructuralDiff({ directory: d, baseRef: 'HEAD' }) as Diff;
    expect(again.summary.deprecatedCallsAdded).toBe(0);
  });

  it('blocks when the operator makes the finding blocking', async () => {
    const d = repo(
      {
        'src/lib.ts': 'export function newApi(): number { return 2; }\n', 'src/app.ts': 'export function main() { return 0; }\n',
        '.openlore/config.json': JSON.stringify({
          version: '1.0.0', projectType: 'unknown', openspecPath: 'openspec',
          analysis: { maxFiles: 1000, includePatterns: [], excludePatterns: [] },
          generation: { model: 'x', domains: 'auto' }, createdAt: '2026-10-18T00:00:00.000Z', lastRun: null,
          enforcement: { policy: { 'deprecated-symbol-use': 'blocking' } },
        }),
      },
      { 'src/lib.ts': LIB, 'src/app.ts': 'import { oldApi } from "./lib";\nexport function main() { return oldApi(); }\n' },
    );
    const r = await handleStructuralDiff({ directory: d, baseRef: 'HEAD' }) as Diff;
    expect(r.deprecatedCalls!.findings[0].enforcementClass).toBe('blocking');
    expect(r.deprecatedCalls!.gated).toBe(true);
  });
});

describe('EdgeStore keeps the marker', () => {
  it('round-trips deprecation, including an empty hint', () => {
    const d = mkdtempSync(join(tmpdir(), 'openlore-deprecated-store-'));
    dirs.push(d);
    const store = EdgeStore.open(join(d, 'graph.db'));
    stores.push(store);
    const base = { isAsync: false, language: 'Go', startIndex: 0, endIndex: 1, fanIn: 0, fanOut: 0, filePath: 'a.go' };
    store.insertNodes([
      { ...base, id: 'a.go::A', name: 'A', deprecation: 'use B' },
      { ...base, id: 'a.go::C', name: 'C', deprecation: '' },
      { ...base, id: 'a.go::B', name: 'B' },
    ]);
    expect(store.getNode('a.go::A')!.deprecation).toBe('use B');
    expect(store.getNode('a.go::C')!.deprecation).toBe('');
    expect(store.getNode('a.go::B')!.deprecation).toBeUndefined();
  });
});
