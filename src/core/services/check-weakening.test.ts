import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

import {
  checkWeakening,
  checkConfigKind,
  detectWeakeningShapes,
  reachIndexFromGraph,
  CHECK_WEAKENING_CODES,
  type CheckWeakeningFinding,
  type ReachIndex,
  type WeakeningFile,
} from './check-weakening.js';
import { FINDING_CODE_REGISTRY } from './mcp-handlers/enforcement-policy.js';
import type { SerializedCallGraph } from '../analyzer/call-graph.js';

/** A test file reaching `parseConfig` (and `helper` through it). */
const REACH: ReachIndex = {
  reachOf: file => file.includes('config')
    ? { recorded: true, symbols: [{ id: 'src/config.ts::parseConfig', name: 'parseConfig' }, { id: 'src/config.ts::helper', name: 'helper' }] }
    : { recorded: false, symbols: [] },
};
const NONE_CHANGED = new Set<string>();
const PARSE_CHANGED = new Set(['src/config.ts::parseConfig']);

const all: CheckWeakeningFinding[] = [];
async function detect(files: WeakeningFile[], changed: ReadonlySet<string> | undefined = NONE_CHANGED, reach: ReachIndex | undefined = REACH) {
  const r = await detectWeakeningShapes(files, reach, changed);
  all.push(...r.findings);
  return r;
}
const codes = (r: { findings: CheckWeakeningFinding[] }) => r.findings.map(f => f.code).sort();

const JS_BASE = `import { parseConfig } from './config';
describe('config', () => {
  it('parses empty config', () => {
    expect(parseConfig('')).toBe(0);
    expect(parseConfig(' a ')).toBe(1);
  });
  it('parses spaces', () => {
    expect(parseConfig('  ')).toBe(0);
  });
});
`;
const jsFile = (current: string | null, base: string | null = JS_BASE): WeakeningFile => ({ path: 'src/config.test.ts', base, current });

