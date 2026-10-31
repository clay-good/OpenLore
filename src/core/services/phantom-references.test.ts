/**
 * Phantom-reference findings (change: add-phantom-reference-findings), over real files and real git
 * repositories: the four codes, the candidate discipline, and every disclosure that keeps an
 * unjudgeable reference from reading as resolved. Plain .test.ts so CI runs it.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

import {
  addedReferences, checkPhantomReferences, prefixCandidates, supportsImports,
  PHANTOM_REFERENCE_CODES,
} from './phantom-references.js';
import { isKnownFindingCode, sourceDefaultClass } from './mcp-handlers/enforcement-policy.js';
import { parseJSImports } from '../analyzer/import-parser.js';

const ENV = {
  ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@e.com', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@e.com',
};
const git = (cwd: string, args: string[]) => execFileSync('git', args, { cwd, stdio: 'ignore', env: ENV });
const write = (cwd: string, rel: string, content: string) => {
  const p = join(cwd, rel); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, content);
};

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

/** A git repository with `files` committed, then `edits` written to the working tree. */
function repo(files: Record<string, string>, edits: Record<string, string> = {}): string {
  const d = mkdtempSync(join(tmpdir(), 'openlore-phantom-'));
  dirs.push(d);
  git(d, ['init', '-q', '-b', 'main']);
  for (const [f, c] of Object.entries(files)) write(d, f, c);
  git(d, ['add', '-A']);
  git(d, ['commit', '-q', '-m', 'base']);
  for (const [f, c] of Object.entries(edits)) write(d, f, c);
  return d;
}

const PKG = (deps: Record<string, string> = {}) => JSON.stringify({ name: 'app', dependencies: deps }, null, 2);
const codes = (r: { findings: Array<{ code: string }> }) => r.findings.map(f => f.code).sort();

describe('added-reference extraction (pure)', () => {
  const imports = (src: string) => parseJSImports(src);

  it('reports only what the head added, comparing by specifier and bound names', () => {
    const base = imports("import { a } from './x';\nimport { keep } from './y';\n");
    const head = imports("import { keep } from './y';\nimport { a, b } from './x';\nimport fresh from './z';\n");
    const added = addedReferences('src/f.ts', base, head);
    expect(added.map(r => [r.specifier, r.names])).toEqual([['./x', ['a', 'b']], ['./z', []]]);
  });

  it('treats every import of an added file as added, and records the line', () => {
    const added = addedReferences('src/f.ts', null, imports("\nimport { a } from './x';\n"));
    expect(added).toHaveLength(1);
    expect(added[0].line).toBe(2);
  });

  it('checks an aliased name under the name the target must export', () => {
    const added = addedReferences('src/f.ts', [], imports("import { real as local } from './x';\n"));
    expect(added[0].names).toEqual(['real']);
  });

  it('binds no name for a default or namespace import', () => {
    const added = addedReferences('src/f.ts', [], imports("import d from './x';\nimport * as ns from './y';\n"));
    expect(added.map(r => [r.specifier, r.names, r.wholeModule])).toEqual([['./x', [], true], ['./y', [], true]]);
  });
});

describe('candidate discipline (pure)', () => {
  it('offers names that share a prefix, longest first, at most three', () => {
    expect(prefixCandidates('formatDate', ['formatTime', 'formatDuration', 'parse', 'formatDateTime']))
      .toEqual(['formatDateTime', 'formatDuration', 'formatTime']);
  });

  it('offers nothing when no name shares a real prefix', () => {
    expect(prefixCandidates('formatDate', ['parse', 'run', 'x'])).toEqual([]);
  });

  it('never offers the name itself', () => {
    expect(prefixCandidates('parse', ['parse'])).toEqual([]);
  });
});

describe('finding codes', () => {
  it('registers every emitted code as advisory', () => {
    for (const code of PHANTOM_REFERENCE_CODES) {
      expect(isKnownFindingCode(code), code).toBe(true);
      expect(sourceDefaultClass(code), code).toBe('advisory');
    }
  });
});

