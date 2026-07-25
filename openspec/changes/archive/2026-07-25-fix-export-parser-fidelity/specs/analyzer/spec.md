# analyzer spec delta

## ADDED Requirements

### Requirement: ExportParserRecognizesModifierPrefixedExports

The shared import/export parser SHALL recognize modifier-prefixed JavaScript/TypeScript
exports — `export async function`, `export function*`, `export async function*`, and
`export abstract class` — as exports of the declared name, and SHALL name a
`export default async function foo` declaration `foo`, never the modifier token. The
recognition SHALL live in the shared parser itself so every consumer (dependency graph,
spec verifier, mapping generator, public-surface certification) receives the same export
set; no consumer SHALL carry a local recovery patch for a gap the shared parser owns.

#### Scenario: An async export reaches the export index

- **GIVEN** a file containing `export async function handleOrient() {}`
- **WHEN** the dependency graph and the mapping generator run
- **THEN** `handleOrient` appears in the file's exports and in the requirement→function
  `exportIndex`, with kind `function`

#### Scenario: A generator and an abstract class are exports

- **GIVEN** a file containing `export function* walk() {}` and `export abstract class Base {}`
- **WHEN** `parseJSExports` runs
- **THEN** both `walk` (kind `function`) and `Base` (kind `class`) are returned

#### Scenario: A default async function is named correctly

- **GIVEN** a file containing `export default async function bootstrap() {}`
- **WHEN** `parseJSExports` runs
- **THEN** the default export's name is `bootstrap`, not `async`

#### Scenario: Consumers share one implementation

- **GIVEN** the shared parser recognizes modifier-prefixed exports
- **WHEN** the public-surface certifier computes exported names
- **THEN** it obtains async/generator exports from the shared parser without a local
  recovery regex, and its breaking-change verdicts are unchanged

### Requirement: ImportExportLineNumbersMatchOriginalSource

Import and export line numbers emitted by the shared parser SHALL refer to the line in the
ORIGINAL file content. Comment stripping (and any multi-line normalization) performed before
regex matching SHALL preserve the line structure of the input — blanking with same-length
whitespace that keeps newlines — so that a match offset converts to the true source line.
A statement spanning multiple physical lines SHALL be attributed to its first line, and
this attribution rule SHALL be documented at the parser.

#### Scenario: A block-comment header does not shift lines

- **GIVEN** a TypeScript file whose first 12 lines are a block comment and whose line 14 is
  `import { x } from './y'`
- **WHEN** imports are parsed
- **THEN** the import is recorded at line 14, not a comment-stripped offset near line 2

#### Scenario: A multi-line Python import is attributed to its first line

- **GIVEN** a Python file with `from x import (\n  A,\n  B\n)` starting at line 20
- **WHEN** imports are parsed
- **THEN** the import is recorded at line 20 and later imports in the file keep their true
  line numbers

#### Scenario: Parenthesized non-import code does not perturb lines

- **GIVEN** a Python file with a multi-line function call above an import
- **WHEN** imports are parsed
- **THEN** the import's recorded line equals its line in the original file
