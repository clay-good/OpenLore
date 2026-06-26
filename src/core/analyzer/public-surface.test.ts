import { describe, it, expect } from 'vitest';
import {
  parseSignature,
  compareTypes,
  classifySignatureChange,
  overallClass,
  signatureClassifiable,
  type SurfaceChange,
} from './public-surface.js';

describe('parseSignature', () => {
  it('parses a typed TS signature into params + return type', () => {
    const p = parseSignature('export function foo(a: number, b?: string): boolean', 'TypeScript');
    expect(p.confidence).toBe('typed');
    expect(p.returnType).toBe('boolean');
    expect(p.params).toEqual([
      { name: 'a', optional: false, rest: false, type: 'number' },
      { name: 'b', optional: true, rest: false, type: 'string' },
    ]);
  });

  it('treats a default value and a rest param as optional', () => {
    const p = parseSignature('function f(a: number = 1, ...rest: string[]): void', 'TypeScript');
    expect(p.params[0].optional).toBe(true);
    expect(p.params[1]).toMatchObject({ name: 'rest', optional: true, rest: true });
  });

  it('respects nested generics/objects when splitting params', () => {
    const p = parseSignature('function g(a: Map<string, number>, b: { x: number; y: number }): void', 'TypeScript');
    expect(p.params.map((x) => x.name)).toEqual(['a', 'b']);
    expect(p.params[0].type).toBe('Map<string, number>');
  });

  it('does NOT mistake a function-type param for an optional/defaulted one (=> is not a default)', () => {
    const p = parseSignature('function f(cb: (x: number) => void): void', 'TypeScript');
    expect(p.params).toEqual([{ name: 'cb', optional: false, rest: false, type: '(x: number) => void' }]);
    expect(p.returnType).toBe('void');
  });

  it('preserves a function-typed return value (interior => not stripped)', () => {
    const p = parseSignature('function f(): (x: number) => void', 'TypeScript');
    expect(p.returnType).toBe('(x: number) => void');
  });

  it('still strips a trailing arrow on an arrow-function declaration', () => {
    const p = parseSignature('const f = (a: number): void =>', 'TypeScript');
    expect(p.returnType).toBe('void');
    expect(p.params).toEqual([{ name: 'a', optional: false, rest: false, type: 'number' }]);
  });

  it('parses a Python signature with -> return', () => {
    const p = parseSignature('def foo(a: int, b: str) -> bool', 'Python');
    expect(p.returnType).toBe('bool');
    expect(p.params.map((x) => x.name)).toEqual(['a', 'b']);
  });

  it('marks an untyped signature untyped', () => {
    const p = parseSignature('function h(a, b)', 'JavaScript');
    expect(p.confidence).toBe('untyped');
  });

  it('marks a signature with no locatable param list unparsed', () => {
    expect(parseSignature('export const X = 42', 'TypeScript').confidence).toBe('unparsed');
  });
});

describe('compareTypes (union-membership subset)', () => {
  it('detects narrowing (member dropped)', () => {
    expect(compareTypes('string | number', 'string')).toBe('narrowed');
  });
  it('detects widening (member added)', () => {
    expect(compareTypes('string', 'string | number')).toBe('widened');
  });
  it('treats reordered unions as same', () => {
    expect(compareTypes('a | b', 'b | a')).toBe('same');
  });
  it('reports incomparable when neither contains the other', () => {
    expect(compareTypes('string', 'number')).toBe('incomparable');
  });
});

