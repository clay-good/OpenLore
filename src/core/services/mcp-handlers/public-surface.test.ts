import { describe, it, expect } from 'vitest';
import { assembleSurfaceDiff } from './public-surface.js';

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
