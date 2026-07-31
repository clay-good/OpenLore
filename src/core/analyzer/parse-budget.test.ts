/**
 * Per-file parse budget (change: fix-analyze-native-abort-and-file-cost-budget).
 *
 * The acceptance criterion of this change is a REPRODUCER, so the tests lead with the two
 * behaviours that were broken on `origin/main`:
 *
 *   1. A 300 KB file of a repeated unterminated block-comment opener parses for ~84 s and yields a
 *      100,002-deep tree. It must now be abandoned at the budget and RECORDED, not waited on.
 *   2. The tree it does produce overflowed the recursive parse-health walk, and a `RangeError`
 *      raised inside the native binding's node accessor is what turned it into
 *      `libc++abi: terminating due to uncaught exception of type Napi::Error` (exit 134). The walk
 *      must survive a tree far deeper than any call stack.
 *
 * And with them the CONTROL, which matters just as much: a bound that silently drops real files
 * would be a worse bug than the one being fixed. So an ordinary large file must be unaffected, and
 * the graph must be identical to a run with the budget disabled.
 */

import { describe, it, expect, afterEach } from 'vitest';
import {
  parseWithBudget,
  parseBudgetMs,
  parseBudgetOverrunMs,
  parseBudgetSupported,
  ParseBudgetExceededError,
  PARSE_BUDGET_MESSAGE_PREFIX,
} from './parse-budget.js';
import { tallyParseHealth, type ParseHealthNode } from './parse-health.js';
import { CallGraphBuilder, serializeCallGraph } from './call-graph.js';
import { PER_FILE_PARSE_BUDGET_MS, PARSE_BUDGET_ENV } from '../../constants.js';

/** The exact payload that reproduced the failure: 100,000 unterminated block-comment openers. */
const HOSTILE_TS = '/*x'.repeat(100_000);

afterEach(() => { delete process.env[PARSE_BUDGET_ENV]; });

// ---------------------------------------------------------------------------
// The bound itself
// ---------------------------------------------------------------------------

