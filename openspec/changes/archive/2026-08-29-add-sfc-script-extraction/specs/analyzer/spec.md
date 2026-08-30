# analyzer spec delta

## ADDED Requirements

### Requirement: ScriptContainerBoundaryIsDisclosed

The analyzer SHALL disclose recognized-but-unextracted script container formats
(`.vue`, `.svelte`, `.astro`) as an explicit boundary rather than leaving their code silently
absent from the graph. When such files are present, analysis SHALL count the container files and
their `<script>` blocks and report them ("N files contain M script blocks not yet extracted");
`get_language_support` SHALL return a per-format record identifying a recognized container with
unsupported extraction (never the undifferentiated `'unknown'` record); and `orient`/`doctor`
SHALL surface the boundary so a near-empty graph on an SFC codebase is interpretable as
"unextracted container," not "little code here." Framework semantics the extractor does not
analyze (template-expression calls, Svelte `$:`, Vue/Svelte macros) SHALL remain named in the
boundary record even after script bodies are extracted.

#### Scenario: A Vue repo's quiet graph is interpretable

- **GIVEN** a repository whose application logic lives in `.vue` files
- **WHEN** analysis runs before script extraction is available
- **THEN** the output reports the count of container files and script blocks not yet extracted
- **AND** `orient` and `doctor` surface the same boundary, so the small graph is disclosed as a
  container gap rather than presented as complete

#### Scenario: The registry answers honestly for a container format

- **GIVEN** a query to `get_language_support` for `.svelte`
- **WHEN** the record is returned
- **THEN** it identifies a recognized script container with extraction unsupported (or, once
  stage 2 lands, the supported extraction scope), never an all-false unknown-language row

### Requirement: SfcScriptBlocksAreExtracted

The analyzer SHALL extract `<script>` and `<script lang="ts">` bodies from `.vue`, `.svelte`, and
`.astro` files into the existing TypeScript/JavaScript pipeline using an offset-preserving blank
of the container file (the html-script-extractor technique), so extracted functions, call edges,
signatures, CFG, and style fingerprint carry line-true positions in the container file and ride
the existing lanes with no tool-side changes. `lang="ts"` blocks SHALL parse as TypeScript and
untyped blocks as JavaScript. Template expressions and framework macro semantics SHALL be out of
scope and disclosed (per ScriptContainerBoundaryIsDisclosed), never guessed. Each container
format's extraction claim SHALL grow only together with a conformance fixture, per the existing
coverage-guard discipline.

#### Scenario: A Vue script block joins the call graph at true lines

- **GIVEN** a `.vue` file whose `<script lang="ts">` defines `save()` calling an imported helper
- **WHEN** the call graph is built
- **THEN** `save` is a node whose line numbers match its position in the `.vue` file, and the
  call edge to the helper resolves through the existing TS pipeline

#### Scenario: Untyped and typed blocks dispatch to the right extractor

- **GIVEN** a `.svelte` file with a plain `<script>` block and a `.vue` file with
  `<script lang="ts">`
- **WHEN** extraction runs
- **THEN** the former parses as JavaScript and the latter as TypeScript

#### Scenario: Framework magic is disclosed, not guessed

- **GIVEN** a `.svelte` file using `$:` reactive statements and a `.vue` file calling `save()`
  only from a template `@click` binding
- **WHEN** extraction and analysis run
- **THEN** no call edge is invented from the template or reactive statement
- **AND** the boundary record names template expressions and framework macros as unanalyzed, so a
  function invoked only from a template is not confidently reported dead

#### Scenario: A claimed container format has a fixture

- **GIVEN** a container format claimed as extracted
- **WHEN** the conformance suite runs
- **THEN** a fixture for that format yields functions and a resolved edge with line-true
  positions, and a claimed format without a fixture fails the suite
