import { describe, expect, it } from 'vitest';
import { bm25MatchEvidence, bm25Score, buildBm25Corpus, tokenize } from './vector-index.js';

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