describe('check weakening — test shapes (Vitest/Jest/Mocha)', () => {
  it('a skipped test names the changed symbol it was guarding', async () => {
    const r = await detect([jsFile(JS_BASE.replace("it('parses empty config'", "it.skip('parses empty config'"))], PARSE_CHANGED);
    expect(codes(r)).toEqual(['test-disabled']);
    const f = r.findings[0];
    expect(f.subject).toBe('src/config.test.ts::config > parses empty config');
    expect(f.reachesChanged).toEqual(['parseConfig']);
    expect(f.reaches).toEqual(['parseConfig', 'helper']);
    expect(f.severity).toBe('error');
    expect(f.message).toContain('reaches parseConfig, in code this diff changes');
    expect(f.location).toEqual({ path: 'src/config.test.ts', line: 3 });
  });

  it('xit, describe.skip and a focus marker are reported', async () => {
    expect(codes(await detect([jsFile(JS_BASE.replace("it('parses spaces'", "xit('parses spaces'"))]))).toEqual(['test-disabled']);
    const suite = await detect([jsFile(JS_BASE.replace("describe('config'", "describe.skip('config'"))]);
    expect(codes(suite)).toEqual(['test-disabled', 'test-disabled']);
    const focus = await detect([jsFile(JS_BASE.replace("it('parses spaces'", "it.only('parses spaces'"))]);
    expect(codes(focus)).toEqual(['test-disabled']);
    expect(focus.findings[0].message).toContain('the other 1 test case(s)');
  });

  it('a removed test is reported; a renamed one with the same body is not', async () => {
    const removed = await detect([jsFile(JS_BASE.replace(/ {2}it\('parses spaces'[\s\S]*?\n {2}\}\);\n/, ''))]);
    expect(codes(removed)).toEqual(['test-removed']);
    expect(removed.findings[0].subject).toBe('src/config.test.ts::config > parses spaces');
    const renamed = await detect([jsFile(JS_BASE.replace("'parses spaces'", "'parses whitespace'"))]);
    expect(renamed.findings).toEqual([]);
  });

  it('a removed test file is one finding naming its case count', async () => {
    const r = await detect([jsFile(null)]);
    expect(codes(r)).toEqual(['test-removed']);
    expect(r.findings[0].message).toContain('(2 test case(s))');
  });

  it('fewer assertions is reported', async () => {
    const r = await detect([jsFile(JS_BASE.replace("    expect(parseConfig(' a ')).toBe(1);\n", ''))]);
    expect(codes(r)).toEqual(['assertions-reduced']);
    expect(r.findings[0].message).toContain('has 1 assertion(s), down from 2');
  });

  it('a changed expected value is reported only when the code it checks did not change', async () => {
    const edited = jsFile(JS_BASE.replace(".toBe(1);", ".toBe(2);"));
    const r = await detect([edited]);
    expect(codes(r)).toEqual(['expected-value-changed']);
    expect(r.findings[0].message).toContain('(`1` → `2`)');
    // The production function it reaches changed too: an expected value updated with its code.
    expect((await detect([edited], PARSE_CHANGED)).findings).toEqual([]);
    // A changed input to the code under test (the actual side) is not an expected value.
    expect((await detect([jsFile(JS_BASE.replace("parseConfig(' a ')", "parseConfig(' b ')"))])).findings).toEqual([]);
  });

  it('without a recorded reach the expected-value shape is not-assessed, never silent', async () => {
    const r = await detect([{ path: 'src/other.test.ts', base: JS_BASE, current: JS_BASE.replace('.toBe(1);', '.toBe(2);') }]);
    expect(r.findings).toEqual([]);
    expect(r.notAssessed).toEqual([expect.objectContaining({ file: 'src/other.test.ts', shapes: ['expected-value-changed'] })]);
  });

  it('a renamed assertion-free edit (formatting) reports nothing', async () => {
    expect((await detect([jsFile(JS_BASE.replace(/\n {4}expect/g, '\n      expect'))])).findings).toEqual([]);
  });
});

describe('check weakening — other frameworks', () => {
  it('pytest: skip decorator, fewer asserts, unittest assert methods', async () => {
    const base = `import pytest
def test_parse():
    assert parse_config('') == 0
    assert parse_config('a') == 1

class TestConfig(unittest.TestCase):
    def test_eq(self):
        self.assertEqual(parse_config(''), 0)
`;
    const cur = base
      .replace('def test_parse', '@pytest.mark.skip(reason="flaky")\ndef test_parse')
      .replace("        self.assertEqual(parse_config(''), 0)\n", '        pass\n');
    const r = await detect([{ path: 'tests/test_config.py', base, current: cur }]);
    expect(codes(r)).toEqual(['assertions-reduced', 'test-disabled']);
    expect(r.findings.find(f => f.code === 'test-disabled')!.message).toContain('@pytest.mark.skip');
    expect(r.findings.find(f => f.code === 'assertions-reduced')!.subject).toBe('tests/test_config.py::TestConfig.test_eq');
  });

  it('Go: t.Skip, removed t.Run subtest, testify literal changed', async () => {
    const base = `package config
func TestParse(t *testing.T) {
	assert.Equal(t, 0, Parse(""))
	t.Run("spaces", func(t *testing.T) {
		if Parse(" ") != 0 { t.Errorf("bad") }
	})
}
func TestOther(t *testing.T) {
	require.Equal(t, 1, Parse("a"))
}
`;
    const cur = base
      .replace('\tassert.Equal(t, 0, Parse(""))', '\tt.Skip("later")\n\tassert.Equal(t, 0, Parse(""))')
      .replace(/\tt\.Run\("spaces"[\s\S]*?\n\t\}\)\n/, '')
      .replace('require.Equal(t, 1,', 'require.Equal(t, 2,');
    const r = await detect([{ path: 'config/config_test.go', base, current: cur }]);
    expect(codes(r)).toEqual(['expected-value-changed', 'test-disabled', 'test-removed']);
    expect(r.findings.find(f => f.code === 'test-removed')!.subject).toBe('config/config_test.go::TestParse/spaces');
  });

  it('JUnit: @Disabled and a removed assertion', async () => {
    const base = `class ConfigTest {
  @Test void parses() { assertEquals(0, Config.parse("")); assertThat(Config.parse("a")).isEqualTo(1); }
  @Test void other() { assertTrue(Config.ok()); }
}`;
    const cur = base
      .replace('@Test void other', '@Disabled @Test void other')
      .replace(' assertThat(Config.parse("a")).isEqualTo(1);', '');
    const r = await detect([{ path: 'src/test/java/ConfigTest.java', base, current: cur }]);
    expect(codes(r)).toEqual(['assertions-reduced', 'test-disabled']);
  });

  it('a test file in a language outside the table is not-assessed', async () => {
    const r = await detect([{ path: 'spec/config_spec.rb', base: "it 'a' do\n expect(1).to eq(1)\nend\n", current: "xit 'a' do\nend\n" }]);
    expect(r.findings).toEqual([]);
    expect(r.notAssessed[0]).toMatchObject({ file: 'spec/config_spec.rb', shapes: expect.arrayContaining(['test-disabled', 'suppression-added']) });
  });
});

