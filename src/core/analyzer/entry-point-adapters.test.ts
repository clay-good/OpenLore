/**
 * Framework entry-point adapters (change: add-framework-entry-point-adapters): deterministic config
 * readers that add receipted liveness evidence, and disclose what they cannot resolve.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { collectExternalWiring, stripJsonComments } from './entry-point-adapters.js';

let root: string;
let outside: string;

async function put(path: string, content = 'export {};\n'): Promise<void> {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), content);
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'ol-wiring-'));
  outside = await mkdtemp(join(tmpdir(), 'ol-wiring-outside-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

describe('collectExternalWiring — package.json', () => {
  it('maps bin, main, and exports build outputs back to their TypeScript sources, with receipts', async () => {
    await put('tsconfig.json', '{\n  // build layout\n  "compilerOptions": { "outDir": "dist", "rootDir": "src", },\n}\n');
    await put('src/cli/index.ts');
    await put('src/api/index.ts');
    await put('package.json', JSON.stringify({
      bin: { tool: 'dist/cli/index.js' },
      main: 'dist/api/index.js',
      exports: { '.': { import: './dist/api/index.js', types: './dist/api/index.d.ts' }, './features/*': './dist/features/*.js' },
    }));
    const report = await collectExternalWiring(root);
    expect(report.wired).toEqual([
      { file: 'src/api/index.ts', receipts: [
        { config: 'package.json', key: 'exports["."]["import"]' },
        { config: 'package.json', key: 'main' },
      ] },
      { file: 'src/cli/index.ts', receipts: [{ config: 'package.json', key: 'bin.tool' }] },
    ]);
    expect(report.boundaries).toEqual([
      { config: 'package.json', key: 'exports["./features/*"]', reference: './dist/features/*.js', reason: 'dynamic-reference' },
    ]);
  });

  it('reads the script files npm scripts run, and discloses what it cannot resolve', async () => {
    await put('scripts/build.ts');
    await put('tools/check.mjs');
    await put('package.json', JSON.stringify({
      scripts: {
        build: 'tsx scripts/build.ts && node ./tools/check.mjs --strict',
        test: 'vitest run src',
        dynamic: 'node $SCRIPT',
        missing: 'node scripts/gone.js',
        escape: 'node ../elsewhere/run.js',
      },
    }));
    const report = await collectExternalWiring(root);
    expect(report.wired).toEqual([
      { file: 'scripts/build.ts', receipts: [{ config: 'package.json', key: 'scripts.build' }] },
      { file: 'tools/check.mjs', receipts: [{ config: 'package.json', key: 'scripts.build' }] },
    ]);
    expect(report.boundaries).toEqual([
      { config: 'package.json', key: 'scripts.dynamic', reference: '$SCRIPT', reason: 'dynamic-reference' },
      { config: 'package.json', key: 'scripts.escape', reference: '../elsewhere/run.js', reason: 'outside-repository' },
      { config: 'package.json', key: 'scripts.missing', reference: 'scripts/gone.js', reason: 'target-not-found' },
    ]);
  });

  it('prefers the TypeScript source over a built output that also exists on disk', async () => {
    await put('tsconfig.json', '{ "compilerOptions": { "outDir": "dist", "rootDir": "src" } }');
    await put('src/cli/index.ts');
    await put('dist/cli/index.js');
    await put('package.json', JSON.stringify({ bin: 'dist/cli/index.js', scripts: { start: 'node dist/cli/index.js' } }));
    const report = await collectExternalWiring(root);
    expect(report.wired).toEqual([{ file: 'src/cli/index.ts', receipts: [
      { config: 'package.json', key: 'bin' },
      { config: 'package.json', key: 'scripts.start' },
    ] }]);
  });

  it('reports a repeated unresolved reference once', async () => {
    await put('package.json', JSON.stringify({ scripts: { twice: 'node gone.js && node gone.js' } }));
    const report = await collectExternalWiring(root);
    expect(report.boundaries).toEqual([
      { config: 'package.json', key: 'scripts.twice', reference: 'gone.js', reason: 'target-not-found' },
    ]);
  });

  it('discloses a manifest it cannot parse instead of guessing', async () => {
    await put('package.json', '{ "bin": ');
    const report = await collectExternalWiring(root);
    expect(report.wired).toEqual([]);
    expect(report.boundaries).toEqual([{ config: 'package.json', key: '', reference: 'package.json', reason: 'unparsed-config' }]);
  });

  it('never resolves a target through a symlink that leaves the repository', async ({ skip }) => {
    if (process.platform === 'win32') skip();
    await writeFile(join(outside, 'secret.js'), 'x');
    await symlink(outside, join(root, 'linked'));
    await put('package.json', JSON.stringify({ main: 'linked/secret.js' }));
    const report = await collectExternalWiring(root);
    expect(report.wired).toEqual([]);
    expect(report.boundaries.map(b => b.reason)).toEqual(['outside-repository']);
  });
});

describe('collectExternalWiring — tsconfig and test runners', () => {
  it('reads tsconfig files and literal setup files, and discloses a non-literal setting', async () => {
    await put('tsconfig.json', '{ "files": ["src/entry.ts", "types/global.d.ts"] }');
    await put('src/entry.ts');
    await put('vitest.setup.ts');
    await put('vitest.config.ts', "export default defineConfig({ test: { setupFiles: ['./vitest.setup.ts'], globalSetup: setupPath } });\n");
    const report = await collectExternalWiring(root);
    expect(report.wired).toEqual([
      { file: 'src/entry.ts', receipts: [{ config: 'tsconfig.json', key: 'files' }] },
      { file: 'vitest.setup.ts', receipts: [{ config: 'vitest.config.ts', key: 'setupFiles' }] },
    ]);
    expect(report.boundaries).toEqual([
      { config: 'vitest.config.ts', key: 'globalSetup', reference: 'setupPath', reason: 'unparsed-config' },
    ]);
  });
});

describe('collectExternalWiring — GitHub Actions', () => {
  it('reads run steps relative to their working directory and discloses expressions', async () => {
    await put('scripts/release.sh');
    await put('tools/scripts/verify.js');
    await put('.github/workflows/ci.yml', [
      'jobs:',
      '  build:',
      '    steps:',
      '      - uses: actions/checkout@v4',
      '      - run: bash scripts/release.sh --dry-run',
      '      - run: node scripts/verify.js',
      '        working-directory: tools',
      '      - run: node ${{ matrix.script }}',
      '',
    ].join('\n'));
    const report = await collectExternalWiring(root);
    expect(report.wired).toEqual([
      { file: 'scripts/release.sh', receipts: [{ config: '.github/workflows/ci.yml', key: 'jobs.build.steps[1].run' }] },
      { file: 'tools/scripts/verify.js', receipts: [{ config: '.github/workflows/ci.yml', key: 'jobs.build.steps[2].run' }] },
    ]);
    expect(report.boundaries).toEqual([
      { config: '.github/workflows/ci.yml', key: 'jobs.build.steps[3].run', reference: '${{ }}', reason: 'dynamic-reference' },
    ]);
  });

  it('contributes nothing for a repository with no supported config', async () => {
    await put('src/orphan.ts');
    expect(await collectExternalWiring(root)).toEqual({ wired: [], boundaries: [], boundariesOmitted: 0 });
  });
});

describe('stripJsonComments', () => {
  it('removes comments and trailing commas without touching string contents', () => {
    const source = '{ "url": "http://x//y", /* block */ "a": [1, 2,], // line\n "b": "/*keep*/", }';
    expect(JSON.parse(stripJsonComments(source))).toEqual({ url: 'http://x//y', a: [1, 2], b: '/*keep*/' });
  });
});
