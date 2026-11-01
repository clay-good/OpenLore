import { describe, it, expect } from 'vitest';
import { readCallBody } from './payload-literal.js';

const at = (text: string, client = 'fetch') => readCallBody(text, text.indexOf(client === 'fetch' ? 'fetch' : 'axios'), client);

describe('literal request bodies at a call site', () => {
  it('reads JSON.stringify and object bodies, with shorthand, quoted, and nested values', () => {
    expect(at("fetch('/v1/orders', { method: 'POST', body: JSON.stringify({ items, 'note': `a ${x}`, total: f({ y: 1 }) }) });")).toEqual({ kind: 'literal', keys: ['items', 'note', 'total'] });
    expect(at("axios.post('/v1/orders', { customerId: id, items: [1, 2] })", 'axios')).toEqual({ kind: 'literal', keys: ['customerId', 'items'] });
    expect(at("axios.put('/v1/orders', JSON.stringify({ a: '}' }))", 'axios')).toEqual({ kind: 'literal', keys: ['a'] });
  });

  it('a spread, a computed key, or a variable is not literal; no body is absent', () => {
    expect(at("fetch('/v1/orders', { method: 'POST', body: JSON.stringify({ ...base, items }) })").kind).toBe('not-literal');
    expect(at("fetch('/v1/orders', { method: 'POST', body: JSON.stringify({ [k]: 1 }) })").kind).toBe('not-literal');
    expect(at("fetch('/v1/orders', { method: 'POST', body: payload })").kind).toBe('not-literal');
    expect(at("fetch('/v1/orders', { method: 'POST', body })").kind).toBe('not-literal');
    expect(at("fetch('/v1/orders', opts)").kind).toBe('not-literal');
    expect(at("fetch('/v1/orders', { method: 'POST' })")).toEqual({ kind: 'absent' });
    expect(at("axios.post('/v1/orders')", 'axios')).toEqual({ kind: 'absent' });
    expect(at("axios.get('/v1/orders', { params })", 'axios').kind).toBe('not-literal');
  });
});
