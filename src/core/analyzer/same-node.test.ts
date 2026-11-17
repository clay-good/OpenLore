import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { sameNode } from './same-node.js';
import { getExceptionParser } from './exception-flow.js';
import { freshOnEveryRead } from './fixtures/fresh-node-reads.js';

describe('sameNode', () => {
  it('matches two reads of one node, even when they are different objects', async () => {
    const parser = await getExceptionParser('Go');
    const root = parser!.parse('package p\nfunc f() {}').rootNode;
    const fn = root.namedChildren[1];
    const again = freshOnEveryRead(root).namedChildren[1];
    expect(again).not.toBe(fn);
    expect(sameNode(again, fn)).toBe(true);
    expect(sameNode(fn, root)).toBe(false);
    expect(sameNode(fn, null)).toBe(false);
    expect(sameNode(undefined, undefined)).toBe(false);
  });
});

// A walk up `.parent` that stops on `===` against a node from another read depends on GC timing
// (see same-node.ts). New code must use sameNode(). Each allowed line compares objects that are not
// two reads of one syntax node.
const ALLOWED: Record<string, string> = {
  'src/core/analyzer/dynamic-boundary.ts': 'parent && parent !== root', // `parent` is the walk's own stack entry
  'src/core/analyzer/http-route-parser.ts': "current.kind === 'class' && current !== origin", // scope records, not nodes
  'src/core/analyzer/pass1-fact-cache.ts': 'parent === dir', // directory paths
};
const PARENT_WALK_IDENTITY = /\b(parent|current|cur|ancestor)(\.parent)?\s*[!=]==\s*(?!null\b|undefined\b|['"`])[A-Za-z_]/;

function* sourceFiles(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) { if (name !== 'fixtures' && name !== 'node_modules') yield* sourceFiles(p); }
    else if (p.endsWith('.ts') && !p.endsWith('.test.ts') && !p.endsWith('.d.ts')) yield p;
  }
}

describe('no syntax-node parent walk compares by object identity', () => {
  it('every match is a known non-node comparison', () => {
    const root = join(__dirname, '..', '..', '..');
    const offenders: string[] = [];
    for (const file of sourceFiles(join(root, 'src'))) {
      const text = readFileSync(file, 'utf8');
      if (!/tree-sitter|SyntaxNode|rootNode/.test(text)) continue;
      const rel = relative(root, file).split('\\').join('/');
      text.split('\n').forEach((line, i) => {
        if (PARENT_WALK_IDENTITY.test(line) && !(ALLOWED[rel] && line.includes(ALLOWED[rel]))) offenders.push(`${rel}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(offenders).toEqual([]);
  });
});
