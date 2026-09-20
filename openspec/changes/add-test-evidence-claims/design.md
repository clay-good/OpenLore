# Design

## Context

See `proposal.md` — Why. What exists already:

- `claim-verification.ts` defines a closed `ClaimKind` set — `calls`, `reaches`, `dead`, `impacts`,
  `safe-to-change`, `decision-current` — each computed over the graph with a citable receipt.
- `select_tests` computes backward reachability from tests, and `report_coverage_gaps` deliberately
  reports only the negative direction ("no reaching test"), because reachability cannot support the
  positive one.
- The analyzer already builds a CFG/def-use overlay for the languages in its matrix, which is the
  machinery needed to answer "is this assertion's argument derived from that call" *inside one test
  body*.

## Goals / Non-Goals

**Goals:**

- Distinguish the three kinds of test relationship that today collapse into one, using analysis the
  product already performs.
- Give `verify_claim` an honest answer to the question an agent is most tempted to assert loosely.

**Non-Goals:**

- No mutation probing, no test execution, no coverage instrumentation.
- No judgment of test quality, no score, no "well tested" label.
- No cross-test aggregation into a percentage.

## Decisions

**1. The data-flow check is local to the test body, and that is the whole reason this is affordable.**
Asking "is this assertion's argument derived from a call to S" across the whole program is a full
taint analysis. Inside a single test function it is a bounded def-use walk over a small body — the
overlay already computes it. The classification therefore reads: does a def reaching the assertion's
argument have, in its chain within this body, a call to S. A chain leaving the body (a helper that
returns a value) is followed one level into a same-file test helper and otherwise stops, yielding
`exercises` with a disclosed reason.
*Alternative considered:* interprocedural flow through test helpers. Deferred — the one-level rule
covers the common `const result = subject(x); expect(result)…` and the `expectOk(subject(x))` shapes,
and the honest downgrade is available for the rest.

**2. Assertion recognition is a per-framework recognizer, declared in the capability matrix.**
An assertion is a call whose callee matches a framework's assertion surface and whose argument
positions are known (`expect(x).toBe(y)`, `assert.equal(a, b)`, `assertEqual(a, b)`). The
recognizer's job is only to say "this call is an assertion, and these argument positions are the
asserted values". Declaring support per framework is what keeps a uniform `reaches` result
interpretable — without it, an unsupported framework would look exactly like an untested codebase.

**3. `refuted` is reserved for a genuinely test-free symbol, and is otherwise avoided.**
For a `tested` claim, the dangerous verdict is a false `confirmed` and the second most dangerous is a
false `refuted`. `unverifiable` absorbs every case where the analysis cannot see the evidence —
weaker classes, unrecognized frameworks, flow leaving the body. That asymmetry matches the existing
`verify_claim` posture: an `unverifiable` verdict tells the caller to hedge.

**4. Mutation probing is explicitly out of scope, and named as such rather than silently omitted.**
Proving that an assertion would *catch* a change requires perturbing the code and running the suite.
That is a runtime operation with a cost, a flakiness surface and a non-deterministic result — the
opposite of the deterministic, local, no-runtime substrate the north-star decision (c6d1ad07)
commits to. If it is ever built it belongs behind an explicit opt-in command with its own budget,
not inside `verify_claim`'s receipt path. Recording that boundary here is part of the change: the
retex that motivated this work named mutation probing as the ideal, and the honest answer is that
the static lower bound is what fits the product, plus a clear statement of what it cannot prove.

**5. The classification rides existing carriers.**
`select_tests` already returns a reason per selected test; the class goes there. The coverage-gap
report already labels gaps; the class sharpens its wording without changing which gaps it reports.
Neither tool changes what it selects, so no consumer's behavior shifts.

## Risks / Trade-offs

- **`asserts-on` read as "correct"** → the spec fixes the wording at every surface and forbids the
  bare word "tested" as a guarantee; the risk is a documentation discipline, guarded like the other
  honesty-contract phrases in this corpus.
- **One-level helper following misses a common house style** → shows up as `exercises` with a
  reason; measurable on this repository, where assertion helpers are common, and the number is worth
  recording before choosing to go further.
- **Framework recognizer drift** → each recognizer is small and declared; an unrecognized form
  degrades to `reaches` with disclosure rather than to a wrong class.
- **Cost on large test suites** → the walk is per test body and bounded; measured in task 4.2.

## Migration Plan

Additive: a new claim kind and an extra field on relationships that already exist. Consumers ignoring
the class keep their current behavior. No artifact schema break; an index built before this change
reports the class as unavailable and names the rebuild command.