describe('parseWithBudget', () => {
  it('arms the deadline, returns the tree, and always disarms it', () => {
    const calls: number[] = [];
    const parser = {
      setTimeoutMicros: (n: number) => calls.push(n),
      parse: () => ({ ok: true }),
    };
    expect(parseWithBudget(parser, 'x')).toEqual({ ok: true });
    // Armed to the budget, then cleared — a deadline left armed would charge the NEXT file the
    // remainder of this one's budget on the same singleton parser.
    expect(calls).toEqual([PER_FILE_PARSE_BUDGET_MS * 1000, 0]);
  });

  it('disarms the deadline even when the parse throws', () => {
    const calls: number[] = [];
    const parser = {
      setTimeoutMicros: (n: number) => calls.push(n),
      parse: () => { throw new Error('boom'); },
    };
    expect(() => parseWithBudget(parser, 'x')).toThrow('boom');
    expect(calls).toEqual([PER_FILE_PARSE_BUDGET_MS * 1000, 0]);
  });

  it('turns a null tree from a BOUNDED parser into a budget-exceeded error carrying the bound', () => {
    const parser = { setTimeoutMicros: () => {}, parse: () => null };
    let thrown: unknown;
    try { parseWithBudget(parser, 'x'); } catch (e) { thrown = e; }
    expect(thrown).toBeInstanceOf(ParseBudgetExceededError);
    expect((thrown as Error).message).toContain(PARSE_BUDGET_MESSAGE_PREFIX);
    expect(parseBudgetOverrunMs((thrown as Error).message)).toBe(PER_FILE_PARSE_BUDGET_MS);
  });

  it('RESETS the parser when the deadline fires, so the next file does not resume the abandoned parse', () => {
    // A timed-out tree-sitter parse is SUSPENDED, not discarded — calling `parse` again resumes
    // it. Without the reset, the file AFTER a budget-exceeded one silently produced zero symbols.
    let resets = 0;
    const parser = { setTimeoutMicros: () => {}, reset: () => { resets++; }, parse: () => null };
    expect(() => parseWithBudget(parser, 'x')).toThrow(ParseBudgetExceededError);
    expect(resets).toBe(1);
  });

  it('does not reset on a successful parse — resetting is the timeout path only', () => {
    let resets = 0;
    const parser = { setTimeoutMicros: () => {}, reset: () => { resets++; }, parse: () => ({ ok: true }) };
    parseWithBudget(parser, 'x');
    expect(resets).toBe(0);
  });

  it('does NOT call a null tree from an UNBOUNDED parser a budget overrun', () => {
    // No `setTimeoutMicros` — the deadline was never armed, so a missing tree is some other
    // failure. Mislabelling it would attribute a real defect to a bound that never ran.
    const parser = { parse: () => null };
    expect(() => parseWithBudget(parser, 'x')).toThrow('tree-sitter returned no tree');
    expect(parseBudgetSupported(parser)).toBe(false);
  });

  it('never arms a deadline the parser cannot enforce', () => {
    let parsed = false;
    const parser = { parse: () => { parsed = true; return { ok: true }; } };
    expect(parseWithBudget(parser, 'x')).toEqual({ ok: true });
    expect(parsed).toBe(true);
  });

  it('falls back to an unbounded parse when arming the deadline THROWS, and never asks that parser again', () => {
    // `web-tree-sitter@0.25` exposes `setTimeoutMicros` and throws
    // `TypeError: Cannot convert 0 to a BigInt` from inside it. Letting that propagate made every
    // Dart and Lua file fail to extract — a bound that silently deleted real work.
    let arms = 0;
    const parser = {
      setTimeoutMicros: () => { arms++; throw new TypeError('Cannot convert 0 to a BigInt'); },
      parse: () => ({ ok: true }),
    };
    expect(parseWithBudget(parser, 'x')).toEqual({ ok: true });
    expect(parseWithBudget(parser, 'y')).toEqual({ ok: true });
    // Refused once, demoted for good: the throw is not re-paid per file.
    expect(arms).toBe(1);
    expect(parseBudgetSupported(parser)).toBe(false);
  });

  it('demotes the whole BINDING, not one instance — the WASM lane builds a fresh parser per file', () => {
    // The lane this fallback was written for (`loadWasmGrammarSoft`) constructs a new parser for
    // every file, because its WASM heap must not be shared. Recording the refusal against the
    // INSTANCE therefore never helped: the entry from file N was never consulted on file N+1, and
    // the throw was re-paid on every file — precisely what the demotion claims to avoid.
    let arms = 0;
    class WasmLikeParser {
      setTimeoutMicros(): void { arms++; throw new TypeError('Cannot convert 0 to a BigInt'); }
      parse(): { ok: boolean } { return { ok: true }; }
    }
    // Two files, two fresh parsers, one shared prototype — the real shape.
    expect(parseWithBudget(new WasmLikeParser(), 'file-1')).toEqual({ ok: true });
    expect(parseWithBudget(new WasmLikeParser(), 'file-2')).toEqual({ ok: true });
    expect(parseWithBudget(new WasmLikeParser(), 'file-3')).toEqual({ ok: true });
    expect(arms, 'the binding refused once and was not asked again').toBe(1);
    // And a DIFFERENT binding is unaffected — this is a per-binding fact, not a global switch.
    // (Keying on the prototype rather than the constructor got this wrong: every plain object
    // literal shares `Object.prototype`, so one refusal demoted every unrelated parser.)
    let healthyArms = 0;
    class NativeLikeParser {
      setTimeoutMicros(): void { healthyArms++; }
      parse(): { ok: boolean } { return { ok: true }; }
    }
    parseWithBudget(new NativeLikeParser(), 'x');
    expect(healthyArms, 'a healthy binding still arms and clears').toBe(2);
  });

  it('a parser that cannot arm a deadline reports a missing tree honestly, not as a budget overrun', () => {
    const parser = {
      setTimeoutMicros: () => { throw new TypeError('nope'); },
      parse: () => null,
    };
    expect(() => parseWithBudget(parser, 'x')).toThrow('tree-sitter returned no tree');
  });

  it('is disabled by OPENLORE_PARSE_BUDGET_MS=0, restoring the previous unbounded behaviour', () => {
    process.env[PARSE_BUDGET_ENV] = '0';
    const calls: number[] = [];
    const parser = { setTimeoutMicros: (n: number) => calls.push(n), parse: () => ({ ok: true }) };
    expect(parseBudgetMs()).toBe(0);
    parseWithBudget(parser, 'x');
    expect(calls).toEqual([]); // no deadline armed at all
  });
});