describe('classifySignatureChange', () => {
  const TS = 'TypeScript';
  it('added required parameter → breaking', () => {
    const r = classifySignatureChange('function f(a: number): void', 'function f(a: number, b: string): void', TS);
    expect(r.class).toBe('breaking');
    expect(r.reasons.join(' ')).toMatch(/required parameter "b" was added/);
  });

  it('added trailing optional parameter → non-breaking', () => {
    const r = classifySignatureChange('function f(a: number): void', 'function f(a: number, b?: string): void', TS);
    expect(r.class).toBe('non-breaking');
  });

  it('removed parameter → breaking', () => {
    const r = classifySignatureChange('function f(a: number, b: string): void', 'function f(a: number): void', TS);
    expect(r.class).toBe('breaking');
    expect(r.reasons.join(' ')).toMatch(/"b" was removed/);
  });

  it('optional parameter made required → breaking', () => {
    const r = classifySignatureChange('function f(a?: number): void', 'function f(a: number): void', TS);
    expect(r.class).toBe('breaking');
    expect(r.reasons.join(' ')).toMatch(/became required/);
  });

  it('narrowed parameter type → breaking', () => {
    const r = classifySignatureChange('function f(a: string | number): void', 'function f(a: string): void', TS);
    expect(r.class).toBe('breaking');
    expect(r.reasons.join(' ')).toMatch(/type narrowed/);
  });

  it('narrowed return type → breaking', () => {
    const r = classifySignatureChange('function f(): string | number', 'function f(): string', TS);
    expect(r.class).toBe('breaking');
    expect(r.reasons.join(' ')).toMatch(/return type narrowed/);
  });

  it('widened return type → non-breaking', () => {
    const r = classifySignatureChange('function f(): string', 'function f(): string | number', TS);
    expect(r.class).toBe('non-breaking');
  });

  it('a parameter losing its type annotation → potentially-breaking (never silently safe)', () => {
    const r = classifySignatureChange('function f(a: number): void', 'function f(a): void', 'TypeScript');
    expect(r.class).toBe('potentially-breaking');
    expect(r.reasons.join(' ')).toMatch(/untyped; compatibility unprovable/);
  });

  it('pure parameter rename (untyped) → non-breaking (positional, no contract effect)', () => {
    const r = classifySignatureChange('function f(a)', 'function f(b)', 'JavaScript');
    expect(r.class).toBe('non-breaking');
  });

  it('incomparable type change → potentially-breaking', () => {
    const r = classifySignatureChange('function f(a: string): void', 'function f(a: number): void', TS);
    expect(r.class).toBe('potentially-breaking');
  });

  it('non-classifiable language → potentially-breaking on any change', () => {
    const r = classifySignatureChange('func F(a int)', 'func F(a int, b string)', 'Go');
    expect(r.class).toBe('potentially-breaking');
  });

  it('added required function-type (callback) parameter → breaking (regression: => is not "optional")', () => {
    const r = classifySignatureChange(
      'function f(a: number): void',
      'function f(a: number, cb: (x: number) => void): void',
      TS,
    );
    expect(r.class).toBe('breaking');
    expect(r.reasons.join(' ')).toMatch(/required parameter "cb" was added/);
  });

  it('a callback parameter becoming required → breaking (regression: optional→required under =>)', () => {
    const r = classifySignatureChange(
      'function f(cb?: (x: number) => void): void',
      'function f(cb: (x: number) => void): void',
      TS,
    );
    expect(r.class).toBe('breaking');
    expect(r.reasons.join(' ')).toMatch(/became required/);
  });

  it('identical signature → non-breaking with no reasons', () => {
    const r = classifySignatureChange('function f(a: number): void', 'function f(a: number): void', TS);
    expect(r.class).toBe('non-breaking');
    expect(r.reasons).toEqual([]);
  });

  it('whitespace-only difference → non-breaking', () => {
    const r = classifySignatureChange('function f(a: number): void', 'function  f(a:  number) : void', TS);
    expect(r.class).toBe('non-breaking');
  });
});

describe('overallClass', () => {
  const mk = (cls: SurfaceChange['class']): SurfaceChange =>
    ({ changeKind: 'signature', class: cls, name: 'x', file: 'a.ts', kind: 'function', reasons: [] });
  it('breaking dominates', () => {
    expect(overallClass([mk('non-breaking'), mk('potentially-breaking'), mk('breaking')])).toBe('breaking');
  });
  it('potentially-breaking when no breaking', () => {
    expect(overallClass([mk('non-breaking'), mk('potentially-breaking')])).toBe('potentially-breaking');
  });
  it('non-breaking when all non-breaking', () => {
    expect(overallClass([mk('non-breaking'), mk('non-breaking')])).toBe('non-breaking');
  });
  it('empty → non-breaking', () => {
    expect(overallClass([])).toBe('non-breaking');
  });
});

describe('signatureClassifiable', () => {
  it('true for TS/JS/Python, false otherwise', () => {
    expect(signatureClassifiable('TypeScript')).toBe(true);
    expect(signatureClassifiable('Python')).toBe(true);
    expect(signatureClassifiable('Go')).toBe(false);
  });
});
