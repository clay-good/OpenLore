# Check-weakening findings

An agent that cannot make a test pass sometimes changes the check instead of the code: it skips or
deletes the test, removes assertions, edits the expected value, adds `@ts-ignore`, catches and drops
the error, or relaxes the CI config. OpenLore reports each of these diff shapes as an advisory
finding and names the code the weakened test was guarding. It runs no test and judges nothing: a
legitimate cleanup produces the same fact, and you decide.

| Where | What you get |
|-------|--------------|
| `structural_diff` | `checkWeakening`: `{ baseline, findings, gated, silenced?, notAssessed?, boundaries? }` |
| `verify_change` | one receipt item per finding (`check: "check_weakening"`), the findings in `findings[]` classified by `enforcement.policy` (with `gated`), `summary.checksWeakened` (`null` when the check did not run), and `checkWeakeningBaseline` |
| `openlore review` | a **Checks weakened** section (Markdown) or lines (terminal); listed, not gated |

## The baseline is fixed

Shapes are computed against the **merge-base** of the base ref with your current state, read through
git. With no base ref (or `HEAD`), the default branch is used (`main`, `master`, `origin/HEAD`; on the
default branch itself, its remote). So a weakening committed on the branch before the last edit is
still found; it is never compared against the agent's own last commit. The working tree, staged
changes, and untracked files are included. When no such baseline exists (a single-commit repo, a
shallow clone, an unresolvable base ref, unrelated history), the baseline used is named in
`boundaries`.

## The shapes

| Code | Reported when |
|------|---------------|
| `test-removed` | A test case, or a whole test file, present at the baseline is gone. A case renamed, or moved to another test file in the same diff, with the same body is not reported. |
| `test-disabled` | A skip marker is added to a test or its suite, or a focus marker (`.only`, `fit`) is added so the file's other tests stop running. |
| `assertions-reduced` | A test has fewer assertion calls than at the baseline. |
| `expected-value-changed` | A literal argument of a test's assertions, or a row of its data table (`it.each`, `@pytest.mark.parametrize`, a Go table), changes, and no production symbol the test file reaches changed. Quote style, spacing, number spelling (`1.0`/`1`) and assertion messages do not count. An expected value updated with its code is not reported. |
| `suppression-added` | A suppression directive is added (matched by its normalized text, so an existing or re-spaced one is never reported). Markers inside strings, and prose that only mentions one, do not count. |
| `error-swallowed` | A function in an existing file gets a new catch/except (or Go `if err != nil`) block around a call, whose body is empty, or only logs and returns at most a constant (`return null`, Go `return nil`). `log.Fatal*`/`Panic*` end the process and do not count. |
| `check-config-relaxed` | A test-runner, coverage, lint, or CI config adds an exclude/ignore entry, turns a lint rule off, lowers or removes a coverage threshold, adds `continue-on-error`/`allow_failure`, turns a job or step off (`if: false`, GitLab `when: manual`), removes or changes a CI step that ran tests, or is deleted; or `.openlore/config.json` lowers the enforcement class of one of these seven codes. |

Test findings carry `reaches` (the production symbols the test file reaches) and `reachesChanged`
(those in code this diff changes). When `reachesChanged` is not empty, a `warning` becomes an
`error`. Reach is read from the index at its last analysis, per test **file** (its `tested_by` edges
and their call closure), not per test case. A test file the index has no reach for is named in
`boundaries`.

## Closed tables