describe('parseBudgetMs', () => {
  it('honours a valid override', () => {
    process.env[PARSE_BUDGET_ENV] = '1500';
    expect(parseBudgetMs()).toBe(1500);
  });

  it.each(['', '   ', 'abc', '-5', 'NaN', 'Infinity'])(
    'ignores %o and keeps the default — a typo must not silently disable the bound',
    (raw) => {
      process.env[PARSE_BUDGET_ENV] = raw;
      expect(parseBudgetMs()).toBe(PER_FILE_PARSE_BUDGET_MS);
    },
  );
});

describe('parseBudgetOverrunMs', () => {
  it('reads the BUDGET off a message that crossed a worker boundary', () => {
    // The class does not survive structured cloning, so classification is message-keyed. This is
    // the exact shape the parent receives from a worker.
    //
    // The budget, not the measured elapsed time: the caller writes this into `parse-health.json`,
    // which must be byte-identical across re-analyses of a fixed repository state. A wall-clock
    // number there would make every run differ.
    expect(parseBudgetOverrunMs(new ParseBudgetExceededError(19_977, 20_000).message)).toBe(20_000);
  });

  it('still classifies a marked message whose budget it cannot read', () => {
    // Degrading to "ordinary parse failure" would mis-attribute the cause; falling back to the
    // active budget keeps the reason right.
    expect(parseBudgetOverrunMs(`${PARSE_BUDGET_MESSAGE_PREFIX}: mangled`)).toBe(PER_FILE_PARSE_BUDGET_MS);
  });

  it.each([undefined, '', 'Maximum call stack size exceeded', 'Unexpected token'])(
    'returns undefined for %o so an ordinary failure is never re-labelled',
    (msg) => expect(parseBudgetOverrunMs(msg)).toBeUndefined(),
  );
});

// ---------------------------------------------------------------------------
// Reproducer 1 — the pathological file is abandoned and recorded, not waited on
// ---------------------------------------------------------------------------

