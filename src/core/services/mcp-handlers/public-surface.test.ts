import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { execFileGitSync } from '../../../utils/git-exec.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assembleSurfaceDiff, computeCertifyPublicSurface, publicSurfaceFindings } from './public-surface.js';
import { getChangedFiles } from '../../drift/git-diff.js';
import { FINDING_CODE_REGISTRY, resolveEnforcementClass } from './enforcement-policy.js';
import { BREAKING_SURFACE_RULE_CODES } from '../../analyzer/public-surface.js';
import { readCachedContext } from './utils.js';
import { findCrossRepoConsumersBatch } from '../../federation/resolver.js';
import { writeAcceptedBreakages } from './public-surface-baseline.js';
import {
  DECISIONS_PENDING_FILE,
  OPENLORE_DECISIONS_SUBDIR,
  OPENLORE_DIR,
  PUBLIC_SURFACE_BASELINE_REL_PATH,
} from '../../../constants.js';

// Mock only the two utils the handler reads; the pure assembleSurfaceDiff core below
// does not touch them, so the existing suite is unaffected. git-diff is imported
// dynamically inside the handler, so vi.mock still intercepts it.
vi.mock('./utils.js', () => ({
  validateDirectory: vi.fn(async (d: string) => d),
  readCachedContext: vi.fn(async () => ({ callGraph: { nodes: [] } })),
}));
vi.mock('../../drift/git-diff.js', () => ({
  validateGitRef: vi.fn(() => {}),
  getChangedFiles: vi.fn(async () => ({ files: [], resolvedBase: 'main' })),
  resolveBaseRefDisclosed: vi.fn(async (_d: string, requested: string) => ({
    requested,
    resolved: 'main',
    fellBack: requested === 'bogus-ref',
  })),
}));

// Federation is opt-in: inactive unless the caller asks, and then one sibling repo is consulted.
vi.mock('../../federation/resolver.js', () => ({
  resolveFederationScope: vi.fn((_dir: string, opts: { federation?: boolean }) =>
    opts.federation
      ? { active: true, repos: [{ name: 'sibling', path: '/sibling' }], unknownNames: [] }
      : { active: false, repos: [], unknownNames: [] }),
  findCrossRepoConsumersBatch: vi.fn(async (_scope: unknown, symbols: string[]) => ({
    bySymbol: new Map(symbols.map((s) => [s, [] as unknown[]])),
    truncated: 0,
    coverage: { reposConsulted: [{ name: 'sibling' }], reposSkipped: [], caveats: ['matched by symbol name'] },
  })),
}));

type File = { path: string; content: string; language: string };
const ts = (path: string, content: string): File => ({ path, content, language: 'TypeScript' });
const noRename = new Map<string, string>();

/** Find the change for a symbol by name. */
function change(result: Awaited<ReturnType<typeof assembleSurfaceDiff>>, name: string) {
  return result.changes.find((c) => c.name === name);
}

