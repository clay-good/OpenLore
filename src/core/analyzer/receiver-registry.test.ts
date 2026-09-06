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
import { extractExceptionFactsFromSource } from './exception-flow.js';
import type { CallEdge, CallGraphResult } from './call-graph.js';
import {
  buildReceiverFieldRegistry,
  finalizeReceiverFieldFacts,
  receiverFieldKey,
  RECEIVER_FIELD_FACT_CAP,
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
// The owner of a field write — receiver rebinding and unnameable owners
// (round-1 adversarial review: five confirmed false-edge sources)
// ---------------------------------------------------------------------------

describe('the class that owns a field write', () => {
  const repo = ts('repo.ts', 'export class WrongRepo { save(x: number) { return x; } }');

  it('refuses a write inside a `function` expression, which rebinds `this`', async () => {
    const result = await new CallGraphBuilder().build([
      repo,
      ts('service.ts', `
        import { WrongRepo } from './repo';
        export class Service {
          init(emitter: any) { emitter.on('x', function () { this.store = new WrongRepo(); }); }
          run() { return this.store.save(1); }
        }
      `),
    ]);
    expect(anyEdgeNamed(result, 'run', 'save')).toEqual([]);
  });

  it('refuses a write inside an object-literal method, which also rebinds `this`', async () => {
    const result = await new CallGraphBuilder().build([
      repo,
      ts('service.ts', `
        import { WrongRepo } from './repo';
        export class Service {
          setup() { return { boot() { this.store = new WrongRepo(); } }; }
          run() { return this.store.save(1); }
        }
      `),
    ]);
    expect(anyEdgeNamed(result, 'run', 'save')).toEqual([]);
  });

  it('keeps a write inside an arrow function, which does NOT rebind `this`', async () => {
    const result = await new CallGraphBuilder().build([
      ts('repo.ts', 'export class Repo { save(x: number) { return x; } }'),
      ts('service.ts', `
        import { Repo } from './repo';
        export class Service {
          private repo: Repo;
          init() { [1].forEach(() => { this.repo = new Repo(); }); }
          run() { return this.repo.save(1); }
        }
      `),
    ]);
    expect(edgeTo(result, 'run', 'save')?.confidence).toBe('receiver_inferred');
  });

  it('refuses a field of an anonymous class expression rather than crediting the outer class', async () => {
    const result = await new CallGraphBuilder().build([
      repo,
      ts('service.ts', `
        import { WrongRepo } from './repo';
        export class Service {
          make() { return class { private store = new WrongRepo(); }; }
          run() { return this.store.save(1); }
        }
      `),
    ]);
    expect(anyEdgeNamed(result, 'run', 'save')).toEqual([]);
  });

  it('refuses a Python write inside a nested `def`, which rebinds `self`', async () => {
    const result = await new CallGraphBuilder().build([
      py('repo.py', 'class WrongRepo:\n    def save(self, x):\n        return x\n'),
      py('service.py', [
        'from repo import WrongRepo',
        '',
        'class Service:',
        '    def init(self):',
        '        def handler(self):',
        '            self.store = WrongRepo()',
        '        return handler',
        '',
        '    def run(self):',
        '        return self.store.save(1)',
        '',
      ].join('\n')),
    ]);
    expect(anyEdgeNamed(result, 'run', 'save')).toEqual([]);
  });

  it('does not let a `static` field type an instance receiver', async () => {
    const result = await new CallGraphBuilder().build([
      repo,
      ts('service.ts', `
        import { WrongRepo } from './repo';
        export class Service {
          static store: WrongRepo;
          constructor(store: unknown) { (this as any).store = store; }
          run() { return this.store.save(1); }
        }
      `),
    ]);
    expect(anyEdgeNamed(result, 'run', 'save')).toEqual([]);
  });

  it('does not treat a plain constructor parameter as a field', async () => {
    const result = await new CallGraphBuilder().build([
      ts('repo.ts', 'export class Repo { save(x: number) { return x; } }'),
      ts('service.ts', `
        import { Repo } from './repo';
        export class Service {
          constructor(repo: Repo) { void repo; }
          run() { return this.repo.save(1); }
        }
      `),
    ]);
    expect(anyEdgeNamed(result, 'run', 'save')).toEqual([]);
  });

  it('does not mistake a capitalized LOCAL FUNCTION for a Python class', async () => {
    const result = await new CallGraphBuilder().build([
      py('repo.py', 'class Repo:\n    def save(self, x):\n        return x\n'),
      py('service.py', [
        'def Repo(a, b):',
        '    return 1',
        '',
        'class Service:',
        '    def __init__(self):',
        '        self.repo = Repo(1, 2)',
        '',
        '    def run(self):',
        '        return self.repo.save(1)',
        '',
      ].join('\n')),
    ]);
    expect(anyEdgeNamed(result, 'run', 'save')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The type name's ORIGIN must be proven, not assumed
// ---------------------------------------------------------------------------

describe('binding the declared type name', () => {
  it('never binds a namesake elsewhere when the import says the type comes from another file', async () => {
    const result = await new CallGraphBuilder().build([
      ts('sdk.ts', 'export class Client { connect() { return 1; } }'),
      ts('unrelated/client.ts', 'export class Client { send(x: number) { return x; } }'),
      ts('svc.ts', `
        import { Client } from './sdk';
        export class Service {
          constructor(private client: Client) {}
          run() { return this.client.send(1); }
        }
      `),
    ]);
    expect(anyEdgeNamed(result, 'run', 'send')).toEqual([]);
  });

  it('prefers the imported declaration over a same-named local one', async () => {
    const result = await new CallGraphBuilder().build([
      ts('sdk.ts', 'export class Client { send(x: number) { return x; } }'),
      ts('svc.ts', `
        import { Client } from './sdk';
        export class Service {
          constructor(private client: Client) {}
          run() { return this.client.send(1); }
        }
      `),
    ]);
    const edge = edgeTo(result, 'run', 'send');
    expect(edge?.confidence).toBe('receiver_inferred');
    expect(result.nodes.get(edge!.calleeId)?.filePath).toBe('sdk.ts');
  });

  it('refuses a factory whose local declarations disagree on the return type', async () => {
    const result = await new CallGraphBuilder().build([
      ts('repo.ts', 'export class Repo { save(x: number) { return x; } }'),
      ts('other.ts', 'export class Other { save(x: number) { return x; } }'),
      ts('service.ts', `
        import { Repo } from './repo';
        import { Other } from './other';
        // Two declarations of one name disagreeing on the return type. Invalid TypeScript,
        // deliberately: the registry must refuse the name rather than pick whichever parsed
        // first, and a parser-level fixture is the only way to reach that branch.
        function makeRepo(): Repo { return new Repo(); }
        function makeRepo(): Other { return new Other(); }
        export class Service {
          private repo: unknown;
          constructor() { this.repo = makeRepo(); }
          run() { return this.repo.save(1); }
        }
      `),
    ]);
    expect(anyEdgeNamed(result, 'run', 'save')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Shapes the resolver must NOT quietly fabricate an edge for
// ---------------------------------------------------------------------------

describe('residue never falls through to another strategy', () => {
  it('does not resolve a Python residue to the CALLER’s own same-named method', async () => {
    const result = await new CallGraphBuilder().build([
      py('service.py', [
        'class Service:',
        '    def save(self, x):',
        '        return x',
        '',
        '    def run(self):',
        '        return self.repo.save(1)',
        '',
      ].join('\n')),
    ]);
    expect(anyEdgeNamed(result, 'run', 'save')).toEqual([]);
  });

  // The CHA feed excludes chained raw edges. Without that guard CHA sees `recv: 'this'` and
  // name-binds `this.repo.save()` inside the CALLER's own hierarchy. A hierarchy is required for
  // CHA to fire at all, so this fixture — not the Python one below — is what actually pins it.
  it('does not let CHA name-bind a chained receiver inside the caller’s own hierarchy', async () => {
    const result = await new CallGraphBuilder().build([
      ts('svc.ts', `
        class Base { save(x: number) { return x; } }
        export class Service extends Base {
          private repo: unknown;
          run() { return this.repo.save(1); }
        }
      `),
    ]);
    expect(anyEdgeNamed(result, 'run', 'save')).toEqual([]);
  });

  it('mints no external leaf for a Python residue', async () => {
    const result = await new CallGraphBuilder().build([
      py('service.py', [
        'class Service:',
        '    def run(self):',
        '        return self.repo.persist(1)',
        '',
      ].join('\n')),
    ]);
    expect(anyEdgeNamed(result, 'run', 'persist')).toEqual([]);
    expect([...result.nodes.values()].some(n => n.isExternal && n.name.includes('persist'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Shapes that DO resolve, and the ones deliberately left to disclosure
// ---------------------------------------------------------------------------

describe('chained receiver shapes', () => {
  const repo = ts('repo.ts', 'export class Repo { save(x: number) { return x; } }');
  const svc = (body: string) => ts('service.ts', `
    import { Repo } from './repo';
    export class Service {
      constructor(private repo: Repo) {}
      ${body}
    }
  `);

  it('resolves through `super.<field>`', async () => {
    const result = await new CallGraphBuilder().build([
      repo,
      ts('service.ts', `
        import { Repo } from './repo';
        class Base { constructor(protected repo: Repo) {} }
        export class Service extends Base {
          run() { return super.repo.save(1); }
        }
      `),
    ]);
    expect(edgeTo(result, 'run', 'save')?.confidence).toBe('receiver_inferred');
  });

  it('resolves an awaited chained call', async () => {
    const result = await new CallGraphBuilder().build([repo, svc('async run() { return await this.repo.save(1); }')]);
    const edge = edgeTo(result, 'run', 'save');
    expect(edge?.confidence).toBe('receiver_inferred');
    expect(edge?.callType).toBe('awaited');
  });

  it('resolves inside a nested arrow within a class method', async () => {
    const result = await new CallGraphBuilder().build([repo, svc('run() { return [1].map(n => this.repo.save(n)); }')]);
    expect(edgeTo(result, 'run', 'save')?.confidence).toBe('receiver_inferred');
  });

  it('resolves a `#private` field receiver', async () => {
    const result = await new CallGraphBuilder().build([
      repo,
      ts('service.ts', `
        import { Repo } from './repo';
        export class Service {
          #repo: Repo;
          constructor(repo: Repo) { this.#repo = repo; }
          run() { return this.#repo.save(1); }
        }
      `),
    ]);
    expect(edgeTo(result, 'run', 'save')?.confidence).toBe('receiver_inferred');
  });

  it('resolves a JavaScript field constructed in place', async () => {
    const result = await new CallGraphBuilder().build([
      { path: 'repo.js', content: 'export class Repo { save(x) { return x; } }', language: 'JavaScript' },
      {
        path: 'service.js',
        content: "import { Repo } from './repo';\nexport class Service {\n  constructor() { this.repo = new Repo(); }\n  run() { return this.repo.save(1); }\n}\n",
        language: 'JavaScript',
      },
    ]);
    expect(edgeTo(result, 'run', 'save')?.confidence).toBe('receiver_inferred');
  });

  it('resolves a Python class-body annotated field', async () => {
    const result = await new CallGraphBuilder().build([
      py('repo.py', 'class Repo:\n    def save(self, x):\n        return x\n'),
      py('service.py', [
        'from repo import Repo',
        '',
        'class Service:',
        '    repo: Repo',
        '',
        '    def run(self):',
        '        return self.repo.save(1)',
        '',
      ].join('\n')),
    ]);
    expect(edgeTo(result, 'run', 'save')?.confidence).toBe('receiver_inferred');
  });

  // DECLARED limitations. Each is a recall gap the change accepts, not a silent one: the sites
  // are still classified `self-field` by exception-flow, so `analyze_error_propagation` discloses
  // them. Pinned so a future change that closes one has to say so.
  it('does NOT read a deeper chain (`this.a.b.m()`) — disclosed, never bound', async () => {
    const result = await new CallGraphBuilder().build([
      repo,
      ts('service.ts', `
        import { Repo } from './repo';
        export class Service {
          private inner = { repo: new Repo() };
          run() { return this.inner.repo.save(1); }
        }
      `),
    ]);
    expect(anyEdgeNamed(result, 'run', 'save')).toEqual([]);
  });

  it('does NOT bind a builtin-shaped callee on a typed field — the noise filter runs first', async () => {
    const result = await new CallGraphBuilder().build([
      ts('coll.ts', 'export class Coll { map(x: number) { return x; } }'),
      ts('service.ts', `
        import { Coll } from './coll';
        export class Service {
          constructor(private items: Coll) {}
          run() { return this.items.map(1); }
        }
      `),
    ]);
    expect(anyEdgeNamed(result, 'run', 'map')).toEqual([]);
  });

  // Declared out of scope, pinned so the claim cannot quietly drift. A receiver rooted at a CLASS
  // NAME is not rooted at the enclosing object, so neither the registry nor the disclosure covers
  // it — the same as before this change. Naming it is what keeps "the last silent shape" honest.
  it('leaves a class-name static-field receiver unbound AND undisclosed', async () => {
    const result = await new CallGraphBuilder().build([
      ts('holder.ts', 'export class Dep { work() { return 1; } }\nexport class Holder { static shared = new Dep(); }'),
      ts('svc.ts', `
        import { Holder } from './holder';
        export class Service {
          run() { return Holder.shared.work(); }
        }
      `),
    ]);
    expect(anyEdgeNamed(result, 'run', 'work')).toEqual([]);
    const facts = await extractExceptionFactsFromSource(
      'class K {\n  m() {\n    Holder.shared.work();\n  }\n}',
      'TypeScript',
    );
    expect(facts.callSites.find(c => c.calleeName === 'work')?.receiver).toBe('other');
  });

  it('requires a capitalized type name — a lowercase declaration does not type the field', async () => {
    const result = await new CallGraphBuilder().build([
      py('repo.py', 'class thing:\n    def save(self, x):\n        return x\n'),
      py('service.py', [
        'from repo import thing',
        '',
        'class Service:',
        '    def __init__(self):',
        '        self.repo = thing()',
        '',
        '    def run(self):',
        '        return self.repo.save(1)',
        '',
      ].join('\n')),
    ]);
    expect(anyEdgeNamed(result, 'run', 'save')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Round-2 adversarial findings: three more false-edge sources
// ---------------------------------------------------------------------------

describe('round-2 refusals', () => {
  it('never binds a type the file imports from a PACKAGE to an in-project namesake', async () => {
    const result = await new CallGraphBuilder().build([
      ts('db/client.ts', 'export class Client { query(sql: string) { return sql; } }'),
      ts('svc.ts', `
        import { Client } from 'pg';
        export class Service {
          private client!: Client;
          run() { return this.client.query('x'); }
        }
      `),
    ]);
    expect(anyEdgeNamed(result, 'run', 'query')).toEqual([]);
  });

  it('never binds a Python type imported from a third-party package to an in-project namesake', async () => {
    const result = await new CallGraphBuilder().build([
      py('db/client.py', 'class Client:\n    def query(self, sql):\n        return sql\n'),
      py('svc.py', [
        'from psycopg import Client',
        '',
        'class Service:',
        '    def __init__(self, client: Client):',
        '        self.client = client',
        '',
        '    def run(self):',
        '        return self.client.query(1)',
        '',
      ].join('\n')),
    ]);
    expect(anyEdgeNamed(result, 'run', 'query')).toEqual([]);
  });

  it('does not let a STATIC-context write type the instance field', async () => {
    const result = await new CallGraphBuilder().build([
      ts('caches.ts', 'export class GlobalCache { fetch(k: string) { return k; } }'),
      ts('svc.ts', `
        import { GlobalCache } from './caches';
        export class Service {
          static cache: GlobalCache;
          static init() { this.cache = new GlobalCache(); }
          run() { return this.cache.fetch('k'); }
        }
      `),
    ]);
    expect(anyEdgeNamed(result, 'run', 'fetch')).toEqual([]);
  });

  it('does not let a static BLOCK write type the instance field', async () => {
    const result = await new CallGraphBuilder().build([
      ts('caches.ts', 'export class GlobalCache { fetch(k: string) { return k; } }'),
      ts('svc.ts', `
        import { GlobalCache } from './caches';
        export class Service {
          static cache: GlobalCache;
          static { this.cache = new GlobalCache(); }
          run() { return this.cache.fetch('k'); }
        }
      `),
    ]);
    expect(anyEdgeNamed(result, 'run', 'fetch')).toEqual([]);
  });

  it('reads `super.<field>` from the PARENT slot, never the subclass field of the same name', async () => {
    const result = await new CallGraphBuilder().build([
      ts('svc.ts', `
        class A { save() { return 1; } }
        class B { save() { return 2; } }
        class Base { protected dep: B = new B(); }
        export class Service extends Base {
          protected dep: A = new A();
          run() { return super.dep.save(); }
        }
      `),
    ]);
    const edge = edgeTo(result, 'run', 'save');
    // The parent's slot is a `B`; binding the subclass's `A` would be a wrong edge. Asserted
    // unconditionally: an `if (edge)` guard would let a future recall regression silently pass
    // the only test protecting this fix.
    expect(edge).toBeDefined();
    expect(result.nodes.get(edge!.calleeId)?.className).toBe('B');
  });
});

// ---------------------------------------------------------------------------
// Round-3 adversarial findings
// ---------------------------------------------------------------------------

describe('round-3 refusals and recall', () => {
  const repo = ts('repo.ts', 'export class Repo { save(x: number) { return x; } }');

  for (const decl of ['private static repo: Repo;', 'static readonly repo: Repo;', 'protected static repo = new Repo();']) {
    it(`does not let \`${decl}\` type an instance receiver`, async () => {
      const result = await new CallGraphBuilder().build([
        repo,
        ts('svc.ts', `
          import { Repo } from './repo';
          export class Service {
            ${decl}
            run() { return this.repo.save(1); }
          }
        `),
      ]);
      expect(anyEdgeNamed(result, 'run', 'save')).toEqual([]);
    });
  }

  it('does not let a `private static` METHOD body type an instance receiver', async () => {
    const result = await new CallGraphBuilder().build([
      repo,
      ts('svc.ts', `
        import { Repo } from './repo';
        export class Service {
          private static init() { this.repo = new Repo(); }
          run() { return this.repo.save(1); }
        }
      `),
    ]);
    expect(anyEdgeNamed(result, 'run', 'save')).toEqual([]);
  });

  it('refuses when the ancestor set offers two different types for one field', async () => {
    const result = await new CallGraphBuilder().build([
      py('repo.py', 'class Repo:\n    def save(self, x):\n        return x\n'),
      py('other.py', 'class Other:\n    def save(self, x):\n        return x + 1\n'),
      py('s.py', [
        'from repo import Repo',
        'from other import Other',
        '',
        'class Z:',
        '    def __init__(self):',
        '        self.dep = Other()',
        '',
        'class A(Z):',
        '    pass',
        '',
        'class B:',
        '    def __init__(self):',
        '        self.dep = Repo()',
        '',
        'class C(A, B):',
        '    def run(self):',
        '        return self.dep.save(1)',
        '',
      ].join('\n')),
    ]);
    // `C(A, B)` reaches `Other` through A→Z and `Repo` through B. WHICH one Python picks depends
    // on C3 linearization, and a shared base makes both a breadth-first and a depth-first walk
    // wrong on some shape — so two distinct types across the ancestors refuse, exactly as two
    // declarations of one field do.
    expect(anyEdgeNamed(result, 'run', 'save')).toEqual([]);
  });

  it('still binds when the ancestor set agrees on one type', async () => {
    const result = await new CallGraphBuilder().build([
      py('repo.py', 'class Repo:\n    def save(self, x):\n        return x\n'),
      py('s.py', [
        'from repo import Repo',
        '',
        'class Base:',
        '    def __init__(self):',
        '        self.dep = Repo()',
        '',
        'class Service(Base):',
        '    def run(self):',
        '        return self.dep.save(1)',
        '',
      ].join('\n')),
    ]);
    expect(edgeTo(result, 'run', 'save')?.confidence).toBe('receiver_inferred');
  });

  it('sees `static` through a DECORATOR, and still reads a decorated parameter property', async () => {
    const decorated = await new CallGraphBuilder().build([
      ts('caches.ts', 'export class GlobalCache { fetch(k: string) { return k; } }'),
      ts('svc.ts', `
        import { GlobalCache } from './caches';
        export class Service {
          @Inject() static cache: GlobalCache;
          run() { return this.cache.fetch('k'); }
        }
      `),
    ]);
    expect(anyEdgeNamed(decorated, 'run', 'fetch')).toEqual([]);

    // The canonical NestJS/Angular injection shape — and the most common real chained receiver
    // in TypeScript. A decorator must not make it look like a plain local parameter.
    const injected = await new CallGraphBuilder().build([
      ts('repo.ts', 'export class Repo { save(x: number) { return x; } }'),
      ts('svc.ts', `
        import { Repo } from './repo';
        export class Service {
          constructor(@Inject() private readonly repo: Repo) {}
          run() { return this.repo.save(1); }
        }
      `),
    ]);
    expect(edgeTo(injected, 'run', 'save')?.confidence).toBe('receiver_inferred');
  });

  it('refuses a third-party Python import that a same-named repo file would otherwise vouch for', async () => {
    const result = await new CallGraphBuilder().build([
      py('src/app/requests.py', 'def helper():\n    return 1\n'),
      py('src/app/http.py', 'class Session:\n    def get(self, url):\n        return url\n'),
      py('src/app/svc.py', [
        'from requests import Session',
        '',
        'class Service:',
        '    def __init__(self, s: Session):',
        '        self.s = s',
        '',
        '    def run(self):',
        '        return self.s.get(1)',
        '',
      ].join('\n')),
    ]);
    expect(anyEdgeNamed(result, 'run', 'get')).toEqual([]);
  });

  it('resolves an absolute Python import in a `src/`-layout package', async () => {
    const result = await new CallGraphBuilder().build([
      py('src/myapp/models.py', 'class Repo:\n    def save(self, x):\n        return x\n'),
      py('src/myapp/service.py', [
        'from myapp.models import Repo',
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

  it('refuses a SCOPED npm package — a leading `@` is not by itself an alias', async () => {
    const result = await new CallGraphBuilder().build([
      ts('common/injectable.ts', 'export class Injectable { init(x: number) { return x; } }'),
      ts('svc.ts', `
        import { Injectable } from '@nestjs/common';
        export class Service {
          constructor(private dep: Injectable) {}
          run() { return this.dep.init(1); }
        }
      `),
    ]);
    expect(anyEdgeNamed(result, 'run', 'init')).toEqual([]);
  });

  it('resolves through a TypeScript path alias rather than calling it external', async () => {
    const result = await new CallGraphBuilder().build([
      ts('src/repo.ts', 'export class Repo { save(x: number) { return x; } }'),
      ts('src/svc.ts', `
        import { Repo } from '@/repo';
        export class Service {
          constructor(private repo: Repo) {}
          run() { return this.repo.save(1); }
        }
      `),
    ]);
    expect(edgeTo(result, 'run', 'save')?.confidence).toBe('receiver_inferred');
  });
});

// ---------------------------------------------------------------------------
// Additivity & scope
// ---------------------------------------------------------------------------

describe('the per-file fact cap', () => {
  it('truncates deterministically and never past the cap', () => {
    const facts = Array.from({ length: RECEIVER_FIELD_FACT_CAP + 50 }, (_, i) => ({
      className: 'C', field: `f${String(i).padStart(5, '0')}`, type: 'T',
    }));
    const a = finalizeReceiverFieldFacts([...facts]);
    const b = finalizeReceiverFieldFacts([...facts].reverse());
    expect(a.length).toBe(RECEIVER_FIELD_FACT_CAP);
    // Sorted before slicing, so WHICH facts survive is a function of the set, not of parse order.
    expect(b).toEqual(a);
  });
});

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