describe('check weakening — suppressions and swallowed errors', () => {
  it('reports added suppressions per language, not existing ones', async () => {
    const r = await detect([
      { path: 'src/a.ts', base: '// eslint-disable-next-line no-console\nconsole.log(1);\nconst x: number = 1;\n',
        current: '// eslint-disable-next-line no-console\nconsole.log(1);\n// @ts-ignore\nconst x: number = "s";\n' },
      { path: 'src/b.py', base: 'import os\n', current: 'import os  # noqa: F401\nx = f()  # type: ignore\n' },
      { path: 'cmd/c.go', base: 'package c\nfunc F() {}\n', current: 'package c\nfunc F() {} //nolint:errcheck\n' },
      { path: 'src/D.java', base: 'class D { void f() {} }', current: 'class D { @SuppressWarnings("unchecked") void f() {} }' },
    ]);
    expect(codes(r)).toEqual(Array(5).fill('suppression-added'));
    expect(r.findings.find(f => f.location?.path === 'src/a.ts')!.subject).toBe('src/a.ts:3');
  });

  it('a marker inside a string literal is not a suppression', async () => {
    const r = await detect([{ path: 'src/a.ts', base: 'const s = 1;\n', current: 'const s = "// @ts-ignore";\n' }]);
    expect(r.findings).toEqual([]);
  });

  it('reports a new catch that discards the error, per language', async () => {
    const r = await detect([
      { path: 'src/a.ts', base: 'export function load() {\n  return read();\n}\n',
        current: 'export function load() {\n  try {\n    return read();\n  } catch (e) {\n    console.warn(e);\n  }\n}\n' },
      { path: 'src/b.py', base: 'def load():\n    return read()\n', current: 'def load():\n    try:\n        return read()\n    except Exception:\n        pass\n' },
      { path: 'src/C.java', base: 'class C { void load() { read(); } }', current: 'class C { void load() { try { read(); } catch (Exception e) { } } }' },
      { path: 'pkg/d.go', base: 'package d\nfunc Load() error {\n\terr := read()\n\treturn err\n}\n',
        current: 'package d\nfunc Load() error {\n\terr := read()\n\tif err != nil {\n\t\tlog.Println(err)\n\t}\n\treturn nil\n}\n' },
    ]);
    expect(codes(r)).toEqual(Array(4).fill('error-swallowed'));
    expect(r.findings.find(f => f.location?.path === 'src/a.ts')!.message).toContain('`read()` in `load`');
  });

  it('logging then returning a constant still discards the error; returning the error does not', async () => {
    const r = await detect([
      { path: 'src/a.ts', base: 'function f() { return g(); }\n', current: 'function f() { try { return g(); } catch (e) { console.warn(e); return 0; } }\n' },
      { path: 'pkg/d.go', base: 'package d\nfunc F() error {\n\treturn g()\n}\n', current: 'package d\nfunc F() error {\n\terr := g()\n\tif err != nil {\n\t\treturn nil\n\t}\n\treturn nil\n}\n' },
      { path: 'pkg/e.go', base: 'package e\nfunc F() (int, error) {\n\treturn g()\n}\n', current: 'package e\nfunc F() (int, error) {\n\tv, err := g()\n\tif err != nil {\n\t\treturn 0, err\n\t}\n\treturn v, nil\n}\n' },
    ]);
    expect(r.findings.map(f => f.location?.path)).toEqual(['src/a.ts', 'pkg/d.go']);
  });

  it('a handler that rethrows, or an existing swallow whose try body was edited, is not reported', async () => {
    const r = await detect([
      { path: 'src/a.ts', base: 'function f() { g(); }\n', current: 'function f() { try { g(); } catch (e) { throw wrap(e); } }\n' },
      { path: 'src/b.ts', base: 'function f() { try { g(1); } catch {} }\n', current: 'function f() { try { g(2); } catch {} }\n' },
    ]);
    expect(r.findings).toEqual([]);
  });
});

