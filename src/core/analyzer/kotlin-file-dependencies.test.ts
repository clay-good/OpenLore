/**
 * Kotlin imports resolve through the declared-package index, and exports follow declared
 * visibility (change: add-kotlin-file-dependency-and-exports, issue #546).
 */
import { describe, expect, it } from 'vitest';
import { computeFileImportEdges } from './dependency-graph.js';
import {
  ImportExportParser, buildJvmPackageIndex, extractsExports, parseKotlinExports, parseKotlinImports,
  parseKotlinPackage, type JvmImportReceipt,
} from './import-parser.js';

async function graph(files: Record<string, string>) {
  const parser = new ImportExportParser();
  const analyses = new Map(Object.entries(files).map(([path, content]) => [`/repo/${path}`, parser.parseContent(`/repo/${path}`, content)]));
  const index = buildJvmPackageIndex([...analyses].map(([file, analysis]) => ({ file, jvm: analysis.jvm })));
  const fileSet = new Set(analyses.keys());
  const receipts: Record<JvmImportReceipt, number> = { 'wildcard-unresolved': 0, ambiguous: 0 };
  const edges: string[] = [];
  for (const [file, analysis] of analyses) {
    for (const e of await computeFileImportEdges(file, analysis, fileSet, '/repo', undefined, index, receipts)) {
      edges.push(`${e.source.slice(6)} -> ${e.target.slice(6)} [${e.importedNames.join(',')}]`);
    }
  }
  return { edges: edges.sort(), receipts, analyses };
}

describe('Kotlin imports', () => {
  it('parses the package, plain, aliased, and wildcard imports, and marks built-ins', () => {
    const source = 'package com.acme.app\n\nimport com.acme.repo.Store\nimport com.acme.util.slugify as slug\nimport com.acme.repo.*\nimport kotlin.math.max\nimport java.util.UUID\nimport kotlinx.coroutines.launch\n\nfun f() {}\n';
    expect(parseKotlinPackage(source)).toBe('com.acme.app');
    expect(parseKotlinPackage('fun f() {}')).toBe('');
    expect(parseKotlinImports(source).map(i => [i.source, i.importedNames[0], i.hasNamespace, i.isBuiltin, i.line])).toEqual([
      ['com.acme.repo.Store', 'Store', false, false, 3],
      ['com.acme.util.slugify', 'slug', false, false, 4],
      ['com.acme.repo', '*', true, false, 5],
      ['kotlin.math.max', 'max', false, true, 6],
      ['java.util.UUID', 'UUID', false, true, 7],
      ['kotlinx.coroutines.launch', 'launch', false, false, 8],
    ]);
    expect(parseKotlinImports(source)[1].importedSourceNames).toEqual(['slugify']);
  });

  it('resolves a type, a top-level function, a top-level property, a nested type, and an object member', async () => {
    const { edges } = await graph({
      'a/Decl.kt': 'package lib\nclass Store {\n  class Inner\n}\nobject Env {\n  fun port() = 1\n}\nfun open() = 1\nval limit = 2\n',
      'b/Use.kt': 'package app\nimport lib.Store\nimport lib.open\nimport lib.limit\nimport lib.Store.Inner\nimport lib.Env.port\nfun f() {}\n',
    });
    expect(edges).toEqual([
      'b/Use.kt -> a/Decl.kt [Inner]', 'b/Use.kt -> a/Decl.kt [Store]', 'b/Use.kt -> a/Decl.kt [limit]',
      'b/Use.kt -> a/Decl.kt [open]', 'b/Use.kt -> a/Decl.kt [port]',
    ]);
  });

  it('resolves by declared package, not by directory', async () => {
    const { edges } = await graph({
      'src/main/kotlin/misc/Util.kt': 'package com.acme.util\nfun helper() = 1\n',
      'src/main/kotlin/com/acme/util/Decoy.kt': 'package other\nfun helper() = 2\n',
      'src/main/kotlin/App.kt': 'package app\nimport com.acme.util.helper\nfun f() = helper()\n',
    });
    expect(edges).toEqual(['src/main/kotlin/App.kt -> src/main/kotlin/misc/Util.kt [helper]']);
  });

  it('reaches, through a wildcard import, only the files that declare a name the importer uses', async () => {
    const { edges, receipts } = await graph({
      'repo/Stores.kt': 'package lib.repo\nfun openStore() = 1\n',
      'repo/Unused.kt': 'package lib.repo\nfun neverCalled() = 2\n',
      'app/Uses.kt': 'package app\nimport lib.repo.*\nfun f() = openStore()\n',
      'app/UsesNothing.kt': 'package app\nimport lib.repo.*\n// openStore is only named in this comment\nfun g() = 1\n',
      'app/Library.kt': 'package app\nimport io.ktor.server.routing.*\nfun h() = 1\n',
    });
    expect(edges).toEqual(['app/Uses.kt -> repo/Stores.kt [*]']);
    // The wildcard import of a repository package that reaches nothing is counted; a library
    // package is not a miss.
    expect(receipts).toEqual({ 'wildcard-unresolved': 1, ambiguous: 0 });
  });

  it('creates no edge for a name declared in two files, and counts it', async () => {
    const { edges, receipts } = await graph({
      'a/One.kt': 'package lib\nfun make() = 1\n',
      'a/Two.kt': 'package lib\nfun make() = 2\n',
      'b/Use.kt': 'package app\nimport lib.make\nfun f() = make()\n',
    });
    expect(edges).toEqual([]);
    expect(receipts.ambiguous).toBe(1);
  });

  it('resolves Java imports of Kotlin declarations and Kotlin imports of Java declarations', async () => {
    const { edges } = await graph({
      'k/Service.kt': 'package lib\nclass Service\nfun openStore() = 1\n',
      'j/Tool.java': 'package legacy;\npublic class Tool {}\n',
      'j/Caller.java': 'package legacy;\nimport lib.Service;\nimport lib.ServiceKt;\nimport java.util.List;\npublic class Caller {}\n',
      'k/Use.kt': 'package app\nimport legacy.Tool\nfun f() {}\n',
    });
    expect(edges).toEqual([
      'j/Caller.java -> k/Service.kt [ServiceKt]', 'j/Caller.java -> k/Service.kt [Service]', 'k/Use.kt -> j/Tool.java [Tool]',
    ]);
  });

  it('does not let a private declaration be an import target', async () => {
    const { edges } = await graph({
      'a/Hidden.kt': 'package lib\nprivate fun secret() = 1\n',
      'b/Use.kt': 'package app\nimport lib.secret\nfun f() {}\n',
    });
    expect(edges).toEqual([]);
  });

  it('resolves nothing for a Kotlin file when no index is given, and never reads the directory layout', async () => {
    const parser = new ImportExportParser();
    const analysis = parser.parseContent('/repo/b/Use.kt', 'package app\nimport lib.Store\nfun f() {}\n');
    expect(await computeFileImportEdges('/repo/b/Use.kt', analysis, new Set(['/repo/lib/Store.kt']), '/repo')).toEqual([]);
  });
});

