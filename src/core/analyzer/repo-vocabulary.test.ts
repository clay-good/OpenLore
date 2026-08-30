import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  compareVocabularyRank,
  expandVocabularyQuery,
  loadRepositoryVocabulary,
  mineRepositoryVocabulary,
  persistRepositoryVocabulary,
  type RepositoryVocabularySource,
} from './repo-vocabulary.js';

const dirs: string[] = [];

function tempOutput(): string {
  const dir = mkdtempSync(join(tmpdir(), 'openlore-vocabulary-'));
  dirs.push(dir);
  mkdirSync(join(dir, 'vector-index'));
  return dir;
}

function source(id: string, name: string, signature: string, docstring = ''): RepositoryVocabularySource {
  return { id, name, signature, docstring, className: '', filePath: `src/${id}.ts`, text: `${name} ${signature} ${docstring}` };
}

function df(...terms: string[]): Map<string, number> {
  return new Map(terms.map(term => [term, 2]));
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('repository vocabulary mining', () => {
  it('accepts an evidenced abbreviation and rejects a one-site candidate', () => {
    const vocabulary = mineRepositoryVocabulary([
      source('a', 'pmtHandler', 'pmt: Payment'),
      source('b', 'pmtQueue', 'pmt: Payment'),
      source('c', 'usrHandler', 'usr: User'),
    ], df('pmt', 'payment', 'usr', 'user'), 'a'.repeat(64));
    const entries = new Map(vocabulary.entries);
    expect(entries.get('payment')).toContain('pmt');
    expect(entries.get('pmt')).toContain('payment');
    expect(entries.get('usr') ?? []).not.toContain('user');
  });

  it('does not treat repeated arbitrary body text as abbreviation evidence', () => {
    const vocabulary = mineRepositoryVocabulary([
      { ...source('a', 'firstHandler', 'value: string'), text: 'pmt payment' },
      { ...source('b', 'secondHandler', 'value: string'), text: 'pmt payment' },
    ], df('pmt', 'payment'), '9'.repeat(64));
    const entries = new Map(vocabulary.entries);
    expect(entries.get('pmt') ?? []).not.toContain('payment');
  });

  it('allows only the declared seed set to create an unevidenced abbreviation', () => {
    const vocabulary = mineRepositoryVocabulary([
      source('a', 'cfgReader', 'Config'),
      source('b', 'unrelated', 'value'),
    ], df('cfg', 'config', 'usr', 'user'), 'b'.repeat(64));
    const entries = new Map(vocabulary.entries);
    expect(entries.get('cfg')).toContain('config');
    expect(entries.get('usr')).toBeUndefined();
  });

  it('links only attested conservative morphology and leaves unrelated language tokens alone', () => {
    const vocabulary = mineRepositoryVocabulary([
      source('a', 'validate', 'validation'),
      source('b', 'validateAgain', 'validation'),
      source('c', 'servicio', 'servicio'),
      source('d', 'servicioOtro', 'servicio'),
    ], df('validate', 'validation', 'servicio'), 'c'.repeat(64));
    const entries = new Map(vocabulary.entries);
    expect(entries.get('validation')).toContain('validate');
    expect(entries.get('servicio')).toBeUndefined();
  });

  it('is byte-deterministic across input order', () => {
    const sources = [
      source('a', 'pmtHandler', 'pmt: Payment'),
      source('b', 'pmtQueue', 'pmt: Payment'),
    ];
    const first = mineRepositoryVocabulary(sources, df('pmt', 'payment'), 'd'.repeat(64));
    const second = mineRepositoryVocabulary([...sources].reverse(), df('payment', 'pmt'), 'd'.repeat(64));
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  it('stops at the declared budget and discloses omitted candidates', () => {
    let ticks = 0;
    const terms = Array.from({ length: 300 }, (_, index) => `a${index.toString(36).padStart(3, '0')}`);
    const vocabulary = mineRepositoryVocabulary(
      [source('a', terms.join(' '), terms.join(' ')), source('b', terms.join(' '), terms.join(' '))],
      df(...terms),
      'e'.repeat(64),
      { budgetMs: 1, now: () => ticks++ },
    );
    expect(vocabulary.status).toBe('partial');
    expect(vocabulary.omittedCandidateCount).toBeGreaterThan(0);
  });

  it('emits identical partial bytes regardless of the cutoff position', () => {
    const sources = Array.from({ length: 128 }, (_, index) =>
      source(`site-${index.toString().padStart(3, '0')}`, 'cfgReader', 'Config'),
    );
    const earlyTimes = [0, 2];
    const laterTimes = [0, 0, 2];
    const early = mineRepositoryVocabulary(sources, df('cfg', 'config'), '8'.repeat(64), {
      budgetMs: 1,
      now: () => earlyTimes.shift() ?? 2,
    });
    const later = mineRepositoryVocabulary(sources, df('cfg', 'config'), '8'.repeat(64), {
      budgetMs: 1,
      now: () => laterTimes.shift() ?? 2,
    });
    expect(early.status).toBe('partial');
    expect(JSON.stringify(early)).toBe(JSON.stringify(later));
  });
});

describe('repository vocabulary serving', () => {
  it('loads only a content-stamp-matched, untampered sidecar', async () => {
    const outputDir = tempOutput();
    const stamp = 'f'.repeat(64);
    const vocabulary = mineRepositoryVocabulary([
      source('a', 'pmtHandler', 'pmt: Payment'),
      source('b', 'pmtQueue', 'pmt: Payment'),
    ], df('pmt', 'payment'), stamp);
    await persistRepositoryVocabulary(join(outputDir, 'vector-index'), vocabulary);
    writeFileSync(join(outputDir, 'vector-index-meta.json'), JSON.stringify({ vocabularyContentStamp: stamp }));
    expect(loadRepositoryVocabulary(outputDir)?.entries.length).toBeGreaterThan(0);

    writeFileSync(join(outputDir, 'vector-index-meta.json'), JSON.stringify({ vocabularyContentStamp: '0'.repeat(64) }));
    expect(loadRepositoryVocabulary(outputDir)).toBeNull();
  });

  it('expands only from a verified sidecar and honors the disable flag', async () => {
    const outputDir = tempOutput();
    const stamp = '1'.repeat(64);
    const vocabulary = mineRepositoryVocabulary([
      source('a', 'pmtHandler', 'pmt: Payment'),
      source('b', 'pmtQueue', 'pmt: Payment'),
    ], df('pmt', 'payment'), stamp);
    await persistRepositoryVocabulary(join(outputDir, 'vector-index'), vocabulary);
    writeFileSync(join(outputDir, 'vector-index-meta.json'), JSON.stringify({ vocabularyContentStamp: stamp }));
    expect(expandVocabularyQuery(outputDir, ['payment']).expansionTokens).toContain('pmt');
    expect(expandVocabularyQuery(outputDir, ['payment'], false)).toEqual({
      originalTokens: ['payment'], expansionTokens: [], vocabularyAvailable: false,
    });
  });
});

describe('two-tier vocabulary ranking', () => {
  it('keeps one arbitrarily weak original match above the strongest expansion-only match', () => {
    const ranked = [
      { id: 'expansion', score: 0, expansionScore: Number.MAX_VALUE },
      { id: 'original', score: Number.MIN_VALUE, expansionScore: 0 },
    ].sort(compareVocabularyRank);
    expect(ranked.map(item => item.id)).toEqual(['original', 'expansion']);
  });
});
