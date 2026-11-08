/**
 * Extracting a WIDE composite literal in linear time, under an enforced per-file budget
 * (change: bound-large-literal-extraction).
 *
 * The defect these tests pin, found by a real-repo end-to-end run:
 * `GoogleCloudPlatform/microservices-demo` is a 364-file repository that took 95 s to analyze,
 * 82 s of it inside ONE 89 KB generated file (`src/frontend/genproto/demo.pb.go`). The cost was
 * not the file's size — grpc-go's larger `channelz.pb.go` is fine — but one node's WIDTH: the
 * generated `var file_demo_proto_rawDesc = []byte{0x0a, …}` is a single composite literal of
 * ~4,400 elements. Three whole-tree walks re-read the `namedChildren` getter inside their own
 * child loop, so a node with k children materialized k² child objects. End to end, extraction grew
 * as N^2.5 in the element count: 2.6 s → 29 s → 178 s for N = 1,000 → 4,000 → 8,000.
 *
 * And the 20 s per-file budget that should have abandoned the 82 s file did not fire, because it
 * bounded the PARSE and the parse finished in milliseconds. A documented bound that does not hold
 * is an honesty defect as much as a performance one, so both halves are pinned here:
 *
 *  1. the walk is linear in a node's width — asserted on a deterministic OPERATION COUNT, not
 *     wall clock, which this repository has been bitten by under load;
 *  2. the facts extracted from the real generated file are UNCHANGED, pinned against a golden
 *     captured from the pre-fix build;
 *  3. a file that exceeds the budget in a POST-PARSE phase is abandoned and disclosed as
 *     `budget-exceeded` — never `parse-failure`, which the source itself calls "a cause we cannot
 *     prove".
 */
import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { CallGraphBuilder, dispatchFileExtract } from './call-graph.js';
import {
  checkExtractionBudget,
  extractionBudgetOverrunMs,
  runWithExtractionBudget,
  ExtractionBudgetExceededError,
} from './extraction-budget.js';
import { measurePerfWorkForTests } from './perf-counters.js';
import { PARSE_BUDGET_ENV } from '../../constants.js';

afterEach(() => { delete process.env[PARSE_BUDGET_ENV]; });

/** One Go file whose only notable feature is a `[]byte{…}` literal of `n` elements. */
function wideLiteralGo(n: number): string {
  const rows: string[] = [];
  for (let i = 0; i < n; i += 16) {
    const row: string[] = [];
    for (let j = i; j < Math.min(i + 16, n); j++) row.push(`0x${(j % 256).toString(16).padStart(2, '0')}`);
    rows.push(`\t${row.join(', ')},`);
  }
  return `package gen\n\nvar rawDesc = []byte{\n${rows.join('\n')}\n}\n\nfunc Len() int {\n\treturn len(rawDesc)\n}\n`;
}

/** Child nodes materialized by the shared tree-walk boundary while extracting `content`. */
async function childNodesMaterialized(content: string): Promise<number> {
  const { counters } = await measurePerfWorkForTests(
    () => dispatchFileExtract({ path: 'src/gen.go', content, language: 'Go' }),
  );
  return counters.astChildNodesMaterialized;
}

describe('a wide composite literal is extracted in linear time', () => {
  it('materializes each child once, so quadrupling the literal quadruples the work', async () => {
    // An OPERATION COUNT, not a wall clock: the quantity that went quadratic is how many child
    // nodes the walks materialize, and it is exactly measurable. A wall-clock ratio would flake on
    // a loaded runner, and this repository has shipped that mistake before.
    const small = await childNodesMaterialized(wideLiteralGo(1_000));
    const large = await childNodesMaterialized(wideLiteralGo(4_000));

    // 4x the elements for 4x the work. The headroom is for the fixed per-file nodes the small
    // case pays proportionally more of, not for a growth term.
    expect(large / small).toBeLessThan(6);
    // Pre-fix this ratio was ~16 (N² against 4N elements): 1,006,118 → 16,024,118 measured.
    expect(large).toBeLessThan(small * 6);
  }, 120_000);

  it('materializes O(total nodes), not O(width²) — an absolute bound, not a ratio', async () => {
    // The invariant behind the ratio: a walk reads each node's children ONCE, so the count is
    // bounded by (nodes x walks), never by one node's width squared. The file below has ~8,000
    // leaves under a single parent, so a per-child re-read costs ~64,000,000 and this fails loudly.
    const elements = 8_000;
    const materialized = await childNodesMaterialized(wideLiteralGo(elements));
    // Three whole-tree walks go through the shared boundary, so a generous ceiling is still two
    // orders of magnitude below the quadratic figure.
    expect(materialized).toBeLessThan(elements * 20);
  }, 120_000);
});