describe('internal references', () => {
  it('reports an invented named export with the names the target does have (spec scenario)', async () => {
    const d = repo(
      {
        'package.json': PKG(),
        'packages/utils/index.ts': 'export function formatTime(): string { return ""; }\nexport const formatDuration = 1;\n',
        'src/app.ts': 'export const x = 1;\n',
      },
      { 'src/app.ts': "import { formatDate } from '../packages/utils/index.js';\nexport const x = 1;\n" },
    );
    const r = await checkPhantomReferences(d, 'HEAD');
    expect(codes(r)).toEqual(['unresolved-internal-symbol']);
    expect(r.findings[0].message).toContain('formatDate');
    expect(r.findings[0].message).toContain('formatTime');
    expect(r.findings[0].location).toMatchObject({ path: 'src/app.ts', line: 1 });
  });

  it('reports nothing when the name really is exported', async () => {
    const d = repo(
      { 'package.json': PKG(), 'src/utils.ts': 'export function formatDate(): string { return ""; }\n', 'src/app.ts': 'export const x = 1;\n' },
      { 'src/app.ts': "import { formatDate } from './utils.js';\nexport const x = 1;\n" },
    );
    expect((await checkPhantomReferences(d, 'HEAD')).findings).toEqual([]);
  });

  it('resolves a symbol the same diff adds, because exports are read from current content', async () => {
    const d = repo(
      { 'package.json': PKG(), 'src/utils.ts': 'export const old = 1;\n', 'src/app.ts': 'export const x = 1;\n' },
      {
        'src/utils.ts': 'export const old = 1;\nexport function brandNew(): void {}\n',
        'src/app.ts': "import { brandNew } from './utils.js';\nexport const x = 1;\n",
      },
    );
    expect((await checkPhantomReferences(d, 'HEAD')).findings).toEqual([]);
  });

  it('reports an import whose file does not exist, with a nearby corpus path', async () => {
    const d = repo(
      { 'package.json': PKG(), 'src/helpers.ts': 'export const a = 1;\n', 'src/app.ts': 'export const x = 1;\n' },
      { 'src/app.ts': "import { a } from './helper.js';\nexport const x = 1;\n" },
    );
    const r = await checkPhantomReferences(d, 'HEAD', undefined, ['src/helpers.ts', 'src/app.ts']);
    expect(codes(r)).toEqual(['unresolved-internal-import']);
    expect(r.findings[0].message).toContain('src/helpers.ts');
  });

  it('follows a barrel to the module that really exports the name', async () => {
    const d = repo(
      {
        'package.json': PKG(),
        'src/lib/deep.ts': 'export function deepFn(): void {}\n',
        'src/lib/index.ts': "export * from './deep.js';\n",
        'src/app.ts': 'export const x = 1;\n',
      },
      { 'src/app.ts': "import { deepFn } from './lib/index.js';\nexport const x = 1;\n" },
    );
    expect((await checkPhantomReferences(d, 'HEAD')).findings).toEqual([]);
  });

  it('makes no symbol claim when the target re-exports from a package it cannot follow', async () => {
    const d = repo(
      {
        'package.json': PKG({ lodash: '^4.0.0' }),
        'src/lib/index.ts': "export * from 'lodash';\nexport const own = 1;\n",
        'src/app.ts': 'export const x = 1;\n',
      },
      { 'src/app.ts': "import { whoKnows } from './lib/index.js';\nexport const x = 1;\n" },
    );
    const r = await checkPhantomReferences(d, 'HEAD');
    expect(r.findings).toEqual([]);
    expect(r.notAssessed.map(n => n.reason).join(' ')).toContain('cannot follow');
  });
});