describe('reproducer: a pathological file is abandoned rather than stalling the run', () => {
  it('records it as budget-exceeded with its elapsed time, and analyzes the rest normally', async () => {
    // A small budget so the test is fast; the mechanism is identical at the 20 s default, which
    // this same file exceeds (~84 s of parse on the machine that reproduced it).
    process.env[PARSE_BUDGET_ENV] = '750';
    const result = await new CallGraphBuilder({}).build([
      { path: 'src/hostile.ts', content: HOSTILE_TS, language: 'TypeScript' },
      { path: 'src/ok.ts', content: 'export function a(): void { b(); }\nfunction b(): void {}\n', language: 'TypeScript' },
    ]);

    const health = result.parseHealthByFile?.get('src/hostile.ts');
    expect(health?.exclusion).toBe('budget-exceeded');
    expect(health?.parseFailed).toBe(true);
    expect(health?.budgetMs).toBe(750);

    // The rest of the repository is analyzed normally — the bound costs one file, not the run.
    // This assertion is the one that caught the missing parser reset: `ok.ts` follows the
    // abandoned file through the SAME singleton parser, and without a reset it produced nothing.
    expect([...result.nodes.values()].some(n => n.name === 'a')).toBe(true);
    expect(result.parseHealthByFile?.has('src/ok.ts')).toBe(false);
  }, 60_000);

  it('records the same thing twice — a budget-exceeded file must not make the artifact non-deterministic', async () => {
    // `parse-health.json` is persisted and must be byte-identical across re-analyses of a fixed
    // repository state (change: fix-artifact-output-determinism). Recording the measured elapsed
    // time here would break that on every repository that has one of these files.
    process.env[PARSE_BUDGET_ENV] = '600';
    const files = [{ path: 'src/hostile.ts', content: HOSTILE_TS, language: 'TypeScript' }];
    const once = await new CallGraphBuilder({}).build(files.map(f => ({ ...f })));
    const twice = await new CallGraphBuilder({}).build(files.map(f => ({ ...f })));
    expect(JSON.stringify([...once.parseHealthByFile!]))
      .toBe(JSON.stringify([...twice.parseHealthByFile!]));
    expect(once.parseHealthByFile!.get('src/hostile.ts')?.budgetMs).toBe(600);
    // 120s, not the 60s its siblings use: this is the only case here that builds the graph TWICE
    // over the 300 KB pathological payload, and abandoning that parse is expensive on both runs.
    // It takes ~17s on a developer machine but ~61s on a 2-core CI runner, so at 60s it had no
    // headroom at all and failed on load it did not cause. Measured on this branch and on `main`
    // uncontended it is unchanged (17.0/17.4s vs 17.6/18.0s), so the budget — not the code — is
    // what was wrong.
  }, 120_000);

  it('CONTROL: an ordinary large file is NOT recorded, and the graph matches a run with the budget disabled', async () => {
    // ~1.4 MB of well-formed generated-client-shaped source — far larger than anything in this
    // repository, and it must parse well inside the budget. A bound that dropped this would be a
    // worse bug than the unbounded parse it replaced.
    const big = Array.from(
      { length: 20_000 },
      (_, i) => `export function gen${i}(): number { return helper${i}(); }\nfunction helper${i}(): number { return ${i}; }`,
    ).join('\n');
    const files = [{ path: 'src/generated-client.ts', content: big, language: 'TypeScript' }];

    process.env[PARSE_BUDGET_ENV] = '0';
    const withoutBudget = serializeCallGraph(await new CallGraphBuilder({}).build(files.map(f => ({ ...f }))));
    delete process.env[PARSE_BUDGET_ENV];
    const withBudget = await new CallGraphBuilder({}).build(files.map(f => ({ ...f })));

    expect(withBudget.parseHealthByFile?.get('src/generated-client.ts')).toBeUndefined();
    expect(JSON.stringify(serializeCallGraph(withBudget))).toBe(JSON.stringify(withoutBudget));
  }, 120_000);
});

// ---------------------------------------------------------------------------
// Reproducer 2 — the deep tree that produced the exit-134 abort
// ---------------------------------------------------------------------------

