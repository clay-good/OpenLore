# analyzer spec delta

## ADDED Requirements

### Requirement: GitPathOutputFidelity

Every subprocess that parses file paths from git stdout (history, provenance, coupling, staged
files) SHALL disable git's path quoting (`-c core.quotepath=false`, or NUL-terminated output where
the format supports it) so that paths containing non-ASCII bytes arrive as literal repo-relative
paths, not quoted octal-escaped strings. The discipline SHALL live in one shared helper adopted by
all call sites, and an automated guard SHALL fail when a new path-parsing git spawn omits it —
history-derived joins (provenance, churn, co-change) MUST NOT silently exclude files whose names
are not ASCII.

#### Scenario: A non-ASCII filename joins history to the graph

- **GIVEN** a repository containing a committed file `src/café.ts`
- **WHEN** provenance or change-coupling extraction runs
- **THEN** the file's path is returned exactly as `src/café.ts` and matches the analyzer's
  repo-relative path set, yielding authors, churn, and co-change data rather than a silent gap

#### Scenario: A new git spawn cannot regress the discipline

- **GIVEN** a contributor adds a new `git log`/`git diff` call that parses paths from stdout
- **WHEN** the guard test runs in CI
- **THEN** it fails if the new spawn lacks the quotepath guard (or NUL mode), naming the offending
  site