describe('check weakening — check configs', () => {
  const cfg = (path: string, base: string, current: string) => detect([{ path, base, current }]);

  it('classifies only the closed table of config files', () => {
    expect(checkConfigKind('.github/workflows/ci.yml')).toBe('ci');
    expect(checkConfigKind('vitest.config.ts')).toBe('test-runner');
    expect(checkConfigKind('.eslintrc.json')).toBe('lint');
    expect(checkConfigKind('.coveragerc')).toBe('coverage');
    expect(checkConfigKind('pyproject.toml')).toBe('sectioned');
    expect(checkConfigKind('src/config.yml')).toBeNull();
  });

  it('an exclude entry added to a test runner config', async () => {
    const r = await cfg('vitest.config.ts',
      "export default { test: { exclude: [\n  'node_modules',\n] } };\n",
      "export default { test: { exclude: [\n  'node_modules',\n  'src/parser/**',\n] } };\n");
    expect(codes(r)).toEqual(['check-config-relaxed']);
    expect(r.findings[0].message).toContain("`'src/parser/**',`");
  });

  it('a lowered coverage threshold and a lint rule turned off', async () => {
    const pkg = await cfg('package.json',
      '{ "jest": { "coverageThreshold": { "global": { "lines": 90, "branches": 80 } } } }',
      '{ "jest": { "coverageThreshold": { "global": { "lines": 60, "branches": 80 } } } }');
    expect(pkg.findings.map(f => f.message)).toEqual(['A coverage threshold `lines` was lowered from 90 to 60 in package.json.']);
    const lint = await cfg('.eslintrc.json', '{ "rules": {\n  "no-console": "error"\n} }', '{ "rules": {\n  "no-console": "off"\n} }');
    expect(codes(lint)).toEqual(['check-config-relaxed']);
  });

  it('pyproject: only check sections count', async () => {
    const base = '[tool.coverage.report]\nfail_under = 85\n[tool.setuptools.packages.find]\nexclude = []\n';
    const r = await cfg('pyproject.toml', base, base.replace('fail_under = 85', 'fail_under = 70').replace('exclude = []', 'exclude = ["docs"]'));
    expect(r.findings.map(f => f.message)).toEqual(['A coverage threshold `failunder` was lowered from 85 to 70 in pyproject.toml.']);
    const ruff = await cfg('pyproject.toml', '[tool.ruff]\nline-length = 100\n', '[tool.ruff]\nline-length = 100\nextend-ignore = ["E501"]\n');
    expect(codes(ruff)).toEqual(['check-config-relaxed']);
  });

  it('CI: a removed test step and an added continue-on-error', async () => {
    const base = `jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - run: npm ci
      - name: Unit
        run: npm test
      - name: Lint
        run: npm run lint
`;
    const removed = await cfg('.github/workflows/ci.yml', base, base.replace('      - name: Unit\n        run: npm test\n', ''));
    expect(removed.findings.map(f => f.message)).toEqual(['A CI step that ran tests was removed or changed in .github/workflows/ci.yml (job test, step Unit): `npm test`.']);
    const allowed = await cfg('.github/workflows/ci.yml', base, base.replace('        run: npm run lint\n', '        run: npm run lint\n        continue-on-error: true\n'));
    expect(allowed.findings.map(f => f.message)).toEqual(['Failure is now allowed for job test, step Lint in .github/workflows/ci.yml (continue-on-error / allow_failure).']);
    const softened = await cfg('.github/workflows/ci.yml', base, base.replace('run: npm test', 'run: npm test || true'));
    expect(codes(softened)).toEqual(['check-config-relaxed']);
    // Reordering steps changes nothing.
    expect((await cfg('.github/workflows/ci.yml', base, base.replace('      - run: npm ci\n', '') + '      - run: npm ci\n')).findings).toEqual([]);
  });

  it('an unparsable workflow is not-assessed', async () => {
    const r = await cfg('.github/workflows/ci.yml', 'jobs: {}\n', 'jobs: [\n');
    expect(r.notAssessed[0]).toMatchObject({ shapes: ['check-config-relaxed'] });
  });
});