describe('assembleSurfaceDiff — breaking-change classification over file contents', () => {
  it('removed export → breaking', async () => {
    const base = [ts('a.ts', 'export function foo(a: number): void {}\nexport function bar(): void {}\n')];
    const head = [ts('a.ts', 'export function bar(): void {}\n')];
    const r = await assembleSurfaceDiff(base, head, noRename);
    const c = change(r, 'foo');
    expect(c?.class).toBe('breaking');
    expect(c?.changeKind).toBe('removed');
    expect(r.overall).toBe('breaking');
  });

  it('added required parameter → breaking', async () => {
    const base = [ts('a.ts', 'export function foo(a: number): void {}\n')];
    const head = [ts('a.ts', 'export function foo(a: number, b: string): void {}\n')];
    const c = change(await assembleSurfaceDiff(base, head, noRename), 'foo');
    expect(c?.class).toBe('breaking');
    expect(c?.reasons.join(' ')).toMatch(/required parameter "b" was added/);
  });

  it('added trailing optional parameter → non-breaking', async () => {
    const base = [ts('a.ts', 'export function foo(a: number): void {}\n')];
    const head = [ts('a.ts', 'export function foo(a: number, b?: string): void {}\n')];
    const c = change(await assembleSurfaceDiff(base, head, noRename), 'foo');
    expect(c?.class).toBe('non-breaking');
  });

  it('narrowed return type → breaking', async () => {
    const base = [ts('a.ts', 'export function foo(): string | number { return 1; }\n')];
    const head = [ts('a.ts', 'export function foo(): string { return ""; }\n')];
    const c = change(await assembleSurfaceDiff(base, head, noRename), 'foo');
    expect(c?.class).toBe('breaking');
    expect(c?.reasons.join(' ')).toMatch(/return type narrowed/);
  });

  it('new export added → non-breaking', async () => {
    const base = [ts('a.ts', 'export function foo(): void {}\n')];
    const head = [ts('a.ts', 'export function foo(): void {}\nexport function baz(): void {}\n')];
    const r = await assembleSurfaceDiff(base, head, noRename);
    const c = change(r, 'baz');
    expect(c?.class).toBe('non-breaking');
    expect(c?.changeKind).toBe('added');
    expect(r.overall).toBe('non-breaking');
  });

  it('untyped signature change → potentially-breaking (never silently safe)', async () => {
    const base = [{ path: 'a.js', content: 'export function foo(a) { return a; }\n', language: 'JavaScript' }];
    const head = [{ path: 'a.js', content: 'export function foo(a, b) { return a + b; }\n', language: 'JavaScript' }];
    // adding a 2nd untyped positional param with no default is a required add → breaking,
    // but a type-only ambiguity stays potentially-breaking. Verify the typed-loss case instead:
    const baseT = [ts('a.ts', 'export function foo(a: number): void {}\n')];
    const headT = [ts('a.ts', 'export function foo(a): void {}\n')];
    const c = change(await assembleSurfaceDiff(baseT, headT, noRename), 'foo');
    expect(c?.class).toBe('potentially-breaking');
    // the untyped-required-add is still detected structurally:
    const c2 = change(await assembleSurfaceDiff(base, head, noRename), 'foo');
    expect(c2?.class).toBe('breaking');
  });

  it('renamed export → reported as a rename (not remove+add) via continuity', async () => {
    const body = 'export function computeTax(income: number): number {\n  const rate = 0.2;\n  return income * rate;\n}\n';
    const base = [ts('a.ts', body)];
    const head = [ts('a.ts', body.replace(/computeTax/g, 'calculateTax'))];
    const r = await assembleSurfaceDiff(base, head, noRename);
    const renamed = r.changes.find((c) => c.changeKind === 'renamed');
    expect(renamed).toBeTruthy();
    expect(renamed?.name).toBe('computeTax');
    expect(renamed?.rename?.to).toBe('calculateTax');
    expect(renamed?.class).toBe('breaking');
    // it is NOT double-counted as a removal + addition:
    expect(r.changes.filter((c) => c.changeKind === 'removed').length).toBe(0);
    expect(r.changes.filter((c) => c.changeKind === 'added').length).toBe(0);
  });

  it('names the in-repo consumers a breaking change affects (stub edge store)', async () => {
    const base = [ts('a.ts', 'export function foo(a: number): void {}\n')];
    const head = [ts('a.ts', 'export function foo(a: number, b: string): void {}\n')];
    const edgeStore = {
      getCallers: (id: string) =>
        id === 'a.ts::foo' ? [{ callerId: 'b.ts::useFoo' }, { callerId: 'c.ts::alsoFoo' }] : [],
    };
    const r = await assembleSurfaceDiff(base, head, noRename, edgeStore);
    const breaking = r.breaking.find((c) => c.name === 'foo');
    expect(breaking?.consumers.map((x) => x.name).sort()).toEqual(['alsoFoo', 'useFoo']);
    expect(breaking?.consumers.every((x) => x.file && x.id)).toBe(true);
  });

  it('removed ALIASED export (export { impl as pub }) → breaking removal (regression: not silently no-change)', async () => {
    const base = [ts('a.ts', 'function impl(a: number): void {}\nexport { impl as publicName };\n')];
    const head = [ts('a.ts', 'function impl(a: number): void {}\n')];
    const r = await assembleSurfaceDiff(base, head, noRename);
    const c = change(r, 'publicName');
    expect(c?.class).toBe('breaking');
    expect(c?.changeKind).toBe('removed');
    expect(r.overall).toBe('breaking');
  });

  it('removed exported CONST → breaking removal', async () => {
    const base = [ts('a.ts', 'export const VERSION = "1.0";\nexport function f(): void {}\n')];
    const head = [ts('a.ts', 'export function f(): void {}\n')];
    const c = change(await assembleSurfaceDiff(base, head, noRename), 'VERSION');
    expect(c?.class).toBe('breaking');
    expect(c?.changeKind).toBe('removed');
  });

  it('removed exported GENERATOR → breaking removal (no function node, recovered at name level)', async () => {
    const base = [ts('a.ts', 'export function* gen(): Generator<number> { yield 1; }\nexport function keep(): void {}\n')];
    const head = [ts('a.ts', 'export function keep(): void {}\n')];
    const c = change(await assembleSurfaceDiff(base, head, noRename), 'gen');
    expect(c?.class).toBe('breaking');
    expect(c?.changeKind).toBe('removed');
  });

  it('does NOT double-count a removed function export (node pass + name pass)', async () => {
    const base = [ts('a.ts', 'export function foo(a: number): void {}\nexport function bar(): void {}\n')];
    const head = [ts('a.ts', 'export function bar(): void {}\n')];
    const r = await assembleSurfaceDiff(base, head, noRename);
    expect(r.changes.filter((c) => c.name === 'foo')).toHaveLength(1);
    expect(r.changes.filter((c) => c.name === 'foo')[0].changeKind).toBe('removed');
  });

  it('a renamed export is not also reported as a name-level removal/addition', async () => {
    const body = 'export function computeTax(income: number): number {\n  const rate = 0.2;\n  return income * rate;\n}\n';
    const base = [ts('a.ts', body)];
    const head = [ts('a.ts', body.replace(/computeTax/g, 'calculateTax'))];
    const r = await assembleSurfaceDiff(base, head, noRename);
    expect(r.changes.filter((c) => c.changeKind === 'removed')).toHaveLength(0);
    expect(r.changes.filter((c) => c.changeKind === 'added')).toHaveLength(0);
    expect(r.changes.filter((c) => c.changeKind === 'renamed')).toHaveLength(1);
  });

  it('an unchanged contract produces no change entry', async () => {
    const src = 'export function foo(a: number): void {}\nexport function bar(): void {}\n';
    const r = await assembleSurfaceDiff([ts('a.ts', src)], [ts('a.ts', src)], noRename);
    expect(r.changes).toEqual([]);
    expect(r.overall).toBe('non-breaking');
  });

  it('does not treat an `export function` inside a STRING LITERAL as a real export (phantom guard)', async () => {
    const base = [ts('a.ts', 'export function real(): void {}\nconst tmpl = "export function fake(a: number): void {}";\n')];
    const head = [ts('a.ts', 'export function real(): void {}\n')]; // removed the string-bearing const only
    const r = await assembleSurfaceDiff(base, head, noRename);
    // `fake` lives only inside a string; removing it must NOT register as a breaking export removal.
    expect(r.changes.find((c) => c.name === 'fake')).toBeUndefined();
    expect(r.overall).toBe('non-breaking');
  });

  it('a string containing `//` does NOT swallow a following real export (regression: literal scan, not regex pipeline)', async () => {
    // The `//` inside the URL string previously read as a line comment, ate the closing quote, and
    // cascaded into blanking the real `alpha` export — a false non-breaking.
    const base = [ts('a.ts', 'const url = "http://example.com/x"; // doc\nexport function alpha(p: number): void {}\nexport function beta(): void {}\n')];
    const head = [ts('a.ts', 'const url = "http://example.com/x"; // doc\nexport function alpha(p: number, q: string): void {}\nexport function beta(): void {}\n')];
    const c = change(await assembleSurfaceDiff(base, head, noRename), 'alpha');
    expect(c?.class).toBe('breaking'); // added required param must still be seen
    expect(c?.reasons.join(' ')).toMatch(/required parameter "q" was added/);
  });

  it('a removed-but-still-defined export → visibility-reduced (public → private), breaking', async () => {
    const base = [ts('a.ts', 'export function api(a: number): void {}\n')];
    const head = [ts('a.ts', 'function api(a: number): void {}\n')]; // still defined, no longer exported
    const r = await assembleSurfaceDiff(base, head, noRename);
    const c = change(r, 'api');
    expect(c?.class).toBe('breaking');
    expect(c?.changeKind).toBe('visibility-reduced');
    expect(c?.reasons.join(' ')).toMatch(/visibility reduced/);
  });

  it('a genuinely deleted export stays `removed`, not visibility-reduced', async () => {
    const base = [ts('a.ts', 'export function api(a: number): void {}\nexport function keep(): void {}\n')];
    const head = [ts('a.ts', 'export function keep(): void {}\n')];
    expect(change(await assembleSurfaceDiff(base, head, noRename), 'api')?.changeKind).toBe('removed');
  });

  it('a renamed export resolves consumers via BOTH old and new id (index built at base OR head)', async () => {
    const body = 'export function computeTax(income: number): number {\n  const rate = 0.2;\n  return income * rate;\n}\n';
    const base = [ts('a.ts', body)];
    const head = [ts('a.ts', body.replace(/computeTax/g, 'calculateTax'))];
    // Index built at HEAD: only the NEW id resolves. The union must still surface the consumer.
    const headIndex = { getCallers: (id: string) => (id === 'a.ts::calculateTax' ? [{ callerId: 'b.ts::useIt' }] : []) };
    const rHead = await assembleSurfaceDiff(base, head, noRename, headIndex);
    expect(rHead.breaking.find((c) => c.changeKind === 'renamed')?.consumers.map((x) => x.name)).toEqual(['useIt']);
    // Index built at base: only the OLD id resolves. Still surfaced.
    const baseIndex = { getCallers: (id: string) => (id === 'a.ts::computeTax' ? [{ callerId: 'b.ts::useIt' }] : []) };
    const rBase = await assembleSurfaceDiff(base, head, noRename, baseIndex);
    expect(rBase.breaking.find((c) => c.changeKind === 'renamed')?.consumers.map((x) => x.name)).toEqual(['useIt']);
  });

  it('a regex literal containing a quote does NOT swallow a following real export (regex-aware scan)', async () => {
    // `/can't/` — the apostrophe must not open string mode and blank the export below it.
    const base = [ts('a.ts', "const re = /can't/;\nexport function below(a: number): void {}\n")];
    const head = [ts('a.ts', "const re = /can't/;\nexport function below(a: number, b: string): void {}\n")];
    const c = change(await assembleSurfaceDiff(base, head, noRename), 'below');
    expect(c?.class).toBe('breaking');
    expect(c?.reasons.join(' ')).toMatch(/required parameter "b" was added/);
  });

  it('an `export function` INSIDE a regex literal is not a phantom export', async () => {
    const src = 'const re = /export function ghost\\(z\\)/;\nexport function real(): void {}\n';
    const r = await assembleSurfaceDiff([ts('a.ts', src)], [ts('a.ts', src)], noRename);
    expect(r.changes.find((c) => c.name === 'ghost')).toBeUndefined();
  });

  it('a division operator is not mistaken for a regex (no false blanking of the line)', async () => {
    const base = [ts('a.ts', 'const half = 10 / 2; export function vis(a: number): void {}\n')];
    const head = [ts('a.ts', 'const half = 10 / 2; export function vis(a: number, b: string): void {}\n')];
    expect(change(await assembleSurfaceDiff(base, head, noRename), 'vis')?.class).toBe('breaking');
  });

  it('a re-export barrel does NOT double-count a definition-site change (isReExport filtered)', async () => {
    const base = [
      ts('util.ts', 'export function clamp(x: number): number { return x; }\n'),
      ts('index.ts', 'export { clamp } from "./util.js";\n'),
    ];
    const head = [
      ts('util.ts', 'export function keep(): void {}\n'), // clamp removed at the definition
      ts('index.ts', 'export { keep } from "./util.js";\n'),
    ];
    const r = await assembleSurfaceDiff(base, head, noRename);
    // Exactly one removal of `clamp`, at the definition site — not a phantom second one at the barrel.
    expect(r.changes.filter((c) => c.name === 'clamp')).toHaveLength(1);
    expect(r.changes.find((c) => c.name === 'clamp')?.file).toBe('util.ts');
  });

  it('a removed `export const enum` is reported under its real name, not "enum"', async () => {
    const base = [ts('a.ts', 'export const enum Direction { Up, Down }\nexport function f(): void {}\n')];
    const head = [ts('a.ts', 'export function f(): void {}\n')];
    const r = await assembleSurfaceDiff(base, head, noRename);
    expect(r.changes.find((c) => c.name === 'Direction')?.changeKind).toBe('removed');
    expect(r.changes.find((c) => c.name === 'enum')).toBeUndefined();
  });

  it('is deterministic — byte-identical verdict across runs', async () => {
    const base = [ts('a.ts', 'export function foo(a: number): void {}\nexport function gone(): void {}\n')];
    const head = [ts('a.ts', 'export function foo(a: number, b: string): void {}\n')];
    const r1 = await assembleSurfaceDiff(base, head, noRename);
    const r2 = await assembleSurfaceDiff(base, head, noRename);
    expect(JSON.stringify(r1)).toBe(JSON.stringify(r2));
  });

  it('discloses unindexed/external consumers as a known-unknowable boundary when breaking', async () => {
    const base = [ts('a.ts', 'export function foo(): void {}\n')];
    const head = [ts('a.ts', '\n')];
    const r = await assembleSurfaceDiff(base, head, noRename);
    expect(r.extraCrossings.length).toBe(1);
    expect(r.extraCrossings[0].kind).toBe('unindexed-repo');
  });
});

