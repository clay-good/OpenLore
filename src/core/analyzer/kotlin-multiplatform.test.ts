/**
 * Kotlin expect and actual declarations are linked
 * (change: add-kotlin-multiplatform-source-sets, issue #546).
 */
import { describe, expect, it } from 'vitest';
import { CallGraphBuilder } from './call-graph.js';
import { detectDuplicates } from './duplicate-detector.js';
import { DOMAIN_NOISE_DIRS } from './domain-naming.js';
import { kotlinSourceSet } from './kotlin-source.js';

async function build(files: Record<string, string>) {
  const list = Object.entries(files).map(([path, content]) => ({ path, content, language: 'Kotlin' }));
  const result = await new CallGraphBuilder().build(list);
  const edges = (kind: string) => result.edges.filter(e => (e.kind ?? 'calls') === kind).map(e => `${e.callerId} -> ${e.calleeId}`).sort();
  return { result, edges, list };
}

const COMMON = 'src/commonMain/kotlin/a/Clock.kt';
const JVM = 'src/jvmMain/kotlin/a/Clock.jvm.kt';
const IOS = 'src/iosMain/kotlin/a/Clock.ios.kt';

describe('Kotlin source sets', () => {
  it('reads the source set and the platform from the path', () => {
    expect(kotlinSourceSet(COMMON)).toEqual({ sourceSet: 'commonMain', platform: 'common' });
    expect(kotlinSourceSet(JVM)).toEqual({ sourceSet: 'jvmMain', platform: 'jvm' });
    expect(kotlinSourceSet(IOS)).toEqual({ sourceSet: 'iosMain', platform: 'apple' });
    expect(kotlinSourceSet('app/src/androidUnitTest/kotlin/T.kt')).toEqual({ sourceSet: 'androidUnitTest', platform: 'android' });
    expect(kotlinSourceSet('src/wasmJsMain/kotlin/W.kt')).toEqual({ sourceSet: 'wasmJsMain', platform: 'wasm' });
    expect(kotlinSourceSet('src/main/kotlin/M.kt')).toEqual({ sourceSet: 'main', platform: 'unknown' });
    expect(kotlinSourceSet('src/integrationTest/java/I.java')).toEqual({ sourceSet: 'integrationTest', platform: 'unknown' });
    expect(kotlinSourceSet('lib/Plain.kt')).toBeUndefined();
  });

  it('records them on nodes and treats source-set directories as domain noise', async () => {
    const { result } = await build({ [COMMON]: 'package a\nfun stamp() = 1\n' });
    expect(result.nodes.get(`${COMMON}::stamp`)).toMatchObject({ sourceSet: 'commonMain', platform: 'common' });
    for (const dir of ['commonmain', 'jvmmain', 'iosmain', 'androidunittest']) expect(DOMAIN_NOISE_DIRS.has(dir), dir).toBe(true);
  });
});

