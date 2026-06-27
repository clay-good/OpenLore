# analyzer spec delta

## ADDED Requirements

### Requirement: PerFunctionExceptionExtraction

The analyzer SHALL provide a deterministic, per-function exception extractor that, given a function's
source span and language, returns the function's static exception facts without an LLM and without a
new persisted artifact. The extractor SHALL support the languages whose throw and catch semantics are
cleanly statically extractable — **TypeScript, JavaScript, Python** — and SHALL fail soft for every
other language (returning a record marked unsupported with no facts, never a guess). The supported set
SHALL be the single authoritative source from which the declarative language-support registry derives
the `errorPropagation` capability, so the registry cannot over-claim.

For a supported function the extractor SHALL report:

- **throw sites** — each direct `throw` / `raise` in the function body, with the constructed exception
  type (or `<dynamic>` when the thrown value's static type is unknowable, e.g. a bare re-raise), the
  line, and whether the throw is caught by an enclosing handler within the same function;
- **try regions** — for each `try` in the body, the span its guarded block covers, whether its
  handler is a catch-all (every TypeScript/JavaScript `catch`; Python bare `except` /
  `except Exception` / `except BaseException`), the exact exception type names a typed Python `except`
  matches, and whether the handler re-throws (a re-throwing handler does not swallow);
- **call sites** — each call in the body, with the callee name as written, the line, the enclosing
  `try` guards (innermost first), and how the callee is addressed: `self` for an intra-object call
  (TS/JS `this.`/`super.`, Python `self.`/`cls.`), `other` for a member call on any other receiver,
  or `none` for a bare call. The `self` classification lets the propagation tool disclose an
  intra-object call the call graph could not resolve — the one call shape that otherwise gets no edge
  at all — rather than silently treating it as exception-free.

The extractor SHALL NOT descend into nested closures or nested function definitions: a throw inside a
nested function is attributed to that nested function, not the enclosing one — consistent with the CFG
overlay's treatment of nested scopes. The extractor SHALL reuse the per-language throw / try node-type
knowledge already encoded in the CFG `SPECS` table rather than introducing a second grammar
description.

The extraction SHALL be deterministic: the same source span and language yield byte-identical facts on
every run.

#### Scenario: A directly-thrown, un-caught exception is reported as a throw site

- **GIVEN** a TypeScript function whose body contains `throw new RangeError(...)` outside any `try`
- **WHEN** the extractor runs on that function's span
- **THEN** it reports a throw site with type `RangeError` marked not locally handled

#### Scenario: A throw wrapped in a catching try is marked locally handled

- **GIVEN** a function that throws inside a `try` whose handler catches without re-throwing
- **WHEN** the extractor runs
- **THEN** the throw site is marked locally handled, so it does not escape the function

#### Scenario: An unsupported language fails soft

- **GIVEN** a function in a language outside the error-propagation support set
- **WHEN** the extractor runs
- **THEN** it returns an unsupported record with no throw sites and no try regions, never an error and
  never a fabricated fact
