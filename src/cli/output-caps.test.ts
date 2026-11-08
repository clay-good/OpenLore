/**
 * Guards for the DISCLOSED rendering caps on `openlore analyze`'s console
 * reports, and for the two third-party warning leaks that shared the same
 * symptom — unreadable output in the middle of the report
 * (change: fix-analyze-console-report-caps).
 *
 * Real-repo evidence these pin:
 *   - grpc-go @ cbf30c41 printed one `⚠ Cycle:` line of 36,445 characters
 *     naming 1,347 symbols, and clone-group lines of several KB each.
 *   - grpc-python @ 952c8d46 leaked `[DEP0151]` DeprecationWarning lines from
 *     our own grammar imports.
 *   - kustomize @ 10dc7fa0 leaked four `yaml` "Keys with collection values"
 *     warnings from Helm templates.
 *
 * Each case asserts the rendered line's LENGTH and the EXACT omitted count, so
 * a regression cannot come back as a quiet truncation or an unbounded line.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { createRequire } from 'node:module';
import {
  joinCapped,
  omittedDisclosure,
  CYCLE_MEMBERS_SHOWN,
  CLONE_MEMBERS_SHOWN,
} from '../utils/capped-list.js';
import { renderCycleLine, renderCloneGroupLine } from './commands/analyze.js';
import { resolveGrammarEntry } from '../core/analyzer/grammar-entry.js';
import { YAML_QUIET, reportStringifiedCollectionKeys } from '../core/analyzer/yaml-diagnostics.js';
import { logger, configureLogger } from '../utils/logger.js';

describe('analyze console caps — cycle report line', () => {
  it('a cycle of 1,347 symbols renders one bounded line with the exact omitted count', () => {
    const participants = Array.from({ length: 1347 }, (_, i) => ({
      function: `symbolNumber${i}`,
      file: `pkg/file${i}.go`,
    }));

    const line = renderCycleLine({ size: participants.length, participants });

    // Bounded: the pre-fix line was 36,445 characters.
    expect(line.length).toBeLessThan(400);
    // Disclosed: the exact number withheld, never a bare "…".
    expect(line).toContain(`… and ${1347 - CYCLE_MEMBERS_SHOWN} more symbols`);
    // The names that ARE shown are the first ones, in order.
    expect(line).toContain('⚠ Cycle: symbolNumber0 ↔ symbolNumber1 ↔ ');
    expect(line).not.toContain(`symbolNumber${CYCLE_MEMBERS_SHOWN}`);
  });

  it('a cycle at or under the cap renders every name with no disclosure', () => {
    const participants = Array.from({ length: CYCLE_MEMBERS_SHOWN }, (_, i) => ({
      function: `fn${i}`, file: 'a.go',
    }));
    const line = renderCycleLine({ size: participants.length, participants });
    expect(line).not.toContain('… and');
    for (let i = 0; i < CYCLE_MEMBERS_SHOWN; i++) expect(line).toContain(`fn${i}`);
  });

  it('a hostile symbol name cannot leak ANSI or a bidi override to the terminal', () => {
    const participants = [
      { function: '\u001b[31mred\u001b[0m', file: 'a.go' },
      { function: 'safe‮evil', file: 'a.go' },
      ...Array.from({ length: 200 }, (_, i) => ({ function: `fn${i}`, file: 'a.go' })),
    ];
    const line = renderCycleLine({ size: participants.length, participants });
    expect(line).not.toContain('\u001b');
    expect(line).not.toContain('‮');
    expect(line).toContain('… and 194 more symbols');
  });

  it('a cycle of 100,000 symbols renders in bounded time and length', () => {
    const participants = Array.from({ length: 100_000 }, (_, i) => ({
      function: `fn${i}`, file: 'a.go',
    }));
    const started = Date.now();
    const line = renderCycleLine({ size: participants.length, participants });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(line.length).toBeLessThan(400);
    expect(line).toContain(`… and ${100_000 - CYCLE_MEMBERS_SHOWN} more symbols`);
  });
});

describe('analyze console caps — clone group line', () => {
  it('a 182-member clone group renders one bounded line with the exact omitted count', () => {
    const instances = Array.from({ length: 182 }, (_, i) => ({
      file: `github.com/org/repo/pkg/grpc_lookup_v1/rls_config${i}.pb.go`,
      functionName: `GetCacheSizeBytes${i}`,
      startLine: 1,
      endLine: 6,
    }));

    const line = renderCloneGroupLine({
      type: 'structural',
      similarity: 1,
      lineCount: 6,
      instances,
    });

    // Bounded: the pre-fix line was 8,333 characters.
    expect(line.length).toBeLessThan(600);
    expect(line).toContain(`… and ${182 - CLONE_MEMBERS_SHOWN} more members`);
    // The group's real size is still stated, so the cap hides nothing material.
    expect(line).toContain('(182x, 6 lines)');
  });
});

describe('disclosed-cap helper', () => {
  it('joinCapped never truncates silently', () => {
    expect(joinCapped(['a', 'b'], 5, ', ', 'thing')).toBe('a, b');
    expect(joinCapped(['a', 'b', 'c'], 2, ', ', 'thing')).toBe('a, b  … and 1 more thing');
    expect(joinCapped(['a', 'b', 'c', 'd'], 2, ', ', 'thing')).toBe('a, b  … and 2 more things');
    // A zero cap still discloses rather than printing nothing.
    expect(joinCapped(['a', 'b'], 0, ', ', 'thing')).toBe('… and 2 more things');
  });

  it('omittedDisclosure is null only when nothing was withheld', () => {
    expect(omittedDisclosure(3, 5, 'cycle')).toBeNull();
    expect(omittedDisclosure(5, 5, 'cycle')).toBeNull();
    expect(omittedDisclosure(6, 5, 'cycle')).toBe('… and 1 more cycle');
    expect(omittedDisclosure(289, 10, 'cycle')).toBe('… and 279 more cycles');
  });
});

describe('grammar imports do not trigger DEP0151', () => {
  const require_ = createRequire(import.meta.url);

  it('resolves each grammar to its explicit entry FILE, not the package directory', () => {
    // DEP0151 fires when Node's ESM resolver has to complete an extension-less
    // `"main"`. Pinning the mechanism: what we import is a real file path with an
    // extension, which the resolver never has to complete.
    for (const specifier of ['tree-sitter-c-sharp', 'tree-sitter-python', 'tree-sitter-go']) {
      let installed = true;
      try { require_.resolve(specifier); } catch { installed = false; }
      if (!installed) continue; // grammars are optionalDependencies
      const entry = resolveGrammarEntry(specifier);
      expect(entry, `${specifier} must resolve to an entry file`).toBeTruthy();
      expect(entry!.endsWith('.js'), `${specifier} entry must name a file: ${entry}`).toBe(true);
      expect(entry).not.toMatch(/node_modules[\\/]tree-sitter-[a-z-]+[\\/]?$/);
    }
  });

  it('an unresolvable grammar yields null rather than throwing', () => {
    expect(resolveGrammarEntry('tree-sitter-not-a-real-grammar')).toBeNull();
  });

  it('no production module imports a grammar by bare package specifier', async () => {
    const { readFileSync } = await import('node:fs');
    const { join, dirname } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const root = join(dirname(fileURLToPath(import.meta.url)), '..');
    const offenders: string[] = [];
    for (const rel of [
      'core/analyzer/call-graph.ts',
      'core/analyzer/ast-chunker.ts',
      'core/analyzer/exception-flow.ts',
    ]) {
      const src = readFileSync(join(root, rel), 'utf-8');
      // `import('tree-sitter')` (the runtime itself) declares a proper `main` and
      // is fine; every `tree-sitter-<lang>` grammar must go through importGrammar.
      if (/\bimport\('tree-sitter-[a-z0-9-]+'\)/.test(src)) offenders.push(rel);
    }
    expect(
      offenders,
      'Import grammars via importGrammar() so Node never completes their extension-less "main" (DEP0151):\n' +
      offenders.join('\n'),
    ).toEqual([]);
  });
});

describe('yaml library diagnostics do not reach stderr', () => {
  afterEach(() => { configureLogger({ verbose: false }); });

  /** The Helm-masked shape that provoked the library warning on kustomize. */
  const PROVOKING_YAML = 'kind: Service\nmetadata:\n  name: svc\n{ .Name }: value\n';

  it('a document that provokes the warning emits nothing on the warning channel', async () => {
    const { parseAllDocuments } = await import('yaml');
    const warnings: unknown[] = [];
    const onWarning = (w: unknown) => warnings.push(w);
    process.on('warning', onWarning);
    try {
      const docs = parseAllDocuments(PROVOKING_YAML, { ...YAML_QUIET });
      for (const doc of docs) doc.toJS();
      // `process.emitWarning` is asynchronous — let the event loop drain.
      await new Promise(resolve => setTimeout(resolve, 10));
    } finally {
      process.off('warning', onWarning);
    }
    expect(
      warnings.map(String).filter(w => w.includes('Keys with collection values')),
    ).toEqual([]);
  });

  it('the same document DOES provoke the library warning without the quiet option (the fix is load-bearing)', async () => {
    const { parseAllDocuments } = await import('yaml');
    const warnings: unknown[] = [];
    const onWarning = (w: unknown) => warnings.push(w);
    process.on('warning', onWarning);
    try {
      for (const doc of parseAllDocuments(PROVOKING_YAML)) doc.toJS();
      await new Promise(resolve => setTimeout(resolve, 10));
    } finally {
      process.off('warning', onWarning);
    }
    expect(
      warnings.map(String).some(w => w.includes('Keys with collection values')),
    ).toBe(true);
  });

  it('the information is still reachable: --verbose reports the stringified key on our logger', async () => {
    const { parseAllDocuments } = await import('yaml');
    configureLogger({ verbose: true });
    const seen: string[] = [];
    const spy = vi.spyOn(logger, 'debug').mockImplementation((m: string) => { seen.push(m); });
    try {
      const docs = parseAllDocuments(PROVOKING_YAML, { ...YAML_QUIET });
      reportStringifiedCollectionKeys(docs, 'charts/app/templates/svc.yaml');
    } finally {
      spy.mockRestore();
    }
    const line = seen.find(m => m.startsWith('[yaml]'));
    expect(line, `expected a [yaml] debug line, got: ${seen.join(' | ')}`).toBeTruthy();
    expect(line).toContain('charts/app/templates/svc.yaml');
    expect(line).toContain('collection-valued map key');
    expect(line).toContain('.Name');
  });

  it('says nothing when no key was stringified', async () => {
    const { parseAllDocuments } = await import('yaml');
    configureLogger({ verbose: true });
    const seen: string[] = [];
    const spy = vi.spyOn(logger, 'debug').mockImplementation((m: string) => { seen.push(m); });
    try {
      reportStringifiedCollectionKeys(
        parseAllDocuments('kind: Service\nmetadata:\n  name: svc\n', { ...YAML_QUIET }),
        'charts/app/templates/svc.yaml',
      );
    } finally {
      spy.mockRestore();
    }
    expect(seen.filter(m => m.startsWith('[yaml]'))).toEqual([]);
  });
});