describe('expect and actual linking', () => {
  const files = {
    [COMMON]: 'package a\nexpect fun now(): Long\nfun stamp(): Long = now()\n',
    [JVM]: 'package a\nactual fun now(): Long = 1L\n',
    [IOS]: 'package a\nactual fun now(): Long = 0L\n',
  };

  it('joins each actual to its expect and makes the expect the binding target', async () => {
    const { result, edges } = await build(files);
    expect(edges('actualizes')).toEqual([`${COMMON}::now -> ${IOS}::now`, `${COMMON}::now -> ${JVM}::now`]);
    // The common caller binds the `expect` declaration: three declarations of one name in one
    // package are not an ambiguity.
    expect(edges('calls')).toEqual([`${COMMON}::stamp -> ${COMMON}::now`]);
    expect(result.multiplatform).toEqual({ linked: 1, unmatchedExpectCount: 0, unmatchedActualCount: 0, unmatchedExpect: [], unmatchedActual: [] });
    expect(result.nodes.get(`${JVM}::now`)?.platformVariantOf).toBe(`${COMMON}::now`);
  });

  it('binds a cross-file call to an expect function without an ambiguity refusal', async () => {
    const { edges, result } = await build({ ...files, 'src/commonMain/kotlin/a/Use.kt': 'package a\nfun use() = now()\n', 'src/commonMain/kotlin/b/Far.kt': 'package b\nimport a.now\nfun far() = now()\n' });
    expect(edges('calls')).toContain(`src/commonMain/kotlin/a/Use.kt::use -> ${COMMON}::now`);
    expect(edges('calls')).toContain(`src/commonMain/kotlin/b/Far.kt::far -> ${COMMON}::now`);
    expect(result.ambiguousSites ?? []).toEqual([]);
  });

  it('lets reachability flow forward to every actual and impact flow back to the callers of the expect', async () => {
    const { result } = await build(files);
    const forward = new Map<string, string[]>();
    const backward = new Map<string, string[]>();
    for (const e of result.edges) {
      forward.set(e.callerId, [...(forward.get(e.callerId) ?? []), e.calleeId]);
      backward.set(e.calleeId, [...(backward.get(e.calleeId) ?? []), e.callerId]);
    }
    const reach = (start: string, graph: Map<string, string[]>): Set<string> => {
      const seen = new Set<string>([start]);
      const queue = [start];
      while (queue.length) for (const next of graph.get(queue.pop()!) ?? []) if (!seen.has(next)) { seen.add(next); queue.push(next); }
      return seen;
    };
    expect(reach(`${COMMON}::stamp`, forward).has(`${JVM}::now`)).toBe(true);
    expect(reach(`${COMMON}::stamp`, forward).has(`${IOS}::now`)).toBe(true);
    expect(reach(`${JVM}::now`, backward).has(`${COMMON}::stamp`)).toBe(true);
  });

  it('counts an unmatched expect and an unmatched actual in the receipt, as no error', async () => {
    const { result, edges } = await build({
      [COMMON]: 'package a\nexpect fun lonely(): Int\n',
      [JVM]: 'package a\nactual fun orphan(): Int = 1\n',
    });
    expect(edges('actualizes')).toEqual([]);
    expect(result.multiplatform).toEqual({
      linked: 0, unmatchedExpectCount: 1, unmatchedActualCount: 1,
      unmatchedExpect: [`${COMMON}::lonely`], unmatchedActual: [`${JVM}::orphan`],
    });
  });

  it('links the members of an expect class to the members of its actual class', async () => {
    const { edges } = await build({
      [COMMON]: 'package a\nexpect class Clock() {\n  fun now(): Long\n}\nfun stamp(c: Clock) = c.now()\n',
      [JVM]: 'package a\nactual class Clock actual constructor() {\n  actual fun now(): Long = 1L\n}\n',
    });
    expect(edges('actualizes')).toContain(`${COMMON}::Clock.now -> ${JVM}::Clock.now`);
    expect(edges('calls')).toContain(`${COMMON}::stamp -> ${COMMON}::Clock.now`);
  });

  it('links an expect class to the target of an actual typealias', async () => {
    const { edges } = await build({
      [COMMON]: 'package a\nexpect class Lock() {\n  fun acquire()\n}\n',
      [JVM]: 'package a\nactual typealias Lock = JvmLock\nclass JvmLock {\n  fun acquire() {}\n}\n',
    });
    expect(edges('actualizes')).toContain(`${COMMON}::Lock.acquire -> ${JVM}::JvmLock.acquire`);
  });

  it('does not report an expect and actual pair, or sibling actuals, as clones', async () => {
    const body = (v: number) => `{\n  val a = ${v}\n  val b = a + 1\n  val c = b * 2\n  val d = c - 3\n  val e = d + a\n  return e + b + c + d\n}\n`;
    const { result, list } = await build({
      [COMMON]: 'package a\nexpect fun compute(): Int\n',
      [JVM]: `package a\nactual fun compute(): Int ${body(1)}`,
      [IOS]: `package a\nactual fun compute(): Int ${body(1)}`,
      'src/jvmMain/kotlin/a/Copy.kt': `package a\nfun copied(): Int ${body(1)}\nfun copiedAgain(): Int ${body(1)}`,
    });
    const groups = detectDuplicates(list, result).cloneGroups;
    const names = groups.map(g => g.instances.map(i => i.functionName).sort());
    // The two identical `actual` bodies are not a clone group; the genuine copies still are.
    expect(names).toEqual([['copied', 'copiedAgain']]);
    // Without the link they would be reported: the same two bodies with no `expect` are clones.
    const unlinked = await build({
      [JVM]: `package a\nfun compute(): Int ${body(1)}`,
      [IOS]: `package a\nfun compute(): Int ${body(1)}`,
    });
    expect(detectDuplicates(unlinked.list, unlinked.result).cloneGroups).toHaveLength(1);
  });
});