describe('handleCertifyPublicSurface — base-ref is fatal on non-resolution (fix-cli-conclusion-honesty)', () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'openlore-certbase-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it('a typo\'d --base cannot produce a clean certificate — it errors, no verdict', async () => {
    const r = (await computeCertifyPublicSurface({ directory: dir, baseRef: 'bogus-ref' })) as Record<string, unknown>;
    expect(r.error).toMatch(/base ref "bogus-ref" did not resolve/i);
    expect(r.error).toMatch(/refusing to certify/i);
    expect(r.mode).toBeUndefined(); // no diff verdict was produced
  });

  it('--allow-base-fallback opts back into the disclosed fallback (verdict against main, disclosed)', async () => {
    const r = (await computeCertifyPublicSurface({ directory: dir, baseRef: 'bogus-ref', allowBaseFallback: true })) as Record<string, unknown>;
    expect(r.error).toBeUndefined();
    expect(r.mode).toBe('diff');
    expect(r.baseRefFallback).toEqual({ requested: 'bogus-ref', resolved: 'main' });
  });

  it('withholds the bump when a changed code file is in a language the classifier does not read', async () => {
    vi.mocked(getChangedFiles).mockResolvedValueOnce({ files: [{ path: 'pkg/a.go', status: 'modified' }], resolvedBase: 'main' } as never);
    const r = (await computeCertifyPublicSurface({ directory: dir, baseRef: 'HEAD' })) as Record<string, unknown>;
    expect(r.mode).toBe('diff');
    expect(r.suggestedBump).toBeNull();
    expect(r.suggestedBumpWithheld).toMatch(/1 changed code file\(s\) are in a language whose signatures are not classified/);
  });

  it.each([
    [{ path: 'src/Button.vue', status: 'modified' }],
    [{ path: 'pkg/api.pyi', status: 'modified' }],
    [{ path: 'pkg/_speedups.pyx', status: 'modified' }],
    [{ path: 'scripts/release.sh', status: 'modified' }],
    [{ path: 'lib.txt', oldPath: 'lib.go', status: 'renamed' }],
  ])('withholds the bump for an unclassified code file: %o', async (file) => {
    vi.mocked(getChangedFiles).mockResolvedValueOnce({ files: [file], resolvedBase: 'main' } as never);
    const r = (await computeCertifyPublicSurface({ directory: dir, baseRef: 'HEAD' })) as Record<string, unknown>;
    expect(r.suggestedBump).toBeNull();
  });

  it.each([
    [{ path: 'pkg/a_test.go', status: 'modified' }],
    [{ path: 'infra/main.tf', status: 'modified' }],
    [{ path: 'infra/main.bicep', status: 'modified' }],
    [{ path: 'package.json', status: 'modified' }],
  ])('does not withhold the bump for a test, infrastructure, or config file: %o', async (file) => {
    vi.mocked(getChangedFiles).mockResolvedValueOnce({ files: [file], resolvedBase: 'main' } as never);
    const r = (await computeCertifyPublicSurface({ directory: dir, baseRef: 'HEAD' })) as Record<string, unknown>;
    expect(r.suggestedBump).toBe('patch');
  });

  it('counts an untracked code file in an unclassified language', async () => {
    execFileGitSync('git', ['init', '-q', dir]);
    await writeFile(join(dir, 'new.go'), 'package x\nfunc New() {}\n');
    const r = (await computeCertifyPublicSurface({ directory: dir, baseRef: 'HEAD' })) as Record<string, unknown>;
    expect(r.suggestedBump).toBeNull();
    expect(r.suggestedBumpWithheld).toMatch(/1 changed code file/);
  });

  it('a docs-only change still gets a patch bump (non-code files do not withhold it)', async () => {
    vi.mocked(getChangedFiles).mockResolvedValueOnce({ files: [{ path: 'README.md', status: 'modified' }], resolvedBase: 'main' } as never);
    const r = (await computeCertifyPublicSurface({ directory: dir, baseRef: 'HEAD' })) as Record<string, unknown>;
    expect(r.suggestedBump).toBe('patch');
  });

  it('a resolvable --base produces a verdict with no fallback disclosure', async () => {
    const r = (await computeCertifyPublicSurface({ directory: dir, baseRef: 'HEAD' })) as Record<string, unknown>;
    expect(r.error).toBeUndefined();
    expect(r.mode).toBe('diff');
    expect(r.baseRefFallback).toBeUndefined();
  });
});

