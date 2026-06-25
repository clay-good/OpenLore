/**
 * Tests for CallGraphBuilder — all supported languages.
 *
 * Each language section verifies:
 *  - Function/method nodes are extracted
 *  - Call edges are resolved correctly
 *  - fanIn / fanOut are computed correctly
 *  - Hub functions and entry points are derived correctly
 */

import { describe, it, expect } from 'vitest';
import { CallGraphBuilder, callDistance, CALL_DISTANCE_COSTS } from './call-graph.js';
import type { CallEdge, EdgeConfidence } from './call-graph.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function nodeNames(result: Awaited<ReturnType<CallGraphBuilder['build']>>) {
  return Array.from(result.nodes.values()).map(n => n.name).sort();
}

function edgePairs(result: Awaited<ReturnType<CallGraphBuilder['build']>>) {
  return result.edges.map(e => {
    const callerName = result.nodes.get(e.callerId)?.name ?? e.callerId;
    const calleeName = result.nodes.get(e.calleeId)?.name ?? e.calleeId;
    return `${callerName}→${calleeName}`;
  }).sort();
}

function fanIn(result: Awaited<ReturnType<CallGraphBuilder['build']>>, name: string) {
  return Array.from(result.nodes.values()).find(n => n.name === name)?.fanIn;
}

function fanOut(result: Awaited<ReturnType<CallGraphBuilder['build']>>, name: string) {
  return Array.from(result.nodes.values()).find(n => n.name === name)?.fanOut;
}

// ---------------------------------------------------------------------------
// TypeScript
// ---------------------------------------------------------------------------

