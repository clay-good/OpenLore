import { describe, it, expect } from 'vitest';
import {
  extractExceptionFactsFromSource,
  innermostGuard,
  guardCatches,
  DYNAMIC_TYPE,
  ERROR_PROPAGATION_LANGUAGES,
  type TryGuard,
} from './exception-flow.js';

describe('extractExceptionFacts — TypeScript', () => {
  it('reports a direct, un-caught throw with its constructed type', async () => {
    const facts = await extractExceptionFactsFromSource(
      `function f() {\n  throw new RangeError("bad");\n}`,
      'TypeScript',
    );
    expect(facts.supported).toBe(true);
    expect(facts.throwSites).toHaveLength(1);
    expect(facts.throwSites[0]).toMatchObject({ type: 'RangeError', locallyHandled: false });
  });

  it('marks a throw inside a catching try as locally handled', async () => {
    const facts = await extractExceptionFactsFromSource(
      `function f() {\n  try {\n    throw new TypeError("x");\n  } catch (e) {\n    return 1;\n  }\n}`,
      'TypeScript',
    );
    expect(facts.throwSites).toHaveLength(1);
    expect(facts.throwSites[0].type).toBe('TypeError');
    expect(facts.throwSites[0].locallyHandled).toBe(true);
    expect(facts.tryGuards).toHaveLength(1);
    expect(facts.tryGuards[0].catchAll).toBe(true);
    expect(facts.tryGuards[0].rethrows).toBe(false);
  });

  it('a re-throwing catch does not handle the throw (it escapes)', async () => {
    const facts = await extractExceptionFactsFromSource(
      `function f() {\n  try {\n    throw new TypeError("x");\n  } catch (e) {\n    throw e;\n  }\n}`,
      'TypeScript',
    );
    // The try-body throw + the re-throw in the catch body are both throw sites.
    const tryGuard = facts.tryGuards[0];
    expect(tryGuard.rethrows).toBe(true);
    // The try-body throw is NOT locally handled because the handler re-throws.
    const inTry = facts.throwSites.find(t => t.type === 'TypeError')!;
    expect(inTry.locallyHandled).toBe(false);
    // The re-throw is a <dynamic> throw site in the catch body (not guarded).
    expect(facts.throwSites.some(t => t.type === DYNAMIC_TYPE)).toBe(true);
  });

  it('resolves a qualified constructor to its final name', async () => {
    const facts = await extractExceptionFactsFromSource(
      `function f() {\n  throw new errors.MyError();\n}`,
      'TypeScript',
    );
    expect(facts.throwSites[0].type).toBe('MyError');
  });

  it('a thrown variable is <dynamic>, not a guessed type', async () => {
    const facts = await extractExceptionFactsFromSource(
      `function f(e: unknown) {\n  throw e;\n}`,
      'TypeScript',
    );
    expect(facts.throwSites[0].type).toBe(DYNAMIC_TYPE);
    expect(facts.dynamicThrowCount).toBe(1);
  });

  it('attributes a throw inside a nested closure to the closure, not the function', async () => {
    const facts = await extractExceptionFactsFromSource(
      `function f(xs: number[]) {\n  xs.forEach(x => {\n    throw new Error("nested");\n  });\n  throw new RangeError("own");\n}`,
      'TypeScript',
    );
    // Only the function's own throw is reported; the nested-closure throw is excluded.
    expect(facts.throwSites.map(t => t.type)).toEqual(['RangeError']);
  });
});