describe('external references', () => {
  it('reports an undeclared package and says nothing about the standard library (spec scenario)', async () => {
    const d = repo(
      { 'package.json': PKG({ 'left-pad': '^1.0.0' }), 'src/app.ts': 'export const x = 1;\n' },
      { 'src/app.ts': "import pad from 'left-padx';\nimport { readFile } from 'node:fs';\nimport real from 'left-pad';\nexport const x = [pad, readFile, real];\n" },
    );
    const r = await checkPhantomReferences(d, 'HEAD');
    expect(codes(r)).toEqual(['undeclared-dependency']);
    expect(r.findings[0].subject).toBe('left-padx');
  });

  it('accepts a subpath of a declared package and a declared optional dependency', async () => {
    const d = repo(
      {
        'package.json': JSON.stringify({ name: 'app', dependencies: { lodash: '^4' }, optionalDependencies: { fsevents: '^2' } }),
        'src/app.ts': 'export const x = 1;\n',
      },
      { 'src/app.ts': "import fp from 'lodash/fp';\nimport ev from 'fsevents';\nexport const x = [fp, ev];\n" },
    );
    expect((await checkPhantomReferences(d, 'HEAD')).findings).toEqual([]);
  });

  it('reads the manifest nearest the file in a monorepo', async () => {
    const d = repo(
      {
        'package.json': PKG(),
        'packages/a/package.json': PKG({ dep: '^1.0.0' }),
        'packages/a/src/app.ts': 'export const x = 1;\n',
      },
      { 'packages/a/src/app.ts': "import d from 'dep';\nimport o from 'other';\nexport const x = [d, o];\n" },
    );
    const r = await checkPhantomReferences(d, 'HEAD');
    expect(r.findings.map(f => f.subject)).toEqual(['other']);
  });

  it('treats a workspace package name as internal', async () => {
    const d = repo(
      {
        'package.json': JSON.stringify({ name: 'root', workspaces: ['packages/*'] }),
        'packages/utils/package.json': JSON.stringify({ name: '@app/utils', version: '1.0.0' }),
        'packages/web/package.json': JSON.stringify({ name: '@app/web', dependencies: { '@app/utils': 'workspace:*' } }),
        'packages/web/src/app.ts': 'export const x = 1;\n',
      },
      { 'packages/web/src/app.ts': "import u from '@app/utils';\nexport const x = u;\n" },
    );
    expect((await checkPhantomReferences(d, 'HEAD')).findings).toEqual([]);
  });

  it('discloses a tsconfig paths alias instead of reporting it', async () => {
    const d = repo(
      {
        'package.json': PKG(),
        'tsconfig.json': '{\n  // a comment, legal here\n  "compilerOptions": { "paths": { "@app/*": ["src/*"] } },\n}\n',
        'src/app.ts': 'export const x = 1;\n',
      },
      { 'src/app.ts': "import thing from '@app/thing';\nexport const x = thing;\n" },
    );
    const r = await checkPhantomReferences(d, 'HEAD');
    expect(r.findings).toEqual([]);
    expect(r.boundaries.join(' ')).toContain('@app/thing');
  });

  it('does not judge an ecosystem with no manifest in scope', async () => {
    const d = repo({ 'src/app.ts': 'export const x = 1;\n' }, { 'src/app.ts': "import pad from 'left-padx';\nexport const x = pad;\n" });
    const r = await checkPhantomReferences(d, 'HEAD');
    expect(r.findings).toEqual([]);
    expect(r.notAssessed.map(n => n.reason).join(' ')).toContain('no npm manifest');
  });

  it('does not judge an ecosystem whose manifest did not parse', async () => {
    const d = repo(
      { 'package.json': '{ this is not json', 'src/app.ts': 'export const x = 1;\n' },
      { 'src/app.ts': "import pad from 'left-padx';\nexport const x = pad;\n" },
    );
    const r = await checkPhantomReferences(d, 'HEAD');
    expect(r.findings).toEqual([]);
    expect(r.boundaries.join(' ')).toContain('did not parse');
  });

  it('reports a Python import no requirement declares, and never the standard library', async () => {
    const d = repo(
      { 'requirements.txt': 'requests>=2.0\n', 'app.py': 'x = 1\n' },
      { 'app.py': 'import os\nimport requests\nimport reqeusts\nx = 1\n' },
    );
    const r = await checkPhantomReferences(d, 'HEAD');
    expect(r.findings.map(f => f.subject)).toEqual(['reqeusts']);
  });

  it('treats a Go import under the declared module path as internal, and std as std', async () => {
    const d = repo(
      {
        'go.mod': 'module github.com/acme/app\n\ngo 1.22\n\nrequire (\n\tgithub.com/pkg/errors v0.9.1\n)\n',
        'main.go': 'package main\n',
      },
      { 'main.go': 'package main\n\nimport (\n\t"fmt"\n\t"net/http"\n\t"github.com/acme/app/internal/db"\n\t"github.com/pkg/errors"\n\t"github.com/nope/missing"\n)\n' },
    );
    const r = await checkPhantomReferences(d, 'HEAD');
    expect(r.findings.map(f => f.subject)).toEqual(['github.com/nope/missing']);
  });
});