describe('reproducer: the parse-health walk survives a tree deeper than any call stack', () => {
  /**
   * A right-leaning chain `depth` nodes deep, built lazily through the index accessors the real
   * `SyntaxNode` exposes — the same shape the hostile file produced (measured: 100,002 deep). The
   * recursive walk this replaced overflowed at roughly a tenth of this.
   */
  function deepChain(depth: number): ParseHealthNode {
    const make = (level: number): ParseHealthNode => ({
      type: level === depth ? 'ERROR' : 'binary_expression',
      startPosition: { row: level },
      hasError: true,
      children: [],
      childCount: level === depth ? 0 : 1,
      child: (i: number) => (i === 0 && level < depth ? make(level + 1) : null),
    });
    return make(0);
  }

  it('tallies a 100,000-deep tree without a RangeError', () => {
    // The unguarded `RangeError` here is what surfaced as a native abort with no JavaScript error
    // anywhere: raised inside the binding's node accessor, it cannot be caught as a JS throw.
    const health = tallyParseHealth('TypeScript', deepChain(100_000), 'src/hostile.ts');
    expect(health?.errorCount).toBe(1);
    expect(health?.errorLines).toEqual([100_001]);
  });

  /**
   * Source order, on BOTH child-access shapes.
   *
   * The walk prefers the allocation-free `childCount`/`child(i)` accessors that a real
   * `SyntaxNode` exposes, and falls back to `.children` for plain test objects. An earlier version
   * of this test supplied only `.children`, so it exercised the fallback and left the branch that
   * actually ships free to be reversed with no failure. Both are covered now.
   */
  it.each([
    ['index accessors (the shape production takes)', true],
    ['.children array (the test-double fallback)', false],
  ])('visits children in source order via %s', (_label, useAccessors) => {
    const kid = (row: number): ParseHealthNode =>
      ({ type: 'ERROR', startPosition: { row }, children: [], hasError: true });
    const kids = Array.from({ length: 40 }, (_, i) => kid(i));
    const root: ParseHealthNode = {
      type: 'program',
      startPosition: { row: 0 },
      hasError: true,
      // Deliberately more error regions than the cap, in ascending source order: if the walk ran
      // children in reverse, the retained lines would be the LAST 25, not the first.
      children: useAccessors ? [] : kids,
      ...(useAccessors ? { childCount: kids.length, child: (i: number) => kids[i] ?? null } : {}),
    };
    const health = tallyParseHealth('TypeScript', root, 'a.ts');
    expect(health?.errorCount).toBe(40);
    expect(health?.truncated).toBe(true);
    expect(health?.errorLines).toEqual(Array.from({ length: 25 }, (_, i) => i + 1));
  });
});

// ---------------------------------------------------------------------------
// Regressions found by adversarial review of the first revision of this change
// ---------------------------------------------------------------------------

describe('an abandoned file must not cost OTHER files their edges', () => {
  /**
   * The first revision dropped budget-exceeded files from `buildResolvedImportMap` to save time.
   * `parseJSExports` is a REGEX scan — it reads a file tree-sitter gave up on perfectly well — so
   * that filter deleted re-export information belonging to files that parsed cleanly. The loss
   * landed on files carrying no parse-health record, so nothing connected the missing edge to the
   * abandoned one: absence read as evidence of absence, which is the failure this change exists to
   * prevent.
   */
  it('resolves a call through a barrel that was abandoned at the budget', async () => {
    process.env[PARSE_BUDGET_ENV] = '700';
    // The barrel is a re-export AND pathological: tree-sitter will abandon it, but its
    // `export { … } from` line is still perfectly readable by the regex export scan.
    const barrel = `export { realThing } from './impl';\n${HOSTILE_TS}`;
    const files = [
      { path: 'src/barrel.ts', content: barrel, language: 'TypeScript' },
      { path: 'src/impl.ts', content: 'export function realThing(): number { return 1; }\n', language: 'TypeScript' },
      { path: 'src/consumer.ts', content: "import { realThing } from './barrel';\nexport function consume(): number { return realThing(); }\n", language: 'TypeScript' },
      // A same-named decoy elsewhere: without the barrel's re-export the resolver has two
      // candidates and must fall back to name-only or refuse.
      { path: 'src/decoy.ts', content: 'export function realThing(): string { return "x"; }\n', language: 'TypeScript' },
    ];

    const result = await new CallGraphBuilder({}).build(files);

    // The barrel itself is abandoned and disclosed…
    expect(result.parseHealthByFile?.get('src/barrel.ts')?.exclusion).toBe('budget-exceeded');
    // …but consumer.ts parsed cleanly, and its call must still reach the true definition.
    const edge = result.edges.find(e => e.callerId === 'src/consumer.ts::consume');
    expect(edge, 'the call through the abandoned barrel still resolves').toBeDefined();
    expect(edge!.calleeId).toBe('src/impl.ts::realThing');
    // And the healthy files carry no parse-health record — they were never degraded.
    expect(result.parseHealthByFile?.has('src/consumer.ts')).toBe(false);
  }, 60_000);
});
