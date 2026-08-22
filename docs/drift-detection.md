## Drift Detection

Drift detection is the core of ongoing spec maintenance. It runs in milliseconds, needs no API key, and works entirely from git diffs and spec file mappings.

> **Drift vs. Decisions**: these address different failure modes. Drift asks *"is this spec's source file coverage still accurate?"* — it fires when a spec-covered file changes without the spec being updated. The [decisions workflow](#what-it-does) asks *"has this architectural choice been reviewed?"* — it gates commits until recorded decisions are approved and written back as new requirements. Syncing a decision appends a requirement but does not update a spec's source file list, so drift can still fire on the same commit. Run both: they catch different things.

```bash
$ openlore drift

  Spec Drift Detection

  Analyzing git changes...
  Base ref: main
  Branch: feature/add-notifications
  Changed files: 12

  Loading spec mappings...
  Spec domains: 6
  Mapped source files: 34

  Detecting drift...

   Issues Found: 3

   [ERROR] gap: src/services/user-service.ts
      Spec: openspec/specs/user/spec.md
      File changed (+45/-12 lines) but spec was not updated

   [WARNING] uncovered: src/services/email-queue.ts
      New file has no matching spec domain

   [INFO] adr-gap: openspec/decisions/adr-0001-jwt-auth.md
      Code changed in domain(s) auth referenced by ADR-001

   Summary:
     Gaps: 2
     Uncovered: 1
     ADR gaps: 1
```

### ADR Drift Detection

When `openspec/decisions/` contains Architecture Decision Records, drift detection automatically checks whether code changes affect domains referenced by ADRs. ADR issues are reported at `info` severity since code changes rarely invalidate architectural decisions. Superseded and deprecated ADRs are excluded.

### LLM-Enhanced Mode

Static drift detection catches structural changes but cannot tell whether a change actually affects spec-documented behavior. A variable rename triggers the same alert as a genuine behavior change.

`--use-llm` post-processes gap issues by sending each file's diff and its matching spec to the LLM. The LLM classifies each gap as relevant (keeps the alert) or not relevant (downgrades to info). This reduces false positives.

```bash
openlore drift              # Static mode: fast, deterministic
openlore drift --use-llm    # LLM-enhanced: fewer false positives
```

### Drift → Tests

When drift is detected, `--suggest-tests` finds and lists the test files that cover the affected domains. It scans for `// openlore: {}` metadata tags written by `openlore test` — no LLM required. Pass the listed paths to your project's test runner.

```bash
$ openlore drift --suggest-tests

   [ERROR] gap: src/auth/session.ts
      Spec: openspec/specs/auth/spec.md

   Suggested tests for affected domains:

   auth  (2 files)
     → spec-tests/auth/Login.test.ts
     → spec-tests/auth/Session.test.ts

   Run the listed files with your project test runner.
```

If no tests with openlore annotation tags exist yet for the affected domain, run the `openlore-write-tests` skill to write them.

### Bounded Results and Exit Codes

Drift analyzes at most 100 changed files by default. Increase the limit with `--max-files`. JSON,
MCP, and API results include `totalChangedFiles`, `analyzedFiles`, and `filesOmitted`; do not rely on
`hasDrift: false` when `filesOmitted` is nonzero. `specRelevantFiles` counts only the analyzed
subset.

The CLI exits `0` when no drift reaches the configured threshold, `1` when drift is found, and `2`
when drift could not be checked. Installed pre-commit hooks block only confirmed drift. A missing
configuration, missing specs, invalid repository, internal failure, or incomplete capped result is
reported explicitly but does not block the commit.
