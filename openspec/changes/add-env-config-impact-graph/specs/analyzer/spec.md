# analyzer spec delta

## ADDED Requirements

### Requirement: LinePreciseEnvReadSiteExtraction

The analyzer SHALL provide a deterministic env read-site extractor that, given a source file's
content, its repo-relative path, and its file extension, returns one record per environment-variable
**read site** in the file. Each record SHALL carry the variable name, the 1-based line of the read,
and a per-site `required` flag.

The extractor SHALL reuse the existing per-language environment-variable detection patterns already
encoded in the environment-variable extractor (TypeScript / JavaScript `process.env.X` and
`process.env['X']`; Python `os.environ['X']`, `os.environ.get('X')`, `os.getenv('X')`; Go
`os.Getenv("X")`; Ruby `ENV['X']`, `ENV.fetch('X')`) rather than introducing a second pattern set or a
new grammar. It SHALL scan only the source extensions and skip the directories and test files the
existing inventory extraction already scans and skips, so the read-site set and the inventory agree on
what source is in scope.

The per-site `required` flag SHALL be true when no immediate fallback is detected at that specific read
site, and false otherwise:

- TypeScript / JavaScript: a `process.env.X` immediately followed (ignoring whitespace) by `??` or
  `||` has a fallback at the site → not required; otherwise required.
- Python: a strict subscript `os.environ['X']` is required; `os.environ.get('X')` / `os.getenv('X')`
  with no default argument are required (they return `None`, a deferred hard break); the same calls
  with a default argument (`os.getenv('X', d)`) are not required.
- Go: `os.Getenv("X")` returns an empty string rather than failing → not required.
- Ruby: a strict subscript `ENV['X']` and `ENV.fetch('X')` with no default are required;
  `ENV.fetch('X', default)` and `ENV.fetch('X') { block }` / `ENV.fetch('X') do … end` are not
  required (a positional or block default suppresses the `KeyError`).

A fallback present elsewhere in the file SHALL NOT clear a site's `required` flag — the flag is a
per-site signal. The per-site `required` determination is a documented heuristic, not a guarantee.

The extraction SHALL be deterministic: the same content, path, and extension yield byte-identical
read-site records on every run, in a stable order (by line, then variable name).

#### Scenario: A required read with no fallback is reported

- **GIVEN** a TypeScript file containing `const url = process.env.DATABASE_URL;`
- **WHEN** the read-site extractor runs on the file
- **THEN** it reports a read site for `DATABASE_URL` at that line with `required` true

#### Scenario: A read with an inline fallback is not required

- **GIVEN** a TypeScript file containing `const port = process.env.PORT ?? '3000';`
- **WHEN** the read-site extractor runs
- **THEN** it reports a read site for `PORT` at that line with `required` false

#### Scenario: Python reads are distinguished per site by default presence

- **GIVEN** a Python file containing `os.environ['SECRET']`, `os.getenv('REGION')`, and
  `os.getenv('TZ', 'UTC')`
- **WHEN** the read-site extractor runs
- **THEN** `SECRET` and `REGION` are reported `required` true (strict subscript / no default) and `TZ`
  is reported `required` false (it has a default)

#### Scenario: A file in an unsupported language yields no read sites

- **GIVEN** a source file whose extension is not one the env patterns cover
- **WHEN** the read-site extractor runs
- **THEN** it returns no read-site records (an honest absence, never a guessed read)
