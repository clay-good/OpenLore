# analyzer spec delta

## ADDED Requirements

### Requirement: NormalizedSymbolContentHashes

The analyzer SHALL be able to compute, from the same single parse its extractor already performs
for a file, a per-symbol content hash over the normalized parse tree of the symbol's span: the
pre-order stream of node types, leaf token texts, and node open/close markers, with comments
excluded and whitespace between tokens irrelevant by construction, so that formatting-only and
comment-only edits produce an identical hash while a change in nesting (including indentation that
a layout-significant language parses as structure) changes it. Text a node owns that no child
covers SHALL be hashed too, verbatim inside string-like nodes. Text in comment syntax that changes
how the file is built, parsed, or run — a shebang, a compiler or build directive, an encoding
cookie, a language-level magic comment, a type-checker or tooling pragma — SHALL be hashed as code,
from a closed documented list whose incompleteness is the one disclosed limit of the hash. The same
walk SHALL produce, separately: a residual hash over the module-level tokens outside every symbol
span and outside the import statements; a per-statement hash of each top-level import; and a layout
of the file's runs (residual token counts and span occurrences) so that a symbol added or removed
does not disturb the other signals while module-level code moving across a symbol does. The hash SHALL reuse the established hashing discipline
(sha256, first 16 hex characters) while remaining distinct from the unnormalized span hash used for
anchor freshness, which is unchanged. The hashes SHALL be computed only when a caller requests them
for specific files; a normal analyze SHALL NOT compute or persist them, and persistence is deferred
until a consumer needs stored hashes. A file in a language without a native parse tree SHALL carry
no hashes rather than guessed ones. No new tuning constant is introduced: change detection is hash
equality only.

#### Scenario: A formatting-only edit hashes identically

- **GIVEN** a function whose body is re-indented and whose comments are rewritten, with no token
  changed
- **WHEN** the analyzer computes its normalized content hash
- **THEN** the hash is identical to the previous one, while the unnormalized span hash (anchor
  freshness) differs as before

#### Scenario: Nesting is structure

- **GIVEN** a Python function where one statement moves out of an `if` block by dedenting it
- **WHEN** the normalized content hashes of the two versions are compared
- **THEN** they differ

#### Scenario: A behavior-bearing comment is code

- **GIVEN** a Ruby file whose `# frozen_string_literal:` magic comment flips, or a shell script whose
  shebang names a different interpreter
- **WHEN** the hashes are computed
- **THEN** they differ, while an ordinary comment rewritten in the same file does not change them

#### Scenario: A language without a native parse tree stays honest

- **GIVEN** a file whose language has no native tree-sitter extractor (a WASM grammar or a script
  container)
- **WHEN** hashes are requested for it
- **THEN** no hash is returned, and a consumer keeps the file at file granularity with that reason

### Requirement: SymbolLevelChangedSets

The analyzer SHALL derive the changed-set between a base revision and the working tree by
extracting only the files the git diff names, at the merge base the diff compares against and in the
working tree, and comparing their normalized symbol-hash sets: a symbol is changed when its hash
differs, appeared or disappeared when present on one side only. A disappeared/appeared pair matched
by symbol-identity continuity (exact-body or exact-signature) SHALL be reported as a carried rename
or move. A file SHALL stay at file granularity, with a reason from a closed vocabulary, whenever the
evidence is incomplete: a side that cannot be read, parsed without errors, or hashed; a change
outside every symbol span, including a reordering of symbols or module-level code that NAMES a
changed symbol and may bind it; an index that lists a symbol neither
revision extracts to; a file past the per-call file, byte, or time bound; or a file the changed-set could
not assess. A bound that degrades a file to file granularity SHALL keep every one of its symbols
seeded, so a bound can only ever cost precision, never soundness. A file whose path changed SHALL have its base revision extracted under the old path, so
that a move reads as every symbol disappearing and reappearing rather than as no change at all. A
changed code file the index holds no symbol for SHALL still be assessed, so a consumer never reports
a diff as unchanged on the strength of files it never hashed. Imports that are purely ADDED and bind
a name MAY leave a file symbol-exact, provided every symbol naming a newly bound name stays seeded
and the consumer discloses that the imported module's load-time side effects are not attributed to
the file's other symbols. Within a symbol-granular file, a symbol that names a changed symbol, or holds a dynamic
dispatch site, SHALL stay in the impact seed set, and a consumer publishing the seed set as
"changed" SHALL disclose how many of them did not themselves change. `blast_radius`, `select_tests`, and
`briefing_since` SHALL seed from the symbol-level changed-set and SHALL report which files were
symbol-exact and which stayed file-granular and why. A consumer SHALL state that nothing changed
only when every changed code file was hashed AND no symbol changed in any of them; a symbol that
changed but is absent from the index SHALL be reported as not indexed, never as unchanged.

#### Scenario: A formatting-only diff changes no symbol

- **GIVEN** a working-tree edit that only reformats and re-comments a hash-covered file
- **WHEN** `select_tests` runs against HEAD
- **THEN** no production symbol is seeded, and — when every changed code file was hashed — the result
  says the symbols are unchanged (formatting or comments only, or reverted in the working tree)
  rather than "nothing changed"; any file it could not assess is named as not assessed

#### Scenario: A one-function edit seeds one function

- **GIVEN** a ten-function file in which one function body changes
- **WHEN** `blast_radius` or `select_tests` resolves the diff
- **THEN** only that function (and any same-file function naming it) is seeded, and the receipt
  counts the file as symbol-exact

#### Scenario: A module-level change keeps the whole file

- **GIVEN** a diff that changes a module-level constant used by several functions in the file
- **WHEN** the changed-set is computed
- **THEN** the file stays at file granularity with reason `module-level-change`, and every production
  symbol in it is seeded

#### Scenario: A renamed-but-unchanged symbol is reported as carried

- **GIVEN** a diff that renames `computeTax` to `calculateTax` without editing its body
- **WHEN** `briefing_since` briefs the change
- **THEN** it names the pair under `carried` and briefs the symbol — its id and every caller changed —
  with a caveat stating that the body did not

#### Scenario: A changed symbol the index does not know is "not indexed"

- **GIVEN** a working-tree edit that adds a function to an already-indexed file, with an index that
  predates the edit
- **WHEN** `select_tests` or `blast_radius` resolves the diff
- **THEN** it reports that symbols differ but are absent from the index and that analyze must be
  re-run, never that the edits were formatting or comments only

#### Scenario: A moved file is never "unchanged"

- **GIVEN** a diff that moves a file to a new path without editing it
- **WHEN** the changed-set is computed
- **THEN** every symbol in it is reported as disappeared at the old path and appeared at the new one,
  all of them stay seeded, and the moves are listed under `carried`

#### Scenario: Hashing is bounded by the diff

- **GIVEN** a repository of thousands of files where three files changed since the base ref
- **WHEN** the changed-set is computed
- **THEN** only those three files are read and parsed, once per side