// ---------------------------------------------------------------------------
// The facts must not change — pinned on the real generated file
// ---------------------------------------------------------------------------

const DEMO_PB_GO = fileURLToPath(new URL('./fixtures/genproto/demo.pb.go', import.meta.url));

/**
 * The extraction golden for `demo.pb.go`, CAPTURED FROM THE PRE-FIX BUILD.
 *
 * A performance fix that changed which symbols or edges a file contributes would be a far worse
 * defect than the slowness it cured, and the only honest proof is a golden recorded before the
 * change. The fixture is the unmodified 89 KB `src/frontend/genproto/demo.pb.go` from
 * GoogleCloudPlatform/microservices-demo @ c7cb6d5bfd6e (Apache-2.0, header intact) — the exact
 * file the real-repo run spent 82 s on.
 */
const DEMO_PB_GO_GOLDEN = JSON.parse(
  readFileSync(fileURLToPath(new URL('./fixtures/genproto/demo.pb.go.extract.json', import.meta.url)), 'utf-8'),
) as { nodes: Array<{ id: string; startIndex: number; endIndex: number }>; rawEdges: unknown[] };

describe('extraction of a real generated-protobuf file is unchanged', () => {
  it('yields exactly the functions and edges the pre-fix build yielded', async () => {
    const content = readFileSync(DEMO_PB_GO, 'utf-8');
    const result = await dispatchFileExtract({
      path: 'src/frontend/genproto/demo.pb.go',
      content,
      language: 'Go',
    });

    expect(result).toBeDefined();
    expect(result!.nodes.map(n => ({ id: n.id, startIndex: n.startIndex, endIndex: n.endIndex })))
      .toEqual(DEMO_PB_GO_GOLDEN.nodes);
    expect(result!.rawEdges).toEqual(DEMO_PB_GO_GOLDEN.rawEdges);
    // Non-vacuity: a golden of nothing would pass against any regression.
    expect(DEMO_PB_GO_GOLDEN.nodes.length).toBeGreaterThan(100);
  }, 120_000);
});

// ---------------------------------------------------------------------------
// The stated bound is the real bound
// ---------------------------------------------------------------------------

