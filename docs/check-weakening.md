# Check-weakening findings

An agent that cannot make a test pass sometimes changes the check instead of the code: it skips or
deletes the test, removes assertions, edits the expected value, adds `@ts-ignore`, catches and drops
the error, or relaxes the CI config. OpenLore reports each of these diff shapes as an advisory
finding and names the code the weakened test was guarding. It runs no test and judges nothing: a
legitimate cleanup produces the same fact, and you decide.

| Where | What you get |
|-------|--------------|
| `structural_diff` | `checkWeakening`: `{ baseline, findings, gated, notAssessed?, boundaries? }` |
| `verify_change` | one receipt item per finding (`check: "check_weakening"`), the findings in `findings[]` classified by `enforcement.policy` (with `gated`), `summary.checksWeakened`, and `checkWeakeningBaseline` |

## The baseline is fixed

Shapes are computed against the **merge-base** of the base ref with your current state, read through
git. With no base ref (or `HEAD`), the default branch (`main`, `master`, `origin/HEAD`) is used. So a
weakening committed on the branch before the last edit is still found; it is never compared against
the agent's own last commit. The working tree, staged changes, and untracked files are included.

## The shapes

| Code | Reported when |
|------|---------------|
| `test-removed` | A test case, or a whole test file, present at the baseline is gone. A case renamed with the same body is not reported. |
| `test-disabled` | A skip marker is added to a test or its suite, or a focus marker (`.only`, `fit`) is added so the file's other tests stop running. |
| `assertions-reduced` | A test has fewer assertion calls than at the baseline. |
| `expected-value-changed` | A literal argument of a test's assertions changes, and no production symbol the test file reaches changed. An expected value updated with its code is not reported. |
| `suppression-added` | A suppression comment or annotation is added (matched by its text, so an existing one is never reported). Markers inside strings do not count. |
| `error-swallowed` | A function gets a new catch/except (or Go `if err != nil`) block around a call, whose body is empty, or only logs and returns at most a constant (`return null`, Go `return nil`). |
| `check-config-relaxed` | A test-runner, coverage, lint, or CI config adds an exclude/ignore entry, turns a lint rule off, lowers a coverage threshold, adds `continue-on-error`/`allow_failure`, or removes or changes a CI step that ran tests. |

Test findings carry `reaches` (the production symbols the test file reaches) and `reachesChanged`
(those this diff also changes). When `reachesChanged` is not empty, a `warning` becomes an `error`.
Reach is read from the index per test **file** (its `tested_by` edges and their call closure), not
per test case.

## Closed tables

| Language | Tests (cases, skip/focus, assertions) | Suppressions | Discarded errors |
|----------|----------------------------------------|--------------|------------------|
| TypeScript / JavaScript | Vitest, Jest, Mocha: `it`/`test`/`specify`, `describe`/`context`/`suite`, `.skip`/`.todo`/`.skipIf`/`x*`, `.only`/`f*`; `expect`, `assert`, `expectTypeOf`, `assertType` | `@ts-ignore`, `@ts-expect-error`, `@ts-nocheck`, `eslint-disable*`, `biome-ignore`, `istanbul`/`c8`/`v8 ignore` | `catch`; logging: `console.*`, `logger.*`, `log.*` |
| Python | pytest, unittest: `test*` functions and methods; `@pytest.mark.skip`/`skipif`/`xfail`, `@unittest.skip*`, `pytest.skip()`, `self.skipTest()`; `assert`, `*.assert*()`, `pytest.raises`/`warns` | `# noqa`, `# type: ignore`, `# pylint: disable`, `# pragma: no cover`, `# nosec` | `except`; `pass` or `print`, `logging.*`, `logger.*`, `log.*` |
| Go | `testing`: `Test*`, `t.Run` subtests; `t.Skip*`; `t.Error*`/`Fatal*`/`Fail*`, testify `assert.*`/`require.*` | `//nolint`, `//lint:ignore`, `#nosec` | `if err != nil`; `fmt.Print*`, `log.*`, `logger.*` |
| Java | JUnit 4/5: `@Test`, `@ParameterizedTest`, `@RepeatedTest`, `@TestFactory`, `@TestTemplate`; `@Disabled*`, `@Ignore`; `assert*` (incl. AssertJ chains) | `@SuppressWarnings`, `NOSONAR`, `CHECKSTYLE:OFF` | `catch`; `System.out/err.print*`, `log.*`, `logger.*`, `printStackTrace` |

Check configs: `.github/workflows/*.yml`, `.gitlab-ci.yml`; `vitest`/`jest`/`vite`/`playwright`/`karma`/`cypress` configs, `.mocharc*`,
`pytest.ini`, `package.json`; `.nycrc*`, `.c8rc*`, `.coveragerc`, `codecov.yml`; `.eslintrc*`, `eslint.config.*`, `.eslintignore`,
`.golangci.yml`, `ruff.toml`, `.flake8`, `.pylintrc`, `mypy.ini`, `biome.json`; and the check sections (pytest, coverage, ruff,
flake8, pylint, mypy, tox) of `pyproject.toml`, `setup.cfg`, `tox.ini`.

A changed code file in any other language is listed in `notAssessed` with the shapes that were not
checked, never reported as free of weakening. So is an expected-value change in a test file the
index has no reach for, and a workflow that is not valid YAML.

## Gating

All seven codes are advisory. To block on one, name it in `enforcement.policy` (see
[configuration](configuration.md#enforcement-policy)); `verify_change` then returns
`gated: true`. `openlore enforce` does not collect these findings.