| Language | Tests (cases, skip/focus, assertions) | Suppressions | Discarded errors |
|----------|----------------------------------------|--------------|------------------|
| TypeScript / JavaScript | Vitest, Jest, Mocha: `it`/`test`/`specify`, `describe`/`context`/`suite`, `.each` tables, `.skip`/`.todo`/`.skipIf`/`.runIf`/`.failing`/`.fails`/`x*`, `this.skip()`, `.only`/`f*`; `expect`, `assert`, `chai.expect`/`chai.assert`, `expectTypeOf`, `assertType` | `@ts-ignore`, `@ts-expect-error`, `@ts-nocheck`, `eslint-disable*`, `biome-ignore`, `istanbul`/`c8`/`v8 ignore` (at the start of a comment) | `catch`; logging: `console.*`, `logger.*`, `log.*`, `this.logger.*` |
| Python | pytest, unittest: `test*` functions and methods (not fixtures), `@pytest.mark.parametrize`; `@pytest.mark.skip`/`skipif`/`xfail` (also `@mark.*`), module `pytestmark`, `@unittest.skip*`, `pytest.skip()`, `self.skipTest()`; `assert`, `*.assert*()`, `pytest.raises`/`warns` | `# noqa`, `# type: ignore`, `# pylint: disable`, `# pragma: no cover`, `# nosec` | `except`; `pass`, `...`, or `print`, `logging.*`, `logger.*`, `log.*` |
| Go | `testing`: `Test*`, `t.Run` subtests, table literals; `t.Skip*`; `t.Error*`/`Fatal*`/`Fail*`, testify `assert.*`/`require.*` | `//nolint`, `//lint:ignore`, `#nosec` | `if err != nil`; `fmt.Print*`/`Fprint*`, `log.*`, `logger.*`, `t.Log*` |
| Java | JUnit 4/5: `@Test`, `@ParameterizedTest`, `@RepeatedTest`, `@TestFactory`, `@TestTemplate`; `@Disabled*`, `@Ignore` (on the method or any enclosing class); `assert*` (incl. AssertJ chains) | `@SuppressWarnings`, `NOSONAR`, `CHECKSTYLE:OFF` | `catch` (incl. try-with-resources); `System.out/err.print*`, `log.*`, `logger.*`, `printStackTrace` |

Check configs: `.github/workflows/*.yml`, `.gitlab-ci.yml` (hidden `.template` jobs included);
`vitest`/`jest`/`vite`/`playwright`/`karma`/`cypress` configs, `karma.conf.*`, `.mocharc*`, `pytest.ini`, and the
`jest`/`c8`/`nyc`/`mocha`/`vitest`/`eslintConfig` keys of `package.json`; `.nycrc*`, `.c8rc*`, `.coveragerc`, `codecov.yml`;
`.eslintrc*`, `eslint.config.*`, `.eslintignore`, `.stylelintignore`, `.golangci.yml`, `ruff.toml`, `.flake8`, `.pylintrc`, `mypy.ini`,
`biome.json`; the check sections (pytest, coverage, ruff, flake8, pylint, mypy, tox) of `pyproject.toml`, `setup.cfg`, `tox.ini`;
and `enforcement.policy` in `.openlore/config.json`.

Listed in `notAssessed` (with the shapes not checked), never reported as free of weakening:

- a changed code file in any other language (Rust, Ruby/RSpec, …);
- a test file that imports a test library outside the table (`node:test`, `tap`, `ava`, `tape`, `uvu`, `zora`, `nose`, Ginkgo, GoConvey, TestNG), or in which no test case of the table is recognized;
- a file with a syntax error at either revision (a conflict marker, a half-written edit);
- a file over 1 MB at either revision;
- an expected-value change in a test file the index has no reach for;
- a workflow that is not valid YAML, or a `package.json` that is not valid JSON.

Not detected (known limits): a trigger narrowed to `workflow_dispatch`, `assumeTrue(false)`, an early
`return` before the assertions, and assertions moved into a helper (reported as `assertions-reduced`).

## Gating

All seven codes are advisory. To block on one, name it in `enforcement.policy` (see
[configuration](configuration.md#enforcement-policy)); `verify_change` then returns `gated: true`. A
code set to `off` is dropped from `findings` but still named in `silenced`, and lowering a code's
class in `.openlore/config.json` is itself a `check-config-relaxed` finding. `openlore enforce` does
not collect these findings, and `openlore review` lists them without gating on them.
