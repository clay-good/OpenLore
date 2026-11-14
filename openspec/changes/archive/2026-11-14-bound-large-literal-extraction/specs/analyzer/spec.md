# analyzer spec delta

## ADDED Requirements

### Requirement: TreeWalksAreLinearInNodeWidth

Every whole-tree walk in extraction SHALL read each node's children EXACTLY ONCE, so its cost is
linear in the number of nodes and never quadratic in one node's width. A tree-sitter node's
`children` / `namedChildren` are getters that re-marshal the node and allocate a fresh object per
child, and its `child(i)` / `namedChild(i)` accessors scan from the first child — so re-reading
either inside a per-child loop costs O(k²) on a node with k children. Both hazards SHALL be avoided
by every walk, not only the ones a past incident happened to reach.

A node of a few thousand children is ORDINARY generated code, not hostile input: a generated
protobuf descriptor emits its wire format as one `[]byte{…}` composite literal. A walk that is
quadratic in width therefore degrades real repositories, and the degradation is invisible in file
size — an 89 KB generated file cost 82 s while a larger generated file whose descriptor was emitted
as a string literal cost nothing.

#### Scenario: A wide composite literal extracts in linear time

- **GIVEN** a source file containing one composite literal of N elements
- **WHEN** the file is extracted
- **THEN** the number of child nodes the walks materialize grows proportionally to N, not to N²

#### Scenario: The facts are unchanged

- **GIVEN** a real generated-protobuf source file that extracts within the budget
- **WHEN** it is extracted after the walks were made linear
- **THEN** it contributes exactly the same functions, spans and edges it contributed before

## MODIFIED Requirements

### Requirement: PerFileExtractionCostIsBounded

Extraction of a single file SHALL be bounded by a wall-clock budget expressed as a named constant.
The budget SHALL cover the file's WHOLE extraction — the parse and every post-parse phase the
language extractor runs over the tree — not the parse alone. A bound whose name and documentation
claim the file is bounded, while in fact only its parse is, is an honesty defect as much as a
performance one: a generated protobuf file parsed in milliseconds and then spent 82 s in a
post-parse tree walk, exceeding a documented 20 s per-file bound with no disclosure at all.

The bound SHALL be enforced IN-BAND, at cooperative checkpoints the extraction already passes
through, rather than by an external timer or by terminating the thread holding the work: extraction
is synchronous, so a timer cannot preempt it and terminating mid-parse is what converts a slow file
into a process-level abort. The checkpoints SHALL include the parse (through the parser's own
deadline, armed with the time REMAINING on the file's budget), each shared post-parse phase
boundary, the shared tree-walk children boundary, and the return of the file's extraction. The final
checkpoint SHALL be conclusive: a file whose extraction exceeded the budget SHALL NOT be admitted to
the graph even when no earlier checkpoint interrupted it. A binding that cannot accept the parse
deadline SHALL parse unbounded, as before, and SHALL NOT fail the file; the remaining checkpoints
still apply to it.

A file exceeding the budget SHALL be abandoned, recorded with reason `budget-exceeded` and the
budget it exceeded, and SHALL NOT block completion of the run. Abandoning a file SHALL cost that
file's budget ONCE for the whole build: a later pass that would re-read the same content SHALL skip
it rather than spend the budget again. The default budget SHALL be generous enough that ordinary
source files — including large generated and vendored files — are never affected, and SHALL be
operator-overridable, including a value that disables the bound entirely. Abandoning a file SHALL be
reported, never silent: a bounded result is a lower bound and must read as one.

Abandoning a parse SHALL leave the parser fit to parse the next file. A suspended parse that is
resumed by the next file's parse would silently corrupt every subsequent file in that language,
which is a worse failure than the unbounded parse this bound replaces.

#### Scenario: A pathological file is abandoned rather than stalling the run

- **GIVEN** a 300 KB file of a repeated unterminated block-comment opener, alongside ordinary sources
- **WHEN** `openlore analyze` runs
- **THEN** the run completes, that file is recorded as `budget-exceeded` with the budget it
  exceeded, and the remaining files are analyzed normally

#### Scenario: A file that overruns AFTER its parse is abandoned too

- **GIVEN** a file whose parse completes well inside the budget and whose post-parse extraction
  exceeds it
- **WHEN** `openlore analyze` runs
- **THEN** that file is recorded as `budget-exceeded` with the budget it exceeded — never
  `parse-failure` — its symbols are absent from the graph, and the remaining files are analyzed
  normally

#### Scenario: The file after an abandoned one is unaffected

- **GIVEN** an abandoned file followed by an ordinary file in the same language
- **WHEN** extraction continues
- **THEN** the ordinary file yields its symbols in full and carries no parse-health record

#### Scenario: The record is the same on every run

- **GIVEN** a repository containing a file that exceeds the budget
- **WHEN** it is analyzed twice from the same repository state
- **THEN** the persisted parse-health record is byte-identical across the two runs

#### Scenario: Ordinary large files are unaffected

- **GIVEN** a repository containing a 1.5 MB generated client and a large minified vendor bundle that
  extract within the budget
- **WHEN** `openlore analyze` runs
- **THEN** no file is recorded as `budget-exceeded` and the graph is identical to a run with the
  budget disabled

#### Scenario: A conclusion over an abandoned file discloses the boundary

- **GIVEN** an analysis in which one file was abandoned for exceeding the budget
- **WHEN** a conclusion tool returns a result whose reachable set touches that file
- **THEN** the response discloses that symbols and edges from that file are a lower bound

