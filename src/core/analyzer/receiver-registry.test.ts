/**
 * Chained intra-object receiver resolution (change: shrink-receiver-resolution-boundary).
 *
 * `this.repo.save()` / `self.repo.save()` was the one call shape that produced NOTHING — no
 * resolved edge, no `external::` leaf, and so nothing to disclose. These tests pin the two halves
 * of the fix: a receiver the per-file registry types unambiguously now resolves at
 * `receiver_inferred`, and a receiver it cannot type stays unresolved and disclosed rather than
 * being guessed into an edge.
 */

import { describe, it, expect } from 'vitest';
import { CallGraphBuilder } from './call-graph.js';
import type { CallEdge, CallGraphResult } from './call-graph.js';
import {
  buildReceiverFieldRegistry,
  receiverFieldKey,
  RECEIVER_REGISTRY_LANGUAGES,
  type ReceiverFieldFact,
} from './receiver-registry.js';

type Files = Array<{ path: string; content: string; language: string }>;

const ts = (path: string, content: string) => ({ path, content, language: 'TypeScript' });
const py = (path: string, content: string) => ({ path, content, language: 'Python' });

function edgeTo(result: CallGraphResult, callerName: string, calleeName: string): CallEdge | undefined {
  return result.edges.find(e => {
    const caller = result.nodes.get(e.callerId);
    const callee = result.nodes.get(e.calleeId);
    return caller?.name === callerName && callee?.name === calleeName && (e.kind ?? 'calls') === 'calls';
  });
}

/** Any edge at all leaving `callerName` and named `calleeName` — including an external leaf, so a
 *  test can assert that NOTHING was emitted rather than merely that no internal edge was. */
function anyEdgeNamed(result: CallGraphResult, callerName: string, calleeName: string): CallEdge[] {
  return result.edges.filter(
    e => result.nodes.get(e.callerId)?.name === callerName && e.calleeName === calleeName,
  );
}

// ---------------------------------------------------------------------------
// The registry fold — conflict refuses, per key
// ---------------------------------------------------------------------------

describe('buildReceiverFieldRegistry', () => {
  const fact = (className: string, field: string, type: string): ReceiverFieldFact =>
    ({ className, field, type });

  it('keeps a field observed with one consistent type', () => {
    const registry = buildReceiverFieldRegistry([
      ['a.ts', [fact('Service', 'repo', 'Repo'), fact('Service', 'repo', 'Repo')]],
    ]);
    expect(registry.get(receiverFieldKey('a.ts', 'Service', 'repo'))).toBe('Repo');
  });

  it('refuses a field observed with two different types, and only that field', () => {
    const registry = buildReceiverFieldRegistry([
      ['a.ts', [fact('Service', 'repo', 'Repo'), fact('Service', 'repo', 'OtherRepo'), fact('Service', 'log', 'Logger')]],
    ]);
    expect(registry.has(receiverFieldKey('a.ts', 'Service', 'repo'))).toBe(false);
    expect(registry.get(receiverFieldKey('a.ts', 'Service', 'log'))).toBe('Logger');
  });

  it('keys by file, so same-named classes in different files never cross-contaminate', () => {
    const registry = buildReceiverFieldRegistry([
      ['a.ts', [fact('Service', 'repo', 'RepoA')]],
      ['b.ts', [fact('Service', 'repo', 'RepoB')]],
    ]);
    expect(registry.get(receiverFieldKey('a.ts', 'Service', 'repo'))).toBe('RepoA');
    expect(registry.get(receiverFieldKey('b.ts', 'Service', 'repo'))).toBe('RepoB');
  });
});

// ---------------------------------------------------------------------------
// Recovery — each declared-type source, end to end through the builder
// ---------------------------------------------------------------------------