describe('rule codes, suggested bump, and findings (refine-public-surface-certification)', () => {
  it('attaches a rule code to each change kind', async () => {
    const base = [ts('a.ts', 'export function gone(): void {}\nexport function hidden(): void {}\nexport function keep(a: string | number): void {}\n')];
    const head = [ts('a.ts', 'function hidden(): void {}\nexport function keep(a: string): void {}\nexport function fresh(): void {}\n')];
    const r = await assembleSurfaceDiff(base, head, noRename);
    expect(change(r, 'gone')?.ruleCodes).toEqual(['export-removed']);
    expect(change(r, 'hidden')?.ruleCodes).toEqual(['export-visibility-reduced']);
    expect(change(r, 'keep')?.ruleCodes).toEqual(['param-type-narrowed']);
    expect(change(r, 'fresh')?.ruleCodes).toEqual(['export-added']);
    expect(r.suggestedBump).toBe('major');
  });

  it('suggests minor for an additive diff, and withholds the bump when compatibility is unproven', async () => {
    const additive = await assembleSurfaceDiff([ts('a.ts', 'export function a(): void {}\n')], [ts('a.ts', 'export function a(): void {}\nexport function b(): void {}\n')], noRename);
    expect(additive.suggestedBump).toBe('minor');
    expect(additive.findings).toEqual([]);
    const unproven = await assembleSurfaceDiff([ts('a.ts', 'export function a(x: string): void {}\n')], [ts('a.ts', 'export function a(x): void {}\nexport function b(): void {}\n')], noRename);
    expect(unproven.overall).toBe('potentially-breaking');
    expect(unproven.suggestedBump).toBeNull();
    expect(unproven.suggestedBumpWithheld).toMatch(/1 change\(s\) could not be proven compatible/);
    expect(unproven.findings.map((f) => [f.code, f.severity])).toEqual([['signature-unprovable', 'warning']]);
    const go = await assembleSurfaceDiff([{ path: 'a.go', content: 'package a\nfunc Gone() {}\n', language: 'Go' }], [{ path: 'a.go', content: 'package a\n', language: 'Go' }], noRename);
    expect(go.suggestedBump).toBeNull();
    expect(go.suggestedBumpWithheld).toMatch(/no signature-classifiable language/);
  });

  it('emits one registered finding per breaking rule code, gateable per rule', async () => {
    const base = [ts('a.ts', 'export function gone(): void {}\nexport function keep(a: string | number): void {}\n')];
    const head = [ts('a.ts', 'export function keep(a: string): void {}\n')];
    const r = await assembleSurfaceDiff(base, head, noRename);
    expect(r.findings.map((f) => [f.code, f.subject])).toEqual([['export-removed', 'a.ts::gone'], ['param-type-narrowed', 'a.ts::keep']]);
    for (const f of r.findings) {
      expect(FINDING_CODE_REGISTRY[f.code]?.source).toBe('public-surface');
      expect(f.remediation).toContain(f.subject);
    }
    const policy = { 'export-removed': 'blocking' as const };
    const classes = Object.fromEntries(r.findings.map((f) => [f.code, resolveEnforcementClass(f.code, policy)]));
    expect(classes).toEqual({ 'export-removed': 'blocking', 'param-type-narrowed': 'advisory' });
  });

  it('keeps a subject containing $ patterns intact in the remediation', () => {
    const [finding] = publicSurfaceFindings([{ changeKind: 'removed', class: 'breaking', name: 'loader', file: 'app/routes/$$id.$&.tsx', kind: 'function', reasons: [], ruleCodes: ['export-removed'] }]);
    expect(finding.subject).toBe('app/routes/$$id.$&.tsx::loader');
    expect(finding.remediation).toContain('app/routes/$$id.$&.tsx::loader');
    expect(finding.message).toBe('removed of exported "loader" breaks rule export-removed');
  });

  it('registers every rule code that is a finding, as advisory, and pins a finding exactly', () => {
    for (const code of [...BREAKING_SURFACE_RULE_CODES, 'signature-unprovable']) {
      expect(FINDING_CODE_REGISTRY[code]).toMatchObject({ defaultClass: 'advisory', source: 'public-surface' });
    }
    expect(FINDING_CODE_REGISTRY['export-added']).toBeUndefined();
    expect(publicSurfaceFindings([{ changeKind: 'signature', class: 'potentially-breaking', name: 'x', file: 'a.ts', kind: 'function', reasons: [], ruleCodes: ['signature-unprovable'] }])).toEqual([{
      code: 'signature-unprovable',
      severity: 'warning',
      source: 'public-surface',
      subject: 'a.ts::x',
      message: 'signature of exported "x" triggers rule signature-unprovable',
      remediation: 'Unprovable signature change: a.ts::x; restore the type annotations so compatibility can be classified, or review consumers by hand.',
      location: { path: 'a.ts' },
    }]);
  });

  it('carries export-renamed on a rename, name-level export codes, and parameter codes through the handler', async () => {
    const renameBase = [ts('a.ts', 'export function oldName(x: number): number { const y = x * 2; return y + 1; }\n')];
    const renameHead = [ts('a.ts', 'export function newName(x: number): number { const y = x * 2; return y + 1; }\n')];
    const renamed = await assembleSurfaceDiff(renameBase, renameHead, noRename);
    const rename = renamed.changes.find((c) => c.changeKind === 'renamed');
    expect(rename?.ruleCodes).toEqual(['export-renamed']);
    expect(renamed.findings.map((f) => f.code)).toEqual(['export-renamed']);
    // A rename into another file points the finding at the file that exists after the change.
    const moved = await assembleSurfaceDiff(
      [ts('old.ts', 'export function computeTax(x: number): number { const y = x * 2; return y + 1; }\n')],
      [ts('new.ts', 'export function calcTax(x: number): number { const y = x * 2; return y + 1; }\n')],
      new Map([['old.ts', 'new.ts']]),
    );
    const movedFinding = moved.findings.find((f) => f.code === 'export-renamed');
    expect(movedFinding?.location).toEqual({ path: 'new.ts' });

    const consts = await assembleSurfaceDiff([ts('c.ts', 'export const GONE = 1;\n')], [ts('c.ts', 'export const FRESH = 2;\n')], noRename);
    expect(change(consts, 'GONE')?.ruleCodes).toEqual(['export-removed']);
    expect(change(consts, 'FRESH')?.ruleCodes).toEqual(['export-added']);

    const params = await assembleSurfaceDiff(
      [ts('p.ts', 'export function f(a: number, b?: string, c: boolean): void {}\n')],
      [ts('p.ts', 'export function f(a: number, b: string): void {}\n')],
      noRename,
    );
    // Codes follow parameter order: `b` became required (position 2), then `c` was removed (position 3).
    expect(change(params, 'f')?.ruleCodes).toEqual(['param-became-required', 'param-removed']);
    const added = await assembleSurfaceDiff([ts('q.ts', 'export function g(a: number): void {}\n')], [ts('q.ts', 'export function g(a: number, b: string): void {}\n')], noRename);
    expect(added.findings.map((f) => f.code)).toEqual(['param-required-added']);
  });

  it('a change that is both breaking and unprovable emits an error and a warning finding', async () => {
    const r = await assembleSurfaceDiff(
      [ts('m.ts', 'export function m(a: string, b: number): void {}\n')],
      [ts('m.ts', 'export function m(a): void {}\n')],
      noRename,
    );
    expect(r.findings.map((f) => [f.code, f.severity])).toEqual([['signature-unprovable', 'warning'], ['param-removed', 'error']]);
    expect(r.suggestedBump).toBe('major');
  });

  it('does not claim sibling repositories are checked', async () => {
    const r = await assembleSurfaceDiff([ts('a.ts', 'export function gone(): void {}\n')], [ts('a.ts', '\n')], noRename);
    const detail = r.extraCrossings.map((c) => c.detail).join(' ');
    expect(detail).not.toMatch(/sibling repos are also checked/i);
    expect(detail).toMatch(/in-repo only\. Pass federation to also check indexed sibling repos/);
  });
});