describe('extractExceptionFacts — Python', () => {
  it('reports a raised call type and a bare class name', async () => {
    const facts = await extractExceptionFactsFromSource(
      `def g():\n    raise ValueError("x")\n    raise RuntimeError`,
      'Python',
    );
    expect(facts.supported).toBe(true);
    expect(facts.throwSites.map(t => t.type)).toEqual(['ValueError', 'RuntimeError']);
  });

  it('a bare re-raise is <dynamic>', async () => {
    const facts = await extractExceptionFactsFromSource(
      `def g():\n    try:\n        risky()\n    except Exception:\n        raise`,
      'Python',
    );
    const raise = facts.throwSites.find(t => t.type === DYNAMIC_TYPE);
    expect(raise).toBeTruthy();
  });

  it('a typed except catches the matching type but not others', async () => {
    const facts = await extractExceptionFactsFromSource(
      `def g():\n    try:\n        raise ValueError("x")\n    except KeyError:\n        pass`,
      'Python',
    );
    const guard = facts.tryGuards[0];
    expect(guard.catchAll).toBe(false);
    expect(guard.caughtTypes).toEqual(['KeyError']);
    // ValueError is raised in the try body but the handler only catches KeyError →
    // it is NOT locally handled.
    expect(facts.throwSites.find(t => t.type === 'ValueError')!.locallyHandled).toBe(false);
  });

  it('a tuple except and Exception catch-all are recognized', async () => {
    const facts = await extractExceptionFactsFromSource(
      `def g():\n    try:\n        raise ValueError("x")\n    except (KeyError, IndexError):\n        pass\n    except Exception:\n        pass`,
      'Python',
    );
    const guard = facts.tryGuards[0];
    expect(guard.catchAll).toBe(true); // the Exception clause makes it catch-all
    expect(guard.caughtTypes).toEqual(expect.arrayContaining(['KeyError', 'IndexError']));
    // ValueError is now caught (catch-all) → locally handled.
    expect(facts.throwSites.find(t => t.type === 'ValueError')!.locallyHandled).toBe(true);
  });

  it('raise of a lowercase instance is <dynamic>', async () => {
    const facts = await extractExceptionFactsFromSource(
      `def g(err):\n    raise err`,
      'Python',
    );
    expect(facts.throwSites[0].type).toBe(DYNAMIC_TYPE);
  });
});

describe('extractExceptionFacts — fail-soft + determinism', () => {
  it('an unsupported language returns an unsupported record, not a guess', async () => {
    const facts = await extractExceptionFactsFromSource(
      `func f() error { return errors.New("x") }`,
      'Go',
    );
    expect(facts.supported).toBe(false);
    expect(facts.throwSites).toEqual([]);
    expect(facts.tryGuards).toEqual([]);
    expect(ERROR_PROPAGATION_LANGUAGES.has('Go')).toBe(false);
  });

  it('is deterministic across runs', async () => {
    const src = `function f() {\n  try { throw new A(); } catch { throw new B(); }\n}`;
    const a = await extractExceptionFactsFromSource(src, 'TypeScript');
    const b = await extractExceptionFactsFromSource(src, 'TypeScript');
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe('guard helpers', () => {
  const outer: TryGuard = { fromLine: 1, toLine: 20, catchAll: true, caughtTypes: [], rethrows: false };
  const inner: TryGuard = { fromLine: 5, toLine: 8, catchAll: false, caughtTypes: ['KeyError'], rethrows: false };

  it('innermostGuard picks the smallest enclosing span', () => {
    expect(innermostGuard([outer, inner], 6)).toBe(inner);
    expect(innermostGuard([outer, inner], 15)).toBe(outer);
    expect(innermostGuard([outer, inner], 99)).toBeNull();
  });

  it('guardCatches honors catch-all, typed match, and <dynamic>', () => {
    expect(guardCatches(outer, 'Anything')).toBe(true);
    expect(guardCatches(outer, DYNAMIC_TYPE)).toBe(true);
    expect(guardCatches(inner, 'KeyError')).toBe(true);
    expect(guardCatches(inner, 'ValueError')).toBe(false);
    expect(guardCatches(inner, DYNAMIC_TYPE)).toBe(false);
    expect(guardCatches({ ...outer, rethrows: true }, 'Anything')).toBe(false);
  });
});