describe('chained intra-object receiver resolution', () => {
  const repo = ts('repo.ts', `
    export class Repo {
      save(x: number) { return x; }
      purge() { return 0; }
    }
  `);

  it('resolves through an annotated field declaration at receiver_inferred', async () => {
    const result = await new CallGraphBuilder().build([
      repo,
      ts('service.ts', `
        import { Repo } from './repo';
        export class Service {
          private repo: Repo;
          constructor(repo: Repo) { this.repo = repo; }
          run() { return this.repo.save(1); }
        }
      `),
    ]);
    const edge = edgeTo(result, 'run', 'save');
    expect(edge).toBeDefined();
    expect(edge?.confidence).toBe('receiver_inferred');
    expect(edge?.callType).toBe('method');
    expect(result.nodes.get(edge!.calleeId)?.filePath).toBe('repo.ts');
  });

  it('resolves through a constructor parameter property', async () => {
    const result = await new CallGraphBuilder().build([
      repo,
      ts('service.ts', `
        import { Repo } from './repo';
        export class Service {
          constructor(private readonly repo: Repo) {}
          run() { return this.repo.save(1); }
        }
      `),
    ]);
    expect(edgeTo(result, 'run', 'save')?.confidence).toBe('receiver_inferred');
  });

  it('resolves through a `new T()` field initializer', async () => {
    const result = await new CallGraphBuilder().build([
      repo,
      ts('service.ts', `
        import { Repo } from './repo';
        export class Service {
          private repo = new Repo();
          run() { return this.repo.save(1); }
        }
      `),
    ]);
    expect(edgeTo(result, 'run', 'save')?.confidence).toBe('receiver_inferred');
  });

  it('resolves through a local factory’s declared return type', async () => {
    const result = await new CallGraphBuilder().build([
      repo,
      ts('service.ts', `
        import { Repo } from './repo';
        function makeRepo(): Repo { return new Repo(); }
        export class Service {
          private repo: unknown;
          constructor() { this.repo = makeRepo(); }
          run() { return this.repo.save(1); }
        }
      `),
    ]);
    expect(edgeTo(result, 'run', 'save')?.confidence).toBe('receiver_inferred');
  });

  it('resolves an INHERITED field by walking the class chain', async () => {
    const result = await new CallGraphBuilder().build([
      repo,
      ts('service.ts', `
        import { Repo } from './repo';
        class Base { protected repo: Repo; constructor(r: Repo) { this.repo = r; } }
        export class Service extends Base {
          run() { return this.repo.save(1); }
        }
      `),
    ]);
    expect(edgeTo(result, 'run', 'save')?.confidence).toBe('receiver_inferred');
  });

  it('resolves a Python `self.<field>.<method>()` through an annotated __init__ parameter', async () => {
    const result = await new CallGraphBuilder().build([
      py('repo.py', 'class Repo:\n    def save(self, x):\n        return x\n'),
      py('service.py', [
        'from repo import Repo',
        '',
        'class Service:',
        '    def __init__(self, repo: Repo):',
        '        self.repo = repo',
        '',
        '    def run(self):',
        '        return self.repo.save(1)',
        '',
      ].join('\n')),
    ]);
    const edge = edgeTo(result, 'run', 'save');
    expect(edge?.confidence).toBe('receiver_inferred');
  });

  it('resolves a Python field constructed in place', async () => {
    const result = await new CallGraphBuilder().build([
      py('repo.py', 'class Repo:\n    def save(self, x):\n        return x\n'),
      py('service.py', [
        'from repo import Repo',
        '',
        'class Service:',
        '    def __init__(self):',
        '        self.repo = Repo()',
        '',
        '    def run(self):',
        '        return self.repo.save(1)',
        '',
      ].join('\n')),
    ]);
    expect(edgeTo(result, 'run', 'save')?.confidence).toBe('receiver_inferred');
  });
});

// ---------------------------------------------------------------------------
// Refusal — the boundary shrinks, it is never papered over
// ---------------------------------------------------------------------------

