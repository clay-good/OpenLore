# analyzer spec delta

## ADDED Requirements

### Requirement: NotebooksAreIndexedWithDisclosedExecutionOrder

The analyzer SHALL index computational notebooks (`.ipynb`) as source: code cells SHALL be
extracted and analyzed with the existing per-language extractors, and every resulting symbol span
SHALL be reported against the notebook file with its cell index. Notebook outputs SHALL NOT enter
the corpus or any index. Cross-cell name dependencies SHALL be emitted as cell-level edges derived
from the existing def-use facts. The analyzer SHALL disclose, from the notebook's own recorded
metadata, when the recorded execution order disagrees with cell order, when a cell depends on a
name defined only in a later cell, and when execution order cannot be determined; it SHALL NOT
execute the notebook, inspect outputs, or score notebook quality. Constructs the extractors cannot
resolve (interpreter magics, shell escapes, non-Python kernels) SHALL be disclosed as boundaries —
a non-Python kernel yields membership only, never a silently empty call graph — and notebook
support SHALL be expressed in the language-capability registry so a quiet result is interpretable.

#### Scenario: A notebook symbol is a first-class graph node

- **GIVEN** a repository whose `analysis.ipynb` defines a function in its fourth code cell
- **WHEN** analyze runs
- **THEN** that function is in the graph with its file, its line in the `.ipynb` file, and its
  cell index
- **AND** a module function called only from a notebook cell is not reported as dead code

#### Scenario: Cross-cell dependencies are edges

- **GIVEN** a notebook where cell 5 reads a name that cell 3 defines
- **WHEN** the cell graph is queried for cell 3
- **THEN** cell 5 is reported as dependent, and cells with no name dependency are not

#### Scenario: Out-of-order execution is disclosed

- **GIVEN** a notebook whose recorded execution counts do not follow cell order
- **WHEN** analyze runs
- **THEN** the notebook is reported out-of-order with the cells involved
- **AND** a notebook carrying no execution metadata is reported as order-unknowable rather than
  in-order

#### Scenario: An unsupported kernel is disclosed, not silently empty

- **GIVEN** a notebook whose kernel language has no call-graph extractor
- **WHEN** analyze runs and the capability matrix is queried
- **THEN** the notebook's cells are listed as members of the corpus with no call edges claimed
- **AND** the matrix reports notebook projection as supported and the call graph as unsupported
  for that language
