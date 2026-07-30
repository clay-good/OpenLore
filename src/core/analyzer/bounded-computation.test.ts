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
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
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
  /** Every module that scans a whole repository's files. Add new ones here. */
  const SCAN_MODULES = [
    'ui-component-extractor.ts',
    'schema-extractor.ts',
    'http-route-parser.ts',
    'middleware-extractor.ts',
    'env-extractor.ts',
  ];

  /** `Promise.all(<expr>.map(` — the unbounded fan-out shape, across line breaks. */
  const UNBOUNDED_FANOUT = /Promise\.all\(\s*[\w.]+\s*\.map\(/;

  it.each(SCAN_MODULES)('%s reads through the bounded scan, never a raw readFile', file => {
    const src = readFileSync(join(ANALYZER_DIR, file), 'utf-8');
    // A raw `readFile` in a scan module is unbounded by construction — no size cap.
    expect(src, `${file} must read via readSourceCapped, not readFile`).not.toMatch(/\breadFile\s*\(/);
    expect(src).toMatch(/from '\.\/bounded-file-scan\.js'/);
  });

  it.each(SCAN_MODULES)('%s fans out through mapFilesBounded, not Promise.all', file => {
    const src = readFileSync(join(ANALYZER_DIR, file), 'utf-8');
    // Comments legitimately mention `Promise.all` when explaining why it is not used; strip
    // them so prose cannot fail the guard and code cannot hide behind it.
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');
    expect(code, `${file} must scan via mapFilesBounded`).not.toMatch(UNBOUNDED_FANOUT);
    expect(code).toMatch(/mapFilesBounded\(/);
  });

  it('the call graph synthesizes route-handler edges through the bounded scan', () => {
    const src = readFileSync(join(ANALYZER_DIR, 'call-graph.ts'), 'utf-8');
    // This pass re-reads every file from disk to re-extract routes, so it carries the same
    // hazard as the extractors even though it is handed the content already.
    expect(src).toMatch(/const perFileRoutes = await mapFilesBounded\(/);
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
    expect(src).toMatch(/isOversizedForScan/);
    expect(src).toMatch(/LOWER BOUND/);
    // …and scopes the report to files an extractor would actually have opened, so a large
    // image or data blob does not train the operator to ignore the line.
    expect(src).toMatch(/SCANNED_SOURCE_EXTENSIONS\.has/);
  });

  it('the disclosure covers every extension the scan modules read', async () => {
    const { SCANNED_SOURCE_EXTENSIONS } = await import('./bounded-file-scan.js');
    // Harvest the extension literals each scan module tests against. An extension a module
    // reads but the disclosure set omits would hide a genuinely dropped component/route/env
    // var — the failure the disclosure exists to prevent — so the set must be a superset.
    const missing: string[] = [];
    for (const file of SCAN_MODULES) {
      const src = readFileSync(join(ANALYZER_DIR, file), 'utf-8');
      for (const m of src.matchAll(/'(\.[a-z0-9]{1,7})'/g)) {
        const ext = m[1];
        // Only extensions that appear in an accept-list position (a Set/array of extensions),
        // which is how every one of these modules spells its filter.
        if (!/^\.(ts|tsx|js|jsx|mjs|cjs|py|pyw|go|rb|java|vue|svelte|prisma|html|htm|env)$/.test(ext)) continue;
        if (ext === '.html' || ext === '.htm' || ext === '.env') continue; // not enrichment-scanned
        if (!SCANNED_SOURCE_EXTENSIONS.has(ext)) missing.push(`${file}: ${ext}`);
      }
    }
    expect(missing, 'extensions read by a scan module but absent from the disclosure set').toEqual([]);
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