describe('consumer-weighted breaking verdicts (add-public-surface-acceptance-baseline)', () => {
  const stubStore = (callers: Record<string, string[]>) => ({
    getCallers: (id: string) => (callers[id] ?? []).map((callerId) => ({ callerId })),
  });

  it('a consumed break names its consumers', async () => {
    const r = await assembleSurfaceDiff(
      [ts('a.ts', 'export function gone(): void {}\n')],
      [ts('a.ts', '\n')],
      noRename,
      stubStore({ 'a.ts::gone': ['x.ts::one', 'y.ts::two', 'z.ts::three'] }),
    );
    expect(r.breaking).toHaveLength(1);
    expect(r.breaking[0].breakingClass).toBe('breaking-consumed');
    expect(r.breaking[0].consumerCount).toBe(3);
    expect(r.breaking[0].consumers.map((c) => c.name)).toEqual(['one', 'two', 'three']);
    expect(r.summary).toMatchObject({ breaking: 1, breakingConsumed: 1, breakingUnconsumedInIndex: 0 });
    expect(r.breaking[0].class).toBe('breaking'); // the class and bump are unchanged by the split
    expect(r.suggestedBump).toBe('major');
  });

  it('zero indexed consumers is not "safe"', async () => {
    const r = await assembleSurfaceDiff([ts('a.ts', 'export function gone(): void {}\n')], [ts('a.ts', '\n')], noRename, stubStore({}));
    expect(r.breaking[0]).toMatchObject({ breakingClass: 'breaking-unconsumed-in-index', consumerCount: 0, consumers: [] });
    expect(r.summary).toMatchObject({ breakingConsumed: 0, breakingUnconsumedInIndex: 1 });
    expect(r.extraCrossings).toHaveLength(1);
    expect(r.extraCrossings[0].detail).toMatch(/zero listed consumers does not mean no consumer exists/);
  });

  it('counts consumers beyond the listing cap', async () => {
    const many = Array.from({ length: 30 }, (_, i) => `c${String(i).padStart(2, '0')}.ts::f`);
    const r = await assembleSurfaceDiff([ts('a.ts', 'export function gone(): void {}\n')], [ts('a.ts', '\n')], noRename, stubStore({ 'a.ts::gone': many }));
    expect(r.breaking[0].consumers).toHaveLength(25);
    expect(r.breaking[0].consumersTruncated).toBe(5);
    expect(r.breaking[0].consumerCount).toBe(30);
  });
});

