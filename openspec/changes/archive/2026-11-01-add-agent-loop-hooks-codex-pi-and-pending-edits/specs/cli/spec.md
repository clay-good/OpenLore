# cli spec delta

## ADDED Requirements

### Requirement: PendingEditsAreGradedBeforeTheWrite

The before-edit moment SHALL grade the references a pending `Write`, `Edit`, or `MultiEdit` would
add, on the pending text in memory against the file's current text, and state each unresolved one
before the tool writes. It SHALL write nothing, and SHALL skip an edit whose replacement it cannot
apply exactly (an old string that is absent, or not unique without replace-all).

#### Scenario: An invented import is stated before the write

- **GIVEN** a pending edit whose new text imports `formatDate` from `./utils`, which does not
  export it
- **WHEN** the before-edit hook runs on the edit tool's payload
- **THEN** it prints the unresolved-symbol fact, and the target file is unchanged by the hook

#### Scenario: A valid edit is quiet

- **GIVEN** a pending edit that adds no reference
- **WHEN** the before-edit hook runs
- **THEN** it prints nothing
