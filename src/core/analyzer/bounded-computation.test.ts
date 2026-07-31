/**
 * Bounded Computation Against Hostile Repositories (spec: openspec/specs/mcp-security/spec.md).
 *
 * Asserts that analyzing an adversarial repository cannot hang or exhaust the
 * server: per-file parsing is size-capped, content regexes run without
 * catastrophic backtracking (ReDoS), and oversized files are skipped WITH
 * disclosure (no silent capping). These are real-execution smoke tests against
 * the actual parsers plus regression guards on the documented caps.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync, statSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractSignatures } from './signature-extractor.js';
import { normalizeUrl, extractHttpCalls } from './http-route-parser.js';
import { parseFile, parseJavaPackage } from './import-parser.js';
import { extractEnvVars } from './env-extractor.js';

const ANALYZER_DIR = fileURLToPath(new URL('.', import.meta.url));

/** Run a sync `fn` and assert it completes within `budgetMs` — a ReDoS would blow past it. */
function withinTimeBudget(label: string, budgetMs: number, fn: () => void): void {
  const start = performance.now();
  fn();
  const elapsed = performance.now() - start;
  expect(elapsed, `${label} took ${elapsed.toFixed(0)}ms (budget ${budgetMs}ms) — possible ReDoS`).toBeLessThan(budgetMs);
}

describe('Bounded Computation — ReDoS resilience of content parsers (mcp-security)', () => {
  // Inputs engineered to trigger worst-case backtracking: long unbroken runs,
  // unbalanced brackets, huge whitespace gaps, repeated near-matches. Sized below
  // the 10MB read cap so they exercise the regex path, not the skip path.
  const PATHOLOGICAL = [
    'a'.repeat(200_000),
    '('.repeat(100_000),
    ' '.repeat(200_000) + 'x',
    'function '.repeat(40_000),
    ('import {' + 'a,'.repeat(20_000) + '} from "x"\n'),
    '/* ' + '*'.repeat(200_000), // unterminated block comment
    'def f(' + 'x,'.repeat(20_000) + '):\n',
    ('\t'.repeat(50_000) + 'def g(): pass\n'),
  ].map((s, i) => ({ s, i }));

  const LANGS = ['hostile.ts', 'hostile.py', 'hostile.go', 'hostile.java', 'hostile.rb', 'hostile.rs'];

  for (const file of LANGS) {
    it(`extractSignatures stays linear on adversarial ${extname(file)} content`, () => {
      for (const { s, i } of PATHOLOGICAL) {
        withinTimeBudget(`${file} case#${i}`, 2_000, () => {
          // Must not throw and must return a (possibly empty) signature map.
          const out = extractSignatures(file, s);
          expect(out).toBeTruthy();
        });
      }
    });
  }

  it('normalizeUrl stays linear on adversarial URL strings', () => {
    const urls = [
      '/' + 'a/'.repeat(100_000),
      ':'.repeat(200_000),
      '/{' + 'x'.repeat(200_000) + '}',
      '/' + '%'.repeat(100_000),
    ];
    for (const u of urls) {
      withinTimeBudget('normalizeUrl', 1_000, () => { normalizeUrl(u); });
    }
  });

  it('parseJavaPackage stays linear on adversarial content', () => {
    for (const c of [
      'package ' + 'a.'.repeat(100_000) + 'z;',
      ' '.repeat(200_000) + 'package x;',
      'package' + '\t'.repeat(200_000),
    ]) {
      withinTimeBudget('parseJavaPackage', 1_000, () => { parseJavaPackage(c); });
    }
  });
});

