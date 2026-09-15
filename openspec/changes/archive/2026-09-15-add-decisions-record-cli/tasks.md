## 1. Command

- [x] 1.1 Add the `decisions record` subcommand that parses the options and calls the `record_decision` handler for the current directory; verify with a CLI test that a draft is stored and the output names the id and `openlore decisions status <id>`
- [x] 1.2 Validate input before the handler (required `--title`/`--rationale`, `--scope` enum, `--constraints-file` readable JSON object) and exit non-zero on a handler `error`; verify tests for missing rationale, bad scope, and bad JSON store no draft and set a non-zero exit code
- [x] 1.3 Support `--json` (result on stdout, logs on stderr) and forward `--files`, `--supersedes`, `--consequences`; verify a test parses stdout JSON with the handler's fields, and a re-record of a decided decision reports `alreadyDecided`

## 2. Messages and guidance

- [x] 2.1 Replace both `openlore decisions --record` hints with `openlore decisions record`; verify a source test asserts no `decisions --record` string remains under `src/cli`
- [x] 2.2 When `record_decision` is not wired, make the generated decisions section name `openlore decisions record` (keep the enabling-preset hint); verify `guidance-preset-coherence.test.ts` passes with the updated assertions

## 3. Docs and checks

- [x] 3.1 Document the command in `docs/cli-reference.md` and add a `CHANGELOG.md` Unreleased entry; verify the doc-claims guard passes
- [x] 3.2 Run typecheck, lint, and the decisions, guidance, and doc-claims tests; verify all pass and `openspec validate add-decisions-record-cli --strict` passes