describe('certify_public_surface diff mode: federation census and accepted baseline (handler)', () => {
  let dir: string;
  const A_BASE = 'export function parseLegacy(s: string): string { return s; }\nexport function keep(): void {}\nexport function other(): void {}\n';
  const A_HEAD = 'export function keep(): void {}\n';

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'openlore-certaccept-'));
    execFileGitSync('git', ['init', '-q', '-b', 'main', dir]);
    execFileGitSync('git', ['-C', dir, 'config', 'user.email', 't@example.com']);
    execFileGitSync('git', ['-C', dir, 'config', 'user.name', 't']);
    execFileGitSync('git', ['-C', dir, 'config', 'commit.gpgsign', 'false']);
    await writeFile(join(dir, 'a.ts'), A_BASE);
    execFileGitSync('git', ['-C', dir, 'add', 'a.ts']);
    execFileGitSync('git', ['-C', dir, 'commit', '-q', '-m', 'base']);
    await writeFile(join(dir, 'a.ts'), A_HEAD);
    await mkdir(join(dir, OPENLORE_DIR), { recursive: true });
    vi.mocked(getChangedFiles).mockResolvedValue({ files: [{ path: 'a.ts', status: 'modified' }], resolvedBase: 'main' } as never);
  });
  afterEach(async () => {
    vi.mocked(getChangedFiles).mockReset();
    vi.mocked(getChangedFiles).mockResolvedValue({ files: [], resolvedBase: 'main' } as never);
    await rm(dir, { recursive: true, force: true });
  });

  type Diff = {
    summary: Record<string, number>;
    breaking: Array<{ name: string; breakingClass: string; crossRepoConsumers?: Array<{ repo: string; name: string }> }>;
    findings: Array<{ code: string; subject: string }>;
    consumerCensus: { scope: string; reposConsulted?: string[] };
    baseline?: { error?: string; accepted: Array<{ subject: string; justification: string }>; stale: Array<{ subject: string; supersededBy?: string; reason: string }>; unmatched: unknown[] };
    confidenceBoundary: { knownUnknowable?: Array<{ detail: string }> };
  };
  const run = async (extra: Record<string, unknown> = {}): Promise<Diff> =>
    (await computeCertifyPublicSurface({ directory: dir, baseRef: 'main', ...extra })) as Diff;
  const decisionStore = async (decisions: Array<{ id: string; status?: string; supersedes?: string }>): Promise<void> => {
    const d = join(dir, OPENLORE_DIR, OPENLORE_DECISIONS_SUBDIR);
    await mkdir(d, { recursive: true });
    const full = decisions.map((x) => ({
      status: 'approved', title: `decision ${x.id}`, rationale: 'r', consequences: 'c', proposedRequirement: null,
      affectedDomains: [], affectedFiles: [], syncedToSpecs: [], sessionId: 's', recordedAt: '2026-06-01T00:00:00Z',
      contentOrigin: 'agent-recorded', confidence: 'high', ...x,
    }));
    await writeFile(join(d, DECISIONS_PENDING_FILE), JSON.stringify({ version: '1', sessionId: 's', updatedAt: '2026-06-01T00:00:00Z', decisions: full }, null, 2));
  };

  it('without a baseline or federation: in-repo census, every break is a finding, no baseline block', async () => {
    const r = await run();
    expect(r.consumerCensus).toEqual({ scope: 'in-repo' });
    expect(r.baseline).toBeUndefined();
    expect(r.findings.map((f) => f.subject).sort()).toEqual(['a.ts::other', 'a.ts::parseLegacy']);
    expect(r.summary).toMatchObject({ breaking: 2, breakingConsumed: 0, breakingUnconsumedInIndex: 2, accepted: 0 });
    expect(r.confidenceBoundary.knownUnknowable?.map((k) => k.detail).join(' ')).toMatch(/Pass federation/);
  });

  it('federation widens the census honestly', async () => {
    vi.mocked(findCrossRepoConsumersBatch).mockImplementationOnce(async (_scope, symbols) => ({
      bySymbol: new Map(symbols.map((s) => [s, s === 'parseLegacy'
        ? [{ repo: 'sibling', repoPath: '/sibling', caller: { id: 'app.ts::main', name: 'main', file: 'app.ts' }, symbol: s }]
        : []])),
      truncated: 0,
      coverage: { reposConsulted: [{ name: 'sibling' }], reposSkipped: [], caveats: [] },
    }) as never);
    const r = await run({ federation: true });
    const legacy = r.breaking.find((b) => b.name === 'parseLegacy')!;
    expect(legacy.breakingClass).toBe('breaking-consumed');
    expect(legacy.crossRepoConsumers).toEqual([{ repo: 'sibling', name: 'main', file: 'app.ts' }]);
    expect(r.breaking.find((b) => b.name === 'other')!.breakingClass).toBe('breaking-unconsumed-in-index');
    expect(r.consumerCensus).toMatchObject({ scope: 'federation', reposConsulted: ['sibling'] });
    expect(r.confidenceBoundary.knownUnknowable?.map((k) => k.detail).join(' ')).toMatch(/Federated sibling repos were checked by symbol name/);

    const without = await run();
    expect(without.breaking.find((b) => b.name === 'parseLegacy')!.breakingClass).toBe('breaking-unconsumed-in-index');
  });

  it('an accepted break is listed as accepted, leaves findings, and a new break still reports', async () => {
    await writeAcceptedBreakages(dir, [{ code: 'export-removed', severity: 'error', source: 'public-surface', subject: 'a.ts::parseLegacy', message: 'm' }], 'legacy parser retired in v3');
    const r = await run();
    expect(r.findings.map((f) => f.subject)).toEqual(['a.ts::other']);
    expect(r.baseline?.accepted).toEqual([{ code: 'export-removed', subject: 'a.ts::parseLegacy', justification: 'legacy parser retired in v3' }]);
    expect(r.summary).toMatchObject({ breaking: 2, accepted: 1 });
    // The verdict still describes the diff honestly: the accepted break is still breaking.
    expect(r.breaking.map((b) => b.name).sort()).toEqual(['other', 'parseLegacy']);
  });

  it('a superseded decision anchor expires the acceptance, citing the live superseder', async () => {
    await decisionStore([{ id: 'a1b2c3d4' }]);
    await writeAcceptedBreakages(dir, [{ code: 'export-removed', severity: 'error', source: 'public-surface', subject: 'a.ts::parseLegacy', message: 'm' }], 'retired', 'a1b2c3d4');
    expect((await run()).baseline?.accepted).toHaveLength(1);

    await decisionStore([{ id: 'a1b2c3d4' }, { id: 'b2c3d4e5', supersedes: 'a1b2c3d4' }]);
    const r = await run();
    expect(r.baseline?.accepted).toEqual([]);
    expect(r.baseline?.stale).toHaveLength(1);
    expect(r.baseline?.stale[0]).toMatchObject({ subject: 'a.ts::parseLegacy', supersededBy: 'b2c3d4e5' });
    expect(r.findings.map((f) => f.subject)).toContain('a.ts::parseLegacy');
  });

  it('an unrecorded decision anchor is not honored', async () => {
    await writeAcceptedBreakages(dir, [{ code: 'export-removed', severity: 'error', source: 'public-surface', subject: 'a.ts::parseLegacy', message: 'm' }], 'retired', 'deadbeef');
    const r = await run();
    expect(r.baseline?.stale[0].reason).toMatch(/No decision "deadbeef" is recorded/);
    expect(r.findings.map((f) => f.subject)).toContain('a.ts::parseLegacy');
  });

  it('a corrupt baseline honors nothing and says why', async () => {
    await writeFile(join(dir, PUBLIC_SURFACE_BASELINE_REL_PATH), '# OpenLore accepted public-surface breakages v1\n["accept","export-removed","a.ts::parseLegacy","",""]\n');
    const r = await run();
    expect(r.baseline?.error).toMatch(/no acceptance honored/);
    expect(r.findings.map((f) => f.subject).sort()).toEqual(['a.ts::other', 'a.ts::parseLegacy']);
  });

  it('lists entries that no longer match any finding', async () => {
    await writeAcceptedBreakages(dir, [{ code: 'param-removed', severity: 'error', source: 'public-surface', subject: 'a.ts::fixed', message: 'm' }], 'old');
    const r = await run();
    expect(r.baseline?.unmatched).toEqual([{ code: 'param-removed', subject: 'a.ts::fixed' }]);
  });

  it('the census reads the edge store the analysis provides', async () => {
    vi.mocked(readCachedContext).mockResolvedValueOnce({
      callGraph: { nodes: [] },
      edgeStore: { getCallers: (id: string) => (id === 'a.ts::parseLegacy' ? [{ callerId: 'b.ts::use' }] : []) },
    } as never);
    const r = await run();
    expect(r.breaking.find((b) => b.name === 'parseLegacy')!.breakingClass).toBe('breaking-consumed');
    expect(r.summary).toMatchObject({ breakingConsumed: 1, breakingUnconsumedInIndex: 1 });
  });
});