describe('the per-file budget bounds the whole extraction, not only the parse', () => {
  it('abandons a file whose POST-PARSE phase overruns, and names the budget', async () => {
    process.env[PARSE_BUDGET_ENV] = '40';
    // A phase that overruns after the parse: pre-change nothing checked the clock here at all, so
    // an 82 s post-parse walk returned its facts and the budget was never consulted.
    const overrun = runWithExtractionBudget(async () => {
      await new Promise(resolve => setTimeout(resolve, 300));
      checkExtractionBudget();
      return 'facts';
    });
    await expect(overrun).rejects.toThrow(ExtractionBudgetExceededError);
  });

  it('abandons it even when NO checkpoint fired — the facts are not admitted over budget', async () => {
    process.env[PARSE_BUDGET_ENV] = '40';
    // A phase with no cooperative checkpoint of its own cannot be interrupted, but its file must
    // still not reach the graph: the final check on return is what makes the bound true.
    const overrun = runWithExtractionBudget(async () => {
      await new Promise(resolve => setTimeout(resolve, 300));
      return 'facts';
    });
    await expect(overrun).rejects.toThrow(/abandoned after \d+ms \(budget 40ms/);
  });

  it('classifies the overrun as budget-exceeded, so the builder never files it as parse-failure', async () => {
    process.env[PARSE_BUDGET_ENV] = '40';
    const error: Error = await runWithExtractionBudget<string>(async () => {
      await new Promise(resolve => setTimeout(resolve, 300));
      return 'facts';
    }).then(() => new Error('did not overrun'), (e: unknown) => e as Error);
    // The MESSAGE is the only channel that survives an extraction worker's structured clone, and
    // it is what the builder reads to choose the reason code.
    expect(extractionBudgetOverrunMs(error.message)).toBe(40);
  });

  it('a disabled budget (0) opens no scope at all, so every checkpoint is inert', async () => {
    process.env[PARSE_BUDGET_ENV] = '0';
    const result = await runWithExtractionBudget(async () => {
      await new Promise(resolve => setTimeout(resolve, 50));
      checkExtractionBudget();
      return 'facts';
    });
    expect(result).toBe('facts');
  });

  it('records a wide-literal file as budget-exceeded, with no symbols and a disclosed reason', async () => {
    // END TO END through the builder: the reason code, the disclosure, and the missing symbols.
    // Measured, this file costs 637 ms to extract with the budget disabled, so a 100 ms budget is
    // overrun with ~6x of margin. WHICH phase overruns is not pinned here (the parse of a 390 KB
    // literal is itself a sizeable slice of that 637 ms) — the three tests above pin the post-parse
    // path directly. What this one proves is that an overrun reaches the artifact as
    // `budget-exceeded` and costs exactly one file.
    process.env[PARSE_BUDGET_ENV] = '100';
    const result = await new CallGraphBuilder({}).build([
      { path: 'src/gen.go', content: wideLiteralGo(64_000), language: 'Go' },
      { path: 'src/ok.go', content: 'package ok\n\nfunc A() { B() }\n\nfunc B() {}\n', language: 'Go' },
    ]);

    const health = result.parseHealthByFile?.get('src/gen.go');
    expect(health?.exclusion).toBe('budget-exceeded');
    expect(health?.parseFailed).toBe(true);
    // The BUDGET, not the spend: `parse-health.json` must be byte-identical across re-analyses.
    expect(health?.budgetMs).toBe(100);
    // Its symbols are MISSING from the graph — which is precisely why the record above has to be
    // there for any downstream conclusion to read.
    expect([...result.nodes.values()].some(n => n.filePath === 'src/gen.go')).toBe(false);

    // The bound costs one file, not the run.
    expect([...result.nodes.values()].some(n => n.name === 'A')).toBe(true);
    expect(result.parseHealthByFile?.has('src/ok.go')).toBe(false);
  }, 180_000);
});

// ---------------------------------------------------------------------------
// Why the existing guard missed this, and the guard that would not have
// ---------------------------------------------------------------------------

describe('no tree walk re-reads a children getter inside its own child loop', () => {
  /**
   * `parse-health.test.ts` already had "a wide ERROR node is walked in linear time", and it passed
   * while this shipped — for two reasons. It covers ONE walk (the parse-health tally), and it
   * guards a DIFFERENT hazard: `child(i)` rescanning from the first child. The three walks that
   * went quadratic here were tripped by re-evaluating the `namedChildren` GETTER per child, which
   * no test looked for and which a plain-object test node cannot even exhibit (an own array
   * property is not re-materialized). So the hazard is pinned structurally, across every walk.
   */
  it('indexes a hoisted array, never the getter', () => {
    const analyzerDir = fileURLToPath(new URL('.', import.meta.url));
    const walkFiles = [
      'http-route-parser.ts',
      'exception-flow.ts',
      'ast-children.ts',
      'call-graph.ts',
      'cfg.ts',
      'style-fingerprint.ts',
      'dynamic-boundary.ts',
      'symbol-content-hash.ts',
      'parse-health.ts',
    ];
    const getterInForHeader = /for \s*\([^;]*;[^;]*\.(?:namedChildren|children)\.length/;
    const getterIndexed = /\.(?:namedChildren|children)\[/;
    for (const file of walkFiles) {
      const lines = readFileSync(`${analyzerDir}${file}`, 'utf-8').split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (!getterInForHeader.test(lines[i])) continue;
        // The shape that cost 82 s: a `for` header reading the getter, and its body indexing the
        // getter again rather than a hoisted array. Three lines of body is the whole idiom.
        const body = lines.slice(i, i + 3).join('\n');
        expect(getterIndexed.test(body), `${file}:${i + 1} re-reads a children getter per child`)
          .toBe(false);
      }
    }
  });

  it('counts the materialization through the shared boundary, so a regression is measurable', async () => {
    // Non-vacuity for the linearity assertions above: the counter must actually move.
    expect(await childNodesMaterialized('package gen\n\nfunc A() { B() }\n\nfunc B() {}\n')).toBeGreaterThan(0);
  }, 60_000);
});