describe('Kotlin exports', () => {
  const source = [
    '@file:JvmName("Tools")',
    'package lib',
    'fun open() = 1',
    'internal fun moduleOnly() = 2',
    'private fun secret() = 3',
    'fun String.slugify() = lowercase()',
    '@JvmName("renamed")',
    'fun original() = 4',
    'val limit = 5',
    'typealias Handler = (String) -> Unit',
    'data class User(val id: String) {',
    '  fun label() = id',
    '  protected fun guarded() = id',
    '  private fun hidden() = id',
    '  internal fun inner() = id',
    '  companion object {',
    '    fun make() = User("x")',
    '  }',
    '}',
    'private class Secret {',
    '  fun unreachable() = 1',
    '}',
    'internal object Registry {',
    '  fun lookup() = 1',
    '}',
    'sealed interface Event',
    'enum class Mode { ON }',
  ].join('\n');

  it('lists public and protected declarations, tags internal ones, and omits private ones', () => {
    const exports = parseKotlinExports(source);
    expect(exports.map(e => `${e.owner ? `${e.owner}.` : ''}${e.name}:${e.visibility ?? 'public'}`)).toEqual([
      'open:public', 'moduleOnly:internal', 'slugify:public', 'original:public', 'limit:public', 'Handler:public',
      'User:public', 'User.label:public', 'User.guarded:protected', 'User.inner:internal', 'User.make:public',
      'Registry:internal', 'Registry.lookup:internal', 'Event:public', 'Mode:public',
    ]);
  });

  it('records the kind and the JVM alias of each export', () => {
    const by = Object.fromEntries(parseKotlinExports(source).map(e => [e.name, e]));
    expect(by.open).toMatchObject({ kind: 'function', declarationKind: 'function' });
    expect(by.slugify.declarationKind).toBe('extension-function');
    expect(by.original.jvmAlias).toBe('renamed');
    expect(by.limit).toMatchObject({ kind: 'variable', declarationKind: 'property' });
    expect(by.Handler).toMatchObject({ kind: 'type', declarationKind: 'typealias' });
    expect(by.User).toMatchObject({ kind: 'class', declarationKind: 'data' });
    expect(by.Registry.declarationKind).toBe('object');
    expect(by.Event).toMatchObject({ kind: 'interface', declarationKind: 'interface' });
    expect(by.Mode).toMatchObject({ kind: 'enum', declarationKind: 'enum' });
  });

  it('reports Kotlin as an extracted language with no unsupported-type error', () => {
    expect(extractsExports('a/B.kt')).toBe(true);
    expect(extractsExports('build.gradle.kts')).toBe(true);
    const analysis = new ImportExportParser().parseContent('/repo/A.kt', source);
    expect(analysis.parseErrors).toEqual([]);
    expect(analysis.exports.length).toBeGreaterThan(10);
    expect(analysis.jvm).toEqual({ package: 'lib', declares: ['open', 'moduleOnly', 'slugify', 'original', 'limit', 'Handler', 'User', 'Registry', 'Event', 'Mode', 'Tools'] });
  });
});
