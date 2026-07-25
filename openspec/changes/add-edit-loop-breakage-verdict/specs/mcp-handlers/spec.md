# mcp-handlers spec delta

## ADDED Requirements

### Requirement: EditVerdictIsDerivedAtPatchTime

When the watcher patches the graph for an edited file, it SHALL derive a per-edit verdict from
the pre/post facts already in hand: removed-or-renamed symbols with surviving resolved call
sites (`edit-broken-reference`, each caller named `file:line`), provably incompatible call
sites against changed signatures (`edit-arity-mismatch`), imports of names the file no longer
exports (`edit-import-breakage`), and the reaching tests for the edited symbols. The verdict
SHALL persist beside the artifacts keyed to the edit's content hash, and `openlore check-edit`
SHALL serve it as a read — no analysis in the read path. In hook mode, infrastructure failure or
an absent daemon SHALL never block (advisory default; blocking only via `enforcement.policy` on
the registered codes), and with no daemon the command MAY compute a one-file scoped diff
directly, disclosing the slower path.

#### Scenario: A deleted export with live callers becomes a finding within one debounce

- **GIVEN** a daemon-watched repo where an edit deletes an exported function that two other
  files call
- **WHEN** the watcher's patch for that save completes
- **THEN** the persisted verdict contains `edit-broken-reference` naming both call sites
  `file:line`, and `check-edit` returns it without re-parsing anything

#### Scenario: The hook never blocks on infrastructure

- **GIVEN** hook mode with no daemon running and a store that fails to open
- **WHEN** `check-edit --hook` runs
- **THEN** it exits non-blocking with the failure disclosed on stderr — a broken substrate
  never vetoes an edit

### Requirement: EditVerdictNeverGuessesIncompatibility

An `edit-arity-mismatch` finding SHALL be emitted only when incompatibility is provable from
stored facts: argument count below the required (non-defaulted) parameter count, or above the
total parameter count with no variadic/spread/lower-bound marker involved. Default parameters,
variadics, spread arguments, overloads, and out-of-scope languages SHALL produce no finding.
Language scope SHALL be disclosed in the verdict; silence outside the provable set is the
contract — the verdict is a sound lower bound on breakage, never an over-approximation.

#### Scenario: A provable mismatch fires

- **GIVEN** a Python function changed from `def f(a, b)` to `def f(a, b, c)` (no defaults) and
  a stored call site with exact `argCount: 2`
- **WHEN** the verdict derives
- **THEN** `edit-arity-mismatch` names that call site

#### Scenario: A default parameter silences the check

- **GIVEN** the same change but `def f(a, b, c=1)`
- **WHEN** the verdict derives
- **THEN** no arity finding is emitted — compatibility is possible, so the verdict says nothing