// The import parser, env extractor, and HTTP-call scanner read a file from disk;
// drive them against pathological fixture files and assert linear completion
// (the spec names "import parsers" and "content scanners" explicitly).
describe('Bounded Computation — ReDoS resilience of file-reading scanners (mcp-security)', () => {
  let dir: string;
  afterEach(() => { if (dir) { rmSync(dir, { recursive: true, force: true }); dir = ''; } });

  const PAYLOADS: Record<string, string> = {
    'h.ts': 'import {' + 'a,'.repeat(40_000) + '} from "' + 'x'.repeat(80_000) + '"\n'
          + 'export const ' + 'b'.repeat(80_000) + ' = 1\n'
          + 'fetch("/' + 'a/'.repeat(40_000) + '")\n',
    'h.py': 'from ' + 'm.'.repeat(40_000) + 'n import ' + 'x'.repeat(80_000) + '\n'
          + 'import ' + 'a,'.repeat(40_000) + 'b\n',
    'h.go': 'package main\nimport (\n' + '\t"' + 'p/'.repeat(40_000) + '"\n'.repeat(2) + ')\n',
    'h.java': 'package ' + 'a.'.repeat(40_000) + 'z;\nimport ' + 'b.'.repeat(40_000) + 'C;\n',
    'h.rb': "require '" + 'a/'.repeat(40_000) + "'\n",
    'h.env': '#' + ' '.repeat(200_000) + '\n' + 'A'.repeat(100_000) + '=' + 'v'.repeat(100_000) + '\n',
  };

  async function withinAsyncBudget(label: string, budgetMs: number, fn: () => Promise<unknown>): Promise<void> {
    const start = performance.now();
    await fn();
    const elapsed = performance.now() - start;
    expect(elapsed, `${label} took ${elapsed.toFixed(0)}ms (budget ${budgetMs}ms) — possible ReDoS`).toBeLessThan(budgetMs);
  }

  it('the import parser stays linear on adversarial source files', async () => {
    dir = mkdtempSync(join(tmpdir(), 'ol-redos-imp-'));
    for (const [name, body] of Object.entries(PAYLOADS)) {
      if (name === 'h.env') continue;
      const p = join(dir, name);
      writeFileSync(p, body, 'utf-8');
      await withinAsyncBudget(`parseFile ${name}`, 3_000, () => parseFile(p));
    }
  });

  it('the HTTP-call scanner stays linear on an adversarial source file', async () => {
    dir = mkdtempSync(join(tmpdir(), 'ol-redos-http-'));
    const p = join(dir, 'h.ts');
    writeFileSync(p, PAYLOADS['h.ts'], 'utf-8');
    await withinAsyncBudget('extractHttpCalls', 3_000, () => extractHttpCalls(p));
  });

  it('the env-var extractor stays linear on adversarial files', async () => {
    dir = mkdtempSync(join(tmpdir(), 'ol-redos-env-'));
    writeFileSync(join(dir, '.env'), PAYLOADS['h.env'], 'utf-8');
    writeFileSync(join(dir, 'h.ts'), 'const x = process.env.' + 'A'.repeat(80_000) + '\n', 'utf-8');
    await withinAsyncBudget('extractEnvVars', 3_000, () => extractEnvVars(['.env', 'h.ts'], dir));
  });
});

