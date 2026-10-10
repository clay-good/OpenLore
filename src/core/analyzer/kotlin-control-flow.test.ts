/**
 * The Kotlin control-flow overlay covers branching expressions
 * (change: widen-kotlin-control-flow-overlay, issue #546).
 */
import { describe, expect, it } from 'vitest';
import { CallGraphBuilder } from './call-graph.js';
import { computeCyclomaticComplexity } from './call-graph-complexity.js';
import { buildFunctionCfg, isStructurallyValid, type CfgNode, type FunctionCfg } from './cfg.js';

async function cfgOf(source: string, name = 'f'): Promise<FunctionCfg> {
  const result = await new CallGraphBuilder().build([{ path: 'A.kt', content: source, language: 'Kotlin' }]);
  const node = [...result.nodes.values()].find(n => n.name === name && !n.isExternal)!;
  const cfg = result.cfgs?.get(node.id);
  if (!cfg) throw new Error(`no overlay for ${name}`);
  expect(isStructurallyValid(cfg), 'structurally valid').toBe(true);
  return cfg;
}

const EXIT = 1;
const out = (cfg: FunctionCfg, block: number) => cfg.edges.filter(e => e.from === block);
const branches = (cfg: FunctionCfg) => cfg.blocks.filter(b => b.kind === 'branch');
const exitEdges = (cfg: FunctionCfg) => cfg.edges.filter(e => e.to === EXIT && e.kind === 'exit');