describe('CallGraphBuilder — TypeScript', () => {
  it('extracts top-level functions and resolves calls', async () => {
    const builder = new CallGraphBuilder();
    const result = await builder.build([{
      path: 'src/main.ts',
      language: 'TypeScript',
      content: `
        function main() { greet(); emit(); }
        function greet() { emit(); }
        function emit() {}
      `,
    }]);

    expect(nodeNames(result)).toEqual(['emit', 'greet', 'main']);
    expect(edgePairs(result)).toEqual(['greet→emit', 'main→emit', 'main→greet'].sort());
    expect(fanIn(result, 'emit')).toBe(2);
    expect(fanOut(result, 'main')).toBe(2);
  });

  it('extracts class methods', async () => {
    const builder = new CallGraphBuilder();
    const result = await builder.build([{
      path: 'src/service.ts',
      language: 'TypeScript',
      content: `
        class UserService {
          async getUser() { return this.fetch(); }
          private fetch() {}
        }
      `,
    }]);

    expect(nodeNames(result)).toEqual(['fetch', 'getUser']);
    expect(result.nodes.get('src/service.ts::UserService.getUser')?.isAsync).toBe(true);
    expect(result.nodes.get('src/service.ts::UserService.fetch')?.className).toBe('UserService');
  });

  it('resolves cross-file calls, preferring same-file candidates', async () => {
    const builder = new CallGraphBuilder();
    const result = await builder.build([
      {
        path: 'a.ts',
        language: 'TypeScript',
        content: `function helper() {} function main() { helper(); }`,
      },
      {
        path: 'b.ts',
        language: 'TypeScript',
        content: `function helper() {}`,
      },
    ]);

    // main should resolve to a.ts::helper (same file preference)
    const mainEdge = result.edges.find(e => result.nodes.get(e.callerId)?.name === 'main');
    expect(result.nodes.get(mainEdge!.calleeId)?.filePath).toBe('a.ts');
  });

  it('seeds resolution with pre-existing nodes so a subset rebuild does not degrade cross-file calls to external', async () => {
    const builder = new CallGraphBuilder();

    // The callee lives in utils.ts.
    const full = await builder.build([{
      path: 'src/utils.ts', language: 'TypeScript',
      content: `export function validateThing() {}`,
    }]);
    const utilsNode = Array.from(full.nodes.values()).find(n => n.name === 'validateThing')!;

    // Incremental subset rebuild of ONLY the caller file — utils.ts is not in the subset.
    const callerOnly = [{
      path: 'src/caller.ts', language: 'TypeScript',
      content: `function handle() { validateThing(); }`,
    }];

    // Without seeds: the call degrades to a synthetic external leaf (the bug).
    const degraded = await builder.build(callerOnly);
    const dEdge = degraded.edges.find(e => degraded.nodes.get(e.callerId)?.name === 'handle');
    expect(dEdge!.calleeId).toBe('external::validateThing');

    // With seeds: the call resolves to the real internal node id, and the seed
    // node is NOT added to the subset's output nodes.
    const fixed = await builder.build(callerOnly, undefined, undefined, [utilsNode]);
    const fEdge = fixed.edges.find(e => fixed.nodes.get(e.callerId)?.name === 'handle');
    expect(fEdge!.calleeId).toBe('src/utils.ts::validateThing');
    expect(fEdge!.confidence).not.toBe('external');
    expect(Array.from(fixed.nodes.keys())).not.toContain('src/utils.ts::validateThing');
  });

  it('extracts arrow functions assigned to variables', async () => {
    const builder = new CallGraphBuilder();
    const result = await builder.build([{
      path: 'utils.ts',
      language: 'TypeScript',
      content: `
        const transform = (x: number) => x * 2;
        const process = () => { transform(1); };
      `,
    }]);

    expect(nodeNames(result)).toContain('transform');
    expect(nodeNames(result)).toContain('process');
    expect(fanIn(result, 'transform')).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// JavaScript
// ---------------------------------------------------------------------------

describe('CallGraphBuilder — JavaScript', () => {
  it('parses JS files using the TypeScript grammar', async () => {
    const builder = new CallGraphBuilder();
    const result = await builder.build([{
      path: 'index.js',
      language: 'JavaScript',
      content: `
        function init() { setup(); }
        function setup() {}
      `,
    }]);

    expect(nodeNames(result)).toEqual(['init', 'setup']);
    expect(edgePairs(result)).toEqual(['init→setup']);
    expect(fanIn(result, 'setup')).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// JavaScript — member-assigned & var-bound functions (CommonJS / pre-class idioms)
// (change: widen-js-function-node-extraction)
// ---------------------------------------------------------------------------

describe('CallGraphBuilder — member-assigned & var-bound functions', () => {
  it('indexes `exports.x = function(){}` as a node named exports.x', async () => {
    const builder = new CallGraphBuilder();
    const result = await builder.build([{
      path: 'lib/handler.js',
      language: 'JavaScript',
      content: `
        exports.handler = function handler() { helper(); };
        function helper() {}
      `,
    }]);

    expect(nodeNames(result)).toContain('exports.handler');
    expect(result.nodes.has('lib/handler.js::exports.handler')).toBe(true);
    expect(edgePairs(result)).toContain('exports.handler→helper');
    expect(fanIn(result, 'helper')).toBe(1);
  });

  it('indexes `obj.method = function(){}` (Express-style) and resolves its calls', async () => {
    const builder = new CallGraphBuilder();
    const result = await builder.build([{
      path: 'lib/application.js',
      language: 'JavaScript',
      content: `
        var app = {};
        app.use = function use(fn) { return app.lazyrouter(); };
        app.lazyrouter = function lazyrouter() {};
      `,
    }]);

    expect(nodeNames(result)).toEqual(expect.arrayContaining(['app.use', 'app.lazyrouter']));
    expect(edgePairs(result)).toContain('app.use→app.lazyrouter');
  });

  it('indexes `X.prototype.y = function(){}`', async () => {
    const builder = new CallGraphBuilder();
    const result = await builder.build([{
      path: 'lib/view.js',
      language: 'JavaScript',
      content: `
        function View() {}
        View.prototype.render = function render() {};
      `,
    }]);

    expect(nodeNames(result)).toContain('View.prototype.render');
    expect(result.nodes.has('lib/view.js::View.prototype.render')).toBe(true);
  });

  it('indexes a bare identifier assignment `f = function(){}`', async () => {
    const builder = new CallGraphBuilder();
    const result = await builder.build([{
      path: 'lib/late.js',
      language: 'JavaScript',
      content: `
        let f;
        f = function f() {};
      `,
    }]);

    expect(nodeNames(result)).toContain('f');
  });

  it('indexes a `var`-bound function/arrow', async () => {
    const builder = new CallGraphBuilder();
    const result = await builder.build([{
      path: 'lib/old.js',
      language: 'JavaScript',
      content: `
        var parse = function parse() {};
        var format = () => {};
      `,
    }]);

    expect(nodeNames(result)).toEqual(expect.arrayContaining(['parse', 'format']));
  });

  it('indexes a member-assigned arrow', async () => {
    const builder = new CallGraphBuilder();
    const result = await builder.build([{
      path: 'lib/router.js',
      language: 'JavaScript',
      content: `
        var router = {};
        router.handle = (req, res) => {};
      `,
    }]);

    expect(nodeNames(result)).toContain('router.handle');
  });

  it('does NOT index member assignments whose RHS is not a function', async () => {
    const builder = new CallGraphBuilder();
    const result = await builder.build([{
      path: 'lib/reexport.js',
      language: 'JavaScript',
      content: `
        exports.router = require('./router');
        exports.VERSION = 42;
        exports.config = { a: 1 };
        function real() {}
      `,
    }]);

    // Only the genuine function is a node; the re-export, the number and the
    // object literal must extract nothing.
    expect(nodeNames(result)).toEqual(['real']);
  });

  it('collapses a re-assigned member to a single node (no duplicate explosion)', async () => {
    const builder = new CallGraphBuilder();
    const result = await builder.build([{
      path: 'lib/reassign.js',
      language: 'JavaScript',
      content: `
        obj.fn = function () {};
        obj.fn = function () {};
      `,
    }]);

    const fnNodes = Array.from(result.nodes.values()).filter(n => n.name === 'obj.fn');
    expect(fnNodes.length).toBe(1);
  });

  it('assigns member-named nodes a distinct, escaped stableId', async () => {
    const builder = new CallGraphBuilder();
    const result = await builder.build([{
      path: 'lib/app.js',
      language: 'JavaScript',
      content: `app.use = function use(fn) {};`,
    }]);

    const node = Array.from(result.nodes.values()).find(n => n.name === 'app.use');
    expect(node).toBeDefined();
    // Dotted member names are backtick-escaped by stableSymbolId.
    expect(node?.stableId).toBeDefined();
    expect(node?.stableId).toContain('app.use');
  });
});

// ---------------------------------------------------------------------------
// JavaScript/TypeScript — class-field arrow/function members
// (change: widen-js-function-node-extraction — public_field_definition arm)
// ---------------------------------------------------------------------------

describe('CallGraphBuilder — class-field arrow/function members', () => {
  it('indexes `class C { handler = () => {} }` as C.handler with the enclosing className', async () => {
    const builder = new CallGraphBuilder();
    const result = await builder.build([{
      path: 'src/widget.ts',
      language: 'TypeScript',
      content: `
        class Widget {
          handler = () => {};
        }
      `,
    }]);

    expect(nodeNames(result)).toContain('handler');
    expect(result.nodes.get('src/widget.ts::Widget.handler')?.className).toBe('Widget');
  });

  it('resolves calls out of a class-field arrow', async () => {
    const builder = new CallGraphBuilder();
    const result = await builder.build([{
      path: 'src/comp.ts',
      language: 'TypeScript',
      content: `
        function recompute(msg) {}
        class Comp {
          onClick = () => { recompute('clicked'); };
        }
      `,
    }]);

    expect(edgePairs(result)).toContain('onClick→recompute');
    expect(fanIn(result, 'recompute')).toBe(1);
  });

  it('indexes a class-field function expression and a type-annotated field arrow', async () => {
    const builder = new CallGraphBuilder();
    const result = await builder.build([{
      path: 'src/svc.ts',
      language: 'TypeScript',
      content: `
        class Svc {
          legacy = function legacy() {};
          typed: () => void = () => {};
        }
      `,
    }]);

    expect(nodeNames(result)).toEqual(expect.arrayContaining(['legacy', 'typed']));
    expect(result.nodes.get('src/svc.ts::Svc.legacy')?.className).toBe('Svc');
    expect(result.nodes.get('src/svc.ts::Svc.typed')?.className).toBe('Svc');
  });

  it('does NOT index non-function class fields', async () => {
    const builder = new CallGraphBuilder();
    const result = await builder.build([{
      path: 'src/state.ts',
      language: 'TypeScript',
      content: `
        class State {
          count = 0;
          data = {};
          label = 'x';
          real = () => {};
        }
      `,
    }]);

    // Only the arrow field is a node; the number, object and string fields extract nothing.
    expect(nodeNames(result)).toEqual(['real']);
  });
});

// ---------------------------------------------------------------------------
// JavaScript/TypeScript — widen-js extraction: adversarial boundaries
// (change: widen-js-function-node-extraction — exclusion shapes the PR body
//  claims "by construction" but the first cut left untested, plus the async-
//  metadata correctness that the captured RHS value node now drives.)
// ---------------------------------------------------------------------------

describe('CallGraphBuilder — widen-js exclusion boundaries', () => {
  it('does NOT index a computed-member assignment `obj[key] = function(){}`', async () => {
    const builder = new CallGraphBuilder();
    const result = await builder.build([{
      path: 'lib/dyn.js',
      language: 'JavaScript',
      content: `obj[key] = function(){}; function real(){}`,
    }]);
    // subscript_expression LHS is not a member_expression — excluded by construction.
    expect(nodeNames(result)).toEqual(['real']);
  });

  it('does NOT index an augmented assignment `obj.x ||= function(){}`', async () => {
    const builder = new CallGraphBuilder();
    const result = await builder.build([{
      path: 'lib/aug.js',
      language: 'JavaScript',
      content: `obj.x ||= function(){}; obj.y = function(){}; function real(){}`,
    }]);
    // augmented_assignment_expression is a distinct node type — only the plain `=` matches.
    expect(nodeNames(result)).toEqual(['obj.y', 'real']);
  });

  it('indexes only the inner binding of a chained `exports.a = exports.b = function(){}`', async () => {
    const builder = new CallGraphBuilder();
    const result = await builder.build([{
      path: 'lib/chain.js',
      language: 'JavaScript',
      content: `exports.a = exports.b = function(){};`,
    }]);
    // The outer assignment's RHS is another assignment_expression, not a function — only inner matches.
    expect(nodeNames(result)).toEqual(['exports.b']);
  });

  it('does NOT index a private class field `#handler = () => {}`', async () => {
    const builder = new CallGraphBuilder();
    const result = await builder.build([{
      path: 'src/priv.ts',
      language: 'TypeScript',
      content: `class C { #secret = () => {}; pub = () => {}; }`,
    }]);
    // #-prefixed fields are private_property_identifier, not property_identifier.
    expect(nodeNames(result)).toEqual(['pub']);
  });

  it('collapses a member LHS split across lines to a stable dotted name', async () => {
    const builder = new CallGraphBuilder();
    const result = await builder.build([{
      path: 'lib/wrap.js',
      language: 'JavaScript',
      content: `app\n  .use = function(){};`,
    }]);
    expect(nodeNames(result)).toContain('app.use');
  });

  it('resolves an inbound call to a member-assigned method', async () => {
    const builder = new CallGraphBuilder();
    const result = await builder.build([{
      path: 'lib/inbound.js',
      language: 'JavaScript',
      content: `
        app.render = function render(){};
        app.boot = function boot(){ app.render(); };
      `,
    }]);
    expect(edgePairs(result)).toContain('app.boot→app.render');
    expect(fanIn(result, 'app.render')).toBe(1);
    // The edge must land on the real internal node, not a synthetic external leaf.
    const renderId = 'lib/inbound.js::app.render';
    expect(result.edges.some(e => e.calleeId === renderId)).toBe(true);
    expect(result.nodes.has('external::app.render')).toBe(false);
  });

  it('does NOT fabricate a member edge when no dotted node matches', async () => {
    const builder = new CallGraphBuilder();
    const result = await builder.build([{
      path: 'lib/nomatch.js',
      language: 'JavaScript',
      content: `
        app.boot = function boot(){ redisClient.get('k'); };
        app.use = function use(){};
      `,
    }]);
    // redisClient.get has no internal dotted node — must stay an external leaf,
    // and must not spuriously resolve onto an unrelated member node.
    expect(fanIn(result, 'app.use')).toBe(0);
    expect(result.nodes.has('external::redisClient.get')).toBe(true);
  });
});

describe('CallGraphBuilder — widen-js async metadata (RHS value node)', () => {
  it('marks an async member-assigned function isAsync', async () => {
    const builder = new CallGraphBuilder();
    const result = await builder.build([{
      path: 'lib/h.js',
      language: 'JavaScript',
      content: `exports.handler = async function(){};`,
    }]);
    expect(Array.from(result.nodes.values()).find(n => n.name === 'exports.handler')?.isAsync).toBe(true);
  });

  it('marks an async class-field arrow isAsync', async () => {
    const builder = new CallGraphBuilder();
    const result = await builder.build([{
      path: 'src/c.ts',
      language: 'TypeScript',
      content: `class C { run = async () => {}; idle = () => {}; }`,
    }]);
    expect(Array.from(result.nodes.values()).find(n => n.name === 'run')?.isAsync).toBe(true);
    // a non-async sibling field stays false — async must come from the RHS, not the class.
    expect(Array.from(result.nodes.values()).find(n => n.name === 'idle')?.isAsync).toBe(false);
  });

  it('marks an async var-bound arrow isAsync and leaves a sync one false', async () => {
    const builder = new CallGraphBuilder();
    const result = await builder.build([{
      path: 'lib/v.js',
      language: 'JavaScript',
      content: `var load = async () => {}; var parse = () => {};`,
    }]);
    expect(Array.from(result.nodes.values()).find(n => n.name === 'load')?.isAsync).toBe(true);
    expect(Array.from(result.nodes.values()).find(n => n.name === 'parse')?.isAsync).toBe(false);
  });

  it('still marks a plain `async function` declaration and `async` method isAsync', async () => {
    const builder = new CallGraphBuilder();
    const result = await builder.build([{
      path: 'src/keep.ts',
      language: 'TypeScript',
      content: `async function fetchIt(){} class C { async load(){} sync(){} }`,
    }]);
    expect(Array.from(result.nodes.values()).find(n => n.name === 'fetchIt')?.isAsync).toBe(true);
    expect(Array.from(result.nodes.values()).find(n => n.name === 'load')?.isAsync).toBe(true);
    expect(Array.from(result.nodes.values()).find(n => n.name === 'sync')?.isAsync).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Python
// ---------------------------------------------------------------------------

describe('CallGraphBuilder — Python', () => {
  it('extracts module-level functions and resolves direct calls', async () => {
    const builder = new CallGraphBuilder();
    const result = await builder.build([{
      path: 'app.py',
      language: 'Python',
      content: `
def main():
    process()
    validate()

def process():
    validate()

def validate():
    pass
      `,
    }]);

    expect(nodeNames(result)).toEqual(['main', 'process', 'validate']);
    expect(fanIn(result, 'validate')).toBe(2);
    expect(fanOut(result, 'main')).toBe(2);
  });

  it('extracts class methods and resolves self.method() calls', async () => {
    const builder = new CallGraphBuilder();
    const result = await builder.build([{
      path: 'service.py',
      language: 'Python',
      content: `
class DataService:
    def run(self):
        self.fetch()
        self.process()

    def fetch(self):
        pass

    def process(self):
        self.fetch()
      `,
    }]);

    expect(nodeNames(result)).toEqual(['fetch', 'process', 'run']);
    expect(fanIn(result, 'fetch')).toBe(2); // run + process
    expect(fanOut(result, 'run')).toBe(2);
  });

  it('creates external leaf node for unresolved method calls like redis.get()', async () => {
    const builder = new CallGraphBuilder();
    const result = await builder.build([{
      path: 'cache.py',
      language: 'Python',
      content: `
def get_value(redis_client, key):
    return redis_client.get(key)

def get():
    pass
      `,
    }]);

    // redis_client.get() should NOT resolve to the local get() function
    expect(fanIn(result, 'get')).toBe(0);
    // Instead it should create a synthetic external leaf node
    const externalNode = Array.from(result.nodes.values()).find(n => n.isExternal);
    expect(externalNode).toBeDefined();
    expect(externalNode!.name).toBe('redis_client.get');
    // One edge: get_value → external::redis_client.get
    expect(result.stats.totalEdges).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Go
// ---------------------------------------------------------------------------

describe('CallGraphBuilder — Go', () => {
  it('extracts top-level functions and resolves calls', async () => {
    const builder = new CallGraphBuilder();
    const result = await builder.build([{
      path: 'main.go',
      language: 'Go',
      content: `
package main

func main() {
  greet()
  logMessage()
}

func greet() {
  logMessage()
}

func logMessage() {}
      `,
    }]);

    expect(nodeNames(result)).toEqual(['greet', 'logMessage', 'main']);
    expect(fanIn(result, 'logMessage')).toBe(2);
    expect(fanOut(result, 'main')).toBe(2);
  });

  it('extracts receiver methods', async () => {
    const builder = new CallGraphBuilder();
    const result = await builder.build([{
      path: 'server.go',
      language: 'Go',
      content: `
package main

type Server struct{}

func (s *Server) Start() { s.listen() }
func (s *Server) listen() {}
      `,
    }]);

    expect(nodeNames(result)).toEqual(['Start', 'listen']);
    const startNode = Array.from(result.nodes.values()).find(n => n.name === 'Start');
    expect(startNode?.className).toBe('Server');
  });

  it('ignores Go builtins like make, append, close', async () => {
    const builder = new CallGraphBuilder();
    const result = await builder.build([{
      path: 'util.go',
      language: 'Go',
      content: `
package main

func build() []int {
  s := make([]int, 0)
  s = append(s, 1)
  return s
}
      `,
    }]);

    expect(result.stats.totalEdges).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Rust
// ---------------------------------------------------------------------------

describe('CallGraphBuilder — Rust', () => {
  it('extracts free functions and resolves calls', async () => {
    const builder = new CallGraphBuilder();
    const result = await builder.build([{
      path: 'lib.rs',
      language: 'Rust',
      content: `
fn process() {
    validate();
    format_output();
}

fn validate() {}

fn format_output() {
    validate();
}
      `,
    }]);

    expect(nodeNames(result)).toEqual(['format_output', 'process', 'validate']);
    expect(fanIn(result, 'validate')).toBe(2);
    expect(fanOut(result, 'process')).toBe(2);
  });

  it('extracts impl methods and assigns className from impl block', async () => {
    const builder = new CallGraphBuilder();
    const result = await builder.build([{
      path: 'engine.rs',
      language: 'Rust',
      content: `
struct Engine {}

impl Engine {
    async fn start(&self) { self.run(); }
    fn run(&self) {}
}
      `,
    }]);

    expect(nodeNames(result)).toEqual(['run', 'start']);
    const startNode = Array.from(result.nodes.values()).find(n => n.name === 'start');
    expect(startNode?.className).toBe('Engine');
    expect(startNode?.isAsync).toBe(true);
  });

  it('uses the implementing type (not the trait) as className for `impl Trait for Struct`', async () => {
    // Regression: the impl-block className must be the implementing type, not the
    // trait — otherwise every impl of a trait collapses onto the trait name and
    // distinct types' methods collide (and content-addressed stableIds collide).
    const builder = new CallGraphBuilder();
    const result = await builder.build([{
      path: 'draw.rs',
      language: 'Rust',
      content: `
trait Drawable { fn draw(&self); }
struct Circle {}
struct Square {}
impl Drawable for Circle { fn draw(&self) {} }
impl Drawable for Square { fn draw(&self) {} }
impl<T> Holder<T> { fn get(&self) {} }
`,
    }]);
    const draws = Array.from(result.nodes.values()).filter(n => n.name === 'draw');
    expect(draws.map(n => n.className).sort()).toEqual(['Circle', 'Square']); // not "Drawable"
    // generic impl keeps the base type as className (generics stripped), not undefined
    const get = Array.from(result.nodes.values()).find(n => n.name === 'get');
    expect(get?.className).toBe('Holder');
  });
});

// ---------------------------------------------------------------------------
// Ruby
// ---------------------------------------------------------------------------

describe('CallGraphBuilder — Ruby', () => {
  it('extracts methods and resolves direct calls', async () => {
    const builder = new CallGraphBuilder();
    const result = await builder.build([{
      path: 'app.rb',
      language: 'Ruby',
      content: `
def run
  fetch
  process
end

def fetch; end

def process
  fetch
end
      `,
    }]);

    expect(nodeNames(result)).toEqual(['fetch', 'process', 'run']);
    expect(fanIn(result, 'fetch')).toBe(2);
    expect(fanOut(result, 'run')).toBe(2);
  });

  it('extracts class methods and assigns className', async () => {
    const builder = new CallGraphBuilder();
    const result = await builder.build([{
      path: 'service.rb',
      language: 'Ruby',
      content: `
class UserService
  def create(params)
    validate(params)
    persist(params)
  end

  def validate(params); end
  def persist(params); end
end
      `,
    }]);

    expect(nodeNames(result)).toEqual(['create', 'persist', 'validate']);
    const createNode = Array.from(result.nodes.values()).find(n => n.name === 'create');
    expect(createNode?.className).toBe('UserService');
    expect(fanIn(result, 'validate')).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Java
// ---------------------------------------------------------------------------

describe('CallGraphBuilder — Java', () => {
  it('extracts methods and resolves calls', async () => {
    const builder = new CallGraphBuilder();
    const result = await builder.build([{
      path: 'Main.java',
      language: 'Java',
      content: `
public class Main {
    public void run() {
        fetch();
        process();
    }

    private void fetch() {}

    private void process() {
        fetch();
    }
}
      `,
    }]);

    expect(nodeNames(result)).toEqual(['fetch', 'process', 'run']);
    expect(fanIn(result, 'fetch')).toBe(2);
    expect(fanOut(result, 'run')).toBe(2);
  });

  it('assigns className from enclosing class declaration', async () => {
    const builder = new CallGraphBuilder();
    const result = await builder.build([{
      path: 'Service.java',
      language: 'Java',
      content: `
public class OrderService {
    public void createOrder() { validate(); }
    private void validate() {}
}
      `,
    }]);

    const createNode = Array.from(result.nodes.values()).find(n => n.name === 'createOrder');
    expect(createNode?.className).toBe('OrderService');
  });

  it('does not drop calls to methods named after C++/Swift builtins', async () => {
    // Regression (#138): IGNORED_CALLEES was global, so C++/Swift stdlib names
    // (find/contains/remove/insert/size/...) silently dropped legitimate Java
    // calls — e.g. a repository `find(id)` or a cache `remove(k)`.
    const builder = new CallGraphBuilder();
    const result = await builder.build([{
      path: 'Repo.java',
      language: 'Java',
      content: `
public class Repo {
    public Item lookup(int id) {
        return find(id);
    }
    private Item find(int id) { return null; }
}
      `,
    }]);

    // The internal `find` method must keep its caller edge (not be ignored).
    expect(edgePairs(result)).toContain('lookup→find');
    expect(fanIn(result, 'find')).toBe(1);
  });

  it('emits one edge per qualified call (no bare/qualified duplication)', async () => {
    // Regression (#138): JAVA_CALL_QUERY matched a qualified `Money.of(...)` with
    // BOTH the qualified and the bare pattern, emitting two edges (a `Money.of`
    // external node AND a bare `of`). That doubled fan-out and let bare names
    // falsely resolve to unrelated same-named methods.
    const builder = new CallGraphBuilder();
    const result = await builder.build([{
      path: 'Pay.java',
      language: 'Java',
      content: `
public class Pay {
    public Receipt process(Order o) {
        Money m = Money.of(o.total());
        return repo.save(m);
    }
}
      `,
    }]);

    // No bare duplicates of the qualified callees.
    const externalNames = Array.from(result.nodes.values()).filter(n => n.isExternal).map(n => n.name);
    expect(externalNames).not.toContain('of');    // only `Money.of`
    expect(externalNames).not.toContain('save');  // only `repo.save`
    // process makes exactly three distinct outgoing calls: Money.of, o.total, repo.save.
    expect(fanOut(result, 'process')).toBe(3);
  });

  it('captures constructor calls, method references, and chained calls', async () => {
    // Java patterns previously missing/dropped: `new Foo()` (object_creation),
    // `this::m` (method_reference), and the outer call of a chain `a.b().c()`
    // distinct calls keyed by callee-name position so both survive the dedup).
    const builder = new CallGraphBuilder();
    const result = await builder.build([{
      path: 'Svc.java',
      language: 'Java',
      content: `
public class Svc {
    void run(java.util.List items) {
        Helper h = new Helper();        // constructor call
        items.forEach(this::handle);    // method reference -> internal handle
        items.stream().collect();       // chained: stream() AND collect() must both appear
    }
    void handle(Object o) {}
}
class Helper {}
      `,
    }]);

    const pairs = edgePairs(result);
    expect(pairs).toContain('run→Helper');        // new Helper()
    expect(pairs).toContain('run→handle');        // this::handle resolved internally
    // Both ends of the chain `items.stream().collect()` must appear: the inner
    // qualified call is labeled by its receiver, the outer bare call by name.
    expect(pairs).toContain('run→items.stream');  // inner chained call
    expect(pairs).toContain('run→collect');       // outer chained call (regression)
  });

  it('attributes record methods to the record, not the enclosing class', async () => {
    const builder = new CallGraphBuilder();
    const result = await builder.build([{
      path: 'Order.java',
      language: 'Java',
      content: `
public class Order {
    record LineItem(String sku, int qty) {
        int subtotal() { return qty * 10; }
    }
}
      `,
    }]);

    const subtotal = Array.from(result.nodes.values()).find(n => n.name === 'subtotal');
    expect(subtotal?.className).toBe('LineItem');
  });

  it('resolves a static call to an internal class (Money.of)', async () => {
    const builder = new CallGraphBuilder();
    const result = await builder.build([{
      path: 'Money.java',
      language: 'Java',
      content: `
class Money {
    static Money of(long cents) { return new Money(cents); }
    Money(long c) {}
}
class Service {
    Money compute() { return Money.of(100); }
}
      `,
    }]);

    // Money.of must resolve to the internal node, not a synthetic external one.
    expect(edgePairs(result)).toContain('compute→of');
    const ofNode = Array.from(result.nodes.values()).find(n => n.name === 'of');
    expect(ofNode?.isExternal).toBeFalsy();
  });

  it('collapses overloaded methods to a single node', async () => {
    const builder = new CallGraphBuilder();
    const result = await builder.build([{
      path: 'Api.java',
      language: 'Java',
      content: `
public class Api {
    public void send(String a) {}
    public void send(String a, int b) {}
}
      `,
    }]);

    const sends = Array.from(result.nodes.values()).filter(n => n.name === 'send');
    expect(sends).toHaveLength(1);
  });

  it('extracts constructors as nodes', async () => {
    const builder = new CallGraphBuilder();
    const result = await builder.build([{
      path: 'Repo.java',
      language: 'Java',
      content: `
public class UserRepository {
    public UserRepository() { init(); }
    private void init() {}
}
      `,
    }]);

    expect(nodeNames(result)).toContain('UserRepository');
    expect(nodeNames(result)).toContain('init');
  });

  it('captures super(...) as an edge to the parent class constructor (#138)', async () => {
    const builder = new CallGraphBuilder();
    const result = await builder.build([
      { path: 'Person.java', language: 'Java', content: `
public class Person {
    public Person(String name) {}
}
      ` },
      { path: 'Owner.java', language: 'Java', content: `
public class Owner extends Person {
    public Owner(String name, int age) { super(name); }
}
      ` },
    ]);

    // Constructor nodes are keyed by the class name; super(name) → Person's ctor.
    const ctorEdges = result.edges.filter(e => e.callType === 'constructor');
    expect(ctorEdges).toHaveLength(1);
    expect(edgePairs(result)).toContain('Owner→Person');
  });

  it('omits this(...) self-delegation (overloads collapse to one node) (#138)', async () => {
    const builder = new CallGraphBuilder();
    const result = await builder.build([{
      path: 'Point.java', language: 'Java', content: `
public class Point {
    public Point(int x, int y) {}
    public Point() { this(0, 0); }
}
      ` }]);
    // No constructor edge: this(...) would only be a self-loop on the collapsed node.
    expect(result.edges.filter(e => e.callType === 'constructor')).toHaveLength(0);
  });

  it('drops super(...) to an external superclass without creating an external node (#138)', async () => {
    const builder = new CallGraphBuilder();
    const result = await builder.build([{
      path: 'FooException.java', language: 'Java', content: `
public class FooException extends RuntimeException {
    public FooException(String m) { super(m); }
}
      ` }]);
    // The parent (RuntimeException) is not in the codebase → no edge, no external node.
    expect(result.edges.filter(e => e.callType === 'constructor')).toHaveLength(0);
    expect(nodeNames(result)).not.toContain('RuntimeException');
    expect(Array.from(result.nodes.keys()).some(id => id.includes('RuntimeException'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Cross-cutting: stats, hub functions, entry points
// ---------------------------------------------------------------------------

describe('CallGraphBuilder — stats and derived metrics', () => {
  it('computes hub functions (fanIn >= 5)', async () => {
    const builder = new CallGraphBuilder();
    // Create a shared utility called from 5 different functions
    const callers = Array.from({ length: 5 }, (_, i) => `function f${i}() { shared(); }`).join('\n');
    const result = await builder.build([{
      path: 'hub.ts',
      language: 'TypeScript',
      content: `${callers}\nfunction shared() {}`,
    }]);

    expect(result.hubFunctions.map(n => n.name)).toContain('shared');
    expect(fanIn(result, 'shared')).toBe(5);
  });

  it('computes entry points (fanIn === 0)', async () => {
    const builder = new CallGraphBuilder();
    const result = await builder.build([{
      path: 'entry.ts',
      language: 'TypeScript',
      content: `
        function main() { helper(); }
        function helper() {}
      `,
    }]);

    const entryNames = result.entryPoints.map(n => n.name);
    expect(entryNames).toContain('main');
    expect(entryNames).not.toContain('helper');
  });

  it('handles mixed-language project', async () => {
    const builder = new CallGraphBuilder();
    const result = await builder.build([
      { path: 'server.ts', language: 'TypeScript', content: `function serve() { handle(); } function handle() {}` },
      { path: 'worker.py', language: 'Python', content: `def run():\n    process()\ndef process():\n    pass` },
      { path: 'main.go', language: 'Go', content: `package main\nfunc main() { start() }\nfunc start() {}` },
    ]);

    expect(result.stats.totalNodes).toBe(6);
    expect(result.stats.totalEdges).toBe(3);
  });

  it('returns zero stats for empty input', async () => {
    const builder = new CallGraphBuilder();
    const result = await builder.build([]);

    expect(result.stats.totalNodes).toBe(0);
    expect(result.stats.totalEdges).toBe(0);
    expect(result.hubFunctions).toHaveLength(0);
    expect(result.entryPoints).toHaveLength(0);
  });

  it('skips unsupported languages silently', async () => {
    const builder = new CallGraphBuilder();
    const result = await builder.build([
      { path: 'script.sh', language: 'Shell', content: `echo hello` },
      { path: 'query.sql', language: 'SQL', content: `SELECT 1` },
      { path: 'known.ts', language: 'TypeScript', content: `function ok() {}` },
    ]);

    expect(result.stats.totalNodes).toBe(1);
    expect(nodeNames(result)).toEqual(['ok']);
  });
});

// ---------------------------------------------------------------------------
// Layer violations
// ---------------------------------------------------------------------------

describe('CallGraphBuilder — layer violations', () => {
  const layers = {
    presentation: ['src/routes/', 'src/controllers/'],
    domain:       ['src/services/'],
    data:         ['src/repositories/'],
  };

  it('detects a lower-layer call to an upper-layer function', async () => {
    const builder = new CallGraphBuilder();
    // save() in data layer calls buildView() which only exists in presentation layer
    const result = await builder.build(
      [
        {
          path: 'src/repositories/userRepo.ts',
          language: 'TypeScript',
          content: `function save() { buildView(); }`,
        },
        {
          path: 'src/routes/userRoutes.ts',
          language: 'TypeScript',
          content: `function buildView() {}`,
        },
      ],
      layers
    );

    // data layer calling presentation layer — violation
    expect(result.layerViolations.length).toBeGreaterThanOrEqual(1);
    const v = result.layerViolations[0];
    expect(v.callerLayer).toBe('data');
    expect(v.calleeLayer).toBe('presentation');
    expect(v.reason).toContain('save');
    expect(v.reason).toContain('buildView');
  });

  it('does NOT flag a call from upper to lower layer (correct direction)', async () => {
    const builder = new CallGraphBuilder();
    const result = await builder.build(
      [
        {
          path: 'src/controllers/orderCtrl.ts',
          language: 'TypeScript',
          content: `function handleOrder() { processOrder(); }`,
        },
        {
          path: 'src/services/orderService.ts',
          language: 'TypeScript',
          content: `function processOrder() {}`,
        },
      ],
      layers
    );

    expect(result.layerViolations).toHaveLength(0);
  });

  it('does NOT flag calls within the same layer', async () => {
    const builder = new CallGraphBuilder();
    const result = await builder.build(
      [
        {
          path: 'src/services/orderService.ts',
          language: 'TypeScript',
          content: `function createOrder() { validateOrder(); } function validateOrder() {}`,
        },
      ],
      layers
    );

    expect(result.layerViolations).toHaveLength(0);
  });

  it('ignores calls between files that belong to no layer', async () => {
    const builder = new CallGraphBuilder();
    const result = await builder.build(
      [
        {
          path: 'utils/helpers.ts',
          language: 'TypeScript',
          content: `function helper() { other(); } function other() {}`,
        },
      ],
      layers
    );

    expect(result.layerViolations).toHaveLength(0);
  });

  it('returns empty violations when no layers are provided', async () => {
    const builder = new CallGraphBuilder();
    const result = await builder.build([
      {
        path: 'src/repositories/repo.ts',
        language: 'TypeScript',
        content: `function save() { render(); } function render() {}`,
      },
    ]);

    expect(result.layerViolations).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// C++
// ---------------------------------------------------------------------------

describe('CallGraphBuilder — C++', () => {
  it('extracts free functions and resolves calls', async () => {
    const builder = new CallGraphBuilder();
    const result = await builder.build([{
      path: 'src/main.cpp',
      language: 'C++',
      content: `
        void emit() {}
        void greet() { emit(); }
        void main() { greet(); emit(); }
      `,
    }]);

    expect(nodeNames(result)).toEqual(['emit', 'greet', 'main']);
    expect(edgePairs(result)).toEqual(['greet→emit', 'main→emit', 'main→greet'].sort());
    expect(fanIn(result, 'emit')).toBe(2);
    expect(fanOut(result, 'main')).toBe(2);
  });

  it('extracts inline class methods and detects class context', async () => {
    const builder = new CallGraphBuilder();
    const result = await builder.build([{
      path: 'src/service.cpp',
      language: 'C++',
      content: `
        class UserService {
        public:
          void getUser() { fetch(); }
          void fetch() {}
        };
      `,
    }]);

    expect(nodeNames(result)).toEqual(['fetch', 'getUser']);
    expect(result.nodes.get('src/service.cpp::UserService.getUser')?.className).toBe('UserService');
    expect(result.nodes.get('src/service.cpp::UserService.fetch')?.className).toBe('UserService');
    expect(fanIn(result, 'fetch')).toBe(1);
  });

  it('extracts out-of-class method definitions (Foo::bar)', async () => {
    const builder = new CallGraphBuilder();
    const result = await builder.build([{
      path: 'src/service.cpp',
      language: 'C++',
      content: `
        void MyClass::process() { validate(); }
        void MyClass::validate() {}
      `,
    }]);

    expect(nodeNames(result)).toContain('process');
    expect(nodeNames(result)).toContain('validate');
    const processNode = Array.from(result.nodes.values()).find(n => n.name === 'process');
    expect(processNode?.className).toBe('MyClass');
  });

  it('resolves cross-function calls via member calls (obj.method)', async () => {
    const builder = new CallGraphBuilder();
    const result = await builder.build([{
      path: 'src/app.cpp',
      language: 'C++',
      content: `
        void render() {}
        void run() { render(); }
      `,
    }]);

    expect(edgePairs(result)).toContain('run→render');
  });

  it('does not mark C++ functions as async', async () => {
    const builder = new CallGraphBuilder();
    const result = await builder.build([{
      path: 'src/coro.cpp',
      language: 'C++',
      content: `void fetchData() {}`,
    }]);

    const node = Array.from(result.nodes.values()).find(n => n.name === 'fetchData');
    expect(node?.isAsync).toBe(false);
    expect(node?.language).toBe('C++');
  });

  it('ignores C++ stdlib builtins as call targets', async () => {
    const builder = new CallGraphBuilder();
    const result = await builder.build([{
      path: 'src/io.cpp',
      language: 'C++',
      content: `
        void print() { printf("hello"); }
        void store() { push_back(1); malloc(10); }
      `,
    }]);

    // printf, push_back, malloc are in IGNORED_CALLEES — no edges expected
    expect(result.edges).toHaveLength(0);
  });
});

// ============================================================================
// Swift
// ============================================================================

describe('CallGraphBuilder — Swift', () => {
  it('extracts free functions and resolves direct calls', async () => {
    const builder = new CallGraphBuilder();
    const result = await builder.build([{
      path: 'Sources/App.swift',
      language: 'Swift',
      content: `
        func helper() {}
        func main() { helper() }
      `,
    }]);

    expect(nodeNames(result)).toContain('helper');
    expect(nodeNames(result)).toContain('main');
    expect(edgePairs(result)).toContain('main→helper');
  });

  it('extracts methods from struct declarations with correct className', async () => {
    const builder = new CallGraphBuilder();
    const result = await builder.build([{
      path: 'Sources/Timer.swift',
      language: 'Swift',
      content: `
        struct TimerManager {
            func start() {}
            func stop() { start() }
        }
      `,
    }]);

    const startNode = Array.from(result.nodes.values()).find(n => n.name === 'start');
    expect(startNode?.className).toBe('TimerManager');
    expect(edgePairs(result)).toContain('stop→start');
  });

  it('resolves self.method() calls within the same class', async () => {
    const builder = new CallGraphBuilder();
    const result = await builder.build([{
      path: 'Sources/ViewModel.swift',
      language: 'Swift',
      content: `
        class SettingsViewModel {
            func refresh() {}
            func load() { self.refresh() }
        }
      `,
    }]);

    expect(edgePairs(result)).toContain('load→refresh');
  });

  it('resolves cross-file calls by function name', async () => {
    const builder = new CallGraphBuilder();
    const result = await builder.build([
      {
        path: 'Sources/Helpers.swift',
        language: 'Swift',
        content: `func formatDate() -> String { return "" }`,
      },
      {
        path: 'Sources/View.swift',
        language: 'Swift',
        content: `
          func render() {
              let _ = formatDate()
          }
        `,
      },
    ]);

    expect(edgePairs(result)).toContain('render→formatDate');
  });

  it('resolves cross-file calls via capitalized type name (Strategy 1b)', async () => {
    const builder = new CallGraphBuilder();
    const result = await builder.build([
      {
        path: 'Sources/Logger.swift',
        language: 'Swift',
        content: `
          class Logger {
              func record(_ msg: String) {}
          }
        `,
      },
      {
        path: 'Sources/Manager.swift',
        language: 'Swift',
        content: `
          class Manager {
              func run() { Logger.record("started") }
          }
        `,
      },
    ]);

    // Logger is capitalized → type_name resolution picks Logger.record in Logger.swift
    const edge = result.edges.find(e => e.calleeName === 'record');
    expect(edge).toBeDefined();
    const callerNode = result.nodes.get(edge!.callerId);
    const calleeNode = result.nodes.get(edge!.calleeId);
    expect(callerNode?.filePath).toBe('Sources/Manager.swift');
    expect(calleeNode?.filePath).toBe('Sources/Logger.swift');
  });

  it('ignores Swift stdlib builtins as call targets', async () => {
    const builder = new CallGraphBuilder();
    const result = await builder.build([{
      path: 'Sources/Utils.swift',
      language: 'Swift',
      content: `
        func process(_ items: [String]) {
            let _ = items.map { $0 }
            print("done")
            fatalError("oops")
        }
      `,
    }]);

    // map, print, fatalError are in IGNORED_CALLEES
    expect(result.edges).toHaveLength(0);
  });

  it('does not mark regular Swift functions as async', async () => {
    const builder = new CallGraphBuilder();
    const result = await builder.build([{
      path: 'Sources/Sync.swift',
      language: 'Swift',
      content: `func doWork() {}`,
    }]);

    const node = Array.from(result.nodes.values()).find(n => n.name === 'doWork');
    expect(node?.isAsync).toBe(false);
    expect(node?.language).toBe('Swift');
  });

  it('marks async Swift functions correctly', async () => {
    const builder = new CallGraphBuilder();
    const result = await builder.build([{
      path: 'Sources/Async.swift',
      language: 'Swift',
      content: `func fetchData() async -> String { return "" }`,
    }]);

    const node = Array.from(result.nodes.values()).find(n => n.name === 'fetchData');
    expect(node?.isAsync).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// callDistance — confidence-weighted edge cost
// ---------------------------------------------------------------------------

describe('callDistance', () => {
  const edge = (confidence: EdgeConfidence): CallEdge =>
    ({ callerId: 'a::f', calleeId: 'b::g', calleeName: 'g', confidence });

  // Pin every confidence level to its cost. Adding an EdgeConfidence member
  // breaks compilation of CALL_DISTANCE_COSTS, forcing an explicit cost choice.
  const expected: Record<EdgeConfidence, number> = {
    import: 1, re_export: 1, same_file: 1, self_cls: 1, http_endpoint: 1,
    type_inference: 2, type_name: 2,
    name_only: 3,
    synthesized: 4,
    external: Infinity,
  };

  for (const [confidence, cost] of Object.entries(expected) as [EdgeConfidence, number][]) {
    it(`maps ${confidence} → ${cost}`, () => {
      expect(callDistance(edge(confidence))).toBe(cost);
      expect(CALL_DISTANCE_COSTS[confidence]).toBe(cost);
    });
  }

  it('ranks strongly-resolved edges nearer than heuristic ones', () => {
    expect(callDistance(edge('import'))).toBeLessThan(callDistance(edge('name_only')));
  });

  it('costs a synthesized edge more than any directly-resolved confidence', () => {
    const directConfidences: EdgeConfidence[] = ['import', 'same_file', 'self_cls', 'http_endpoint', 'type_inference', 'type_name', 'name_only'];
    for (const c of directConfidences) {
      expect(callDistance(edge('synthesized'))).toBeGreaterThan(callDistance(edge(c)));
    }
  });

  it('excludes external edges from internal traversal (Infinity)', () => {
    expect(Number.isFinite(callDistance(edge('external')))).toBe(false);
  });

  it('falls back to a finite cost for a malformed/legacy confidence', () => {
    // Real data never carries this, but the runtime default must not throw.
    const bad = { callerId: 'a::f', calleeId: 'b::g', calleeName: 'g', confidence: 'exact' } as unknown as CallEdge;
    expect(callDistance(bad)).toBe(3);
  });
});
