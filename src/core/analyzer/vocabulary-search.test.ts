import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FunctionNode } from './call-graph.js';
import { servedRetrievalMode } from './embedder.js';
import { REPO_VOCABULARY_FILE } from './repo-vocabulary.js';
import { VectorIndex } from './vector-index.js';
import { SpecVectorIndex } from './spec-vector-index.js';
import { TextLineIndex } from './text-line-index.js';
import type { EmbeddingService } from './embedding-service.js';

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })));

function node(id: string, name: string, signature = '', docstring = ''): FunctionNode {
  return {
    id,
    name,
    filePath: id.split('::')[0],
    isAsync: false,
    language: 'TypeScript',
    startIndex: 0,
    endIndex: 10,
    fanIn: 0,
    fanOut: 0,
    signature,
    docstring,
  };
}

describe('repository vocabulary search', () => {
  it('ranks an original match above an expansion-only candidate before truncation', async () => {
    const outputDir = mkdtempSync(join(tmpdir(), 'openlore-vocabulary-rank-'));
    dirs.push(outputDir);
    const exact = node('src/exact.ts::ConfigManager', 'ConfigManager');
    const expansionOnly = Array.from({ length: 20 }, (_, index) =>
      node(`src/cfg-${index}.ts::CfgWorker${index}`, `CfgWorker${index}`),
    );
    await VectorIndex.build(outputDir, [exact, ...expansionOnly], [], new Set(), new Set(), null);

    const [first] = await VectorIndex.search(outputDir, 'config', null, { limit: 1 });
    expect(first?.record.id).toBe(exact.id);
  });

  it('preserves the original-match tier through hybrid rank fusion', async () => {
    const outputDir = mkdtempSync(join(tmpdir(), 'openlore-vocabulary-hybrid-rank-'));
    dirs.push(outputDir);
    const exact = node('src/exact.ts::ConfigManager', 'ConfigManager');
    const expansionOnly = Array.from({ length: 20 }, (_, index) =>
      node(`src/cfg-${index}.ts::CfgWorker${index}`, `CfgWorker${index}`),
    );
    const embedder = {
      modelName: 'vocabulary-tier-test',
      embed: async (texts: string[]) => texts.map((text) =>
        text.includes('ConfigManager') ? [0, 1] : [1, 0],
      ),
    } as EmbeddingService;
    await VectorIndex.build(outputDir, [exact, ...expansionOnly], [], new Set(), new Set(), embedder);

    const [first] = await VectorIndex.search(outputDir, 'config', embedder, { limit: 1 });
    expect(first?.record.id).toBe(exact.id);
  });

  it('reports the keyword mode that actually serves a semantic fallback', async () => {
    const outputDir = mkdtempSync(join(tmpdir(), 'openlore-vocabulary-fallback-mode-'));
    dirs.push(outputDir);
    const buildEmbedder = {
      modelName: 'fallback-test',
      embed: async (texts: string[]) => texts.map(() => [1, 0]),
    } as EmbeddingService;
    await VectorIndex.build(outputDir, [node('src/a.ts::ConfigManager', 'ConfigManager')], [], new Set(), new Set(), buildEmbedder);
    const failingEmbedder = {
      modelName: 'fallback-test',
      embed: async () => { throw new Error('offline'); },
    } as unknown as EmbeddingService;
    let actualMode = '';

    await VectorIndex.search(outputDir, 'config', failingEmbedder, {
      onRetrievalMode: mode => { actualMode = mode; },
    });

    expect(actualMode).toBe('keyword');
  });

  it('mines repeated variable-to-call binding context from function skeletons', async () => {
    const outputDir = mkdtempSync(join(tmpdir(), 'openlore-vocabulary-bindings-'));
    dirs.push(outputDir);
    const bodyA = 'function first() { const pmt = payment(); return pmt; }';
    const bodyB = 'function second() { const pmt = payment(); return pmt; }';
    const sources = [
      { ...node('src/a.ts::first', 'first'), endIndex: bodyA.length },
      { ...node('src/b.ts::second', 'second'), endIndex: bodyB.length },
      node('src/target.ts::PmtSvc', 'PmtSvc'),
      node('src/payment.ts::PaymentProcessor', 'PaymentProcessor'),
    ];
    await VectorIndex.build(
      outputDir,
      sources,
      [],
      new Set(),
      new Set(),
      null,
      new Map([['src/a.ts', bodyA], ['src/b.ts', bodyB]]),
    );

    const results = await VectorIndex.search(outputDir, 'payment', null);
    expect(results.find(result => result.record.name === 'PmtSvc')?.expansionTerms).toContain('pmt');
  });

  it('recalls abbreviated code, preserves the corpus, and invalidates on incremental mutation', async () => {
    const outputDir = mkdtempSync(join(tmpdir(), 'openlore-vocabulary-search-'));
    dirs.push(outputDir);
    const target = node('src/target.ts::PmtSvc', 'PmtSvc');
    const bindingA = node('src/a.ts::bindPayment', 'bindPayment', 'function bindPayment(pmt: Payment)');
    const bindingB = node('src/b.ts::queuePayment', 'queuePayment', 'function queuePayment(pmt: Payment)');
    await VectorIndex.build(outputDir, [target, bindingA, bindingB], [], new Set(), new Set(), null);

    expect(servedRetrievalMode(null, outputDir)).toBe('keyword+vocabulary');
    const corpusPath = join(outputDir, 'vector-index', 'bm25-corpus.json');
    const before = readFileSync(corpusPath);
    const expanded = await VectorIndex.search(outputDir, 'payment', null, { limit: 10 });
    const disabled = await VectorIndex.search(outputDir, 'payment', null, {
      limit: 10,
      vocabularyExpansion: false,
    });
    const expandedTarget = expanded.find(result => result.record.id === target.id);
    expect(expandedTarget?.expansionTerms).toContain('pmt');
    expect(disabled.some(result => result.record.id === target.id)).toBe(false);
    expect(readFileSync(corpusPath)).toEqual(before);

    const disabledBytes = JSON.stringify(disabled);
    rmSync(join(outputDir, 'vector-index', REPO_VOCABULARY_FILE));
    expect(JSON.stringify(await VectorIndex.search(outputDir, 'payment', null, { limit: 10 }))).toBe(disabledBytes);

    await VectorIndex.build(outputDir, [target, bindingA, bindingB], [], new Set(), new Set(), null);

    await TextLineIndex.build(outputDir, [{ filePath: 'status.txt', content: 'pmt processing ready' }]);
    const textHit = (await TextLineIndex.searchText(outputDir, 'payment'))[0];
    expect(textHit?.expansionTerms).toContain('pmt');

    const specsDir = join(outputDir, 'source-specs');
    mkdirSync(join(specsDir, 'billing'), { recursive: true });
    writeFileSync(join(specsDir, 'billing', 'spec.md'), [
      '# Billing Specification',
      '',
      '## Requirements',
      '',
      '### Requirement: PmtQueue',
      '',
      'The system SHALL process pmt work.',
      '',
      '#### Scenario: Queue',
      '- **GIVEN** work',
      '- **WHEN** queued',
      '- **THEN** pmt processing starts',
    ].join('\n'));
    await SpecVectorIndex.build(outputDir, specsDir, null);
    const specHit = (await SpecVectorIndex.search(outputDir, 'payment', null))[0];
    expect(specHit?.expansionTerms).toContain('pmt');

    await VectorIndex.updateFiles(
      outputDir,
      [{ ...target, name: 'PmtService' }],
      new Set([target.filePath]),
      [],
      new Set(),
      new Set(),
      null,
    );
    expect(existsSync(join(outputDir, 'vector-index', REPO_VOCABULARY_FILE))).toBe(false);
    expect(JSON.parse(readFileSync(join(outputDir, 'vector-index-meta.json'), 'utf8')))
      .not.toHaveProperty('vocabularyContentStamp');
    expect(servedRetrievalMode(null, outputDir)).toBe('keyword');
  });
});
