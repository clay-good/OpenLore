# Design

## What exists

- `claim-verification.ts` has a closed `ClaimKind` set. Each kind is computed over the graph and
  returns a receipt the agent can cite.
- `select_tests` (`test-impact.ts`) computes backward reachability from tests. `blast_radius`
  composes it, and `verify_change` composes `blast_radius`.
- The analyzer builds def-use edges (`DefUseEdge` in `cfg.ts`) for the languages in its matrix.

## Decisions

**1. The data-flow check is local to one test body.** "Is this assertion's argument derived from a
call to S" across the whole program is a full taint analysis. Inside one test function it is a
short def-use walk the overlay already supports. A value that comes from a helper is followed one
level into a helper in the same file. Past that the walk stops and the class is `exercises`, with
the reason. This covers `const r = subject(x); expect(r)…` and `expectOk(subject(x))`.

**2. Assertion recognition is one small recognizer per framework, declared in the registry.** A
recognizer says only: this call is an assertion, and these argument positions are the asserted
values. Declaring support is what makes a uniform `reaches` result readable: without it, an
unsupported framework looks the same as a repository with weak tests.

**3. `refuted` is kept for a symbol with no test at all.** The worst answer is a false `confirmed`;
the next worst is a false `refuted`. `unverifiable` takes every case where the analysis cannot see
the evidence: weaker classes, unrecognized frameworks, flow that leaves the body.

**4. The class rides on carriers that exist.** `select_tests` already returns a reason per test,
and `blast_radius` already lists tests to run. The class is one more field there. No selection
changes, so no consumer's behavior changes.

**5. The finding covers changed symbols only.** `changed-symbol-no-asserting-test` is raised for a
symbol in the current diff, in a recognized framework. It is never a repository-wide list. That
keeps the before-stop receipt quiet unless the agent's own change is the subject.

**6. Mutation probing is out of scope.** Proving that an assertion would catch a change needs the
suite to run on perturbed code. That is a runtime step with cost and flaky results, the opposite of
a deterministic local answer. The static lower bound is what fits, with its limit stated.

## Risks

- **`asserts-on` read as "correct."** The wording is fixed in the spec and checked by a test.
- **House style uses deep assertion helpers.** Those tests show as `exercises` with a reason. Task
  4.1 records the class distribution on this repository before anyone widens the rule.
- **Cost on large suites.** The walk is per test body and bounded; task 4.1 measures it.

## Migration

Additive: one claim kind, one field, one advisory finding code. An index built before this change
reports the class as unavailable and names the rebuild command.
