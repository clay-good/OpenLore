import { describe, it, expect } from 'vitest';
import {
  extractExceptionFactsFromSource,
  getExceptionParser,
  innermostGuard,
  enclosingGuards,
  guardCatches,
  guardsCatch,
  DYNAMIC_TYPE,
  ERROR_PROPAGATION_LANGUAGES,
  extractGoErrorFactsFromSource,
  resolveCurrentFunctionSpan,
  type TryGuard,
} from './exception-flow.js';

describe('extractExceptionFacts — TypeScript', () => {
  it('parses TSX without regressing TypeScript angle-bracket assertions', async () => {
    const tsxParser = await getExceptionParser('TypeScript', 'src/View.tsx');
    const tsParser = await getExceptionParser('TypeScript', 'src/cast.ts');

    expect(tsxParser?.parse('const View = () => <section />;').rootNode.hasError).toBe(false);
    expect(tsParser?.parse('const value = <Widget>input;').rootNode.hasError).toBe(false);
  });

  it('extracts exception facts from a TSX function through the source API', async () => {
    const facts = await extractExceptionFactsFromSource(
      'function View() { risky(); if (bad) throw new RenderError(); return <button>Go</button>; }',
      'TypeScript',
      'src/View.tsx',
    );

    expect(facts.throwSites).toEqual([
      expect.objectContaining({ type: 'RenderError', locallyHandled: false }),
    ]);
    expect(facts.callSites.map(site => site.calleeName)).toContain('risky');
  });

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

describe('extractExceptionFacts — adversarial soundness (regression for review findings)', () => {
  it('a throw in an outer catch body is NOT marked handled by an inner one-line try on the same line', async () => {
    // Review CRITICAL #1: line-based containment falsely marked this `throw new GiveUp()`
    // (in the OUTER catch body) as handled because it shares line 5 with the inner try body.
    const facts = await extractExceptionFactsFromSource(
      [
        'function f() {',
        '  try {',
        '    a();',
        '  } catch (e) {',
        '    try { recover(); } catch { /* swallow */ } throw new GiveUp();',
        '  }',
        '}',
      ].join('\n'),
      'TypeScript',
    );
    const giveUp = facts.throwSites.find(t => t.type === 'GiveUp')!;
    expect(giveUp).toBeTruthy();
    expect(giveUp.locallyHandled).toBe(false); // it ESCAPES f
  });

  it('an inner typed except does NOT shadow an outer catch-all (nested-guard walk)', async () => {
    const facts = await extractExceptionFactsFromSource(
      [
        'def g():',
        '    try:',
        '        try:',
        '            raise ValueError("x")',
        '        except KeyError:',
        '            pass',
        '    except Exception:',
        '        pass',
      ].join('\n'),
      'Python',
    );
    // ValueError is not caught by the inner `except KeyError`, but IS caught by the outer
    // `except Exception` — so it does not escape g.
    expect(facts.throwSites.find(t => t.type === 'ValueError')!.locallyHandled).toBe(true);
  });

  it('peels TS wrappers around a thrown new-expression', async () => {
    const paren = await extractExceptionFactsFromSource('function f() {\n  throw (new RangeError("x"));\n}', 'TypeScript');
    expect(paren.throwSites[0].type).toBe('RangeError');
    const asExpr = await extractExceptionFactsFromSource('function f() {\n  throw new RangeError("x") as Error;\n}', 'TypeScript');
    expect(asExpr.throwSites[0].type).toBe('RangeError');
  });

  it('collects call sites with their enclosing guards (byte-precise)', async () => {
    const facts = await extractExceptionFactsFromSource(
      'function f() {\n  try { risky(); } catch {} safe();\n}',
      'TypeScript',
    );
    const risky = facts.callSites.find(c => c.calleeName === 'risky')!;
    const safe = facts.callSites.find(c => c.calleeName === 'safe')!;
    // `risky()` is inside the try body (guarded, catch-all); `safe()` is after it on the
    // same line (NOT guarded) — byte containment distinguishes them where lines cannot.
    expect(risky.guards.length).toBe(1);
    expect(risky.guards[0].catchAll).toBe(true);
    expect(safe.guards.length).toBe(0);
  });
});

describe('extractExceptionFacts — fail-soft + determinism', () => {
  it('Go is claimed through its separate value-flow model, not exception facts', async () => {
    const facts = await extractExceptionFactsFromSource(
      `func f() error { return errors.New("x") }`,
      'Go',
    );
    expect(facts.supported).toBe(false);
    expect(facts.throwSites).toEqual([]);
    expect(facts.tryGuards).toEqual([]);
    expect(ERROR_PROPAGATION_LANGUAGES.has('Go')).toBe(true);
  });

  it('is deterministic across runs', async () => {
    const src = `function f() {\n  try { throw new A(); } catch { throw new B(); }\n}`;
    const a = await extractExceptionFactsFromSource(src, 'TypeScript');
    const b = await extractExceptionFactsFromSource(src, 'TypeScript');
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe('extractGoErrorFacts — value-shaped Go semantics', () => {
  it('separates returned errors, checked errors, panic, recovery, and discarded results', async () => {
    const returned = await extractGoErrorFactsFromSource(`package p\nfunc f() error { err := g(); if err != nil { return err }; return nil }`);
    expect(returned.escapes).toEqual([expect.objectContaining({ value: 'err', kind: 'returned_error', calleeName: 'g' })]);

    const handled = await extractGoErrorFactsFromSource(`package p\nfunc f() { err := g(); if err != nil { log.Print(err) } }`);
    expect(handled.handledInternally).toEqual([]);
    expect(handled.checkedCandidates).toEqual([expect.objectContaining({ value: 'err', kind: 'checked_error', fromCallee: 'g', callResultIndex: 0 })]);

    const recovered = await extractGoErrorFactsFromSource(`package p\nfunc f() { defer func(){ recover() }(); panic("x"); _ = g() }`);
    expect(recovered.escapes).toEqual([]);
    expect(recovered.handledInternally.some(h => h.kind === 'recovered_panic')).toBe(true);
    expect(recovered.discardedResults).toEqual([expect.objectContaining({ calleeName: 'g', resultIndex: 0 })]);
  });

  it('does not treat a non-deferred recover as shielding panic', async () => {
    const facts = await extractGoErrorFactsFromSource(`package p\nfunc f() { recover(); panic("x") }`);
    expect(facts.escapes).toEqual([expect.objectContaining({ kind: 'panic' })]);
  });

  it('does not treat defer recover() or a conditionally unreachable recover as effective', async () => {
    for (const source of [
      `package p\nfunc f() { defer recover(); panic("x") }`,
      `package p\nfunc f() { defer func(){ if false { recover() } }(); panic("x") }`,
      `package p\nfunc f() { defer func(){ for false { recover() } }(); panic("x") }`,
      `package p\nfunc f() { defer func(){ _ = func(){ recover() } }(); panic("x") }`,
    ]) {
      const facts = await extractGoErrorFactsFromSource(source);
      expect(facts.escapes).toEqual([expect.objectContaining({ kind: 'panic' })]);
    }
  });

  it('attributes deferred literal panics to the enclosing function and bounds goroutine panics', async () => {
    const deferred = await extractGoErrorFactsFromSource(`package p\nfunc f() { defer func(){ panic("deferred") }() }`);
    expect(deferred.escapes).toEqual([expect.objectContaining({ kind: 'panic', value: '("deferred")' })]);
    const async = await extractGoErrorFactsFromSource(`package p\nfunc f() { go func(){ panic("async") }() }`);
    expect(async.escapes).toEqual([]);
    expect(async.boundaries.some(b => /goroutine literal.*asynchronous/.test(b))).toBe(true);
  });

  it('does not call an error handled when it is returned after the check', async () => {
    const facts = await extractGoErrorFactsFromSource(`package p\nfunc f() error { err := g(); if err != nil { log.Print(err) }; return err }`);
    expect(facts.escapes).toEqual([expect.objectContaining({ kind: 'returned_error', value: 'err' })]);
    expect(facts.checkedCandidates).toEqual([]);
  });

  it('tracks the error result position instead of relying on an err variable name', async () => {
    const facts = await extractGoErrorFactsFromSource(`package p\nfunc f() (int, error) { failure := g(); return 1, failure }`);
    expect(facts.escapes).toEqual([expect.objectContaining({ value: 'failure', kind: 'returned_error', calleeName: 'g' })]);
  });

  it('does not call a wrapped return or panic(err) internally handled', async () => {
    for (const action of ['return fmt.Errorf("wrap: %w", err)', 'panic(err)']) {
      const facts = await extractGoErrorFactsFromSource(`package p\nfunc f() error { err := g(); if err != nil { ${action} }; return nil }`);
      expect(facts.checkedCandidates).toEqual([]);
    }
  });

  it('does not prove recovery after the panic, with repanic, or with competing defers', async () => {
    for (const source of [
      `package p\nfunc f() { panic("x"); defer func(){ recover() }() }`,
      `package p\nfunc f() { defer func(){ recover(); panic("replacement") }(); panic("x") }`,
      `package p\nfunc f() { defer cleanup(); defer func(){ recover() }(); panic("x") }`,
    ]) {
      const facts = await extractGoErrorFactsFromSource(source);
      expect(facts.escapes.some(e => e.kind === 'panic')).toBe(true);
      expect(facts.boundaries.length).toBeGreaterThan(0);
    }
  });

  it('discloses a named custom result type instead of treating it as error-free', async () => {
    const facts = await extractGoErrorFactsFromSource(`package p\ntype Failure error\nfunc f() Failure { return nil }`);
    expect(facts.boundaries.some(b => /custom Go result type Failure/.test(b))).toBe(true);
  });

  it('tracks lexical shadowing, assignment invalidation, and named-result bare returns', async () => {
    const shadowed = await extractGoErrorFactsFromSource(`package p\nfunc f() error { err := g(); { err := h(); _ = err }; return err }`);
    expect(shadowed.escapes).toEqual([expect.objectContaining({ calleeName: 'g' })]);

    const overwritten = await extractGoErrorFactsFromSource(`package p\nfunc f() error { err := g(); err = nil; return err }`);
    expect(overwritten.escapes).toEqual([]);

    const named = await extractGoErrorFactsFromSource(`package p\nfunc f() (err error) { err = g(); return }`);
    expect(named.escapes).toEqual([expect.objectContaining({ value: 'err', calleeName: 'g' })]);
    expect(named.boundaries.some(b => /bare return/.test(b))).toBe(false);
  });

  it('pairs independent RHS calls separately from one multi-result call', async () => {
    const independent = await extractGoErrorFactsFromSource(`package p\nfunc f() error { _, err := value(), makeErr(); return err }`);
    expect(independent.escapes).toEqual([expect.objectContaining({ calleeName: 'makeErr', callResultIndex: 0 })]);
    expect(independent.discardedResults).toEqual([expect.objectContaining({ calleeName: 'value', resultIndex: 0 })]);

    const multi = await extractGoErrorFactsFromSource(`package p\nfunc f() error { _, err := pair(); return err }`);
    expect(multi.escapes).toEqual([expect.objectContaining({ calleeName: 'pair', callResultIndex: 1 })]);
  });

  it('does not promote an unregistered conditional defer panic and honors simple LIFO replacement', async () => {
    const conditional = await extractGoErrorFactsFromSource(`package p\nfunc f() { if false { defer func(){ panic("x") }() } }`);
    expect(conditional.escapes).toEqual([]);
    expect(conditional.boundaries.some(b => /not proven registered/.test(b))).toBe(true);

    const replacement = await extractGoErrorFactsFromSource(`package p\nfunc f() { defer func(){panic("first")}(); defer func(){panic("second")}(); panic("body") }`);
    expect(replacement.escapes).toEqual([expect.objectContaining({ value: '("first")' })]);
    expect(replacement.boundaries.some(b => /LIFO replacement/.test(b))).toBe(false);
  });

  it('models only trivial proven LIFO recovery and panic ordering', async () => {
    const recovered = await extractGoErrorFactsFromSource(`package p\nfunc f() { defer func(){ recover() }(); defer func(){ panic("later") }() }`);
    expect(recovered.escapes).toEqual([]);
    expect(recovered.handledInternally).toEqual([expect.objectContaining({ kind: 'recovered_panic', value: '("later")' })]);

    const escapes = await extractGoErrorFactsFromSource(`package p\nfunc f() { defer func(){ panic("last") }(); defer func(){ recover() }() }`);
    expect(escapes.escapes).toEqual([expect.objectContaining({ kind: 'panic', value: '("last")' })]);

    const bodyThenReplacement = await extractGoErrorFactsFromSource(`package p\nfunc f() { defer func(){ panic("last") }(); defer func(){ recover() }(); panic("body") }`);
    expect(bodyThenReplacement.escapes).toEqual([expect.objectContaining({ value: '("last")' })]);
    expect(bodyThenReplacement.handledInternally).toEqual([expect.objectContaining({ value: '("body")' })]);
  });

  it('returns a parse-degraded boundary instead of facts from malformed Go', async () => {
    const facts = await extractGoErrorFactsFromSource(`package p\nfunc f() error { err := g(); return err`);
    expect(facts.escapes).toEqual([]);
    expect(facts.boundaries.some(b => /syntax errors/.test(b))).toBe(true);
  });
});

describe('extractExceptionFacts — Java and C#', () => {
  it('extracts Java throws declarations and selects the matching catch clause independently', async () => {
    const declared = await extractExceptionFactsFromSource(`class C { void f() throws IOException { throw new IOException(); } }`, 'Java');
    expect(declared.throwSites).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'IOException', source: 'throws_clause' }),
      expect.objectContaining({ type: 'IOException', source: 'throw' }),
    ]));
    const caught = await extractExceptionFactsFromSource(`class C { void f(){ try { throw new IOException(); } catch(IOException e){} catch(Other e){ throw e; } } }`, 'Java');
    expect(caught.throwSites.find(s => s.type === 'IOException')?.locallyHandled).toBe(true);
  });

  it('distinguishes replacement throws from rethrowing the caught exception', async () => {
    for (const [language, source, original, replacement] of [
      ['Java', `class C { void f(){ try { throw new IOException(); } catch(IOException e){ throw new RuntimeException(); } } }`, 'IOException', 'RuntimeException'],
      ['C#', `class C { void F(){ try { throw new IOException(); } catch(IOException e){ throw new InvalidOperationException(); } } }`, 'IOException', 'InvalidOperationException'],
      ['TypeScript', `function f(){ try { throw new OldError(); } catch(e) { throw new NewError(); } }`, 'OldError', 'NewError'],
      ['Python', `def f():\n    try:\n        raise OldError()\n    except OldError as e:\n        raise NewError()\n`, 'OldError', 'NewError'],
    ] as const) {
      const facts = await extractExceptionFactsFromSource(source, language);
      expect(facts.throwSites.find(s => s.type === original)?.locallyHandled, language).toBe(true);
      expect(facts.throwSites.find(s => s.type === replacement)?.locallyHandled, language).toBe(false);
    }
    const javaRethrow = await extractExceptionFactsFromSource(`class C { void f(){ try { throw new IOException(); } catch(IOException e){ throw e; } } }`, 'Java');
    expect(javaRethrow.throwSites.find(s => s.type === 'IOException')?.locallyHandled).toBe(false);
    const csharpBare = await extractExceptionFactsFromSource(`class C { void F(){ try { throw new IOException(); } catch(IOException e){ throw; } } }`, 'C#');
    expect(csharpBare.throwSites.find(s => s.type === 'IOException')?.locallyHandled).toBe(false);
  });

  it('does not claim that a filtered C# catch always handles', async () => {
    const facts = await extractExceptionFactsFromSource(`class C { void F(){ try { throw new IOException(); } catch(IOException e) when (e.Code > 0) {} } }`, 'C#');
    expect(facts.throwSites.find(s => s.type === 'IOException')?.locallyHandled).toBe(false);
  });

  it('does not treat Java Exception as catching Error subclasses', async () => {
    const facts = await extractExceptionFactsFromSource(`class C { void f(){ try { throw new AssertionError(); } catch(Exception e){} } }`, 'Java');
    expect(facts.throwSites.find(s => s.type === 'AssertionError')?.locallyHandled).toBe(false);
  });

  it('discloses finally control transfer and try-with-resources cleanup boundaries', async () => {
    const java = await extractExceptionFactsFromSource(`class C { void f(){ try (R r = open()) { risky(); } finally { return; } } }`, 'Java');
    expect(java.boundaries).toEqual(expect.arrayContaining([expect.stringMatching(/finally/), expect.stringMatching(/try-with-resources/) ]));
    const cs = await extractExceptionFactsFromSource(`class C { void F(){ try { Risky(); } finally { return; } } }`, 'C#');
    expect(cs.boundaries.some(b => /finally/.test(b))).toBe(true);
    const csUsing = await extractExceptionFactsFromSource(`class C { async Task F(){ await using var r = Open(); await Risky(); } }`, 'C#');
    expect(csUsing.boundaries.some(b => /using\/await-using cleanup/.test(b))).toBe(true);
  });

  it('classifies Java/C# self calls and constructors for unresolved-boundary handling', async () => {
    const java = await extractExceptionFactsFromSource(`class C { void f(){ this.risky(); new Risky(); } }`, 'Java');
    expect(java.callSites.map(c => c.receiver)).toEqual(['self', 'constructor']);
    const cs = await extractExceptionFactsFromSource(`class C { void F(){ this.Risky(); new Risky(); } }`, 'C#');
    expect(cs.callSites.map(c => c.receiver)).toEqual(['self', 'constructor']);
  });

  it('suppresses try-body escapes when a finally definitely completes abruptly', async () => {
    const java = await extractExceptionFactsFromSource(`class C { int f(){ try { throw new IOException(); } finally { return 1; } } }`, 'Java');
    expect(java.throwSites.find(s => s.type === 'IOException')?.locallyHandled).toBe(true);

    const cs = await extractExceptionFactsFromSource(`class C { void F(){ try { throw new IOException(); } finally { throw new OtherException(); } } }`, 'C#');
    expect(cs.throwSites.find(s => s.type === 'IOException')?.locallyHandled).toBe(true);
    expect(cs.throwSites.find(s => s.type === 'OtherException')?.locallyHandled).toBe(false);
  });

  it('returns a parse-degraded boundary instead of a clean malformed Java result', async () => {
    const facts = await extractExceptionFactsFromSource(`class C { void f(){ try { risky(); }`, 'Java');
    expect(facts.throwSites).toEqual([]);
    expect(facts.boundaries.some(b => /syntax errors/.test(b))).toBe(true);
  });
});

describe('extractExceptionFacts — call-site receiver classification', () => {
  it('classifies TS this./super. as self, obj. as other, bare as none', async () => {
    const facts = await extractExceptionFactsFromSource(
      `class K {\n  m() {\n    this.a();\n    super.b();\n    obj.c();\n    d();\n  }\n}`,
      'TypeScript',
    );
    const r = (name: string) => facts.callSites.find(c => c.calleeName === name)?.receiver;
    expect(r('a')).toBe('self');
    expect(r('b')).toBe('self');
    expect(r('c')).toBe('other');
    expect(r('d')).toBe('none');
  });

  it('classifies Python self./cls. as self, obj. as other, bare as none', async () => {
    const facts = await extractExceptionFactsFromSource(
      `class K:\n    def m(self):\n        self.a()\n        cls.b()\n        obj.c()\n        d()\n`,
      'Python',
    );
    const r = (name: string) => facts.callSites.find(c => c.calleeName === name)?.receiver;
    expect(r('a')).toBe('self');
    expect(r('b')).toBe('self');
    expect(r('c')).toBe('other');
    expect(r('d')).toBe('none');
  });
});

describe('extractExceptionFacts — hostile AST bounds', () => {
  it('re-resolves assignment-defined TS/JS function identities used by the call graph', async () => {
    const parser = await getExceptionParser('JavaScript', 'handlers.js');
    expect(parser).toBeTruthy();
    for (const [source, name] of [
      [`h = () => { throw new Error("x") }`, 'h'],
      [`exports.h = function() { throw new Error("x") }`, 'exports.h'],
      [`class C { h = () => { throw new Error("x") } }`, 'h'],
    ] as const) {
      const tree = parser!.parse(source);
      expect(resolveCurrentFunctionSpan(tree.rootNode, 0, source.length, 'JavaScript', name), source).not.toBeNull();
    }
  });

  it('fails soft when a Go function exceeds the traversal-depth budget', async () => {
    const depth = 600;
    const source = `package p\nfunc f() error {\n${'{\n'.repeat(depth)}return nil\n${'}\n'.repeat(depth + 1)}`;

    const facts = await extractGoErrorFactsFromSource(source);

    expect(facts.escapes).toEqual([]);
    expect(facts.boundaries.some(boundary => /traversal budget/.test(boundary))).toBe(true);
  });
});

describe('guard helpers', () => {
  // outer catch-all spans bytes [0,200]; inner typed `except KeyError` spans [50,80].
  const outer: TryGuard = { fromLine: 1, toLine: 20, fromIndex: 0, toIndex: 200, catchAll: true, caughtTypes: [], rethrows: false };
  const inner: TryGuard = { fromLine: 5, toLine: 8, fromIndex: 50, toIndex: 80, catchAll: false, caughtTypes: ['KeyError'], rethrows: false };

  it('innermostGuard picks the smallest enclosing byte span', () => {
    expect(innermostGuard([outer, inner], 60)).toBe(inner);
    expect(innermostGuard([outer, inner], 150)).toBe(outer);
    expect(innermostGuard([outer, inner], 999)).toBeNull();
  });

  it('enclosingGuards returns ALL enclosing guards innermost-first', () => {
    expect(enclosingGuards([outer, inner], 60)).toEqual([inner, outer]);
    expect(enclosingGuards([outer, inner], 150)).toEqual([outer]);
  });

  it('guardCatches honors catch-all, typed match, and <dynamic>', () => {
    expect(guardCatches(outer, 'Anything')).toBe(true);
    expect(guardCatches(outer, DYNAMIC_TYPE)).toBe(true);
    expect(guardCatches(inner, 'KeyError')).toBe(true);
    expect(guardCatches(inner, 'ValueError')).toBe(false);
    expect(guardCatches(inner, DYNAMIC_TYPE)).toBe(false);
    expect(guardCatches({ ...outer, rethrows: true }, 'Anything')).toBe(false);
  });

  it('guardsCatch: an inner non-matching guard does NOT shadow an outer catch-all', () => {
    // ValueError at byte 60 is inside inner (except KeyError, no match) AND outer (catch-all).
    expect(guardsCatch(enclosingGuards([outer, inner], 60), 'ValueError')).toBe(true);
    // With only the inner typed guard, ValueError is not caught.
    expect(guardsCatch(enclosingGuards([inner], 60), 'ValueError')).toBe(false);
  });
});
