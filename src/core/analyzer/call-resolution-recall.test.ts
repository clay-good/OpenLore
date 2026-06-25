/**
 * Call resolution recall — re-export / barrel resolution (change: add-call-resolution-recall).
 *
 * Verifies that a call imported through a re-export barrel resolves to its TRUE
 * definition (so the implementation is no longer reported unreachable), that the
 * recovered edge is honestly labelled `re_export` while a direct import stays
 * `import`, that chains are cycle- and depth-bounded, that resolution is
 * deterministic, and that directly-resolved edges are never relabelled (the
 * regression gate).
 */

import { describe, it, expect } from 'vitest';
import { CallGraphBuilder } from './call-graph.js';
import type { CallEdge, CallGraphResult } from './call-graph.js';
import { buildResolvedImportMap, buildBaseImportMap } from './import-resolver-bridge.js';

type Files = Array<{ path: string; content: string; language: string }>;

const ts = (path: string, content: string) => ({ path, content, language: 'TypeScript' });

function findEdge(result: CallGraphResult, callerName: string, calleeName: string): CallEdge | undefined {
  return result.edges.find(e => {
    const caller = result.nodes.get(e.callerId)?.name;
    const callee = result.nodes.get(e.calleeId)?.name;
    return caller === callerName && callee === calleeName && (e.kind ?? 'calls') === 'calls';
  });
}

function nodeByName(result: CallGraphResult, name: string, file?: string) {
  return Array.from(result.nodes.values()).find(n => n.name === name && (!file || n.filePath === file));
}

// ---------------------------------------------------------------------------
// buildResolvedImportMap — unit
// ---------------------------------------------------------------------------