describe('chained intra-object receivers the registry cannot type', () => {
  it('emits no edge at all for an untyped field — not even an external leaf', async () => {
    const result = await new CallGraphBuilder().build([
      ts('repo.ts', 'export class Repo { save(x: number) { return x; } }'),
      ts('service.ts', `
        export class Service {
          private repo: any;
          run() { return this.repo.save(1); }
        }
      `),
    ]);
    expect(anyEdgeNamed(result, 'run', 'save')).toEqual([]);
  });

  it('refuses a field declared with two conflicting types rather than picking one', async () => {
    const result = await new CallGraphBuilder().build([
      ts('repo.ts', 'export class Repo { save(x: number) { return x; } }'),
      ts('other.ts', 'export class Other { save(x: number) { return x + 1; } }'),
      ts('service.ts', `
        import { Repo } from './repo';
        import { Other } from './other';
        export class Service {
          private repo: Repo;
          constructor() { this.repo = new Other(); }
          run() { return this.repo.save(1); }
        }
      `),
    ]);
    expect(anyEdgeNamed(result, 'run', 'save')).toEqual([]);
  });

  it('does not bind the receiver name to a same-named IMPORT (the qualifier-fallback trap)', async () => {
    const result = await new CallGraphBuilder().build([
      ts('parser.ts', 'export function parse(s: string) { return s; }'),
      ts('service.ts', `
        import * as parser from './parser';
        export class Service {
          private parser: unknown;
          run() { return this.parser.parse('x'); }
        }
      `),
    ]);
    expect(anyEdgeNamed(result, 'run', 'parse')).toEqual([]);
  });

  it('refuses when the typed receiver has no such member', async () => {
    const result = await new CallGraphBuilder().build([
      ts('repo.ts', 'export class Repo { save(x: number) { return x; } }'),
      ts('service.ts', `
        import { Repo } from './repo';
        export class Service {
          constructor(private repo: Repo) {}
          run() { return this.repo.missing(1); }
        }
      `),
    ]);
    expect(anyEdgeNamed(result, 'run', 'missing')).toEqual([]);
  });

  it('records an ambiguous candidate set as a disclosed site instead of an edge', async () => {
    const result = await new CallGraphBuilder().build([
      ts('a/repo.ts', 'export class Repo { save(x: number) { return x; } }'),
      ts('b/repo.ts', 'export class Repo { save(x: number) { return x + 1; } }'),
      ts('service.ts', `
        export class Service {
          private repo: Repo;
          run() { return this.repo.save(1); }
        }
      `),
    ]);
    expect(anyEdgeNamed(result, 'run', 'save')).toEqual([]);
    const site = result.ambiguousSites?.find(s => s.calleeName === 'save');
    expect(site?.strategy).toBe('receiver_inferred');
    expect(site?.candidateCount).toBe(2);
  });

  it('leaves a chained receiver outside any class unresolved', async () => {
    const result = await new CallGraphBuilder().build([
      ts('repo.ts', 'export class Repo { save(x: number) { return x; } }'),
      ts('service.ts', `
        export function run(this: { repo: unknown }) { return this.repo.save(1); }
      `),
    ]);
    expect(anyEdgeNamed(result, 'run', 'save')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Additivity & scope
// ---------------------------------------------------------------------------

describe('receiver resolution scope', () => {
  it('declares exactly the languages whose extractors collect facts', () => {
    expect([...RECEIVER_REGISTRY_LANGUAGES].sort()).toEqual(['JavaScript', 'Python', 'TypeScript']);
  });

  it('leaves direct intra-object resolution untouched', async () => {
    const result = await new CallGraphBuilder().build([
      ts('service.ts', `
        export class Service {
          helper() { return 1; }
          run() { return this.helper(); }
        }
      `),
    ]);
    expect(edgeTo(result, 'run', 'helper')?.confidence).toBe('self_cls');
  });

  it('is deterministic across repeated builds', async () => {
    const files: Files = [
      ts('repo.ts', 'export class Repo { save(x: number) { return x; } }'),
      ts('service.ts', `
        import { Repo } from './repo';
        export class Service {
          constructor(private repo: Repo) {}
          run() { return this.repo.save(1); }
        }
      `),
    ];
    const a = await new CallGraphBuilder().build(files);
    const b = await new CallGraphBuilder().build(files);
    const shape = (r: CallGraphResult) =>
      r.edges.map(e => `${e.callerId}->${e.calleeId}@${e.line}:${e.confidence}`).sort();
    expect(shape(a)).toEqual(shape(b));
  });
});