describe('Bounded Computation — documented caps are present (regression guards)', () => {
  it('the file-walker enforces a maximum read size and discloses skips', () => {
    const src = readFileSync(join(ANALYZER_DIR, 'file-walker.ts'), 'utf-8');
    // A per-file size ceiling exists and gates reads.
    expect(src).toMatch(/MAX_READ_SIZE\s*=\s*[\d_]+/);
    expect(src).toMatch(/s\.size\s*>\s*MAX_READ_SIZE/);
    // Skips are counted and surfaced (no silent capping).
    expect(src).toMatch(/skippedCount/);
    expect(src).toMatch(/recordSkip/);
  });

  it('analyze_impact clamps its depth argument to the documented maximum', () => {
    const src = readFileSync(join(ANALYZER_DIR, '..', 'services', 'mcp-handlers', 'graph.ts'), 'utf-8');
    // depth is clamped against SUBGRAPH_MAX_DEPTH_LIMIT before driving BFS.
    expect(src).toMatch(/depth\s*=\s*Math\.max\(\s*1,\s*Math\.min\(\s*depth,\s*SUBGRAPH_MAX_DEPTH_LIMIT/);
  });
});

/**
 * The regression guards for issue #302 (change: fix-unbounded-file-scan-oom).
 *
 * The OOM was not one bad line — it was a SHAPE that had been written independently in five
 * extractors and three other places: `await Promise.all(files.map(async f => readFile(f)))`.
 * It is the natural way to write a repository-wide scan and it is fatal at scale, so the fix is
 * only durable if reintroducing the shape fails the build. These guards enforce that every
 * repository-wide scan goes through `bounded-file-scan.ts`, whose two bounds are unit-tested in
 * `bounded-file-scan.test.ts`.
 */
describe('Bounded Computation — repository-wide scans stay bounded (issue #302)', () => {
  let repo: string | undefined;
  afterEach(() => {
    if (repo) rmSync(repo, { recursive: true, force: true });
    repo = undefined;
  });

  /** Every module that scans a whole repository's files. Add new ones here. */
  const SCAN_MODULES = [
    'ui-component-extractor.ts',
    'schema-extractor.ts',
    'http-route-parser.ts',
    'middleware-extractor.ts',
    'env-extractor.ts',
  ];

  /** Strip comments so prose explaining the rejected shape cannot fail the guard. */
  const codeOf = (file: string): string =>
    readFileSync(join(ANALYZER_DIR, file), 'utf-8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');

  /**
   * Any `Promise.all` whose argument reaches a `.map(` — the unbounded fan-out shape.
   *
   * Deliberately loose. An earlier version required a bare dotted identifier
   * (`Promise\.all\(\s*[\w.]+\s*\.map\(`), which every natural way of reintroducing the bug
   * walked straight past: `Promise.all(paths.filter(…).map(…))`, a line-broken chain, or the
   * two-step `const jobs = paths.map(…); await Promise.all(jobs)`. A guard that only catches the
   * one spelling nobody would write is not a guard. The two-step form is caught separately below,
   * since no regex over one expression can see it.
   */
  const UNBOUNDED_FANOUT = /Promise\.all\([\s\S]{0,200}?\.map\(/;

  /** Every way to spell "read a whole file" that is NOT the bounded reader. */
  const RAW_READ = /\breadFile\s*\(|\breadFileSync\s*\(|\bcreateReadStream\s*\(/;

  it.each(SCAN_MODULES)('%s reads through the bounded scan, never a raw read', file => {
    const code = codeOf(file);
    // A raw read in a scan module is unbounded by construction — no size cap. `readFileSync` is
    // included because it is the single easiest way to reintroduce the defect while satisfying
    // a naive `readFile(`-only guard.
    expect(code, `${file} must read via readSourceCapped, not a raw read`).not.toMatch(RAW_READ);
    // …and must not smuggle one in under an alias.
    expect(code, `${file} must not alias an fs read`).not.toMatch(/from 'node:fs(\/promises)?'/);
    expect(code).toMatch(/from '\.\/bounded-file-scan\.js'/);
  });

  it.each(SCAN_MODULES)('%s fans out through mapFilesBounded, not Promise.all', file => {
    const code = codeOf(file);
    expect(code, `${file} must scan via mapFilesBounded`).not.toMatch(UNBOUNDED_FANOUT);
    // The two-step form — `const jobs = xs.map(async …); await Promise.all(jobs)` — is invisible
    // to any single-expression regex, so catch its ingredient: an async `.map(` callback that is
    // not immediately consumed. In these modules every legitimate `.map(` is a synchronous
    // projection over already-computed results.
    expect(code, `${file} must not build an async .map() array to hand to Promise.all`)
      .not.toMatch(/\.map\(\s*async\b/);
    expect(code).toMatch(/mapFilesBounded\(/);
  });

  it('the call graph synthesizes route-handler edges through the bounded scan', () => {
    const src = readFileSync(join(ANALYZER_DIR, 'call-graph.ts'), 'utf-8');
    // This pass fans out over every file, so it carries the same fan-out hazard as the extractors.
    expect(src).toMatch(/const perFileRoutes = await mapFilesBounded\(/);
  });

  it('the call graph feeds route extraction its RESIDENT content, never a capped re-read', () => {
    const src = readFileSync(join(ANALYZER_DIR, 'call-graph.ts'), 'utf-8');
    // The enrichment size cap must not reach the graph. This pass already holds every file's
    // text (`contentByPath`), so re-reading through the capped reader bought no memory back and
    // silently dropped the route-handler edges of any file above the cap — turning live handlers
    // into `find_dead_code` candidates.
    expect(src).toMatch(/const resident = contentByPath\.get\(path\)/);
    for (const fn of ['extractRouteDefinitions', 'extractTsRouteDefinitions', 'extractJavaRouteDefinitions']) {
      expect(src, `${fn} must be handed the resident source`).toMatch(
        new RegExp(`${fn}\\(path, resident\\)`),
      );
    }
  });

  it('an oversized file still yields routes when its source is already in memory', async () => {
    // The behavioural half of the guard above: the cap applies to a re-read, never to text the
    // caller already has. Without the `residentSource` path, a route in a 5 MB router silently
    // disappears from the call graph.
    const { extractTsRouteDefinitions } = await import('./http-route-parser.js');
    const { SOURCE_SCAN_MAX_FILE_BYTES } = await import('../../constants.js');

    repo = mkdtempSync(join(tmpdir(), 'ol-resident-'));
    const big = join(repo, 'router.ts');
    const head =
      "import express from 'express';\n"
      + 'const app = express();\n'
      + "app.get('/oversized-route', (req, res) => res.send('ok'));\n";
    // Pad past the cap by MEASURED length, not by an assumed line width — a fixture that
    // silently lands under the cap would make this test assert nothing.
    const padLine = `// ${'pad '.repeat(20)}\n`;
    const body = head + padLine.repeat(Math.ceil((SOURCE_SCAN_MAX_FILE_BYTES + 1024) / padLine.length));
    writeFileSync(big, body);
    expect(statSync(big).size).toBeGreaterThan(SOURCE_SCAN_MAX_FILE_BYTES);

    // Re-read through the cap: nothing (this is the capped path, and it is correct there).
    expect(await extractTsRouteDefinitions(big)).toEqual([]);
    // Handed the resident text: the route survives, which is what the graph gets.
    const withResident = await extractTsRouteDefinitions(big, body);
    expect(withResident.map(r => r.path)).toContain('/oversized-route');
  });

  it('analyze runs the enrichment extractors sequentially, not five at once', () => {
    const src = readFileSync(join(ANALYZER_DIR, '..', '..', 'cli', 'commands', 'analyze.ts'), 'utf-8');
    // Each extractor is internally bounded; running the five together multiplied that bound by
    // five, and the five together are what exhausted the heap.
    expect(src).not.toMatch(/Promise\.all\(\[\s*\n?\s*extractUIComponents/);
    for (const call of [
      'const uiComponents = await extractUIComponents(',
      'const schemas = await extractSchemas(',
      'const routeInventory = await buildRouteInventory(',
      'const middleware = await extractMiddleware(',
      'const envVars = await extractEnvVars(',
    ]) {
      expect(src, `analyze.ts must await ${call}… sequentially`).toContain(call);
    }
  });

  it('analyze discloses files the scan was too large to read (no silent capping)', () => {
    const src = readFileSync(join(ANALYZER_DIR, '..', '..', 'cli', 'commands', 'analyze.ts'), 'utf-8');
    expect(src).toMatch(/const observeOversized: OversizedFileObserver/);
    expect(src).toMatch(/oversizedByPath\.set\(/);
    for (const fn of [
      'extractUIComponents',
      'extractSchemas',
      'buildRouteInventory',
      'extractMiddleware',
      'extractEnvVars',
    ]) {
      expect(src, `${fn} must report scan-time exclusions`).toMatch(
        new RegExp(`${fn}\\([^\\n]+observeOversized\\)`),
      );
    }
    expect(src).toMatch(/LOWER BOUND/);
    // …and scopes the report to files an extractor would actually have opened, so a large
    // image or data blob does not train the operator to ignore the line.
    expect(src).toMatch(/isScannedByEnrichment\(/);
    // …and the repo-controlled path is sanitized before it reaches the terminal.
    expect(src).toMatch(/safe\(f\.path\)/);
  });

  it('the production function and text indexes do not reintroduce all-file fan-out', () => {
    const analyze = codeOf(join('..', '..', 'cli', 'commands', 'analyze.ts'));
    const liveData = readFileSync(
      join(ANALYZER_DIR, '..', 'services', 'mcp-handlers', 'live-data', 'analyze-repo.ts'),
      'utf-8',
    );
    const importCommand = readFileSync(
      join(ANALYZER_DIR, '..', '..', 'cli', 'commands', 'import.ts'),
      'utf-8',
    );

    // All three function-index entry points read every call-graph file. The CLI path was missed
    // by the original fix even though it is the path `openlore install` actually runs.
    for (const [name, src] of [
      ['analyze.ts', analyze],
      ['live-data/analyze-repo.ts', liveData],
      ['import.ts', importCommand],
    ] as const) {
      expect(src, `${name} must use the shared bounded pool`).toMatch(/mapFilesBounded\(/);
      expect(src, `${name} must not fan out reads with Promise.all`).not.toMatch(
        /Promise\.all\([\s\S]{0,300}?readFile\(/,
      );
    }
    for (const [name, src] of [
      ['analyze.ts', analyze],
      ['live-data/analyze-repo.ts', liveData],
      ['import.ts', importCommand],
    ] as const) {
      expect(src, `${name} must route the function-index file list through the bounded pool`)
        .toMatch(/const contents = await mapFilesBounded\(paths/);
    }
    // Text-line indexing must be bounded in BOTH axes (change: fix-text-line-index-oom).
    // Bounding concurrency alone was not enough here: the reads were already pooled, and the
    // build still ran the heap out because it RETAINED every file's text in one array and then
    // amplified it into one record per source line before writing anything. So the guard is on
    // the streaming shape, not on any single call spelling.
    expect(analyze, 'text-line indexing must read through the shared bounded pool')
      .toMatch(/const contents = await mapFilesBounded\(/);
    expect(analyze, 'text-line indexing must STREAM files, not collect them all first')
      .toMatch(/async function\* streamFiles\(\)/);
    expect(analyze, 'text-line indexing must hand the index a stream, not an array')
      .toMatch(/TextLineIndex\.build\(outputPath, streamFiles\(\)\)/);
  });

  it('the text-line index writes in batches instead of materializing every line first', () => {
    const src = readFileSync(join(ANALYZER_DIR, 'text-line-index.ts'), 'utf-8');
    // One record object per source line, for the whole repository, before the first write — that
    // is an AMPLIFICATION of the text, and it is what exhausted the heap on a large repository
    // even though every earlier phase had succeeded. The build must flush as it goes.
    expect(src, 'build must accept a stream').toMatch(/AsyncIterable<TextFileInput>/);
    expect(src, 'build must flush at a bounded interval').toMatch(/batch\.length >= BUILD_FLUSH_LINES/);
    // …and the first flush creates the table while later ones APPEND — re-creating per flush
    // would keep only the final batch.
    expect(src).toMatch(/if \(table === null\)/);
    expect(src).toMatch(/await table\.add\(rows\)/);
  });

  it('the disclosure covers every extension the scan modules read', async () => {
    const { isScannedByEnrichment } = await import('./bounded-file-scan.js');
    // Harvest EVERY extension literal each scan module mentions, with no allowlist.
    //
    // A previous version of this test filtered candidates through a hardcoded pattern that
    // enumerated exactly the members of the disclosure set — so `missing` was provably always
    // empty and the test could not fail. A guard that cannot fail is worse than no guard: it
    // reads as coverage. Harvesting blind means adding `.kt` to any scan module fails this test
    // until the disclosure predicate covers it, which is the whole point.
    const missing: string[] = [];
    for (const file of SCAN_MODULES) {
      for (const m of codeOf(file).matchAll(/'(\.[A-Za-z0-9]{1,8})'/g)) {
        if (!isScannedByEnrichment(`x${m[1]}`)) missing.push(`${file}: ${m[1]}`);
      }
    }
    expect(missing, 'extensions read by a scan module but absent from the disclosure predicate').toEqual([]);
  });

  it('the disclosure predicate covers env declaration files, which have no usable extension', async () => {
    const { isScannedByEnrichment, ENV_DECLARATION_FILES } = await import('./bounded-file-scan.js');
    // `extname('.env')` is `''` and `extname('.env.production')` is `'.production'`, so an
    // extension-only predicate drops an oversized `.env` with no disclosure at all — the exact
    // silent loss the design forbids. Every file the env scan opens must be reportable.
    for (const name of ENV_DECLARATION_FILES) {
      expect(isScannedByEnrichment(`/repo/${name}`), `${name} must be disclosable`).toBe(true);
    }
    // …and it still excludes what no extractor opens, so the warning stays worth reading.
    for (const noise of ['/repo/assets.bin', '/repo/data.json', '/repo/logo.png', '/repo/notes.md']) {
      expect(isScannedByEnrichment(noise), `${noise} must not be reported`).toBe(false);
    }
  });

  it('the size cap is measured on the same file handle it reads from (no TOCTOU)', () => {
    // Comments stripped first: the module's own docblock explains the hazard by NAMING the
    // rejected `stat(path)` / `readFile(path)` shape, and prose must not fail the guard.
    const code = readFileSync(join(ANALYZER_DIR, 'bounded-file-scan.ts'), 'utf-8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');
    // A separate `stat(path)` then `readFile(path)` resolves the name twice, so a file that grew
    // or was replaced in between is read at a size that was never checked — the cap can be
    // stepped around by a repository being written to concurrently. Sizing and reading ONE open
    // handle closes it by construction.
    expect(code).toMatch(/await open\(path, 'r'\)/);
    expect(code).toMatch(/handle\.stat\(\)/);
    expect(code, 'must not re-resolve the path for the read').not.toMatch(/\breadFile\(path/);
    expect(code, 'must not stat the path separately from the read').not.toMatch(/[^.]\bstat\(path\)/);
    // …and the read must be LENGTH-BOUNDED by the size just checked. `handle.readFile()` reads to
    // CURRENT end-of-file, so one handle alone does not bound anything: a file appended to during
    // the await window comes back in full, straight through the cap (measured: 1 KB -> 20 MB).
    expect(code, 'the read must be bounded to the checked size, not readFile-to-EOF')
      .not.toMatch(/handle\.readFile\(/);
    expect(code).toMatch(/handle\.read\(buf/);
    expect(code).toMatch(/Buffer\.allocUnsafe\(s\.size\)/);
    // The handle is always released, including on the oversized/unreadable paths.
    expect(code).toMatch(/finally\s*\{[\s\S]{0,200}handle\?\.close\(\)/);
  });

  it('both bounds are defined, documented, and small enough to matter', async () => {
    const { SOURCE_SCAN_CONCURRENCY, SOURCE_SCAN_MAX_FILE_BYTES } = await import('../../constants.js');
    // A bound large enough to admit an ordinary repository wholesale is not a bound.
    expect(SOURCE_SCAN_CONCURRENCY).toBeGreaterThan(0);
    expect(SOURCE_SCAN_CONCURRENCY).toBeLessThanOrEqual(32);
    expect(SOURCE_SCAN_MAX_FILE_BYTES).toBeGreaterThan(0);
    expect(SOURCE_SCAN_MAX_FILE_BYTES).toBeLessThanOrEqual(16 * 1024 * 1024);
  });
});

describe('Bounded Computation — an oversized file is skipped by every extractor (issue #302)', () => {
  let repo: string | undefined;
  afterEach(() => {
    if (repo) rmSync(repo, { recursive: true, force: true });
    repo = undefined;
  });

  it('excludes the oversized file and still extracts from its neighbours', async () => {
    const { SOURCE_SCAN_MAX_FILE_BYTES } = await import('../../constants.js');
    const { extractUIComponents } = await import('./ui-component-extractor.js');
    const { extractSchemas } = await import('./schema-extractor.js');
    const { buildRouteInventory } = await import('./http-route-parser.js');
    const { extractMiddleware } = await import('./middleware-extractor.js');

    repo = mkdtempSync(join(tmpdir(), 'ol-scan-oversize-'));
    const big = join(repo, 'generated-client.tsx');
    const small = join(repo, 'Widget.tsx');

    // The oversized file carries content EVERY extractor would otherwise match, so a result
    // naming it proves the cap was not applied — an empty result proves nothing on its own.
    const marker =
      'export const KEY = process.env.OVERSIZED_MARKER;\n'
      + "app.get('/oversized-marker', (req, res) => res.send('x'));\n"
      + "app.use(helmet());\n"
      + "export const OversizedMarker = pgTable('oversized_marker', {});\n"
      + 'export function OversizedWidget() { return <div />; }\n';
    writeFileSync(big, marker + '// pad\n'.repeat(Math.ceil(SOURCE_SCAN_MAX_FILE_BYTES / 7)));
    writeFileSync(
      small,
      "import express from 'express';\n"
      + 'const app = express();\n'
      + "app.get('/small', (req, res) => res.send('ok'));\n"
      + 'export function SmallWidget() { return <div />; }\n',
    );

    const paths = [big, small];
    const [ui, schemas, routes, middleware] = [
      await extractUIComponents(paths, repo),
      await extractSchemas(paths, repo),
      await buildRouteInventory(paths, repo),
      await extractMiddleware(paths, repo),
    ];

    const mentionsBig = (blob: unknown) => JSON.stringify(blob ?? null).includes('generated-client');
    expect(mentionsBig(ui), 'UI components must skip the oversized file').toBe(false);
    expect(mentionsBig(schemas), 'schemas must skip the oversized file').toBe(false);
    expect(mentionsBig(routes), 'routes must skip the oversized file').toBe(false);
    expect(mentionsBig(middleware), 'middleware must skip the oversized file').toBe(false);

    // …and the cap did not simply disable the extractors: the neighbour is still extracted.
    expect(JSON.stringify(ui)).toContain('SmallWidget');
    expect(routes.routes.some(r => r.path === '/small')).toBe(true);
  });

  it('the env extractor skips the oversized file and still reads its neighbours', async () => {
    const { SOURCE_SCAN_MAX_FILE_BYTES } = await import('../../constants.js');

    repo = mkdtempSync(join(tmpdir(), 'ol-scan-oversize-env-'));
    const big = join(repo, 'huge.ts');
    const small = join(repo, 'config.ts');
    writeFileSync(
      big,
      'const K = process.env.OVERSIZED_ONLY_VAR;\n'
      + 'const PAD = 0;\n'.repeat(Math.ceil(SOURCE_SCAN_MAX_FILE_BYTES / 15)),
    );
    writeFileSync(small, 'export const url = process.env.SMALL_FILE_VAR;\n');

    const vars = await extractEnvVars([big, small], repo);
    const names = vars.map(v => v.name);
    expect(names).toContain('SMALL_FILE_VAR');
    expect(names).not.toContain('OVERSIZED_ONLY_VAR');
  });
});