describe('Kotlin control-flow overlay', () => {
  it('models `when` as one multi-way branch with one arm per entry', async () => {
    const cfg = await cfgOf('fun f(x: Int) {\n  when (x) {\n    1, 2 -> a()\n    3 -> b()\n    else -> c()\n  }\n}\nfun a() {}\nfun b() {}\nfun c() {}\n');
    expect(branches(cfg)).toHaveLength(1);
    const arms = out(cfg, branches(cfg)[0].id);
    // `1, 2 ->` is one arm; `else` is the default arm; with an `else` there is no fall-through.
    expect(arms.map(e => e.kind).sort()).toEqual(['false', 'true', 'true']);
  });

  it('gives a `when` with no `else` a fall-through exit', async () => {
    const cfg = await cfgOf('fun f(x: Int) {\n  when {\n    x > 1 -> a()\n    x > 2 -> b()\n  }\n}\nfun a() {}\nfun b() {}\n');
    const arms = out(cfg, branches(cfg)[0].id);
    expect(arms.filter(e => e.kind === 'true')).toHaveLength(2);
    const merge = cfg.blocks.find(b => b.kind === 'merge')!;
    expect(arms.filter(e => e.kind === 'false').map(e => e.to)).toEqual([merge.id]);
  });

  it('models `try` with a handler per catch and a finally on every exit', async () => {
    const cfg = await cfgOf('fun f(): Int? {\n  return try {\n    load()\n  } catch (e: IllegalStateException) {\n    null\n  } catch (e: RuntimeException) {\n    fallback()\n  } finally {\n    audit()\n  }\n}\nfun load() = 1\nfun fallback() = 2\nfun audit() {}\n');
    const entry = branches(cfg)[0];
    // One edge into the protected body and one into each of the two handlers.
    expect(out(cfg, entry.id).filter(e => e.kind === 'true')).toHaveLength(1);
    expect(out(cfg, entry.id).filter(e => e.kind === 'false')).toHaveLength(2);
    // The only way out of the function is after the finally block: its block uses `audit`'s
    // call site line, and it is the single predecessor of the exit.
    const intoExit = cfg.edges.filter(e => e.to === EXIT);
    expect(intoExit).toHaveLength(1);
    const merge = cfg.blocks.find(b => b.kind === 'merge')!;
    expect(intoExit[0].from).toBe(merge.id);
  });

  it('models `do-while` as a post-test loop', async () => {
    const cfg = await cfgOf('fun f(): Int {\n  var n = 0\n  do {\n    n++\n  } while (n < 3)\n  return n\n}\n');
    const loop = cfg.blocks.find(b => b.kind === 'loop')!;
    // The body is entered before the test: the loop block has a back edge into it, and the
    // pre-loop definition of `n` does not reach the `return`.
    expect(out(cfg, loop.id).map(e => e.kind).sort()).toEqual(['back', 'false']);
    const reaching = cfg.defUse.filter(e => e.variable === 'n' && e.useLine === 6).map(e => e.defLine);
    expect(reaching).toEqual([4]);
  });

  it('makes the right side of an Elvis operator an exit when it is a jump', async () => {
    const cfg = await cfgOf('fun f(id: String?): String? {\n  val u = find(id) ?: return null\n  return u\n}\nfun find(id: String?) = id\n');
    expect(branches(cfg)).toHaveLength(1);
    expect(exitEdges(cfg)).toHaveLength(2); // the Elvis `return null` and the final `return u`
    const elvis = branches(cfg)[0];
    const rightBlock = out(cfg, elvis.id).find(e => e.kind === 'false')!.to;
    expect(out(cfg, rightBlock).map(e => `${e.kind}->${e.to}`)).toEqual([`exit->${EXIT}`]);
  });

  it('models an Elvis operator with a value on the right as a two-way branch that rejoins', async () => {
    const cfg = await cfgOf('fun f(a: String?): String {\n  val v = a ?: fallback()\n  return v\n}\nfun fallback() = "x"\n');
    expect(branches(cfg)).toHaveLength(1);
    expect(out(cfg, branches(cfg)[0].id).map(e => e.kind).sort()).toEqual(['false', 'true']);
    expect(exitEdges(cfg)).toHaveLength(1);
  });

  it('models a safe call as a two-way branch that skips the call', async () => {
    const cfg = await cfgOf('fun f(a: A?) {\n  a?.go()\n}\nclass A {\n  fun go() {}\n}\n');
    expect(branches(cfg)).toHaveLength(1);
    const edges = out(cfg, branches(cfg)[0].id);
    const merge = cfg.blocks.find(b => b.kind === 'merge')!;
    expect(edges.find(e => e.kind === 'false')?.to).toBe(merge.id);
    expect(edges.find(e => e.kind === 'true')?.to).not.toBe(merge.id);
  });

  it('gives an expression-position `if` an overlay with one two-way branch', async () => {
    const cfg = await cfgOf('fun f(c: Boolean): Int {\n  val v = if (c) a() else b()\n  return v\n}\nfun a() = 1\nfun b() = 2\n');
    expect(branches(cfg)).toHaveLength(1);
    expect(out(cfg, branches(cfg)[0].id).map(e => e.kind).sort()).toEqual(['false', 'true']);
    // The definition of `v` is after the join, so it reaches the `return`.
    expect(cfg.defUse.some(e => e.variable === 'v' && e.defLine === 2 && e.useLine === 3)).toBe(true);
  });

  it('builds an overlay for branches in an argument and in an expression body', async () => {
    const asArgument = await cfgOf('fun f(c: Boolean) {\n  use(if (c) 1 else 2, when (c) { true -> 3; else -> 4 })\n}\nfun use(a: Int, b: Int) {}\n');
    expect(branches(asArgument)).toHaveLength(2);
    const expressionBody = await cfgOf('fun f(id: String?): String = id ?: throw IllegalArgumentException("x")\n');
    expect(branches(expressionBody)).toHaveLength(1);
    expect(exitEdges(expressionBody).length).toBeGreaterThanOrEqual(1);
  });

  it('records compound assignment and increment as a use and a definition', async () => {
    const cfg = await cfgOf('fun f(): Int {\n  var n = 0\n  n += 2\n  n++\n  --n\n  return n\n}\n');
    const chain = cfg.defUse.filter(e => e.variable === 'n').map(e => `${e.defLine}->${e.useLine}`);
    expect(chain).toEqual(expect.arrayContaining(['2->3', '3->4', '4->5', '5->6']));
    expect(chain).not.toContain('2->6');
  });

  it('sends a labeled jump to its labeled loop', async () => {
    const cfg = await cfgOf('fun f(xs: List<Int>) {\n  outer@ for (x in xs) {\n    for (y in xs) {\n      if (y == 3) continue@outer\n      if (y == 5) break@outer\n      inner()\n    }\n  }\n  after()\n}\nfun inner() {}\nfun after() {}\n');
    const loops = cfg.blocks.filter(b => b.kind === 'loop');
    expect(loops).toHaveLength(2);
    const [outer] = loops;
    // `continue@outer` is a back edge to the OUTER loop header from inside the inner loop body.
    const backToOuter = cfg.edges.filter(e => e.to === outer.id && e.kind === 'back');
    expect(backToOuter.length).toBeGreaterThanOrEqual(2); // the labeled continue and the inner loop's normal end
    const outerExit = out(cfg, outer.id).find(e => e.kind === 'false')!.to;
    // `break@outer` jumps to the block after the outer loop.
    expect(cfg.edges.some(e => e.to === outerExit && e.kind === 'normal' && e.from !== outer.id)).toBe(true);
  });

  it('keeps a labeled return inside a lambda out of the function exit', async () => {
    const cfg = await cfgOf('fun f(items: List<Int>) {\n  items.forEach {\n    if (it == 0) return@forEach\n    use(it)\n  }\n  done()\n}\nfun use(x: Int) {}\nfun done() {}\n');
    // The lambda is its own scope: the function has no branch and one normal fall-through exit.
    expect(branches(cfg)).toHaveLength(0);
    expect(exitEdges(cfg)).toHaveLength(0);
    expect(cfg.edges.filter(e => e.to === EXIT)).toHaveLength(1);
  });

  it('does not treat `when` as a `break` target', async () => {
    const cfg = await cfgOf('fun f(xs: List<Int>) {\n  for (x in xs) {\n    when (x) {\n      1 -> break\n      else -> use(x)\n    }\n  }\n}\nfun use(x: Int) {}\n');
    const loop = cfg.blocks.find(b => b.kind === 'loop')!;
    const afterLoop = out(cfg, loop.id).find(e => e.kind === 'false')!.to;
    expect(cfg.edges.some(e => e.to === afterLoop && e.from !== loop.id)).toBe(true);
  });

  it('counts the same `when` arms as complexity does', async () => {
    const source = 'fun f(x: Int): Int {\n  return when (x) {\n    1 -> 10\n    2, 3 -> 20\n    in 4..9 -> 30\n    else -> 0\n  }\n}\n';
    const cfg = await cfgOf(source);
    const nonDefaultArms = out(cfg, branches(cfg)[0].id).filter(e => e.kind === 'true').length;
    expect(nonDefaultArms).toBe(3);
    expect((computeCyclomaticComplexity(source, 'Kotlin') ?? 0) - 1).toBe(nonDefaultArms);
  });

  it('builds an overlay for every function of a file that mixes all the forms', async () => {
    const source = [
      'class S(private val repo: R?) {',
      '  fun describe(id: String?): String {',
      '    val key = id ?: return "anonymous"',
      '    return try {',
      '      when (val u = repo?.find(key)) {',
      '        null -> "missing"',
      '        else -> u.toString()',
      '      }',
      '    } catch (e: IllegalStateException) {',
      '      "broken"',
      '    }',
      '  }',
      '}',
      'class R { fun find(k: String): Any? = null }',
    ].join('\n');
    const cfg = await cfgOf(source, 'describe');
    expect(branches(cfg).length).toBeGreaterThanOrEqual(4); // Elvis, try, when, safe call
  });

  it('yields no overlay, not a partial one, when the builder throws', () => {
    const boom: CfgNode = {
      type: 'function_declaration', text: '', startIndex: 0, endIndex: 0, startPosition: { row: 0 },
      get namedChildren(): CfgNode[] { throw new Error('unknown node shape'); },
      childForFieldName: () => null,
    };
    expect(buildFunctionCfg(boom, 'Kotlin')).toBeUndefined();
  });
});
