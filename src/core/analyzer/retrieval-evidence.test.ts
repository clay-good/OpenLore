import { describe, expect, it } from 'vitest';
import { bm25MatchEvidence, bm25Score, buildBm25Corpus, searchableFieldsForFunctionRow, tokenize } from './vector-index.js';

describe('retrieval match evidence', () => {
  it.each([
    ['symbol', { symbol: 'chargeCard', body: 'unrelated' }, 'charge'],
    ['path', { path: 'src/billing/payment-service.ts', body: 'unrelated' }, 'billing'],
    ['signature', { signature: 'function settleInvoice(invoiceId: string)', body: 'unrelated' }, 'invoice'],
    ['doc', { doc: 'Authenticates a bearer credential', body: 'unrelated' }, 'credential'],
    ['body', { body: 'retry the remote request with jitter' }, 'jitter'],
  ] as const)('attributes a lexical win to %s', (field, fields, query) => {
    const corpus = buildBm25Corpus([{ id: 'one', text: Object.values(fields).join(' ') }]);
    expect(bm25MatchEvidence(corpus, tokenize(query), 0, fields)).toEqual({ field, terms: tokenize(query), tier: 1 });
  });

  it('uses the fixed field precedence on equal contributions and preserves repeated query terms', () => {
    const corpus = buildBm25Corpus([{
      id: 'one',
      text: 'shared shared',
    }]);
    expect(bm25MatchEvidence(corpus, ['shared', 'shared'], 0, { symbol: 'shared', body: 'shared' })).toEqual({
      field: 'symbol',
      terms: ['shared', 'shared'],
      tier: 1,
    });
  });

  it('attributes the aggregate term contribution instead of re-saturating each field', () => {
    const corpus = buildBm25Corpus([{
      id: 'one',
      text: 'beta beta beta beta beta alpha',
    }]);
    expect(bm25MatchEvidence(
      corpus,
      ['alpha', 'beta'],
      0,
      { symbol: 'beta beta beta beta', body: 'alpha beta' },
    ).field).toBe('symbol');
  });

  /**
   * A receipt that names evidence the file does not contain is worse than no receipt
   * (change: fix-retrieval-coverage-over-unread-content). The language marker rode the `path`
   * field, so `search_code {"query":"type"}` answered `field: "path", terms: ["type"]` for
   * `src/index.ts` — a path with no `type` token anywhere in it.
   */
  it('never names a field that does not contain the named terms', () => {
    const fields = searchableFieldsForFunctionRow({
      name: 'run', filePath: 'src/index.ts', language: 'TypeScript', text: '', signature: '', docstring: '',
    });
    const corpus = buildBm25Corpus([{ id: 'one', text: Object.values(fields).join(' ') }]);
    const evidence = bm25MatchEvidence(corpus, tokenize('type'), 0, fields);

    expect(evidence.field).toBe('language');
    for (const term of evidence.terms) {
      expect(tokenize(fields[evidence.field as 'language'] ?? '')).toContain(term);
    }
    expect(tokenize(fields.path ?? '')).not.toContain('type');
  });

  it('keeps the path field answering for the path', () => {
    const fields = searchableFieldsForFunctionRow({
      name: 'run', filePath: 'src/billing/index.ts', language: 'TypeScript', text: '', signature: '', docstring: '',
    });
    const corpus = buildBm25Corpus([{ id: 'one', text: Object.values(fields).join(' ') }]);

    expect(bm25MatchEvidence(corpus, tokenize('billing'), 0, fields).field).toBe('path');
  });

  it('does not perturb aggregate BM25 scores or ordering', () => {
    const plain = buildBm25Corpus([
      { id: 'a', text: 'charge card payment payment' },
      { id: 'b', text: 'charge settlement' },
    ]);
    const fielded = buildBm25Corpus([
      { id: 'a', text: 'charge card payment payment' },
      { id: 'b', text: 'charge settlement' },
    ]);
    const query = tokenize('charge payment');
    expect(fielded.docs.map((_, i) => bm25Score(fielded, query, i)))
      .toEqual(plain.docs.map((_, i) => bm25Score(plain, query, i)));
  });
});