describe('check weakening — reach index', () => {
  it('joins tested_by edges and their forward call closure, skipping tests and externals', () => {
    const cg = {
      nodes: [
        { id: 'src/c.ts::parseConfig', name: 'parseConfig', filePath: 'src/c.ts' },
        { id: 'src/c.ts::helper', name: 'helper', filePath: 'src/c.ts' },
        { id: 'external::fs', name: 'fs', filePath: '', isExternal: true },
        { id: 'src/u.ts::unrelated', name: 'unrelated', filePath: 'src/u.ts' },
      ],
      edges: [
        { callerId: 'src/c.ts::parseConfig', calleeId: 'src/c.test.ts::*', calleeName: 'c.test', kind: 'tested_by' },
        { callerId: 'src/c.ts::parseConfig', calleeId: 'src/c.ts::helper', calleeName: 'helper', kind: 'calls' },
        { callerId: 'src/c.ts::helper', calleeId: 'external::fs', calleeName: 'fs', kind: 'calls' },
      ],
    } as unknown as SerializedCallGraph;
    const idx = reachIndexFromGraph(cg);
    expect(idx.reachOf('src/c.test.ts')).toEqual({ recorded: true, symbols: [
      { id: 'src/c.ts::parseConfig', name: 'parseConfig' }, { id: 'src/c.ts::helper', name: 'helper' },
    ] });
    expect(idx.reachOf('src/u.test.ts')).toEqual({ recorded: false, symbols: [] });
  });
});

describe('check weakening — registration and wording', () => {
  it('every code is registered as an advisory check-weakening finding', () => {
    for (const code of CHECK_WEAKENING_CODES) {
      expect(FINDING_CODE_REGISTRY[code]).toMatchObject({ defaultClass: 'advisory', source: 'check-weakening' });
    }
  });

  it('no finding message is judgmental', () => {
    expect(all.length).toBeGreaterThan(20);
    for (const f of all) expect(f.message).not.toMatch(/cheat|hack|gam(e|ing)|fraud|sneak|suspicious/i);
  });
});

// ── Real git: the fixed baseline ───────────────────────────────────────────────

const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@e.com', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@e.com',
};
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'ignore', env: GIT_ENV });
const write = (cwd: string, rel: string, content: string) => {
  const p = join(cwd, rel); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, content);
};