describe('lockfile pinning', () => {
  const lock = (names: string[]) => JSON.stringify({
    lockfileVersion: 3,
    packages: Object.fromEntries([['', { name: 'app' }], ...names.map(n => [`node_modules/${n}`, { version: '1.0.0' }])]),
  });

  it('reports a dependency the changed manifest declares but the lockfile does not pin', async () => {
    const d = repo(
      { 'package.json': PKG({ old: '^1.0.0' }), 'package-lock.json': lock(['old']), 'src/app.ts': 'export const x = 1;\n' },
      {
        'package.json': PKG({ old: '^1.0.0', fresh: '^2.0.0' }),
        'src/app.ts': "import f from 'fresh';\nexport const x = f;\n",
      },
    );
    const r = await checkPhantomReferences(d, 'HEAD');
    expect(codes(r)).toEqual(['unpinned-dependency']);
    expect(r.findings[0].subject).toBe('fresh');
    expect(r.findings[0].location?.path).toBe('package.json');
  });

  it('reports nothing once the lockfile pins it', async () => {
    const d = repo(
      { 'package.json': PKG({ old: '^1.0.0' }), 'package-lock.json': lock(['old']), 'src/app.ts': 'export const x = 1;\n' },
      {
        'package.json': PKG({ old: '^1.0.0', fresh: '^2.0.0' }),
        'package-lock.json': lock(['old', 'fresh']),
        'src/app.ts': "import f from 'fresh';\nexport const x = f;\n",
      },
    );
    expect((await checkPhantomReferences(d, 'HEAD')).findings).toEqual([]);
  });

  it('reports nothing when the manifest did not change in the diff', async () => {
    const d = repo(
      { 'package.json': PKG({ fresh: '^2.0.0' }), 'package-lock.json': lock([]), 'src/app.ts': 'export const x = 1;\n' },
      { 'src/app.ts': "import f from 'fresh';\nexport const x = f;\n" },
    );
    expect((await checkPhantomReferences(d, 'HEAD')).findings).toEqual([]);
  });

  it('reports nothing when no lockfile exists at all', async () => {
    const d = repo(
      { 'package.json': PKG({ old: '^1.0.0' }), 'src/app.ts': 'export const x = 1;\n' },
      { 'package.json': PKG({ old: '^1.0.0', fresh: '^2.0.0' }), 'src/app.ts': "import f from 'fresh';\nexport const x = f;\n" },
    );
    expect((await checkPhantomReferences(d, 'HEAD')).findings).toEqual([]);
  });
});