describe('buildResolvedImportMap', () => {
  it('follows a named re-export `export { x } from` to the true definition and flags it', () => {
    const files: Files = [
      ts('impl.ts', 'export function doWork() { return 1; }'),
      ts('index.ts', "export { doWork } from './impl';"),
      ts('caller.ts', "import { doWork } from './index';\nexport function run() { return doWork(); }"),
    ];
    const { map, reExported } = buildResolvedImportMap(files);
    expect(map.get('caller.ts')?.get('doWork')).toBe('impl');
    expect(reExported.has('caller.ts\0doWork')).toBe(true);
  });

  it('follows `export * from` only when the star source surfaces the name', () => {
    const files: Files = [
      ts('impl.ts', 'export function star() {}'),
      ts('other.ts', 'export function unrelated() {}'),
      ts('index.ts', "export * from './impl';\nexport * from './other';"),
      ts('caller.ts', "import { star } from './index';\nexport function run() { return star(); }"),
    ];
    const { map, reExported } = buildResolvedImportMap(files);
    expect(map.get('caller.ts')?.get('star')).toBe('impl');
    expect(reExported.has('caller.ts\0star')).toBe(true);
  });

  it('follows a depth-N chain to the leaf definition', () => {
    const files: Files = [
      ts('deep.ts', 'export function deep() {}'),
      ts('mid.ts', "export { deep } from './deep';"),
      ts('top.ts', "export { deep } from './mid';"),
      ts('caller.ts', "import { deep } from './top';\nexport function run() { return deep(); }"),
    ];
    const { map, reExported } = buildResolvedImportMap(files);
    expect(map.get('caller.ts')?.get('deep')).toBe('deep');
    expect(reExported.has('caller.ts\0deep')).toBe(true);
  });

  it('keeps a direct import labelled NOT re-export (provenance honesty)', () => {
    const files: Files = [
      ts('impl.ts', 'export function direct() {}'),
      ts('caller.ts', "import { direct } from './impl';\nexport function run() { return direct(); }"),
    ];
    const { map, reExported } = buildResolvedImportMap(files);
    expect(map.get('caller.ts')?.get('direct')).toBe('impl');
    expect(reExported.has('caller.ts\0direct')).toBe(false);
  });

  it('terminates on a re-export cycle (no infinite loop)', () => {
    const files: Files = [
      ts('a.ts', "export { ghost } from './b';"),
      ts('b.ts', "export { ghost } from './a';"),
      ts('caller.ts', "import { ghost } from './a';\nexport function run() { return ghost(); }"),
    ];
    // The assertion is simply that this returns (a hang would fail the test run).
    const { map } = buildResolvedImportMap(files);
    expect(map.get('caller.ts')?.has('ghost')).toBe(true);
  });

  it('terminates on an `export *` cycle and still resolves a name reachable past it', () => {
    // a and b re-export each other with `export *` (a star cycle, distinct from the
    // named-cycle case — it exercises the separate starExposes visited-set), while the
    // real definition lives in c, also star-exported from a.
    const files: Files = [
      ts('a.ts', "export * from './b';\nexport * from './c';"),
      ts('b.ts', "export * from './a';"),
      ts('c.ts', 'export function deep() { return 1; }'),
      ts('caller.ts', "import { deep } from './a';\nexport function run() { return deep(); }"),
    ];
    const { map, reExported } = buildResolvedImportMap(files);
    expect(map.get('caller.ts')?.get('deep')).toBe('c');
    expect(reExported.has('caller.ts\0deep')).toBe(true);
  });

  it('default re-export through a barrel degrades gracefully (deferred rename limitation)', () => {
    // `export { default } from './impl'` re-binds under the consumer's chosen local
    // name; like an aliased re-export, the binding name differs from the export name
    // across the hop, so it is not chased — but it must not bind to a wrong target.
    // A DIRECT default import still resolves (covered separately by the call-graph test).
    const files: Files = [
      ts('impl.ts', 'export default function widget() { return 1; }'),
      ts('index.ts', "export { default } from './impl';"),
      ts('caller.ts', "import widget from './index';\nexport function run() { return widget(); }"),
    ];
    const { map, reExported } = buildResolvedImportMap(files);
    // Falls back to the barrel module (not chased to impl); never a wrong target.
    expect(map.get('caller.ts')?.get('widget')).toBe('index');
    expect(reExported.has('caller.ts\0widget')).toBe(false);
  });

  it('matches buildBaseImportMap for TS/JS direct imports when no re-export applies', () => {
    // For a plain (non-barrel) TS/JS import the resolved target is identical to the
    // legacy buildBaseImportMap. (Python leading-dot resolution intentionally diverges
    // — buildResolvedImportMap resolves it precisely where buildBaseImportMap did not.)
    const files: Files = [
      ts('a.ts', 'export function f() {}'),
      ts('b.ts', "import { f } from './a';\nexport function g() { return f(); }"),
    ];
    const base = buildBaseImportMap(files);
    const { map } = buildResolvedImportMap(files);
    for (const [file, names] of base) {
      for (const [name, target] of names) {
        expect(map.get(file)?.get(name)).toBe(target);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// CallGraphBuilder — integration (the conclusions that depend on it)
// ---------------------------------------------------------------------------

describe('call graph — re-export resolution', () => {
  it('resolves a call through a named barrel to the true definition at re_export confidence', async () => {
    const files: Files = [
      ts('impl.ts', 'export function doWork() { return 1; }'),
      ts('index.ts', "export { doWork } from './impl';"),
      ts('caller.ts', "import { doWork } from './index';\nexport function run() { return doWork(); }"),
    ];
    const result = await new CallGraphBuilder().build(files);
    const edge = findEdge(result, 'run', 'doWork');
    expect(edge).toBeDefined();
    expect(result.nodes.get(edge!.calleeId)?.filePath).toBe('impl.ts');
    expect(edge!.confidence).toBe('re_export');
    // The implementation is now reachable — no longer a false dead-code candidate.
    expect(nodeByName(result, 'doWork', 'impl.ts')?.fanIn).toBeGreaterThanOrEqual(1);
  });

  it('resolves through `export * from` barrels', async () => {
    const files: Files = [
      ts('impl.ts', 'export function star() { return 1; }'),
      ts('index.ts', "export * from './impl';"),
      ts('caller.ts', "import { star } from './index';\nexport function run() { return star(); }"),
    ];
    const result = await new CallGraphBuilder().build(files);
    const edge = findEdge(result, 'run', 'star');
    expect(edge).toBeDefined();
    expect(result.nodes.get(edge!.calleeId)?.filePath).toBe('impl.ts');
    expect(edge!.confidence).toBe('re_export');
  });

  it('labels a direct (non-barrel) import `import`, not `re_export`', async () => {
    const files: Files = [
      ts('impl.ts', 'export function direct() { return 1; }'),
      ts('caller.ts', "import { direct } from './impl';\nexport function run() { return direct(); }"),
    ];
    const result = await new CallGraphBuilder().build(files);
    const edge = findEdge(result, 'run', 'direct');
    expect(edge?.confidence).toBe('import');
  });

  it('disambiguates to the imported definition, not the first same-named candidate', async () => {
    // Two files define `handler`; the caller imports the one in `a/`.
    const files: Files = [
      ts('a/impl.ts', 'export function handler() { return "a"; }'),
      ts('b/impl.ts', 'export function handler() { return "b"; }'),
      ts('caller.ts', "import { handler } from './a/impl';\nexport function run() { return handler(); }"),
    ];
    const result = await new CallGraphBuilder().build(files);
    const edge = findEdge(result, 'run', 'handler');
    expect(edge).toBeDefined();
    expect(result.nodes.get(edge!.calleeId)?.filePath).toBe('a/impl.ts');
    expect(edge!.confidence).toBe('import');
  });

  it('is deterministic — re-analysis of the same sources is byte-identical', async () => {
    const files: Files = [
      ts('impl.ts', 'export function doWork() { return 1; }'),
      ts('index.ts', "export { doWork } from './impl';"),
      ts('caller.ts', "import { doWork } from './index';\nexport function run() { return doWork(); }"),
    ];
    const a = await new CallGraphBuilder().build(files);
    const b = await new CallGraphBuilder().build(files);
    const serialize = (r: CallGraphResult) =>
      r.edges
        .map(e => `${e.callerId}|${e.calleeId}|${e.confidence}|${e.kind ?? 'calls'}`)
        .sort()
        .join('\n');
    expect(serialize(a)).toBe(serialize(b));
  });

  it('does NOT follow a re-export to a non-relative package (stays out of the internal graph)', async () => {
    const files: Files = [
      ts('index.ts', "export { thing } from 'some-external-pkg';"),
      ts('caller.ts', "import { thing } from './index';\nexport function run() { return thing(); }"),
    ];
    const result = await new CallGraphBuilder().build(files);
    const edge = findEdge(result, 'run', 'thing');
    // No in-repo definition exists; the package re-export is never invented as internal.
    expect(edge?.confidence === 're_export' || edge?.confidence === 'import').toBe(false);
  });

  it('prefers a barrel-local definition over its own re-export (local def wins)', async () => {
    const files: Files = [
      ts('impl.ts', 'export function thing() { return "impl"; }'),
      // The barrel both re-exports `thing` AND defines its own `thing`; the local
      // definition is authoritative for a call that lands on the barrel module.
      ts('index.ts', "export { thing } from './impl';\nexport function thing() { return 'barrel'; }"),
      ts('caller.ts', "import { thing } from './index';\nexport function run() { return thing(); }"),
    ];
    const result = await new CallGraphBuilder().build(files);
    const edge = findEdge(result, 'run', 'thing');
    expect(edge).toBeDefined();
    // Resolves to the barrel's own definition, not chased through to impl.
    expect(result.nodes.get(edge!.calleeId)?.filePath).toBe('index.ts');
    expect(edge!.confidence).toBe('import');
  });

  it('aliased re-export (rename through barrel) degrades gracefully — no wrong edge (known limitation)', async () => {
    // `export { internalName as publicName }` renames across the hop. The call uses
    // the alias, but the definition node is named `internalName`, so a simple-name
    // lookup cannot bind them — the edge must not resolve to a WRONG target, and the
    // build must not crash. Documented as a deferred recall limitation.
    const files: Files = [
      ts('impl.ts', 'export function internalName() { return 1; }'),
      ts('index.ts', "export { internalName as publicName } from './impl';"),
      ts('caller.ts', "import { publicName } from './index';\nexport function run() { return publicName(); }"),
    ];
    const result = await new CallGraphBuilder().build(files);
    const edge = findEdge(result, 'run', 'publicName');
    // It does not falsely bind to internalName, and never claims re_export/import.
    expect(edge?.confidence).not.toBe('re_export');
    expect(edge?.confidence).not.toBe('import');
  });

  it('resolves Python leading-dot relative imports to import confidence', async () => {
    // Python relative imports use leading-dot module syntax (`from .impl import x`,
    // `from ..pkg.mod import y`); N dots = package levels up. Resolving the dot-prefix
    // (rather than letting posix.join treat `.impl` as a filename) binds the cross-file
    // call precisely instead of leaving it as the ambiguous name-only fallback.
    const py = (path: string, content: string) => ({ path, content, language: 'Python' });
    const files: Files = [
      py('pkg/impl.py', 'def do_work():\n    return 1\n'),
      py('pkg/caller.py', 'from .impl import do_work\n\ndef run():\n    return do_work()\n'),
    ];
    const result = await new CallGraphBuilder().build(files);
    const edge = findEdge(result, 'run', 'do_work');
    expect(edge).toBeDefined();
    expect(result.nodes.get(edge!.calleeId)?.filePath).toBe('pkg/impl.py');
    expect(edge!.confidence).toBe('import');
  });

  it('resolves a Python function-level (deferred) relative import and a parent-package import', async () => {
    // Imports inside a function body (common to break import cycles / lazy-load) and
    // `from ..pkg import x` (parent package) both resolve.
    const py = (path: string, content: string) => ({ path, content, language: 'Python' });
    const files: Files = [
      py('pkg/models.py', 'def build_model():\n    return 1\n'),
      py('pkg/sub/impl.py', 'def work():\n    return 2\n'),
      py(
        'pkg/sub/caller.py',
        'def run():\n    from .impl import work\n    from ..models import build_model\n    return work() + build_model()\n',
      ),
    ];
    const result = await new CallGraphBuilder().build(files);
    expect(findEdge(result, 'run', 'work')?.confidence).toBe('import');
    expect(findEdge(result, 'run', 'build_model')?.confidence).toBe('import');
    expect(result.nodes.get(findEdge(result, 'run', 'build_model')!.calleeId)?.filePath).toBe('pkg/models.py');
  });

  it('regression gate — same-file and direct edges are never relabelled re_export', async () => {
    const files: Files = [
      ts('impl.ts', 'export function doWork() { return 1; }'),
      ts('index.ts', "export { doWork } from './impl';"),
      ts(
        'caller.ts',
        "import { doWork } from './index';\n" +
          'function localHelper() { return 2; }\n' +
          'export function run() { return doWork() + localHelper(); }',
      ),
    ];
    const result = await new CallGraphBuilder().build(files);
    // The same-file call keeps its strongly-resolved label.
    expect(findEdge(result, 'run', 'localHelper')?.confidence).toBe('same_file');
    // Only the barrel-crossed edge wears re_export.
    const reExportEdges = result.edges.filter(e => e.confidence === 're_export');
    expect(reExportEdges.every(e => result.nodes.get(e.calleeId)?.name === 'doWork')).toBe(true);
  });
});