describe('check weakening — fixed baseline (real git)', () => {
  const dirs: string[] = [];
  afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

  function repo(): string {
    const dir = mkdtempSync(join(tmpdir(), 'olcw-'));
    dirs.push(dir);
    git(dir, 'init', '-q', '-b', 'main');
    write(dir, 'src/config.ts', 'export function parseConfig(s: string) { return s.trim().length; }\n');
    write(dir, 'src/config.test.ts', JS_BASE);
    git(dir, 'add', '-A');
    git(dir, 'commit', '-qm', 'init');
    git(dir, 'checkout', '-qb', 'feature');
    return dir;
  }

  it('a weakening split across commits is still found against the merge-base', async () => {
    const dir = repo();
    write(dir, 'src/config.test.ts', JS_BASE.replace("    expect(parseConfig(' a ')).toBe(1);\n", ''));
    git(dir, 'commit', '-qam', 'step 1');
    write(dir, 'src/config.ts', 'export function parseConfig(s: string) { return s.length; }\n');
    git(dir, 'commit', '-qam', 'step 2');
    // Omitted base: the default branch's merge-base, not the agent's own last commit.
    for (const baseRef of [undefined, 'HEAD', 'main']) {
      const r = await checkWeakening({ root: dir, baseRef });
      expect(r.baseline.ref).toBe('main');
      expect(r.findings.map(f => f.code)).toEqual(['assertions-reduced']);
    }
  });

  it('reads working-tree, untracked and deleted files, and joins reach from the index', async () => {
    const dir = repo();
    write(dir, 'src/config.test.ts', JS_BASE.replace("it('parses spaces'", "it.skip('parses spaces'"));
    write(dir, 'src/extra.ts', '// @ts-nocheck\nexport const x = 1;\n');
    const cg = {
      nodes: [{ id: 'src/config.ts::parseConfig', name: 'parseConfig', filePath: 'src/config.ts', startIndex: 0, endIndex: 66 }],
      edges: [{ callerId: 'src/config.ts::parseConfig', calleeId: 'src/config.test.ts::*', calleeName: 'config.test', kind: 'tested_by' }],
    } as unknown as SerializedCallGraph;
    const r = await checkWeakening({ root: dir, callGraph: cg });
    expect(r.findings.map(f => f.code).sort()).toEqual(['suppression-added', 'test-disabled']);
    expect(r.findings.find(f => f.code === 'test-disabled')!.reaches).toEqual(['parseConfig']);
    unlinkSync(join(dir, 'src/config.test.ts'));
    const gone = await checkWeakening({ root: dir, callGraph: cg });
    expect(gone.findings.find(f => f.code === 'test-removed')!.subject).toBe('src/config.test.ts');
  });

  it('an expected value updated with its code is not reported (changed set at the baseline)', async () => {
    const dir = repo();
    write(dir, 'src/config.ts', 'export function parseConfig(s: string) { return s.trim().length + 1; }\n');
    write(dir, 'src/config.test.ts', JS_BASE.replace('.toBe(1);', '.toBe(2);'));
    const cg = {
      nodes: [{ id: 'src/config.ts::parseConfig', name: 'parseConfig', filePath: 'src/config.ts', startIndex: 0, endIndex: 66, language: 'TypeScript' }],
      edges: [{ callerId: 'src/config.ts::parseConfig', calleeId: 'src/config.test.ts::*', calleeName: 'config.test', kind: 'tested_by' }],
    } as unknown as SerializedCallGraph;
    const r = await checkWeakening({ root: dir, callGraph: cg });
    expect(r.findings).toEqual([]);
    // The same edit with the code untouched is reported.
    git(dir, 'checkout', '--', 'src/config.ts');
    const r2 = await checkWeakening({ root: dir, callGraph: cg });
    expect(r2.findings.map(f => f.code)).toEqual(['expected-value-changed']);
  });
});