describe('scope and honesty', () => {
  it('says which language has no import support instead of calling the file clean', () => {
    expect(supportsImports('src/a.ts')).toBe(true);
    expect(supportsImports('main.go')).toBe(true);
    expect(supportsImports('lib.rb')).toBe(false);
    expect(supportsImports('README.md')).toBe(false);
  });

  it('checks an added file whose base revision does not exist', async () => {
    const d = repo({ 'package.json': PKG(), 'src/keep.ts': 'export const k = 1;\n' }, {});
    write(d, 'src/new.ts', "import pad from 'left-padx';\nexport const x = pad;\n");
    git(d, ['add', 'src/new.ts']);
    const r = await checkPhantomReferences(d, 'HEAD');
    expect(r.findings.map(f => f.subject)).toEqual(['left-padx']);
    expect(r.summary.filesChecked).toBe(1);
  });

  it('counts what it looked at, so no finding is readable as no check', async () => {
    const d = repo(
      { 'package.json': PKG({ dep: '^1' }), 'src/app.ts': 'export const x = 1;\n' },
      { 'src/app.ts': "import d from 'dep';\nexport const x = d;\n" },
    );
    const r = await checkPhantomReferences(d, 'HEAD');
    expect(r.findings).toEqual([]);
    expect(r.summary).toEqual({ filesChecked: 1, referencesChecked: 1 });
  });

  it('is unaffected by a deleted file', async () => {
    const d = repo({ 'package.json': PKG(), 'src/gone.ts': "import pad from 'left-padx';\nexport const x = pad;\n" });
    rmSync(join(d, 'src/gone.ts'));
    expect((await checkPhantomReferences(d, 'HEAD')).findings).toEqual([]);
  });

  it('makes no network request on any path', async () => {
    const d = repo(
      { 'package.json': PKG(), 'src/app.ts': 'export const x = 1;\n' },
      { 'src/app.ts': "import pad from 'left-padx';\nimport { nope } from './missing.js';\nexport const x = [pad, nope];\n" },
    );
    const realFetch = globalThis.fetch;
    let called = 0;
    globalThis.fetch = (() => { called++; throw new Error('network access attempted'); }) as typeof fetch;
    try {
      const r = await checkPhantomReferences(d, 'HEAD');
      expect(codes(r)).toEqual(['undeclared-dependency', 'unresolved-internal-import']);
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(called).toBe(0);
  });
});

describe('languages this check cannot read', () => {
  it('discloses a file whose imports it cannot extract instead of calling it clean (spec scenario)', async () => {
    const d = repo(
      { 'package.json': PKG(), 'src/Main.java': 'class Main {}\n' },
      { 'src/Main.java': 'import com.nope.Missing;\n\nclass Main {}\n' },
    );
    const r = await checkPhantomReferences(d, 'HEAD');
    expect(r.findings).toEqual([]);
    expect(r.notAssessed).toEqual([{ file: 'src/Main.java', reason: 'this check cannot read Java imports' }]);
  });

  it('skips a language with no import support at all', async () => {
    const d = repo({ 'lib.rb': 'x = 1\n' }, { 'lib.rb': "require 'nope'\nx = 1\n" });
    const r = await checkPhantomReferences(d, 'HEAD');
    expect(r.findings).toEqual([]);
    expect(r.notAssessed).toEqual([]);
    expect(r.summary.filesChecked).toBe(0);
  });
});

describe('Go internal packages', () => {
  const goMod = 'module github.com/acme/app\n\ngo 1.22\n';

  it('reports an import under the module path that names no package directory', async () => {
    const d = repo(
      { 'go.mod': goMod, 'internal/db/db.go': 'package db\n', 'main.go': 'package main\n' },
      { 'main.go': 'package main\n\nimport (\n\t"github.com/acme/app/internal/db"\n\t"github.com/acme/app/internal/nope"\n)\n' },
    );
    const r = await checkPhantomReferences(d, 'HEAD', undefined, ['go.mod', 'internal/db/db.go', 'main.go']);
    expect(r.findings.map(f => f.subject)).toEqual(['github.com/acme/app/internal/nope']);
    expect(r.findings[0].code).toBe('unresolved-internal-import');
  });

  it('makes no claim about an internal Go package when the index is unavailable', async () => {
    const d = repo(
      { 'go.mod': goMod, 'main.go': 'package main\n' },
      { 'main.go': 'package main\n\nimport "github.com/acme/app/internal/nope"\n' },
    );
    expect((await checkPhantomReferences(d, 'HEAD')).findings).toEqual([]);
  });

  it('reports a go.sum that does not pin a newly required module', async () => {
    const d = repo(
      {
        'go.mod': goMod + '\nrequire github.com/pkg/errors v0.9.1\n',
        'go.sum': 'github.com/pkg/errors v0.9.1 h1:abc=\ngithub.com/pkg/errors v0.9.1/go.mod h1:def=\n',
        'main.go': 'package main\n',
      },
      {
        'go.mod': goMod + '\nrequire (\n\tgithub.com/pkg/errors v0.9.1\n\tgithub.com/fresh/mod v1.0.0\n)\n',
        'main.go': 'package main\n\nimport "github.com/fresh/mod/sub"\n',
      },
    );
    const r = await checkPhantomReferences(d, 'HEAD');
    expect(codes(r)).toEqual(['unpinned-dependency']);
    expect(r.findings[0].subject).toBe('github.com/fresh/mod/sub');
  });
});
