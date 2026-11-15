/**
 * HTTP call extraction must not depend on syntax-node object identity (see `same-node.ts`): the
 * native binding can return a new object for a second read of a node after a garbage collection.
 */
import { describe, expect, it } from 'vitest';
import { getExceptionParser } from './exception-flow.js';
import { extractGoHttpCallsFromRoot, extractPythonHttpCallsFromRoot } from './http-route-parser.js';
import { freshOnEveryRead } from './fixtures/fresh-node-reads.js';

describe('HTTP call extraction — independent of node object identity', () => {
  it('Python: an import inside a function under a module-level `if` stays unconditional for that function', async () => {
    const parser = await getExceptionParser('Python', 'app.py');
    expect(parser).not.toBeNull();
    const source = [
      'import os',
      'if os.environ.get("ENABLED"):',
      '    def fetch_users():',
      '        import requests',
      '        return requests.get("https://api.example.com/users")',
      '',
    ].join('\n');
    const root = parser!.parse(source).rootNode;
    const stable = extractPythonHttpCallsFromRoot('app.py', root);
    expect(stable).toEqual([expect.objectContaining({ method: 'GET', url: 'https://api.example.com/users' })]);
    expect(extractPythonHttpCallsFromRoot('app.py', freshOnEveryRead(root))).toEqual(stable);
  });

  it('Go: calls in nested blocks give the same result with fresh reads', async () => {
    const parser = await getExceptionParser('Go', 'main.go');
    expect(parser).not.toBeNull();
    const source = [
      'package main',
      'import "net/http"',
      'func f(ok bool) {',
      '  if ok {',
      '    http.Get("https://api.example.com/a")',
      '  }',
      '  http.Post("https://api.example.com/b", "application/json", nil)',
      '}',
      '',
    ].join('\n');
    const root = parser!.parse(source).rootNode;
    const stable = extractGoHttpCallsFromRoot('main.go', root);
    expect(stable.length).toBeGreaterThan(0);
    expect(extractGoHttpCallsFromRoot('main.go', freshOnEveryRead(root))).toEqual(stable);
  });
});
