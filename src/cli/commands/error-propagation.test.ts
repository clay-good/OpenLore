import { describe, expect, it } from 'vitest';
import { renderHuman } from './error-propagation.js';

describe('error-propagation rendering', () => {
  it('renders Go value flow without exception terminology', () => {
    const text = renderHuman({
      errorModel: 'go-value',
      query: { symbol: 'f::main.go', language: 'Go' },
      summary: { escapes: 1, direct: 0, propagated: 0, dynamic: 0, returnedErrors: 1, panics: 0, handledInternally: 0, functionsAnalyzed: 1 },
      escapes: [{ value: 'err', kind: 'returned_error', originFunction: 'f::main.go', originFile: 'main.go', originLine: 4, path: ['f::main.go'] }],
      handledInternally: [], boundaries: [],
    });
    expect(text).toContain('returned error');
    expect(text).not.toMatch(/exception|thrown|caught/i);
  });

  it('accounts for Java throws-clause declarations without changing legacy zero-declaration text', () => {
    const text = renderHuman({
      query: { symbol: 'f::C.java', language: 'Java' },
      summary: { escapes: 1, direct: 0, propagated: 0, dynamic: 0, declared: 1, handledInternally: 0, functionsAnalyzed: 1 },
      escapes: [{ type: 'IOException', kind: 'declared', originFunction: 'f::C.java', originFile: 'C.java', originLine: 2, path: ['f::C.java'] }],
      handledInternally: [], boundaries: [],
    });
    expect(text).toContain('declared 1');
    expect(text).toContain('declared in throws clause');
  });

  it('does not render a bounded empty result as a proven clean function', () => {
    const legacyClean = renderHuman({
      query: { symbol: 'f::x.ts', language: 'TypeScript' },
      summary: { escapes: 0, direct: 0, propagated: 0, dynamic: 0, handledInternally: 0, functionsAnalyzed: 1 },
      escapes: [], handledInternally: [], boundaries: [],
    });
    expect(legacyClean).toContain('no exceptions escape this function');

    const bounded = renderHuman({
      query: { symbol: 'f::x.ts', language: 'TypeScript' },
      summary: { escapes: 0, direct: 0, propagated: 0, dynamic: 0, handledInternally: 0, functionsAnalyzed: 0 },
      escapes: [], handledInternally: [], boundaries: ['source contains syntax errors'],
    });
    expect(bounded).toContain('no escaping exceptions proven in the analyzed portion');
    expect(bounded).not.toContain('no exceptions escape this function');

    const goBounded = renderHuman({
      errorModel: 'go-value', query: { symbol: 'f::x.go', language: 'Go' },
      summary: { escapes: 0, propagated: 0, handledInternally: 0, functionsAnalyzed: 0 },
      escapes: [], handledInternally: [], boundaries: ['AST traversal budget exceeded'],
    });
    expect(goBounded).toContain('proven in the analyzed portion');
    expect(goBounded).not.toContain('escape this function');
  });
});
