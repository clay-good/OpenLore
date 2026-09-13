/**
 * Framework entry-point adapters (change: add-framework-entry-point-adapters): deterministic config
 * readers that add receipted liveness evidence, and disclose what they cannot resolve.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { collectExternalWiring, stripJsonComments, type ExternalWiringReport } from './entry-point-adapters.js';

let root: string;
let outside: string;

async function put(path: string, content = 'export {};\n'): Promise<void> {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), content);
}

const files = (report: ExternalWiringReport) => report.wired.map(w => w.file);

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
      exports: {
        '.': { import: './dist/api/index.js', types: './dist/api/index.d.ts' },
        './features/*': './dist/features/*.js',
        './package.json': './package.json',
      },
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

  it('names a build output with no mapped source instead of calling it missing', async () => {
    await put('tsconfig.json', '{ "compilerOptions": { "outDir": "dist" } }');
    await put('src/index.ts');
    await put('package.json', JSON.stringify({ main: 'dist/index.js' }));
    const report = await collectExternalWiring(root);
    expect(report.boundaries).toEqual([
      { config: 'package.json', key: 'main', reference: 'dist/index.js', reason: 'build-output-unmapped' },
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

  it('refuses a linked or FIFO config without hanging, and discloses it', async ({ skip }) => {
    if (process.platform === 'win32') skip();
    await writeFile(join(outside, 'package.json'), JSON.stringify({ main: 'x.js' }));
    await symlink(join(outside, 'package.json'), join(root, 'package.json'));
    execFileSync('mkfifo', [join(root, 'tsconfig.json')]);
    const report = await collectExternalWiring(root);
    expect(report.wired).toEqual([]);
    expect(report.boundaries).toEqual([
      { config: 'package.json', key: '', reference: 'package.json', reason: 'unreadable-config' },
      { config: 'tsconfig.json', key: '', reference: 'tsconfig.json', reason: 'unreadable-config' },
    ]);
  }, 10_000);
});

describe('collectExternalWiring — shell commands', () => {
  it('counts only the files a command executes, never arguments, outputs, or heredoc content', async () => {
    for (const f of ['scripts/build.ts', 'tools/check.mjs', 'build.js', 'setup.cjs', 'run.ts', 'bin/tool', 'src/dead.ts', 'dist/out.js', 'old.js', 'gen.sh', 'log.js']) {
      await put(f);
    }
    await put('package.json', JSON.stringify({
      scripts: {
        build: 'tsx scripts/build.ts&&node ./tools/check.mjs --strict',
        out: 'node build.js > dist/out.js 2>log.js',
        preload: 'cross-env NODE_ENV=test node --require ./setup.cjs --import tsx run.ts',
        direct: './bin/tool --flag',
        lint: 'eslint . --ignore-pattern src/dead.ts',
        clean: 'rm -rf old.js; echo gen.sh | tee log.js',
        test: 'vitest run src/dead.ts',
      },
    }));
    const report = await collectExternalWiring(root);
    expect(files(report)).toEqual(['bin/tool', 'build.js', 'run.ts', 'scripts/build.ts', 'setup.cjs', 'tools/check.mjs']);
  });

  it('discloses variables, globs, modules by name, and paths after a cd', async () => {
    await put('scripts/a.js');
    await put('package.json', JSON.stringify({
      scripts: {
        dynamic: 'node $SCRIPT',
        glob: 'tsx src/cli-*.ts',
        module: 'python -m pkg.tool',
        moved: 'cd tools && node scripts/a.js',
        missing: 'node scripts/gone.js',
        escape: 'node ../elsewhere/run.js',
        quoted: 'node "my dir/a.js"',
      },
    }));
    const report = await collectExternalWiring(root);
    expect(report.wired).toEqual([]);
    expect(report.boundaries).toEqual([
      { config: 'package.json', key: 'scripts.dynamic', reference: '$SCRIPT', reason: 'dynamic-reference' },
      { config: 'package.json', key: 'scripts.escape', reference: '../elsewhere/run.js', reason: 'outside-repository' },
      { config: 'package.json', key: 'scripts.glob', reference: 'src/cli-*.ts', reason: 'dynamic-reference' },
      { config: 'package.json', key: 'scripts.missing', reference: 'scripts/gone.js', reason: 'target-not-found' },
      { config: 'package.json', key: 'scripts.module', reference: '-m pkg.tool', reason: 'unsupported-form' },
      { config: 'package.json', key: 'scripts.moved', reference: 'scripts/a.js', reason: 'unsupported-form' },
      { config: 'package.json', key: 'scripts.quoted', reference: 'my dir/a.js', reason: 'target-not-found' },
    ]);
  });

  it('reports a repeated unresolved reference once', async () => {
    await put('package.json', JSON.stringify({ scripts: { twice: 'node gone.js && node gone.js' } }));
    const report = await collectExternalWiring(root);
    expect(report.boundaries).toEqual([
      { config: 'package.json', key: 'scripts.twice', reference: 'gone.js', reason: 'target-not-found' },
    ]);
  });

  it('keys a case-insensitive match by the repository spelling', async () => {
    await put('src/Cased.ts');
    await put('package.json', JSON.stringify({ scripts: { run: 'tsx src/Cased.ts' } }));
    expect(files(await collectExternalWiring(root))).toEqual(['src/Cased.ts']);
  });
});

describe('collectExternalWiring — runner syntax', () => {
  it('reads each runner\'s flags: shell -e, value flags, subshells, keywords, and wrapper options', async () => {
    for (const f of ['s/e.sh', 's/ts.ts', 's/w.py', 'ignore', 's/stack.js', 's/sub.js', 'sub.js', 's/kw.sh', 's/bang.js', 's/sudo.js', 's/envu.js', 's/yarn.js']) {
      await put(f);
    }
    await put('tsconfig.json', '{}');
    await put('package.json', JSON.stringify({
      scripts: {
        shellE: 'bash -e s/e.sh',
        tsconfig: 'tsx --tsconfig tsconfig.json s/ts.ts',
        pythonW: 'python -W ignore s/w.py',
        stack: 'node --stack-size 2000 s/stack.js',
        subshell: '( cd s && node sub.js ); { cd s; node sub.js; }',
        keywords: 'if true; then bash s/kw.sh; fi; ! node s/bang.js',
        wrappers: 'sudo -u ci node s/sudo.js && env -u FOO node s/envu.js && yarn node s/yarn.js',
        tasks: 'bun run build && deno task dev && ./node_modules/.bin/tsc',
      },
    }));
    const report = await collectExternalWiring(root);
    expect(files(report)).toEqual(['s/bang.js', 's/e.sh', 's/envu.js', 's/kw.sh', 's/stack.js', 's/sudo.js', 's/ts.ts', 's/w.py', 's/yarn.js']);
    expect(report.boundaries).toEqual([
      { config: 'package.json', key: 'scripts.subshell', reference: 'sub.js', reason: 'unsupported-form' },
    ]);
  });

  it('keeps scripts after switches, restores the directory after a subshell, and reads inline shell code', async () => {
    for (const f of ['main.ts', 'runme', 'build.js', 'server.js', 'root.js', 'inner.js', 'app.js', 'script.sh', 'quoted.js']) await put(f);
    await put('package.json', JSON.stringify({
      scripts: {
        deno: 'deno run --allow-read --allow-net main.ts',
        norc: 'bash --norc runme',
        watch: 'node --watch build && node --no-warnings server',
        subshell: '(cd sub && make); node root.js',
        inline: 'sh -c "node inner.js"',
        profile: 'node --cpu-prof-dir ./prof app.js && bash --rcfile ./rc script.sh',
        escaped: 'node "quo\\"ted.js" || node quoted.js',
        quiet: 'bun test && bun install && deno fmt && deno task dev && python - <<EOF\nprint(1)\nEOF',
      },
    }));
    const report = await collectExternalWiring(root);
    expect(files(report)).toEqual(['app.js', 'build.js', 'inner.js', 'main.ts', 'quoted.js', 'root.js', 'runme', 'script.sh', 'server.js']);
    expect(report.boundaries).toEqual([
      { config: 'package.json', key: 'scripts.escaped', reference: 'quo"ted.js', reason: 'target-not-found' },
    ]);
  });

  it('keeps a subshell cd across command substitutions, reads short-flag groups, and quoted backslash paths', async () => {
    for (const f of ['b.js', 'y.js', 's.sh', 'scripts/build.js', 'test/index.js', 'build.js']) await put(f);
    await put('package.json', JSON.stringify({
      scripts: {
        subst: '(cd a && echo $(pwd) && node b.js); (cd a; n=$((1+2)); node b.js)',
        pipefail: "bash -euo pipefail -c 'node y.js' && bash -eo pipefail s.sh",
        winpath: 'node "scripts\\build.js"',
        shellBare: 'bash test',
        nodeBare: 'node build',
        cdInline: "cd x && sh -c 'node y.js'",
      },
    }));
    const report = await collectExternalWiring(root);
    expect(files(report)).toEqual(['build.js', 's.sh', 'scripts/build.js', 'y.js']);
    expect(report.boundaries).toEqual([
      { config: 'package.json', key: 'scripts.cdInline', reference: 'node y.js', reason: 'unsupported-form' },
      { config: 'package.json', key: 'scripts.shellBare', reference: 'test', reason: 'target-not-found' },
      { config: 'package.json', key: 'scripts.subst', reference: 'b.js', reason: 'unsupported-form' },
    ]);
  });

  it('reads value-taking flag groups, process substitutions, and one name run by two runners', async () => {
    for (const f of ['script.py', 'test.rb', 'scripts/gen.js', 'c.js', 'build2.js']) await put(f);
    await put('package.json', JSON.stringify({
      scripts: {
        pyW: 'python -Wonce script.py',
        rubyI: 'ruby -Iexe test.rb',
        pyModule: 'python -um pkg',
        procsub: 'diff <(node scripts/gen.js) x.js',
        substCd: 'echo $(cd a; node b.js); node c.js',
        twice: 'bash build2 && node build2',
      },
    }));
    const report = await collectExternalWiring(root);
    expect(files(report)).toEqual(['build2.js', 'c.js', 'script.py', 'scripts/gen.js', 'test.rb']);
    expect(report.boundaries).toEqual([
      { config: 'package.json', key: 'scripts.pyModule', reference: '-m pkg', reason: 'unsupported-form' },
      { config: 'package.json', key: 'scripts.substCd', reference: 'b.js', reason: 'unsupported-form' },
      { config: 'package.json', key: 'scripts.twice', reference: 'build2', reason: 'target-not-found' },
    ]);
  });

  it('reads shell flag groups from the following words, and keeps substitution arguments dynamic', async () => {
    for (const f of ['z.js', 'w.js', 'x.sh', 'b.js']) await put(f);
    await put('package.json', JSON.stringify({
      scripts: {
        ce: "bash -ce 'node z.js'",
        cx: "sh -cx 'node w.js'",
        oe: 'bash -oe pipefail x.sh',
        substArg: 'node $(echo a.js) && node dist/$(cat f).js',
        siblings: 'diff <(cd a; true) <(node b.js)',
      },
    }));
    const report = await collectExternalWiring(root);
    expect(files(report)).toEqual(['b.js', 'w.js', 'x.sh', 'z.js']);
    expect(report.boundaries.map(b => [b.key, b.reason])).toEqual([
      ['scripts.substArg', 'dynamic-reference'],
      ['scripts.substArg', 'dynamic-reference'],
    ]);
  });

  it('bounds cd tracking and regex and template scanning on hostile input', async () => {
    const commands = `${'('.repeat(200_000)}cd a;${'x;'.repeat(100_000)}`;
    await put('.github/workflows/deep.yml', `jobs:\n  a:\n    steps:\n      - run: ${JSON.stringify(commands)}\n`);
    await put('vitest.config.ts', `${'(/['.repeat(100_000)}\n${'`${'.repeat(20_000)}\nexport default { test: { setupFiles: ['./s.ts'] } };\n`);
    await put('s.ts');
    const started = Date.now();
    const report = await collectExternalWiring(root);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(report.wired.length + report.boundaries.length).toBeGreaterThanOrEqual(0);
  }, 30_000);

  it('tokenizes a long command substitution run in linear time', async () => {
    await put('.github/workflows/subst.yml', `jobs:\n  a:\n    steps:\n      - run: ${JSON.stringify('$('.repeat(250_000))}\n`);
    const started = Date.now();
    await collectExternalWiring(root);
    expect(Date.now() - started).toBeLessThan(3_000);
  }, 20_000);

  it('parses a hostile unclosed setup-file string in linear time', async () => {
    await put('vitest.config.ts', `export default { test: { setupFiles: '${"\\'".repeat(200_000)}` );
    const started = Date.now();
    const report = await collectExternalWiring(root);
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(report.boundaries.map(b => b.reason)).toEqual(['unparsed-config']);
  }, 20_000);

  it('keeps boundaries bounded per config', async () => {
    const run = Array.from({ length: 5_000 }, (_, i) => `node $X${i}`).join(';');
    await put('.github/workflows/noisy.yml', `jobs:\n  a:\n    steps:\n      - run: ${JSON.stringify(run)}\n`);
    const report = await collectExternalWiring(root);
    expect(report.boundaries).toHaveLength(50);
    expect(report.boundariesOmitted).toBe(4_950);
  });
});

describe('collectExternalWiring — tsconfig and test runners', () => {
  it('reads tsconfig files and literal setup files, and discloses a non-literal setting', async () => {
    await put('tsconfig.json', '{ "files": ["src/entry.ts", "types/global.d.ts"] }');
    await put('src/entry.ts');
    await put('vitest.setup.ts');
    await put('vitest.other.ts');
    await put('old-setup.ts');
    await put('vitest.config.ts', [
      'export default defineConfig({ test: {',
      "  setupFiles: ['./vitest.setup.ts', './vitest.other.ts'],",
      "  // setupFiles: ['./old-setup.ts'],",
      '  globalSetup: setupPath,',
      '} });',
      '',
    ].join('\n'));
    const report = await collectExternalWiring(root);
    expect(report.wired).toEqual([
      { file: 'src/entry.ts', receipts: [{ config: 'tsconfig.json', key: 'files' }] },
      { file: 'vitest.other.ts', receipts: [{ config: 'vitest.config.ts', key: 'setupFiles' }] },
      { file: 'vitest.setup.ts', receipts: [{ config: 'vitest.config.ts', key: 'setupFiles' }] },
    ]);
    expect(report.boundaries).toEqual([
      { config: 'vitest.config.ts', key: 'globalSetup', reference: 'setupPath', reason: 'unparsed-config' },
    ]);
  });

  it('reads quoted keys, ignores keys inside strings and type annotations, and tolerates a BOM', async () => {
    await put('quoted.ts');
    await put('in-string.ts');
    await put('bom.ts');
    await put('vitest.config.ts', [
      "const note = \"setupFiles: ['./in-string.ts']\";",
      'interface Options { setupFiles: string[]; globalSetup: string }',
      "export default { test: { 'setupFiles': ['./quoted.ts'] } };",
      '',
    ].join('\n'));
    await put('package.json', '\uFEFF' + JSON.stringify({ main: 'bom.ts' }));
    const report = await collectExternalWiring(root);
    expect(files(report)).toEqual(['bom.ts', 'quoted.ts']);
    expect(report.boundaries).toEqual([]);
  });

  it('reads a key after regex and template literals that contain quotes, and not a ternary branch', async () => {
    await put('after-regex.ts');
    await put('vitest.config.ts', [
      "const quote = /'/;",
      'const t = `x ${"`"} z`;',
      "const pick = flag ? \"setupFiles\" : \"b\";",
      "export default { test: { setupFiles: ['./after-regex.ts'] } };",
      '',
    ].join('\n'));
    const report = await collectExternalWiring(root);
    expect(files(report)).toEqual(['after-regex.ts']);
    expect(report.boundaries).toEqual([]);
  });

  it('reads multi-line jest arrays and expands <rootDir>', async () => {
    await put('jest.setup.js');
    await put('jest.env.js');
    await put('jest.config.js', "module.exports = {\n  setupFilesAfterEnv: [\n    '<rootDir>/jest.setup.js',\n  ],\n};\n");
    await put('package.json', JSON.stringify({ jest: { setupFiles: ['<rootDir>/jest.env.js'] } }));
    expect(files(await collectExternalWiring(root))).toEqual(['jest.env.js', 'jest.setup.js']);
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
      '      - run: |',
      '          cat <<EOF > gen.sh',
      '          node not/a/script.js',
      '          EOF',
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

  it('discloses PowerShell steps instead of misreading their syntax, and follows line continuations', async () => {
    await put('scripts/check.sh');
    await put('scripts/probe.js');
    await put('.github/workflows/os.yml', [
      'jobs:',
      '  windows:',
      '    runs-on: windows-latest',
      '    steps:',
      '      - run: |',
      '          $probe = Join-Path $PWD "x"',
      '          node scripts/probe.js',
      '  linux:',
      '    runs-on: ubuntu-latest',
      '    steps:',
      '      - run: |',
      '          [[ "${{ needs.a.result }}" == "success" ]] || \\',
      '            bash scripts/check.sh',
      '      - run: /usr/bin/env node scripts/probe.js',
      '      - shell: pwsh',
      '        run: node scripts/probe.js',
      '',
    ].join('\n'));
    const report = await collectExternalWiring(root);
    expect(report.wired).toEqual([
      { file: 'scripts/check.sh', receipts: [{ config: '.github/workflows/os.yml', key: 'jobs.linux.steps[0].run' }] },
      { file: 'scripts/probe.js', receipts: [{ config: '.github/workflows/os.yml', key: 'jobs.linux.steps[1].run' }] },
    ]);
    expect(report.boundaries).toEqual([
      { config: '.github/workflows/os.yml', key: 'jobs.linux.steps[2].run', reference: 'shell pwsh', reason: 'unsupported-form' },
      { config: '.github/workflows/os.yml', key: 'jobs.windows.steps[0].run', reference: 'shell pwsh', reason: 'unsupported-form' },
    ]);
  });

  it('shows a templated shell as an expression, not the internal placeholder', async () => {
    await put('.github/workflows/matrix.yml', 'jobs:\n  a:\n    steps:\n      - shell: ${{ matrix.shell }}\n        run: node x.js\n');
    const report = await collectExternalWiring(root);
    expect(report.boundaries).toEqual([
      { config: '.github/workflows/matrix.yml', key: 'jobs.a.steps[0].run', reference: 'shell ${{ }}', reason: 'unsupported-form' },
    ]);
  });

  it('parses a merge-key bomb quickly instead of expanding it', async () => {
    const lines = ['a0: &a0 {x: 1}'];
    for (let i = 1; i <= 40; i++) lines.push(`a${i}: &a${i} {<<: [*a${i - 1}, *a${i - 1}]}`);
    lines.push('jobs: {}');
    await put('.github/workflows/bomb.yml', lines.join('\n'));
    const started = Date.now();
    await collectExternalWiring(root);
    expect(Date.now() - started).toBeLessThan(5_000);
  }, 20_000);

  it('caps references per config with a disclosure instead of losing everything', async () => {
    await put('x.js');
    await put('package.json', JSON.stringify({ bin: 'x.js' }));
    const run = Array.from({ length: 1_500 }, (_, i) => `node s${i}.js`).join(' && ');
    await put('.github/workflows/big.yml', `jobs:\n  a:\n    steps:\n      - run: ${JSON.stringify(run)}\n`);
    const report = await collectExternalWiring(root);
    expect(files(report)).toEqual(['x.js']);
    expect(report.boundaries.some(b => b.reference === 'more than 1000 references')).toBe(true);
  });

  it('contributes nothing for a repository with no supported config', async () => {
    await put('src/orphan.ts');
    expect(await collectExternalWiring(root)).toEqual({ wired: [], boundaries: [], boundariesOmitted: 0 });
  });
});

describe('stripJsonComments', () => {
  it('removes comments and trailing commas without touching string contents', () => {
    const source = '{ "url": "http://x//y", /* block */ "a": [1, 2,], // line\n "b": "/*keep*/", "c": ["x, ]", "y,}"], }';
    expect(JSON.parse(stripJsonComments(source))).toEqual({ url: 'http://x//y', a: [1, 2], b: '/*keep*/', c: ['x, ]', 'y,}'] });
  });
});
